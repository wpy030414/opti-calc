import { Frac, ceilDiv, floorDiv, zeros } from './frac'
import { solveLp, type LpStandard } from './lp'
import { denormalize, type Standardized } from './standardize'
import { buildVarCut, pickFractionalInteger, type BranchCut } from './milp'
import type { Box, BTerm } from './bilinear'

/**
 * 空间分支定界（spatial branch-and-bound），用于「连续 × 连续」的二次项。
 *
 * 思路：
 * - 每个节点把每个 B 类项用 **McCormick 包络**（4 条线性约束）放松后解 LP；
 *   包络是原非凸问题的凸放松，因此 LP 值是该节点区域内的**下界**（按 min 方向）。
 * - 维护 incumbent（已找到的可行解，上界）与开放节点的最小松弛值（下界），
 *   二者之差就是**损失率的可证明上界**（optimality gap）。
 * - 分支：优先整性分支（A 类二进制展开产生的 b_k），否则选包络违背最大的
 *   B 类项，在其因子上二分盒。
 *
 * 与 milp.ts 一致，全程使用精确有理数与明确节点上限——超出上限时如实报告
 * 当前 gap，绝不把近似值伪装成精确最优。
 *
 * 搜索策略用 best-first（按松弛值最小优先），因为 gap 需要「开放节点最小下界」；
 * 代价是维护一个优先队列，仅在少量二次项的场景下使用。
 */

const MAX_SPATIAL_NODES = 10_000
/**
 * 时间预算（毫秒）。空间分支定界在病态/不可行例子上可能迟迟无法收敛，
 * 用墙钟预算兜底，避免同步求解把浏览器主线程卡死。
 * 这是控制流预算，不参与任何数值计算。
 */
const TIME_BUDGET_MS = 3_000

export interface SpatialBBResult {
  status: 'optimal' | 'infeasible' | 'unbounded' | 'degenerate'
  /** 标准形下的 incumbent 解。 */
  x: Frac[]
  /** min 方向的目标值（已含 max 翻转，未加 objectiveConst）。 */
  objective: Frac
  /** 相对损失率上界；infeasible/unbounded 时无意义。 */
  relativeGap?: Frac
  nodes: number
  reason?: string
}

interface SNode {
  /** B 类因子变量的当前盒界。 */
  box: Map<string, Box>
  /** 整性分支累积的线性切。 */
  intCuts: BranchCut[]
}

/** 当前最优可行解（按 min 方向）。 */
type Incumbent = { x: Frac[]; obj: Frac }

interface HeapItem {
  bound: Frac
  node: SNode
}

/** 以 Frac 为键的最小堆。 */
class MinHeap {
  private a: HeapItem[] = []

  get size(): number {
    return this.a.length
  }

  peek(): HeapItem | undefined {
    return this.a[0]
  }

  push(item: HeapItem): void {
    this.a.push(item)
    let i = this.a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if ((this.a[p] as HeapItem).bound.le((this.a[i] as HeapItem).bound)) break
      const t = this.a[p] as HeapItem
      this.a[p] = this.a[i] as HeapItem
      this.a[i] = t
      i = p
    }
  }

  pop(): HeapItem | undefined {
    const top = this.a[0]
    const last = this.a.pop()
    if (this.a.length > 0 && last !== undefined) {
      this.a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < this.a.length && (this.a[l] as HeapItem).bound.lt((this.a[m] as HeapItem).bound))
          m = l
        if (r < this.a.length && (this.a[r] as HeapItem).bound.lt((this.a[m] as HeapItem).bound))
          m = r
        if (m === i) break
        const t = this.a[i] as HeapItem
        this.a[i] = this.a[m] as HeapItem
        this.a[m] = t
        i = m
      }
    }
    return top
  }
}

