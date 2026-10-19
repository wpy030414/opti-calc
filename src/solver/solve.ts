import { Frac } from './frac'
import { SolverError } from './errors'
import { LinExpr } from './linexpr'
import { parse } from './parser'
import { buildModel, collectVariables } from './linearize'
import { solveLinearSystem, describeRank, type LinearSystemResult } from './gaussian'
import { standardize, denormalize } from './standardize'
import { solveMilp } from './milp'
import type { Constraint, Model, Solution, SolveStatus, VarDecl } from './model'

/**
 * 求解编排层。
 *
 * 这是整个内核的唯一入口：`solve(文本) → Solution`。三条路径按模型形态自动选择：
 *
 * | 模型形态 | 路径 | 语义 |
 * |---|---|---|
 * | 无目标函数，等式为主 | 高斯消元（精确 RREF） | 「求定点」——直接解出未知数 |
 * | 无目标函数，解不唯一 | 高斯消元 + 零目标 MILP 找可行点 | 给出一个满足全部约束的具体解，并说明解集维度 |
 * | 有目标函数 | 标准化 + LP / 分支定界 MILP | 「求最优解」——最大化或最小化 |
 *
 * 无目标路径优先走高斯消元而非 LP，是因为它能区分「唯一解 / 无穷多解 / 无解」并给出
 * 解空间基；LP 只会返回一个顶点，无法告诉用户「其实还差一个条件」。
 * 对算账场景这个区别很关键：用户经常是少写了一个条件而不自知。
 */

export interface SolveOptions {
  /** 允许整数约束求解（分支定界）。关闭则退化为纯 LP。 */
  integer?: boolean
}

/** 求解入口。抛出 `SolverError` 子类表示模型有误（携带行号）。 */
export function solve(source: string, options: SolveOptions = {}): Solution {
  const allowInteger = options.integer !== false
  const stmts = parse(source)
  const model = buildModel(stmts)
  const varNames = collectVariables(model)

  if (varNames.length === 0 && model.constraints.length === 0 && !model.objective) {
    throw new SolverError('模型为空：请至少写一条约束、变量声明或目标函数', 1, 1)
  }

  const warnings: string[] = []
  // 变量声明中未出现在任何表达式里的，也提示一下（常见笔误）
  for (const v of model.vars) {
    if (!varNames.includes(v.name)) {
      warnings.push(`第 ${v.line} 行：变量「${v.name}」已声明但未在任何约束或目标中使用。`)
    }
  }

  const equalities = model.constraints.filter((c) => c.op === '=' || c.op === '==')
  const inequalities = model.constraints.filter((c) => c.op !== '=' && c.op !== '==')

  if (!model.objective) {
    return solveWithoutObjective(model, varNames, equalities, inequalities, allowInteger, warnings)
  }
  return solveWithObjective(model, varNames, allowInteger, warnings)
}

/** 无目标函数：求精确解或可行点。 */
function solveWithoutObjective(
  model: Model,
  varNames: string[],
  equalities: Constraint[],
  inequalities: Constraint[],
  allowInteger: boolean,
  warnings: string[],
): Solution {
  const sys: LinearSystemResult = solveLinearSystem(equalities, varNames)
  const stats = {
    vars: varNames.length,
    constraints: model.constraints.length,
    integerVars: model.vars.filter((v) => v.kind !== 'real').length,
  }

  if (sys.kind === 'infeasible') {
    return {
      status: { kind: 'infeasible', reason: sys.reason },
      values: new Map(),
      warnings,
      stats,
    }
  }

  if (sys.kind === 'unique') {
    const feasible = checkFeasible(sys.particular, model, varNames)
    if (feasible.ok) {
      return {
        status: { kind: 'optimal' },
        values: sys.particular,
        warnings: [...warnings, describeRank(sys)],
        constraintReport: reportConstraints(sys.particular, model.constraints),
        stats,
      }
    }
    // 唯一等式解违反不等式或边界 → 整体不可行
    return {
      status: { kind: 'infeasible', reason: feasible.reason },
      values: new Map(),
      warnings: [...warnings, describeRank(sys)],
      stats,
    }
  }

  // 无穷多解：用零目标 MILP 找一个满足全部约束的具体解
  warnings.push(describeRank(sys))
  warnings.push(
    `解不唯一，下面给出的是满足全部约束的其中一个解。若要唯一答案，请补充 ${sys.basis.length} 个条件，或写一个 max/min 目标。`,
  )
  const fallback = solveWithObjective(
    { ...model, objective: { sense: 'min', expr: LinExpr.zero(), line: 0 } },
    varNames,
    allowInteger,
    warnings,
  )
  return { ...fallback, stats }
}

