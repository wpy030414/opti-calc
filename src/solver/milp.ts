import { Frac, ceilDiv, floorDiv, zeros } from './frac'
import { solveLp, type LpStandard, type LpResult } from './lp'
import type { Standardized } from './standardize'

/**
 * 混合整数线性规划（MILP）求解：分支定界。
 *
 * 算法：
 * 1. 先解 LP 松弛。若松弛不可行 → 原问题不可行。
 * 2. 在松弛解中找第一个取非整数值的整数变量，分支为 `x <= ⌊v⌋` 与 `x >= ⌈v⌉` 两个子问题。
 * 3. 深度优先搜索。用当前最优目标值作上界剪枝（min 问题下，子问题 LP 值 >= 已知最优即剪掉）。
 *
 * 为什么用深度优先而不是最优优先（best-first）：
 * 日常算账场景的整数变量通常是个位数规模，深度优先能尽早拿到一个可行整数解从而收紧界，
 * 且内存占用恒定；最优优先要维护优先队列，在浏览器里更容易吃内存。
 *
 * 全精确算术：分支界 ⌊v⌋ / ⌈v⌉ 用 BigInt 整数除法，剪枝比较用有理数精确比较，
 * 因此不存在「0.9999999 被误判为整数」这类浮点陷阱。
 */

export interface MilpResult {
  status: 'optimal' | 'infeasible' | 'unbounded' | 'degenerate'
  /** 标准形下的最优解。 */
  x: Frac[]
  /** 标准形目标值（已含 minimize 翻转，未加 objectiveConst）。 */
  objective: Frac
  /** 搜索节点数，用于展示求解代价。 */
  nodes: number
  reason?: string
}

/** 一条分支产生的额外约束：Σ coef·x {<=,>=} rhs。 */
interface BranchCut {
  coef: Frac[]
  sense: 'le' | 'ge'
  rhs: Frac
}

/** 搜索栈节点。 */
interface Node {
  cuts: BranchCut[]
}

const MAX_NODES = 200_000

export function solveMilp(std: Standardized, allowInteger: boolean): MilpResult {
  const { lp, integerIdx, varNames, subs, ncols } = std

  if (!allowInteger || integerIdx.size === 0) {
    const r = solveLp(lp)
    return { status: r.status, x: r.x, objective: r.objective, nodes: 1, reason: r.reason }
  }

  let best: { x: Frac[]; obj: Frac } | null = null
  let nodes = 0

  const stack: Node[] = [{ cuts: [] }]

  while (stack.length > 0) {
    const node = stack.pop() as Node
    if (++nodes > MAX_NODES) {
      return {
        status: 'degenerate',
        x: best?.x ?? [],
        objective: best?.obj ?? Frac.ZERO,
        nodes,
        reason: `分支定界节点数超过 ${MAX_NODES}，问题规模过大。可尝试收紧变量上界或减少整数变量。`,
      }
    }

    const sub = applyCuts(lp, node.cuts)
    const r: LpResult = solveLp(sub)

    if (r.status === 'infeasible') continue
    if (r.status === 'degenerate') {
      return { status: 'degenerate', x: [], objective: Frac.ZERO, nodes, reason: r.reason }
    }
    if (r.status === 'unbounded') {
      // 无 cuts 时的无界即原问题无界；有 cuts 时理论上不会出现
      if (node.cuts.length === 0) {
        return { status: 'unbounded', x: [], objective: Frac.ZERO, nodes, reason: r.reason }
      }
      continue
    }

    // 剪枝：LP 松弛值不优于已知最优
    if (best !== null && r.objective.ge(best.obj)) continue

    // 找第一个非整数的整数变量（按原始变量遍历，自由变量取 x⁺ - x⁻ 的值）
    const fracVar = pickFractionalInteger(r.x, varNames, subs, integerIdx)
    if (fracVar === null) {
      best = { x: r.x.slice(), obj: r.objective }
      continue
    }

    const { idx, value } = fracVar
    const sub0 = subs.get(varNames[idx] as string)
    if (!sub0) continue

    const lo = Frac.fromBigInt(floorDiv(value.n, value.d))
    const hi = Frac.fromBigInt(ceilDiv(value.n, value.d))

    const leCut = buildVarCut(ncols, sub0.cols, sub0.split, 'le', lo)
    const geCut = buildVarCut(ncols, sub0.cols, sub0.split, 'ge', hi)

    // 深度优先：先探 >= 分支（更接近原松弛解，更容易快速找到可行整数解）
    stack.push({ cuts: [...node.cuts, leCut] })
    stack.push({ cuts: [...node.cuts, geCut] })
  }

  if (best === null) {
    return {
      status: 'infeasible',
      x: [],
      objective: Frac.ZERO,
      nodes,
      reason: '不存在满足整数约束的可行解',
    }
  }
  return { status: 'optimal', x: best.x, objective: best.obj, nodes }
}

/** 找第一个取非整数值的整数变量；全部为整数时返回 null。 */
function pickFractionalInteger(
  x: Frac[],
  varNames: string[],
  subs: Standardized['subs'],
  integerIdx: Set<number>,
): { idx: number; value: Frac } | null {
  for (const idx of integerIdx) {
    const name = varNames[idx]
    if (name === undefined) continue
    const sub = subs.get(name)
    if (!sub) continue
    const v = sub.split
      ? (x[sub.cols[0] as number] ?? Frac.ZERO).sub(x[sub.cols[1] as number] ?? Frac.ZERO)
      : (x[sub.cols[0] as number] ?? Frac.ZERO).add(sub.shift)
    if (v.d !== 1n) return { idx, value: v }
  }
  return null
}

/** 为分支变量构造标准形系数行。 */
function buildVarCut(
  ncols: number,
  cols: number[],
  split: boolean,
  sense: 'le' | 'ge',
  rhs: Frac,
): BranchCut {
  const coef = zeros(ncols)
  if (split) {
    coef[cols[0] as number] = Frac.ONE
    coef[cols[1] as number] = Frac.ONE.neg()
  } else {
    coef[cols[0] as number] = Frac.ONE
  }
  return { coef, sense, rhs }
}

/** 把分支约束追加到 LP 标准形上，返回新的问题实例（不修改原对象）。 */
function applyCuts(lp: LpStandard, cuts: BranchCut[]): LpStandard {
  if (cuts.length === 0) return lp
  const A = lp.A.map((row) => row.slice())
  const b = lp.b.slice()
  const sense = lp.sense.slice()
  for (const cut of cuts) {
    A.push(cut.coef.slice())
    b.push(cut.rhs)
    sense.push(cut.sense)
  }
  return { n: lp.n, A, sense, b, c: lp.c.slice() }
}

export { MAX_NODES }