/** 变量在标准形里的系数行（按原始坐标）。B 类变量已拆分，shift 为 0。 */
function varCoef(name: string, std: Standardized, sign: Frac): Frac[] {
  const sub = std.subs.get(name)
  if (!sub) throw new Error(`内部错误：变量 ${name} 缺少标准化映射`)
  const coef = zeros(std.ncols)
  if (sub.split) {
    coef[sub.cols[0] as number] = (coef[sub.cols[0] as number] as Frac).add(sign)
    coef[sub.cols[1] as number] = (coef[sub.cols[1] as number] as Frac).sub(sign)
  } else {
    coef[sub.cols[0] as number] = (coef[sub.cols[0] as number] as Frac).add(sign)
  }
  return coef
}

function addScaled(dst: Frac[], src: Frac[], k: Frac): void {
  if (k.isZero) return
  for (let j = 0; j < dst.length; j++) {
    dst[j] = (dst[j] as Frac).add((src[j] as Frac).mul(k))
  }
}

/** 构造某节点完整的 LP：基础行 + 盒界行 + McCormick 包络 + 整性切。 */
function buildNodeLp(std: Standardized, node: SNode, bTerms: BTerm[]): LpStandard {
  const A = std.lp.A.map((r) => r.slice())
  const b = std.lp.b.slice()
  const sense = std.lp.sense.slice()
  const push = (coef: Frac[], s: 'le' | 'ge', rhs: Frac): void => {
    A.push(coef)
    b.push(rhs)
    sense.push(s)
  }

  // 盒界：x >= lo, x <= hi（B 类因子均为 free/split，无平移）
  for (const [name, box] of node.box) {
    const c = varCoef(name, std, Frac.ONE)
    push(c.slice(), 'ge', box.lo)
    push(c.slice(), 'le', box.hi)
  }

  // McCormick 包络
  for (const t of bTerms) {
    const bi = node.box.get(t.i)
    const bj = node.box.get(t.j)
    if (!bi || !bj) throw new Error(`内部错误：B 类项 (${t.i}, ${t.j}) 缺少盒界`)
    const ci = varCoef(t.i, std, Frac.ONE)
    const cj = varCoef(t.j, std, Frac.ONE)
    const cw = varCoef(t.aux, std, Frac.ONE)
    const { lo: Li, hi: Ui } = bi
    const { lo: Lj, hi: Uj } = bj

    // w >= Li*j + Lj*i - Li*Lj
    const r1 = cw.slice()
    addScaled(r1, cj, Li.neg())
    addScaled(r1, ci, Lj.neg())
    push(r1, 'ge', Li.mul(Lj).neg())

    // w >= Ui*j + Uj*i - Ui*Uj
    const r2 = cw.slice()
    addScaled(r2, cj, Ui.neg())
    addScaled(r2, ci, Uj.neg())
    push(r2, 'ge', Ui.mul(Uj).neg())

    // w <= Ui*j + Lj*i - Ui*Lj
    const r3 = cw.slice()
    addScaled(r3, cj, Ui.neg())
    addScaled(r3, ci, Lj.neg())
    push(r3, 'le', Ui.mul(Lj).neg())

    // w <= Li*j + Uj*i - Li*Uj
    const r4 = cw.slice()
    addScaled(r4, cj, Li.neg())
    addScaled(r4, ci, Uj.neg())
    push(r4, 'le', Li.mul(Uj).neg())
  }

  // 整性分支切
  for (const cut of node.intCuts) {
    push(cut.coef.slice(), cut.sense, cut.rhs)
  }

  return { n: std.lp.n, A, b, sense, c: std.lp.c.slice() }
}

/** 二分盒；优先在给定解值处切，若贴边则取中点。 */
function splitBox(box: Box, at: Frac | undefined): [Box, Box] {
  let mid = at
  if (mid === undefined || !mid.gt(box.lo) || !mid.lt(box.hi)) {
    mid = box.lo.add(box.hi).div(Frac.fromBigInt(2n))
  }
  return [
    { lo: box.lo, hi: mid },
    { lo: mid, hi: box.hi },
  ]
}

