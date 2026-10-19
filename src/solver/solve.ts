import { Frac } from './frac'
import { SolverError } from './errors'
import { LinExpr } from './linexpr'
import { parse } from './parser'
import { buildModel, collectVariables } from './linearize'
import { solveLinearSystem, describeRank, type LinearSystemResult } from './gaussian'
import { standardize, denormalize } from './standardize'
import { solveMilp } from './milp'
import { buildQuadraticProgram } from './bilinear'
import { solveSpatialBb } from './spatialbb'
import type { Constraint, Model, Solution, SolveStatus } from './model'

/**
 * 求解编排层。内核唯一入口：`solve(文本) → Solution`。
 *
 * ## 职责划分
 *
 * - **高斯消元只负责诊断，不负责出解。** 它能区分「唯一 / 无穷多 / 矛盾」并给出解空间维度，
 *   这是 LP 做不到的——LP 只会返回一个顶点，无法告诉用户「其实还差一个条件」。
 *   对算账场景这个区别很关键：用户经常是少写了一个条件而不自知。
 * - **实际解统一由 MILP（或退化的 LP）给出。** 等式、不等式、变量边界、整数约束
 *   全部走同一条路径，避免两套可行性判定逻辑互相漂移。
 *
 * ## 路径选择
 *
 * | 模型形态 | 行为 |
 * |---|---|
 * | 等式系统自相矛盾 | 立即判 infeasible，给出矛盾行（`0 = 非零`） |
 * | 有目标函数 | 标准化 → LP / 分支定界，返回最优解 |
 * | 无目标函数 | 零目标 MILP 找一个可行点，再做唯一性探测 |
 *
 * ## 唯一性探测
 *
 * 对每个变量分别求 `max v` 与 `min v`（按模型是否含整数走 MILP 或 LP）。
 * 该判据在两个方向上都是严格的：
 * - 某个变量的 max > min ⟹ 两个极值点在该坐标上不同 ⟹ 确实存在两组不同解；
 * - 所有变量的 max == min ⟹ 每个变量都被夹死 ⟹ 解唯一。
 *
 * 代价是 2n 次求解，因此对变量数设了上限；超限则退回基于矩阵秩的维度估计，
 * 并明确标注这是估计而非证明。
 */

export interface SolveOptions {
  /** 允许整数约束求解（分支定界）。关闭则退化为纯 LP。 */
  integer?: boolean
  /**
   * 「连续 × 连续」二次项近似求解的相对损失率阈值，默认 1%。
   * 只影响 B 类项；A 类（整数/二元因子）始终精确。
   */
  gapTolerance?: Frac
}

/** B 类二次项的默认相对损失率阈值：1%。 */
const DEFAULT_GAP_TOLERANCE = Frac.parse('0.01')

/** 超过该变量数就不再逐变量探测唯一性，改用秩估计。 */
const UNIQUENESS_PROBE_LIMIT = 40

/**
 * 求解结果中由编排层统一补齐的展示字段。
 *
 * 内部各分支只需产出「算出来的东西」，`varOrder` 与 `objectiveSense`
 * 这类纯粹为界面服务的字段在 `solve()` 出口处一次性附加。
 * 否则每个 return 点都要记得带上，漏一个就少一块 UI 信息。
 */
type RawSolution = Omit<Solution, 'varOrder' | 'objectiveSense'>

