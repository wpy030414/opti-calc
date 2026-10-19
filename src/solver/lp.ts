import { Frac, zeros } from './frac'
import { SolverError } from './errors'

/**
 * 单纯形法（两阶段，精确有理数）。
 *
 * 求解标准形式：
 *
 * ```
 * min  cᵀx
 * s.t. A x {<=, =, >=} b
 *      x >= 0
 * ```
 *
 * 实现要点：
 * - **两阶段法**：第一阶段用人工变量找初始可行基；最小值 > 0 即原问题不可行。
 *   比 Big-M 更适合精确算术——Big-M 的 M 无论取多大都会污染判据，而两阶段没有这种妥协。
 * - **Bland 规则**：进基取最小下标的负检验数，出基在最小比值并列时取基变量下标最小者。
 *   该规则可证明不会循环，因此不需要退化扰动这种启发式补丁。
 * - 主元选取优先绝对值最小者，抑制 BigInt 位数膨胀。
 */

export type RelSense = 'le' | 'eq' | 'ge'

export interface LpStandard {
  /** 结构变量个数（已完成自由变量拆分与下界平移，全部 >= 0）。 */
  n: number
  /** m × n 系数矩阵。 */
  A: Frac[][]
  sense: RelSense[]
  b: Frac[]
  /** 目标系数；求解器统一按 min 处理。 */
  c: Frac[]
}

export type LpStatus = 'optimal' | 'infeasible' | 'unbounded' | 'degenerate'

export interface LpResult {
  status: LpStatus
  /** 结构变量取值（仅 optimal 有意义）。 */
  x: Frac[]
  /** cᵀx（仅 optimal 有意义）。 */
  objective: Frac
  reason?: string
}

interface Tableau {
  m: number
  /** 约束行数。 */
  ncols: number
  /** 约束列 + 人工列总数（不含 rhs）。 */
  rows: Frac[][]
  /** m × (ncols + 1)，最后一列为 rhs。 */
  basis: number[]
  /** 每行的基变量列下标。 */
  objRow: Frac[]
  /** 长度 ncols + 1，存检验数与 -z。 */
}

function at(row: Frac[], j: number): Frac {
  const v = row[j]
  if (v === undefined) throw new SolverError(`内部错误：矩阵越界访问列 ${j}`)
  return v
}

function rowAt(rows: Frac[][], i: number): Frac[] {
  const r = rows[i]
  if (r === undefined) throw new SolverError(`内部错误：矩阵越界访问行 ${i}`)
  return r
}

/**
 * 读取某行的基变量列下标。
 *
 * 表长与行数始终同步（每行都 push 过一次），因此越界只可能是实现 bug。
 * 单独立一个函数是为了让 `noUncheckedIndexedAccess` 下的调用点保持整洁，
 * 而不是散落一堆非空断言。
 */
function basisAt(basis: number[], i: number): number {
  const v = basis[i]
  if (v === undefined) throw new SolverError(`内部错误：基变量表越界访问行 ${i}`)
  return v
}

