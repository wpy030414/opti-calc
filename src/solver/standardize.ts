import { Frac, ceilDiv, floorDiv, zeros } from './frac'
import { ModelError } from './errors'
import type { LpStandard, RelSense } from './lp'
import type { Constraint, Model, RelOp } from './model'

/**
 * 标准化：把带边界、自由变量、各类比较符的模型转成 LP 标准形。
 *
 * 标准形要求所有变量 >= 0，因此做两类变量代换：
 *
 * 1. **有限下界平移**：`x >= L` → 令 `x' = x - L >= 0`，回代 `x = x' + L`。
 *    把下界吸收进变量定义，省掉 m 条显式约束，矩阵更小。
 *    整数变量额外把 L 收紧为 `⌈L⌉`——「x 是整数且 x >= 2.5」等价于「x >= 3」，
 *    收紧后平移量必为整数，分支定界判分数才成立。
 * 2. **自由变量拆分**：`x` 无下界 → `x = x⁺ - x⁻`，`x⁺, x⁻ >= 0`。
 *    二者之差可表示任意实数；最优基里不会同时为正。
 *
 * 严格不等式（`<` / `>`）在实数域上无法被 LP 表达（开集没有最值）。处理策略：
 * - 整数变量：收紧为闭区间（`x < 5` → `x <= 4`），语义精确等价。
 * - 实数变量：放宽为 `<=` / `>=` 并记一条 warning，让用户知道这是近似。
 */

export interface Substitution {
  /** 标准形中的列下标；自由变量拆分时有两个（x⁺ 在前，x⁻ 在后）。 */
  cols: number[]
  /** 是否经过自由变量拆分。 */
  split: boolean
  /** 平移量 L（`x = x' + L`）；拆分时为 0。 */
  shift: Frac
  /** 该变量是否要求取整数。 */
  integer: boolean
}

export interface Standardized {
  lp: LpStandard
  /** 原始变量名。 */
  varNames: string[]
  /** 每个原始变量到标准形列的映射。 */
  subs: Map<string, Substitution>
  /** 标准形列总数。 */
  ncols: number
  /** 整数变量在 varNames 中的下标集合。 */
  integerIdx: Set<number>
  /** 标准化阶段产生的语义提示。 */
  warnings: string[]
  /** 目标是否已按 min 处理（max 会被取反）。 */
  minimize: boolean
  /**
   * 目标函数中的常数项 C（**原始符号**，不随 max/min 翻转）。
   *
   * 标准形求的是 `Σ c_std·x`，它与真实目标的关系是：
   * min 时 `r = obj - C`，max 时 `r = -(obj - C)`，
   * 因此还原公式统一为 `obj = (minimize ? r : -r) + C`。
   */
  objectiveConst: Frac
}

const OP_SENSE: Record<RelOp, RelSense> = {
  '<=': 'le',
  '>=': 'ge',
  '=': 'eq',
  '<': 'le',
  '>': 'ge',
  // != 在 toRowForm 里被拒绝（非凸），这里给出映射只为让 Record 覆盖完整类型
  '!=': 'eq',
}

/** 把一条约束整理为 `A x rel b`：所有项移到左边，右边只剩常数。 */
function toRowForm(
  c: Constraint,
  subs: Map<string, Substitution>,
  ncols: number,
): { coef: Frac[]; sense: RelSense; rhs: Frac; warning?: string } {
  if (c.op === '!=') {
    throw new ModelError(
      `第 ${c.line} 行使用了「!=」约束。它定义的可行域不是凸集，线性规划无法直接处理；` +
        `可拆成两个模型分别求解，或引入 0/1 变量做析取。`,
      c.line,
      1,
    )
  }

  const diff = c.left.sub(c.right)
  const coef = zeros(ncols)
  for (const [name, k] of diff.terms) {
    const sub = subs.get(name)
    if (!sub) throw new ModelError(`内部错误：变量「${name}」缺少标准化映射`)
    if (sub.split) {
      const p = sub.cols[0] as number
      const n = sub.cols[1] as number
      coef[p] = (coef[p] as Frac).add(k)
      coef[n] = (coef[n] as Frac).sub(k)
    } else {
      const col = sub.cols[0] as number
      coef[col] = (coef[col] as Frac).add(k)
    }
  }
  // 约束为 `diff op 0`，把常数项移到右边
  const rhs = diff.constant.neg()

  let warning: string | undefined
  if (c.op === '<' || c.op === '>') {
    const involved = [...diff.terms.keys()]
    const allInteger = involved.length > 0 && involved.every((nm) => subs.get(nm)?.integer === true)
    if (!allInteger) {
      warning =
        `第 ${c.line} 行使用了严格不等式（${c.op}）。实数变量上的开集不存在最值，` +
        `已放宽为 ${c.op === '<' ? '<=' : '>='}；若需要精确语义，请把相关变量声明为整数。`
    }
  }

  return { coef, sense: OP_SENSE[c.op] ?? 'eq', rhs, warning }
}