/** 求解入口。抛出 `SolverError` 子类表示模型有误（携带行号）。 */
export function solve(source: string, options: SolveOptions = {}): Solution {
  const allowInteger = options.integer !== false
  const model = buildModel(parse(source))
  const varNames = collectVariables(model)

  if (varNames.length === 0 && model.constraints.length === 0 && !model.objective) {
    throw new SolverError('模型为空：请至少写一条约束、变量声明或目标函数', 1, 1)
  }

  const warnings: string[] = []
  for (const v of model.vars) {
    if (!varNames.includes(v.name)) {
      warnings.push(`第 ${v.line} 行：变量「${v.name}」已声明但未在任何约束或目标中使用。`)
    }
  }

  // 含二次项：走专门路径（A 类精确线性化 / B 类空间分支定界）。
  // 非线性下高斯诊断与唯一性探测不成立，因此在这之前分流。
  const hasBilinear =
    model.constraints.some((c) => (c.bilinear?.length ?? 0) > 0) ||
    (model.objective?.bilinear?.length ?? 0) > 0
  if (hasBilinear) {
    return {
      ...solveBilinear(
        model,
        varNames,
        allowInteger,
        options.gapTolerance ?? DEFAULT_GAP_TOLERANCE,
        warnings,
      ),
      varOrder: varNames,
      objectiveSense: model.objective?.sense,
    }
  }

  const equalities = model.constraints.filter((c) => c.op === '=')

  // 诊断：等式系统是否自相矛盾。矛盾时无需再跑 LP。
  const sys: LinearSystemResult = solveLinearSystem(equalities, varNames)

  const raw: RawSolution =
    sys.kind === 'infeasible'
      ? {
          status: { kind: 'infeasible', reason: sys.reason },
          values: new Map(),
          warnings,
          stats: makeStats(model, varNames),
        }
      : model.objective
        ? solveWithObjective(model, varNames, allowInteger, warnings, sys)
        : solveFeasiblePoint(model, varNames, allowInteger, warnings, sys)

  return {
    ...raw,
    varOrder: varNames,
    objectiveSense: model.objective?.sense,
  }
}

function makeStats(
  model: Model,
  varNames: string[],
  lpNodes?: number,
): NonNullable<Solution['stats']> {
  return {
    vars: varNames.length,
    constraints: model.constraints.length,
    integerVars: model.vars.filter((v) => v.kind !== 'real').length,
    lpNodes,
  }
}

/**
 * 含二次项模型的求解。
 *
 * - 全部是 A 类（整数/二元因子）→ 精确线性化后交给 MILP，结果精确。
 * - 含 B 类（连续 × 连续）→ 空间分支定界，返回近似解与损失率上界。
 */
function solveBilinear(
  model: Model,
  varNames: string[],
  allowInteger: boolean,
  gapTolerance: Frac,
  warnings: string[],
): RawSolution {
  const prog = buildQuadraticProgram(model, varNames, allowInteger)
  const expandedVars = collectVariables(prog.model)
  const std = standardize(prog.model, expandedVars)
  warnings.push(...std.warnings)

  if (prog.bTerms.length === 0) {
    // 全 A 类：精确线性化后的纯 MILP
    const r = solveMilp(std, allowInteger)
    const stats = makeStats(model, varNames, r.nodes)
    if (r.status !== 'optimal') {
      return { status: statusOf(r.status, r.reason), values: new Map(), warnings, stats }
    }
    const all = denormalize(std, r.x)
    return {
      status: { kind: 'optimal' },
      values: visibleValues(all, prog.internal),
      objectiveValue: convertObjective(model, std, r.objective),
      constraintReport: reportConstraints(all, model.constraints),
      warnings,
      stats,
    }
  }

  // 含 B 类：空间分支定界，结果近似，必须报告损失率
  const r = solveSpatialBb(std, prog.bTerms, prog.boxes, allowInteger, gapTolerance)
  const stats = makeStats(model, varNames, r.nodes)
  if (r.status !== 'optimal') {
    return { status: statusOf(r.status, r.reason), values: new Map(), warnings, stats }
  }
  if (r.reason) warnings.push(r.reason)

  const all = denormalize(std, r.x)
  const relativeGap = r.relativeGap
  const approximate = relativeGap !== undefined && relativeGap.gt(Frac.ZERO)
  if (approximate && relativeGap) {
    const pct = relativeGap.mul(Frac.parse('100')).toDecimalString(2)
    warnings.push(
      `模型含「连续变量相乘」，这是非凸问题，结果为近似值：` +
        `与真实最优值的相对差距不超过 ${fmt(relativeGap)}（约 ${pct}%）。`,
    )
  }

  return {
    status: { kind: 'optimal' },
    values: visibleValues(all, prog.internal),
    objectiveValue: convertObjective(model, std, r.objective),
    approximation: approximate && relativeGap ? { relativeGap } : undefined,
    constraintReport: reportConstraints(all, model.constraints),
    warnings,
    stats,
  }
}