export function solveLp(p: LpStandard): LpResult {
  const m = p.A.length
  // 先把 b 规整为非负：整行取反并翻转不等号方向
  const A: Frac[][] = []
  const sense: RelSense[] = []
  const b: Frac[] = []
  for (let i = 0; i < m; i++) {
    const bi = p.b[i] ?? Frac.ZERO
    const row = rowAt(p.A, i).slice(0, p.n)
    if (bi.isNegative) {
      A.push(row.map((v) => v.neg()))
      b.push(bi.neg())
      const s = p.sense[i] ?? 'eq'
      sense.push(s === 'le' ? 'ge' : s === 'ge' ? 'le' : 'eq')
    } else {
      A.push(row)
      b.push(bi)
      sense.push(p.sense[i] ?? 'eq')
    }
  }

  // 列布局：结构变量 | 松弛/剩余 | 人工
  const needSlack = (s: RelSense): boolean => s !== 'eq'
  const needArtificial = (s: RelSense): boolean => s !== 'le'
  const nSlack = sense.filter(needSlack).length
  const nArt = sense.filter(needArtificial).length
  const ncols = p.n + nSlack + nArt
  const artStart = p.n + nSlack

  const rows: Frac[][] = []
  const basis: number[] = []
  let slackIdx = p.n
  let artIdx = artStart

  for (let i = 0; i < m; i++) {
    const row = zeros(ncols + 1)
    const src = rowAt(A, i)
    for (let j = 0; j < p.n; j++) row[j] = at(src, j)
    const s = sense[i] as RelSense
    let basic = -1
    if (needSlack(s)) {
      row[slackIdx] = s === 'le' ? Frac.ONE : Frac.ONE.neg()
      if (s === 'le') basic = slackIdx
      slackIdx++
    }
    if (needArtificial(s)) {
      row[artIdx] = Frac.ONE
      basic = artIdx
      artIdx++
    }
    row[ncols] = b[i] ?? Frac.ZERO
    rows.push(row)
    basis.push(basic)
  }

  // 没有人工变量的行必须有基变量；否则该行为 0 = b，已在规整阶段保证 b>=0
  for (let i = 0; i < m; i++) {
    if (basisAt(basis, i) < 0) {
      // 纯等式行不会走到这里；'ge' 行有人工变量；'le' 行有松弛变量
      throw new SolverError(`内部错误：第 ${i} 行无法确定初始基变量`)
    }
  }

  const t: Tableau = { m, ncols, rows, basis, objRow: zeros(ncols + 1) }

  // ---- 第一阶段：min Σ 人工变量 ----
  const phase1Cost = zeros(ncols)
  for (let j = artStart; j < ncols; j++) phase1Cost[j] = Frac.ONE
  computeObjRow(t, phase1Cost)

  const itLimit = 400 * (m + ncols + 1)
  const r1 = simplex(t, phase1Cost, itLimit)
  if (r1 === 'degenerate') {
    return { status: 'degenerate', x: [], objective: Frac.ZERO, reason: '第一阶段迭代次数超出上限' }
  }

  const phase1Obj = t.objRow[ncols]?.neg() ?? Frac.ZERO
  if (phase1Obj.gt(Frac.ZERO)) {
    return {
      status: 'infeasible',
      x: [],
      objective: Frac.ZERO,
      reason: '约束互相矛盾，不存在可行解',
    }
  }

  // 把仍在基中的人工变量（值必为 0）换出，避免污染第二阶段
  for (let i = 0; i < m; i++) {
    if (basisAt(basis, i) < artStart) continue
    let pivotCol = -1
    const row = rowAt(t.rows, i)
    for (let j = 0; j < artStart; j++) {
      if (!at(row, j).isZero) {
        pivotCol = j
        break
      }
    }
    if (pivotCol >= 0) {
      doPivot(t, i, pivotCol)
    } else {
      // 整行全 0：冗余约束，标记为不可进基（保持原样即可，第二阶段不会用到它）
      basis[i] = -1
    }
  }

  // ---- 第二阶段：min 原目标，人工变量禁止进基 ----
  const phase2Cost = zeros(ncols)
  for (let j = 0; j < p.n; j++) phase2Cost[j] = p.c[j] ?? Frac.ZERO
  computeObjRow(t, phase2Cost)

  const r2 = simplex(t, phase2Cost, itLimit, artStart)
  if (r2 === 'degenerate') {
    return { status: 'degenerate', x: [], objective: Frac.ZERO, reason: '第二阶段迭代次数超出上限' }
  }
  if (r2 === 'unbounded') {
    return { status: 'unbounded', x: [], objective: Frac.ZERO, reason: '目标函数无界' }
  }

  const x = zeros(p.n)
  for (let i = 0; i < m; i++) {
    const bi = basisAt(t.basis, i)
    if (bi >= 0 && bi < p.n) x[bi] = at(rowAt(t.rows, i), t.ncols)
  }
  const objective = t.objRow[ncols]?.neg() ?? Frac.ZERO
  return { status: 'optimal', x, objective }
}