/** 找包络违背最大的 B 类项，并选出要分支的因子（盒更宽者）。 */
function pickWorstTerm(
  bTerms: BTerm[],
  values: ReadonlyMap<string, Frac>,
  boxes: Map<string, Box>,
): { term: BTerm; varName: string } | null {
  let best: { term: BTerm; varName: string; viol: Frac } | null = null
  for (const t of bTerms) {
    const w = values.get(t.aux) ?? Frac.ZERO
    const iv = values.get(t.i) ?? Frac.ZERO
    const jv = values.get(t.j) ?? Frac.ZERO
    const viol = w.sub(iv.mul(jv)).abs()
    if (viol.isZero) continue
    const bi = boxes.get(t.i)
    const bj = boxes.get(t.j)
    if (!bi || !bj) continue
    const wi = bi.hi.sub(bi.lo)
    const wj = bj.hi.sub(bj.lo)
    const varName = wi.ge(wj) ? t.i : t.j
    if (best === null || viol.gt(best.viol)) best = { term: t, varName, viol }
  }
  return best ? { term: best.term, varName: best.varName } : null
}

export function solveSpatialBb(
  std: Standardized,
  bTerms: BTerm[],
  initialBoxes: Map<string, Box>,
  allowInteger: boolean,
  gapTolerance: Frac,
): SpatialBBResult {
  const { varNames, subs, ncols, integerIdx } = std

  const bVars = new Set<string>()
  for (const t of bTerms) {
    bVars.add(t.i)
    bVars.add(t.j)
  }
  const rootBox = new Map<string, Box>()
  for (const name of bVars) {
    const box = initialBoxes.get(name)
    if (!box) throw new Error(`内部错误：变量 ${name} 缺少盒界`)
    rootBox.set(name, box)
  }

  let incumbent: Incumbent | null = null
  let nodes = 0
  let stopReason: 'limit' | 'degenerate' | 'unbounded' | null = null
  let degenerateReason: string | undefined
  const startedAt = Date.now()
  const heap = new MinHeap()

  // 通过函数读取，绕开 TS 对「闭包内赋值」的控制流分析限制。
  const getIncumbent = (): Incumbent | null => incumbent

  const tryIncumbent = (x: Frac[], obj: Frac): void => {
    if (incumbent === null || obj.lt(incumbent.obj)) incumbent = { x: x.slice(), obj }
  }

  const lowerBound = (): Frac | null => {
    if (heap.size > 0) return (heap.peek() as HeapItem).bound
    const cur = getIncumbent()
    return cur ? cur.obj : null
  }

  /** 解一个节点并分派。返回 false 表示应当终止整个搜索。 */
  const process = (node: SNode): boolean => {
    if (nodes >= MAX_SPATIAL_NODES || Date.now() - startedAt > TIME_BUDGET_MS) {
      stopReason = 'limit'
      return false
    }
    const r = solveLp(buildNodeLp(std, node, bTerms))
    nodes++
    if (r.status === 'infeasible') return true
    if (r.status === 'degenerate') {
      stopReason = 'degenerate'
      degenerateReason = r.reason
      return false
    }
    if (r.status === 'unbounded') {
      stopReason = 'unbounded'
      return false
    }

    const obj = r.objective
    const cur = getIncumbent()
    if (cur !== null && obj.ge(cur.obj)) return true

    const values = denormalize(std, r.x)
    const fracInt = allowInteger ? pickFractionalInteger(r.x, varNames, subs, integerIdx) : null
    const productTight = bTerms.every((t) => {
      const w = values.get(t.aux) ?? Frac.ZERO
      const iv = values.get(t.i) ?? Frac.ZERO
      const jv = values.get(t.j) ?? Frac.ZERO
      return w.eq(iv.mul(jv))
    })

    if (fracInt === null && productTight) {
      tryIncumbent(r.x, obj)
      return true
    }

    // 1) 先做整性分支（A 类二进制展开要靠它保证精确）
    if (fracInt !== null) {
      const sub0 = subs.get(varNames[fracInt.idx] as string)
      if (!sub0) return true
      const lo = Frac.fromBigInt(floorDiv(fracInt.value.n, fracInt.value.d))
      const hi = Frac.fromBigInt(ceilDiv(fracInt.value.n, fracInt.value.d))
      heap.push({
        bound: obj,
        node: {
          box: node.box,
          intCuts: [...node.intCuts, buildVarCut(ncols, sub0.cols, sub0.split, 'le', lo)],
        },
      })
      heap.push({
        bound: obj,
        node: {
          box: node.box,
          intCuts: [...node.intCuts, buildVarCut(ncols, sub0.cols, sub0.split, 'ge', hi)],
        },
      })
      return true
    }

    // 2) 空间分支：选包络违背最大的项
    const worst = pickWorstTerm(bTerms, values, node.box)
    if (!worst) return true
    const box = node.box.get(worst.varName)
    if (!box) return true
    const [b1, b2] = splitBox(box, values.get(worst.varName))
    const nb1 = new Map(node.box)
    nb1.set(worst.varName, b1)
    const nb2 = new Map(node.box)
    nb2.set(worst.varName, b2)
    heap.push({ bound: obj, node: { box: nb1, intCuts: node.intCuts } })
    heap.push({ bound: obj, node: { box: nb2, intCuts: node.intCuts } })
    return true
  }

  // 根节点
  if (!process({ box: rootBox, intCuts: [] })) {
    if (getIncumbent() === null) {
      if (stopReason === 'unbounded') {
        return { status: 'unbounded', x: [], objective: Frac.ZERO, nodes, reason: '目标函数无界' }
      }
      return {
        status: 'degenerate',
        x: [],
        objective: Frac.ZERO,
        nodes,
        reason: degenerateReason ?? '求解在根节点即中止',
      }
    }
  }

  // best-first 主循环
  while (heap.size > 0 && stopReason === null) {
    const cur = getIncumbent()
    if (cur !== null && gapConverged(cur.obj, lowerBound(), gapTolerance)) break
    const item = heap.pop() as HeapItem
    if (!process(item.node)) break
  }

  const finalIncumbent = getIncumbent()
  if (finalIncumbent === null) {
    if (stopReason === 'unbounded') {
      return { status: 'unbounded', x: [], objective: Frac.ZERO, nodes, reason: '目标函数无界' }
    }
    if (stopReason !== null) {
      return {
        status: 'degenerate',
        x: [],
        objective: Frac.ZERO,
        nodes,
        reason: degenerateReason ?? `未找到可行解（节点数 ${nodes}）`,
      }
    }
    return {
      status: 'infeasible',
      x: [],
      objective: Frac.ZERO,
      nodes,
      reason: '不存在满足全部约束的可行解',
    }
  }

  const lb = lowerBound() ?? finalIncumbent.obj
  const absGap = finalIncumbent.obj.sub(lb)
  const relativeGap = relativeTo(absGap, finalIncumbent.obj)
  return {
    status: 'optimal',
    x: finalIncumbent.x,
    objective: finalIncumbent.obj,
    relativeGap,
    nodes,
    reason:
      stopReason === 'limit'
        ? `已达空间分支定界的节点/时间上限（${MAX_SPATIAL_NODES} 节点 / ${TIME_BUDGET_MS} ms），返回当前最优可行解`
        : undefined,
  }
}

function gapConverged(incumbent: Frac, lower: Frac | null, tol: Frac): boolean {
  if (lower === null) return true
  if (lower.ge(incumbent)) return true
  const gap = incumbent.sub(lower)
  return relativeTo(gap, incumbent).le(tol)
}

function relativeTo(gap: Frac, value: Frac): Frac {
  const mag = value.abs()
  if (mag.isZero) return gap.isZero ? Frac.ZERO : Frac.ONE
  return gap.div(mag)
}

export { MAX_SPATIAL_NODES }