/** min 方向目标值还原为原始目标值（含 max 翻转与常数项）。 */
function convertObjective(
  model: Model,
  std: ReturnType<typeof standardize>,
  raw: Frac,
): Frac | undefined {
  if (!model.objective) return undefined
  return (std.minimize ? raw : raw.neg()).add(std.objectiveConst)
}

/** 去掉内部辅助变量，只返回用户可写出的变量。 */
function visibleValues(
  all: ReadonlyMap<string, Frac>,
  internal: ReadonlySet<string>,
): Map<string, Frac> {
  const out = new Map<string, Frac>()
  for (const [name, v] of all) {
    if (!internal.has(name)) out.set(name, v)
  }
  return out
}

/** 无目标函数：找一个可行点，并判定解是否唯一。 */
function solveFeasiblePoint(
  model: Model,
  varNames: string[],
  allowInteger: boolean,
  warnings: string[],
  sys: LinearSystemResult,
): RawSolution {
  const stats = makeStats(model, varNames)
  const probe = zeroObjectiveModel(model)
  const std = standardize(probe, varNames)
  warnings.push(...std.warnings)

  const r = solveMilp(std, allowInteger)
  stats.lpNodes = r.nodes

  if (r.status !== 'optimal') {
    const reason = enrichInfeasibleReason(r.reason, sys)
    return { status: statusOf(r.status, reason), values: new Map(), warnings, stats }
  }

  const values = denormalize(std, r.x)
  const report = reportConstraints(values, model.constraints)

  // 等式已把解夹死 → 唯一，无需探测
  if (sys.kind === 'unique') {
    return {
      status: { kind: 'optimal' },
      values,
      warnings: [...warnings, describeRank(sys)],
      constraintReport: report,
      stats,
    }
  }

  const uniq = probeUniqueness(model, varNames, allowInteger)
  warnings.push(...uniq.warnings)

  if (uniq.unique) {
    warnings.push(
      `解唯一：虽然等式不足以确定全部 ${varNames.length} 个未知数，但不等式与取值范围把它们夹死了。`,
    )
  } else {
    warnings.push(describeRank(sys))
    warnings.push(
      `解不唯一，下面给出的是满足全部约束的其中一个解。` +
        `若要唯一答案，请补充条件，或写一个 max/min 目标来挑出最优的那个。`,
    )
  }

  return {
    status: { kind: 'optimal' },
    values,
    constraintReport: report,
    warnings,
    stats,
  }
}

/** 有目标函数：标准化后交给 LP / MILP。 */
function solveWithObjective(
  model: Model,
  varNames: string[],
  allowInteger: boolean,
  warnings: string[],
  sys: LinearSystemResult,
): RawSolution {
  const std = standardize(model, varNames)
  warnings.push(...std.warnings)

  const r = solveMilp(std, allowInteger)
  const stats = makeStats(model, varNames, r.nodes)

  if (r.status !== 'optimal') {
    const reason = enrichInfeasibleReason(r.reason, sys)
    return { status: statusOf(r.status, reason), values: new Map(), warnings, stats }
  }

  const values = denormalize(std, r.x)
  const objectiveValue = (std.minimize ? r.objective : r.objective.neg()).add(std.objectiveConst)

  const alt = probeAlternativeOptimum(model, varNames, objectiveValue, values, allowInteger)
  if (alt === 'degenerate') {
    warnings.push('变量数过多，跳过最优解唯一性探测；可能存在同样最优的另一组取值。')
  } else if (alt) {
    warnings.push(
      `最优解不唯一：目标值同为 ${fmt(objectiveValue)} 的还有另一组取值，` +
        `例如 ${describeAssignment(alt, varNames)}。`,
    )
  }

  return {
    status: { kind: 'optimal' },
    values,
    objectiveValue,
    warnings,
    constraintReport: reportConstraints(values, model.constraints),
    stats,
  }
}