/**
 * 用给定成本重建检验数行。
 *
 * 约定：`objRow[j] = c_j - c_Bᵀ B⁻¹ A_j`（即检验数 d_j），`objRow[rhs] = -z`。
 * 最小化问题的最优判据是所有可进基列满足 d_j >= 0。
 */
function computeObjRow(t: Tableau, costs: Frac[]): void {
  const obj = t.objRow
  for (let j = 0; j <= t.ncols; j++) obj[j] = costs[j] ?? Frac.ZERO
  for (let i = 0; i < t.m; i++) {
    const bi = basisAt(t.basis, i)
    if (bi < 0) continue
    const cb = costs[bi] ?? Frac.ZERO
    if (cb.isZero) continue
    const row = rowAt(t.rows, i)
    for (let j = 0; j <= t.ncols; j++) {
      obj[j] = at(obj, j).sub(cb.mul(at(row, j)))
    }
  }
}

/**
 * 单纯形主循环。返回 'optimal' | 'unbounded' | 'degenerate'。
 *
 * @param blockFrom 该列下标起禁止进基（第二阶段用来屏蔽人工变量）。
 */
function simplex(
  t: Tableau,
  costs: Frac[],
  itLimit: number,
  blockFrom = Infinity,
): 'optimal' | 'unbounded' | 'degenerate' {
  let it = 0
  for (;;) {
    if (++it > itLimit) return 'degenerate'

    // Bland 进基规则：最小下标的负检验数
    let enter = -1
    for (let j = 0; j < t.ncols && j < blockFrom; j++) {
      if (at(t.objRow, j).lt(Frac.ZERO)) {
        enter = j
        break
      }
    }
    if (enter < 0) return 'optimal'

    // 最小比值检验
    let leave = -1
    let bestTheta: Frac | null = null
    let bestBasis = -1
    for (let i = 0; i < t.m; i++) {
      const row = rowAt(t.rows, i)
      const a = at(row, enter)
      if (!a.gt(Frac.ZERO)) continue
      const theta = at(row, t.ncols).div(a)
      const bi = basisAt(t.basis, i)
      if (bestTheta === null || theta.lt(bestTheta)) {
        bestTheta = theta
        bestBasis = bi
        leave = i
      } else if (theta.eq(bestTheta) && bi >= 0 && (bestBasis < 0 || bi < bestBasis)) {
        // Bland 出基规则：比值并列时取基变量下标最小者，保证不会循环
        bestBasis = bi
        leave = i
      }
    }
    if (leave < 0) return 'unbounded'

    doPivot(t, leave, enter)
  }
}

/** 以 (r, c) 为主元做枢轴变换，同步更新检验数行。 */
function doPivot(t: Tableau, r: number, c: number): void {
  const row = rowAt(t.rows, r)
  const pv = at(row, c)
  if (pv.isZero) throw new SolverError('内部错误：主元为 0')
  if (!pv.eq(Frac.ONE)) {
    const inv = pv.inv()
    for (let j = 0; j <= t.ncols; j++) row[j] = at(row, j).mul(inv)
  }
  const pr = rowAt(t.rows, r)
  for (let i = 0; i < t.m; i++) {
    if (i === r) continue
    const cur = rowAt(t.rows, i)
    const f = at(cur, c)
    if (f.isZero) continue
    for (let j = 0; j <= t.ncols; j++) {
      cur[j] = at(cur, j).sub(f.mul(at(pr, j)))
    }
  }
  const fo = at(t.objRow, c)
  if (!fo.isZero) {
    for (let j = 0; j <= t.ncols; j++) {
      t.objRow[j] = at(t.objRow, j).sub(fo.mul(at(pr, j)))
    }
  }
  t.basis[r] = c
}