export function standardize(model: Model, varNames: string[]): Standardized {
  const warnings: string[] = []
  const subs = new Map<string, Substitution>()
  let col = 0

  for (const name of varNames) {
    const decl = model.vars.find((v) => v.name === name)
    const kind = decl?.kind ?? 'real'
    const isInt = kind === 'integer' || kind === 'binary'

    // 「未声明即自由」：算账里负数有意义（亏损、欠款），需要非负时显式写「非负整数」或 `>= 0`。
    const hasLower = decl !== undefined && decl.free !== true && decl.lower !== undefined
    let shift = Frac.ZERO
    if (hasLower) {
      const lo = decl?.lower ?? Frac.ZERO
      shift = isInt && lo.d !== 1n ? Frac.fromBigInt(ceilDiv(lo.n, lo.d)) : lo
    }

    if (!hasLower) {
      const p = col++
      const n = col++
      subs.set(name, { cols: [p, n], split: true, shift: Frac.ZERO, integer: isInt })
      if (decl?.upper !== undefined) {
        warnings.push(`第 ${decl.line} 行：变量「${name}」只有上界没有下界，上界已转为显式约束。`)
      }
    } else {
      subs.set(name, { cols: [col++], split: false, shift, integer: isInt })
    }
  }

  const ncols = col
  const A: Frac[][] = []
  const sense: RelSense[] = []
  const b: Frac[] = []
  const pushRow = (coef: Frac[], s: RelSense, rhs: Frac): void => {
    A.push(coef)
    sense.push(s)
    b.push(rhs)
  }

  for (const c of model.constraints) {
    const row = toRowForm(c, subs, ncols)
    if (row.warning) warnings.push(row.warning)
    pushRow(row.coef, row.sense, row.rhs)
  }

  // 变量上界转为约束行；整数变量同时把上界收紧为 ⌊U⌋
  for (const name of varNames) {
    const decl = model.vars.find((v) => v.name === name)
    const sub = subs.get(name)
    if (!decl || !sub || decl.upper === undefined) continue
    const coef = zeros(ncols)
    if (sub.split) {
      coef[sub.cols[0] as number] = Frac.ONE
      coef[sub.cols[1] as number] = Frac.ONE.neg()
    } else {
      coef[sub.cols[0] as number] = Frac.ONE
    }
    let upper = decl.upper
    if (sub.integer && upper.d !== 1n) upper = Frac.fromBigInt(floorDiv(upper.n, upper.d))
    pushRow(coef, 'le', upper.sub(sub.shift))
  }

  const minimize = model.objective ? model.objective.sense === 'min' : true
  const c = zeros(ncols)
  let objectiveConst = Frac.ZERO
  if (model.objective) {
    const sign = minimize ? Frac.ONE : Frac.ONE.neg()
    for (const [name, k] of model.objective.expr.terms) {
      const sub = subs.get(name)
      if (!sub) continue
      const kk = k.mul(sign)
      if (sub.split) {
        c[sub.cols[0] as number] = (c[sub.cols[0] as number] as Frac).add(kk)
        c[sub.cols[1] as number] = (c[sub.cols[1] as number] as Frac).sub(kk)
      } else {
        c[sub.cols[0] as number] = (c[sub.cols[0] as number] as Frac).add(kk)
      }
    }
    objectiveConst = model.objective.expr.constant
  }

  const integerIdx = new Set<number>()
  varNames.forEach((name, i) => {
    if (subs.get(name)?.integer) integerIdx.add(i)
  })

  return {
    lp: { n: ncols, A, sense, b, c },
    varNames,
    subs,
    ncols,
    integerIdx,
    warnings,
    minimize,
    objectiveConst,
  }
}

/** 把标准形解还原为原始变量取值。 */
export function denormalize(std: Standardized, x: Frac[]): Map<string, Frac> {
  const out = new Map<string, Frac>()
  for (const name of std.varNames) {
    const sub = std.subs.get(name)
    if (!sub) {
      out.set(name, Frac.ZERO)
      continue
    }
    const v = sub.split
      ? (x[sub.cols[0] as number] ?? Frac.ZERO).sub(x[sub.cols[1] as number] ?? Frac.ZERO)
      : (x[sub.cols[0] as number] ?? Frac.ZERO).add(sub.shift)
    out.set(name, v)
  }
  return out
}