function statusOf(status: 'infeasible' | 'unbounded' | 'degenerate', reason?: string): SolveStatus {
  if (status === 'infeasible') return { kind: 'infeasible', reason }
  if (status === 'unbounded') return { kind: 'unbounded', direction: reason }
  return { kind: 'degenerate', reason }
}

/**
 * 等式系统有唯一实数解、但整体不可行时，补充说明原因。
 *
 * 最常见的两种情况是「唯一解不是整数」和「唯一解超出声明范围」，
 * 单说「无可行解」对用户没有指导意义。
 */
function enrichInfeasibleReason(
  reason: string | undefined,
  sys: LinearSystemResult,
): string | undefined {
  if (sys.kind !== 'unique') return reason
  const point = describeAssignment(sys.particular, sys.varNames)
  return `${reason ?? '无可行解'}。等式部分本身有唯一解 ${point}，但它违反了不等式、边界或整数约束。`
}

function zeroObjectiveModel(model: Model): Model {
  return { ...model, objective: { sense: 'min', expr: LinExpr.zero(), line: 0 } }
}

interface UniquenessResult {
  unique: boolean
  warnings: string[]
}

/**
 * 无目标场景：逐变量求 max/min，判定可行域是否为单点。
 *
 * 这里在整个可行域上探测是正确的——用户要的就是「满足约束的解」，
 * 可行域含多于一点即意味着答案不唯一。
 *
 * 变量数超过 `UNIQUENESS_PROBE_LIMIT` 时跳过探测，并在 warning 中说明。
 */
function probeUniqueness(
  model: Model,
  varNames: string[],
  allowInteger: boolean,
): UniquenessResult {
  if (varNames.length > UNIQUENESS_PROBE_LIMIT) {
    return {
      unique: false,
      warnings: [`变量数超过 ${UNIQUENESS_PROBE_LIMIT}，跳过解唯一性探测；结果可能不唯一。`],
    }
  }

  for (const name of varNames) {
    const lo = probeVar(model, varNames, name, 'min', allowInteger)
    const hi = probeVar(model, varNames, name, 'max', allowInteger)
    if (lo === null || hi === null) {
      return {
        unique: false,
        warnings: [`变量「${name}」在可行域内无界，因此存在无穷多组解；下面给出的是其中一个。`],
      }
    }
    if (hi.gt(lo)) return { unique: false, warnings: [] }
  }
  return { unique: true, warnings: [] }
}

/**
 * 有目标场景：在「目标值 = 最优值」的切面上探测是否还有别的解。
 *
 * 必须加这条等式约束——若在整个可行域上探测，变量只要能动就会误报「最优解不唯一」，
 * 而实际上那些变动会改变目标值、并非最优。
 *
 * 返回：`null` 表示唯一；`'degenerate'` 表示规模过大未探测；否则返回另一组最优解。
 */
