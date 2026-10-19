import { Frac } from './frac'
import type { Constraint } from './model'

/**
 * 线性方程组求解（精确 Gauss-Jordan 消元，RREF）。
 *
 * 全程 BigInt 有理数，无浮点误差。返回三种情形之一：
 * - `unique`：唯一解
 * - `infinite`：无穷多解，给出特解 + 解空间基（自由变量作参数）
 * - `infeasible`：出现 `0 = 非零` 的矛盾行
 *
 * 这是「求定点」类问题的主力：用户只写等式与边界，不写目标函数时走这条路径。
 */

export interface BasisVector {
  /** 对应的自由变量名（参数）。 */
  param: string
  /** 该参数增加 1 时，各变量的变化量。 */
  vec: Map<string, Frac>
}

export interface LinearSystemResult {
  kind: 'unique' | 'infinite' | 'infeasible'
  varNames: string[]
  /** 特解（unique 时即唯一解；infinite 时为参数全取 0 时的解）。 */
  particular: Map<string, Frac>
  /** 解空间基；unique / infeasible 时为空数组。 */
  basis: BasisVector[]
  /** 自由变量名列表。 */
  freeVars: string[]
  /** infeasible 时的原因说明。 */
  reason?: string
  /** 参与消元的等式行数与列数，便于展示规模。 */
  rows: number
  cols: number
}

interface Row {
  coef: Frac[]
  rhs: Frac
}

/** 把等式约束整理为增广矩阵行。`a op b` 统一移项为 `(a-b) = 0`。 */
function buildRows(eqs: Constraint[], varNames: string[]): Row[] {
  const idx = new Map<string, number>()
  varNames.forEach((v, i) => idx.set(v, i))
  const rows: Row[] = []
  for (const c of eqs) {
    const diff = c.left.sub(c.right)
    const coef = new Array<Frac>(varNames.length).fill(Frac.ZERO)
    for (const [name, k] of diff.terms) {
      const j = idx.get(name)
      if (j === undefined) throw new Error(`内部错误：变量 ${name} 未在变量表中`)
      coef[j] = k
    }
    rows.push({ coef, rhs: diff.constant.neg() })
  }
  return rows
}

/** Gauss-Jordan 消元至简化行阶梯形（RREF）。原地修改 rows。 */
function rref(rows: Row[]): { pivotCols: number[]; rank: number } {
  const pivotCols: number[] = []
  const m = rows.length
  if (m === 0) return { pivotCols, rank: 0 }
  const n = (rows[0] as Row).coef.length
  let r = 0

  for (let c = 0; c < n && r < m; c++) {
    // 选主元：取该列绝对值最小的非零元，控制 BigInt 膨胀
    let pivot = -1
    let best: bigint | null = null
    for (let i = r; i < m; i++) {
      const row = rows[i] as Row
      const v = row.coef[c] as Frac
      if (!v.isZero) {
        const size = v.n < 0n ? -v.n * v.d : v.n * v.d
        if (best === null || size < best) {
          best = size
          pivot = i
        }
      }
    }
    if (pivot < 0) continue

    const tmp = rows[r] as Row
    rows[r] = rows[pivot] as Row
    rows[pivot] = tmp

    const prow = rows[r] as Row
    const pv = prow.coef[c] as Frac
    const inv = pv.inv()
    for (let k = c; k < n; k++) {
      prow.coef[k] = (prow.coef[k] as Frac).mul(inv)
    }
    prow.rhs = prow.rhs.mul(inv)

    for (let i = 0; i < m; i++) {
      if (i === r) continue
      const row = rows[i] as Row
      const f = row.coef[c] as Frac
      if (f.isZero) continue
      for (let k = c; k < n; k++) {
        row.coef[k] = (row.coef[k] as Frac).sub(f.mul(prow.coef[k] as Frac))
      }
      row.rhs = row.rhs.sub(f.mul(prow.rhs))
    }

    pivotCols.push(c)
    r++
  }

  return { pivotCols, rank: pivotCols.length }
}

export function solveLinearSystem(eqs: Constraint[], varNames: string[]): LinearSystemResult {
  const rows = buildRows(eqs, varNames)
  const empty = new Map<string, Frac>()
  const base: LinearSystemResult = {
    kind: 'infeasible',
    varNames,
    particular: empty,
    basis: [],
    freeVars: [],
    rows: rows.length,
    cols: varNames.length,
  }

  if (rows.length === 0) {
    // 没有等式：解空间是整个 R^n
    return {
      ...base,
      kind: 'infinite',
      particular: new Map(varNames.map((v) => [v, Frac.ZERO])),
      basis: varNames.map((v) => ({ param: v, vec: new Map([[v, Frac.ONE]]) })),
      freeVars: [...varNames],
    }
  }

  const { pivotCols, rank } = rref(rows)

  // 检查矛盾行：系数全 0 而 rhs != 0
  for (const row of rows) {
    const allZero = row.coef.every((c) => c.isZero)
    if (allZero && !row.rhs.isZero) {
      return {
        ...base,
        kind: 'infeasible',
        reason: `出现矛盾等式：0 = ${row.rhs.toString()}（方程组无解）`,
      }
    }
  }

  const pivotSet = new Set(pivotCols)
  const freeCols: number[] = []
  for (let c = 0; c < varNames.length; c++) {
    if (!pivotSet.has(c)) freeCols.push(c)
  }

  // 特解：自由变量取 0，主元变量取对应行的 rhs
  const particular = new Map<string, Frac>()
  for (const v of varNames) particular.set(v, Frac.ZERO)
  pivotCols.forEach((c, i) => {
    const row = rows[i] as Row
    particular.set(varNames[c] as string, row.rhs)
  })

  if (freeCols.length === 0) {
    return { ...base, kind: 'unique', particular, freeVars: [] }
  }

  // 解空间基：每个自由变量取 1、其余取 0 时的解
  const basis: BasisVector[] = []
  for (const fc of freeCols) {
    const vec = new Map<string, Frac>()
    for (const v of varNames) vec.set(v, Frac.ZERO)
    vec.set(varNames[fc] as string, Frac.ONE)
    pivotCols.forEach((c, i) => {
      const row = rows[i] as Row
      vec.set(varNames[c] as string, (row.coef[fc] as Frac).neg())
    })
    basis.push({ param: varNames[fc] as string, vec })
  }

  return {
    kind: 'infinite',
    varNames,
    particular,
    basis,
    freeVars: freeCols.map((c) => varNames[c] as string),
    rows: rows.length,
    cols: varNames.length,
  }
}

/** 秩与未知数个数，用于向用户解释「为什么有无穷多解」。 */
export function describeRank(res: LinearSystemResult): string {
  if (res.kind === 'infeasible') return res.reason ?? '方程组无解'
  const r = res.basis.length
  if (res.kind === 'unique') return `${res.rows} 个方程、${res.cols} 个未知数，恰好确定唯一解`
  return `${res.cols} 个未知数、独立方程 ${res.cols - r} 个，尚缺 ${r} 个条件，解集是 ${r} 维的（自由变量：${res.freeVars.join('、')}）`
}