/** 有目标函数：标准化后交给 LP / MILP。 */
function solveWithObjective(
  model: Model,
  varNames: string[],
  allowInteger: boolean,
  warnings: string[],
): Solution {
  const std = standardize(model, varNames)
  warnings.push(...std.warnings)

  const r = solveMilp(std, allowInteger)
  const stats = {
    vars: varNames.length,
    constraints: model.constraints.length,
    integerVars: model.vars.filter((v) => v.kind !== 'real').length,
    lpNodes: r.nodes,
  }

  if (r.status !== 'optimal') {
    const status: SolveStatus =
      r.status === 'infeasible'
        ? { kind: 'infeasible', reason: r.reason }
        : r.status === 'unbounded'
          ? { kind: 'unbounded', direction: r.reason }
          : { kind: 'degenerate', reason: r.reason }
    return { status, values: new Map(), warnings, stats }
  }

  const values = denormalize(std, r.x)
  // 标准形目标是「min 化后的 cᵀx」，还原为原始 sense 下的目标值
  const objectiveValue = (std.minimize ? r.objective : r.objective.neg()).add(std.objectiveConst)

  return {
    status: { kind: 'optimal' },
    values,
    objectiveValue,
    warnings,
    constraintReport: reportConstraints(values, model.constraints),
    stats,
  }
}

/** 检查赋值是否满足全部不等式约束与变量边界。 */
function checkFeasible(
  assign: ReadonlyMap<string, Frac>,
  model: Model,
  varNames: string[],
): { ok: true } | { ok: false; reason: string } {
  for (const c of model.constraints) {
    const diff = c.left.eval(assign).sub(c.right.eval(assign))
    const ok =
      c.op === '<='
        ? diff.le(Frac.ZERO)
        : c.op === '>='
          ? diff.ge(Frac.ZERO)
          : c.op === '<'
            ? diff.lt(Frac.ZERO)
            : c.op === '>'
              ? diff.gt(Frac.ZERO)
              : diff.eq(Frac.ZERO)
    if (!ok) {
      return {
        ok: false,
        reason: `等式解违反第 ${c.line} 行的约束：代入后左边比右边${diff.isNegative ? '小' : '大'} ${diff.abs().toString()}`,
      }
    }
  }

  const decls = new Map<string, VarDecl>(model.vars.map((v) => [v.name, v]))
  for (const name of varNames) {
    const v = assign.get(name) ?? Frac.ZERO
    const decl = decls.get(name)
    const isInt = decl ? decl.kind !== 'real' : false
    if (decl?.lower !== undefined && v.lt(decl.lower)) {
      return { ok: false, reason: `变量「${name}」= ${fmt(v)}，低于声明的下界 ${fmt(decl.lower)}（第 ${decl.line} 行）` }
    }
    if (decl?.upper !== undefined && v.gt(decl.upper)) {
      return { ok: false, reason: `变量「${name}」= ${fmt(v)}，高于声明的上界 ${fmt(decl.upper)}（第 ${decl.line} 行）` }
    }
    if (isInt && v.d !== 1n) {
      return { ok: false, reason: `变量「${name}」声明为${decl?.kind === 'binary' ? '二元' : '整数'}，但等式解给出 ${fmt(v)}（第 ${decl?.line ?? 0} 行）` }
    }
    if (decl?.kind === 'binary' && !v.eq(Frac.ZERO) && !v.eq(Frac.ONE)) {
      return { ok: false, reason: `变量「${name}」声明为二元（0/1），但等式解给出 ${fmt(v)}（第 ${decl.line} 行）` }
    }
  }
  return { ok: true }
}

/** 生成约束满足情况报告。 */
function reportConstraints(assign: ReadonlyMap<string, Frac>, constraints: Constraint[]): Solution['constraintReport'] {
  return constraints.map((c) => {
    const left = c.left.eval(assign)
    const right = c.right.eval(assign)
    const slack = left.sub(right)
    const satisfied =
      c.op === '<='
        ? slack.le(Frac.ZERO)
        : c.op === '>='
          ? slack.ge(Frac.ZERO)
          : c.op === '<'
            ? slack.lt(Frac.ZERO)
            : c.op === '>'
              ? slack.gt(Frac.ZERO)
              : c.op === '=' || c.op === '=='
                ? slack.eq(Frac.ZERO)
                : !slack.eq(Frac.ZERO)
    const tight = slack.eq(Frac.ZERO)
    return { name: c.name, slack, tight, satisfied, line: c.line }
  })
}

/** 展示用：能有限小数表示就给精确小数，否则给分数。 */
export function fmt(v: Frac): string {
  if (v.d === 1n) return v.n.toString()
  if (v.terminates) return v.toDecimalString(10)
  return `${v.toString()} (≈ ${v.toDecimalString(6)})`
}