function probeAlternativeOptimum(
  model: Model,
  varNames: string[],
  objectiveValue: Frac,
  incumbent: ReadonlyMap<string, Frac>,
  allowInteger: boolean,
): Map<string, Frac> | null | 'degenerate' {
  if (!model.objective || varNames.length > UNIQUENESS_PROBE_LIMIT) return 'degenerate'
  if (varNames.length === 0) return null

  // 把最优目标值锁成一条等式，后续探测都在这个切面上进行
  const slice: Model = {
    ...model,
    constraints: [
      ...model.constraints,
      {
        left: model.objective.expr,
        op: '=',
        right: LinExpr.const(objectiveValue),
        line: model.objective.line,
      },
    ],
  }

  for (const name of varNames) {
    const lo = probeVar(slice, varNames, name, 'min', allowInteger)
    const hi = probeVar(slice, varNames, name, 'max', allowInteger)
    if (lo === null || hi === null) continue
    if (hi.gt(lo)) {
      // 找到可动方向，取 max 端点构造一组与当前解不同的最优解
      const probeModel: Model = {
        ...slice,
        objective: { sense: 'max', expr: LinExpr.var(name), line: 0 },
      }
      const std = standardize(probeModel, varNames)
      const r = solveMilp(std, allowInteger)
      if (r.status === 'optimal') {
        const alt = denormalize(std, r.x)
        if (!sameAssignment(alt, incumbent, varNames)) return alt
      }
    }
  }
  return null
}

function sameAssignment(
  a: ReadonlyMap<string, Frac>,
  b: ReadonlyMap<string, Frac>,
  names: string[],
): boolean {
  return names.every((n) => (a.get(n) ?? Frac.ZERO).eq(b.get(n) ?? Frac.ZERO))
}

/** 求某变量在可行域上的极值；无界或不可行返回 null。 */
function probeVar(
  model: Model,
  varNames: string[],
  name: string,
  sense: 'min' | 'max',
  allowInteger: boolean,
): Frac | null {
  const probeModel: Model = {
    ...model,
    objective: { sense, expr: LinExpr.var(name), line: 0 },
  }
  const std = standardize(probeModel, varNames)
  const r = solveMilp(std, allowInteger)
  if (r.status !== 'optimal') return null
  return (std.minimize ? r.objective : r.objective.neg()).add(std.objectiveConst)
}

/** 约束余量：`(left - right)` 的线性部分 + 二次部分。 */
function constraintSlack(c: Constraint, assign: ReadonlyMap<string, Frac>): Frac {
  let slack = c.left.eval(assign).sub(c.right.eval(assign))
  for (const t of c.bilinear ?? []) {
    const iv = assign.get(t.i) ?? Frac.ZERO
    const jv = assign.get(t.j) ?? Frac.ZERO
    slack = slack.add(t.coef.mul(iv).mul(jv))
  }
  return slack
}

/** 生成约束满足情况报告。 */
function reportConstraints(
  assign: ReadonlyMap<string, Frac>,
  constraints: Constraint[],
): Solution['constraintReport'] {
  return constraints.map((c) => {
    const slack = constraintSlack(c, assign)
    let satisfied: boolean
    switch (c.op) {
      case '<=':
        satisfied = slack.le(Frac.ZERO)
        break
      case '>=':
        satisfied = slack.ge(Frac.ZERO)
        break
      case '<':
        satisfied = slack.lt(Frac.ZERO)
        break
      case '>':
        satisfied = slack.gt(Frac.ZERO)
        break
      case '!=':
        satisfied = !slack.eq(Frac.ZERO)
        break
      default:
        satisfied = slack.eq(Frac.ZERO)
    }
    return { name: c.name, slack, tight: slack.eq(Frac.ZERO), satisfied, line: c.line }
  })
}

function describeAssignment(assign: ReadonlyMap<string, Frac>, names: string[]): string {
  return names.map((n) => `${n} = ${fmt(assign.get(n) ?? Frac.ZERO)}`).join('，')
}

/** 展示用：能有限小数表示就给精确小数，否则给分数并附近似值。 */
export function fmt(v: Frac): string {
  if (v.d === 1n) return v.n.toString()
  if (v.terminates) return v.toDecimalString(12)
  return `${v.toString()}（≈ ${v.toDecimalString(6)}）`
}
