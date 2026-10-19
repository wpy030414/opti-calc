import { Frac, ceilDiv, floorDiv, zeros } from './frac'
import { ModelError } from './errors'
import { LinExpr } from './linexpr'
import { standardize, type Standardized } from './standardize'
import { solveLp } from './lp'
import type { BilinearTerm, Constraint, Model, Objective, VarDecl } from './model'

/**
 * 二次项（bilinear）的变换层。
 *
 * 把含 `x*y` / `x^2` 的模型拆成两类：
 * - **A 类**（至少一个因子是整数/二元）：可用 big-M / 二进制展开精确线性化，
 *   结果仍是精确有理数。
 * - **B 类**（两个因子都是连续变量）：替换为辅助变量 `w`，由空间分支定界
 *   （spatialbb.ts）逐节点加 McCormick 包络，得到带损失率上界的近似解。
 *
 * 本模块只做「变换」，不求解；求解仍由 `solve.ts` 编排。
 */

export interface Box {
  lo: Frac
  hi: Frac
}

/** B 类项：spatial B&B 需要为它生成 McCormick 包络。 */
export interface BTerm {
  /** 代表 `i*j` 的辅助变量名。 */
  aux: string
  i: string
  j: string
}

export interface QuadraticProgram {
  /** 变换后的模型：A 类已精确展开、B 类已替换为辅助变量，bilinear 字段已清空。 */
  model: Model
  /** 每个参与乘积变量的初始盒界（A/B 都用它做 big-M 或包络）。 */
  boxes: Map<string, Box>
  /** B 类项，交给 spatial B&B。 */
  bTerms: BTerm[]
  /** 辅助变量名（结果展示时隐藏）。 */
  internal: Set<string>
}

type PairClass = 'binary' | 'integer' | 'continuous'

function pairKey(i: string, j: string): string {
  return i <= j ? `${i}\u0000${j}` : `${j}\u0000${i}`
}

function bitLength(n: bigint): number {
  let bits = 0
  while (n > 0n) {
    n >>= 1n
    bits++
  }
  return bits
}

/** 求某变量在线性松弛上的极值；无界返回 null。 */
function probeExtreme(std: Standardized, name: string, sense: 'min' | 'max'): Frac | null {
  const sub = std.subs.get(name)
  if (!sub) return null
  const c = zeros(std.lp.n)
  const sign = sense === 'min' ? Frac.ONE : Frac.ONE.neg()
  if (sub.split) {
    c[sub.cols[0] as number] = sign
    c[sub.cols[1] as number] = sign.neg()
  } else {
    c[sub.cols[0] as number] = sign
  }
  const r = solveLp({ n: std.lp.n, A: std.lp.A, sense: std.lp.sense, b: std.lp.b, c })
  if (r.status !== 'optimal') return null
  let val = r.objective
  if (sense === 'max') val = val.neg()
  if (!sub.split) val = val.add(sub.shift)
  return val
}

/**
 * 推导参与乘积的每个变量的有限盒界。
 *
 * 优先用声明里的下/上界（整数变量收紧到整数）；缺失时对线性松弛跑 LP 反推
 * （FBBT）。仍无界则抛错并给出可操作的声明示例——绝不静默假设一个盒。
 */
export function deriveBounds(
  model: Model,
  varNames: string[],
  needed: ReadonlySet<string>,
): Map<string, Box> {
  const boxes = new Map<string, Box>()
  const std = standardize(model, varNames)

  for (const name of needed) {
    const decl = model.vars.find((v) => v.name === name)
    const isInt = decl?.kind === 'integer' || decl?.kind === 'binary'
    let lo = decl && decl.free !== true ? decl.lower : undefined
    let hi = decl?.upper
    if (decl?.kind === 'binary') {
      lo = Frac.ZERO
      hi = Frac.ONE
    }
    if (isInt) {
      if (lo) lo = Frac.fromBigInt(ceilDiv(lo.n, lo.d))
      if (hi) hi = Frac.fromBigInt(floorDiv(hi.n, hi.d))
    }
    if (lo === undefined) {
      const v = probeExtreme(std, name, 'min')
      if (v === null) {
        throw new ModelError(
          `参与乘积的变量「${name}」没有有限下界。请显式声明，如「${name} : 非负」或「${name} : 实数 >= 0」。`,
          decl?.line ?? 1,
          1,
        )
      }
      lo = v
    }
    if (hi === undefined) {
      const v = probeExtreme(std, name, 'max')
      if (v === null) {
        throw new ModelError(
          `参与乘积的变量「${name}」没有有限上界。请显式声明，如「${name} : 非负 <= 100」。`,
          decl?.line ?? 1,
          1,
        )
      }
      hi = v
    }
    if (hi.lt(lo)) {
      throw new ModelError(`变量「${name}」在乘积中的取值范围为空`, decl?.line ?? 1, 1)
    }
    boxes.set(name, { lo, hi })
  }
  return boxes
}

/** 生成一条 `w = b*y`（b 二元）的 big-M 精确线性化约束，追加到 constraints。 */
function addBigM(constraints: Constraint[], w: string, b: string, y: string, box: Box): void {
  const L = box.lo
  const U = box.hi
  const W = () => LinExpr.var(w)
  const B = () => LinExpr.var(b)
  const Y = () => LinExpr.var(y)
  constraints.push({
    left: W().sub(B().scale(U)),
    op: '<=',
    right: LinExpr.const(Frac.ZERO),
    line: 0,
  })
  constraints.push({
    left: W().sub(B().scale(L)),
    op: '>=',
    right: LinExpr.const(Frac.ZERO),
    line: 0,
  })
  constraints.push({
    left: W().sub(Y()).sub(B().scale(L)),
    op: '<=',
    right: LinExpr.const(L.neg()),
    line: 0,
  })
  constraints.push({
    left: W().sub(Y()).sub(B().scale(U)),
    op: '>=',
    right: LinExpr.const(U.neg()),
    line: 0,
  })
}

/**
 * 把含 bilinear 的模型变换为 QuadraticProgram。
 *
 * 步骤：收集去重后的 (i,j) 对并分类 → 推导盒界 → 为每对生成辅助变量与
 * 精确/近似链接约束 → 把原约束与目标里的 bilinear 项替换为 `coef * aux`。
 */
export function buildQuadraticProgram(
  model: Model,
  varNames: string[],
  allowInteger: boolean,
): QuadraticProgram {
  const kindOf = (name: string): string => {
    const decl = model.vars.find((v) => v.name === name)
    return decl?.kind ?? 'real'
  }

  // 1. 收集去重后的 (i,j) 对，并分类
  const pairs = new Map<string, { i: string; j: string; cls: PairClass }>()
  const allTerms: BilinearTerm[] = []
  for (const c of model.constraints) {
    for (const t of c.bilinear ?? []) allTerms.push(t)
  }
  for (const t of model.objective?.bilinear ?? []) allTerms.push(t)

  for (const t of allTerms) {
    const key = pairKey(t.i, t.j)
    if (pairs.has(key)) continue
    const ki = kindOf(t.i)
    const kj = kindOf(t.j)
    const iInt = ki === 'integer' || ki === 'binary'
    const jInt = kj === 'integer' || kj === 'binary'
    const iBin = ki === 'binary'
    const jBin = kj === 'binary'
    let cls: PairClass
    if (!allowInteger) cls = 'continuous'
    else if (iBin || jBin) cls = 'binary'
    else if (iInt || jInt) cls = 'integer'
    else cls = 'continuous'
    pairs.set(key, { i: t.i, j: t.j, cls })
  }

  // B 类（连续 × 连续）是非凸的，需要目标函数来界定「损失率」；
  // 无目标的可行性问题收敛性不可靠，明确拒绝而不是给一个没有保证的点。
  const hasContinuousPair = [...pairs.values()].some((p) => p.cls === 'continuous')
  if (hasContinuousPair && !model.objective) {
    throw new ModelError(
      '连续变量相乘目前只支持带目标函数的优化模型（需要目标函数来界定损失率）。' +
        '请补一条 max/min 目标；或把相乘的因子声明为整数，使其可精确线性化。',
      1,
      1,
    )
  }

  // 2. 需要盒界的变量：所有乘积因子
  const needed = new Set<string>()
  for (const p of pairs.values()) {
    needed.add(p.i)
    needed.add(p.j)
  }
  const boxes = deriveBounds(model, varNames, needed)

  // 参与 B 类项、且是连续变量的因子 → 基础标准形里剥掉声明边界，改由空间 B&B 逐节点加盒
  const strip = new Set<string>()
  for (const p of pairs.values()) {
    if (p.cls !== 'continuous') continue
    if (kindOf(p.i) === 'real') strip.add(p.i)
    if (kindOf(p.j) === 'real') strip.add(p.j)
  }

  // 3. 生成辅助变量名（不与任何已有变量/常量冲突）
  const used = new Set<string>([...varNames, ...model.constants.keys()])
  let seq = 0
  const fresh = (): string => {
    for (;;) {
      const name = `__q${seq++}`
      if (!used.has(name)) {
        used.add(name)
        return name
      }
    }
  }

  const auxOf = new Map<string, string>()
  const internal = new Set<string>()
  const newVars: VarDecl[] = []
  const linkConstraints: Constraint[] = []
  const bTerms: BTerm[] = []

  // 复制原始变量；strip 集合里的连续变量改为 free（无下界），由空间 B&B 加盒
  for (const v of model.vars) {
    if (strip.has(v.name)) {
      newVars.push({ name: v.name, kind: 'real', free: true, line: v.line })
    } else {
      newVars.push({ ...v })
    }
  }

  const addFreeVar = (name: string): void => {
    newVars.push({ name, kind: 'real', free: true, line: 0 })
    internal.add(name)
  }
  const addBinaryVar = (name: string): void => {
    newVars.push({ name, kind: 'binary', lower: Frac.ZERO, upper: Frac.ONE, line: 0 })
    internal.add(name)
  }

  // 4. 为每对生成链接
  for (const p of pairs.values()) {
    const aux = fresh()
    auxOf.set(pairKey(p.i, p.j), aux)
    addFreeVar(aux)

    if (p.cls === 'binary') {
      // 选二元因子做 b，另一个做 y
      const iBin = kindOf(p.i) === 'binary'
      const b = iBin ? p.i : p.j
      const y = iBin ? p.j : p.i
      addBigM(linkConstraints, aux, b, y, boxes.get(y) as Box)
    } else if (p.cls === 'integer') {
      // 二进制展开整数因子 x，每个 bit 一个 b_k * y 的 big-M
      const iInt = kindOf(p.i) === 'integer'
      const x = iInt ? p.i : p.j
      const y = iInt ? p.j : p.i
      const xb = boxes.get(x) as Box
      const yb = boxes.get(y) as Box
      const L = xb.lo
      const U = xb.hi
      const r = U.sub(L) // 非负整数
      const bits = bitLength(r.n)

      const bVars: string[] = []
      const wVars: string[] = []
      for (let k = 0; k < bits; k++) {
        const bk = fresh()
        const wk = fresh()
        addBinaryVar(bk)
        addFreeVar(wk)
        bVars.push(bk)
        wVars.push(wk)
        addBigM(linkConstraints, wk, bk, y, yb)
      }

      // 链接：x = L + Σ 2^k b_k
      let rhs = LinExpr.const(L)
      for (let k = 0; k < bits; k++) {
        rhs = rhs.add(LinExpr.var(bVars[k] as string).scale(Frac.fromBigInt(1n << BigInt(k))))
      }
      linkConstraints.push({ left: LinExpr.var(x), op: '=', right: rhs, line: 0 })

      // Σ 2^k b_k <= r
      let sumB = LinExpr.zero()
      for (let k = 0; k < bits; k++) {
        sumB = sumB.add(LinExpr.var(bVars[k] as string).scale(Frac.fromBigInt(1n << BigInt(k))))
      }
      if (bits > 0) {
        linkConstraints.push({ left: sumB, op: '<=', right: LinExpr.const(r), line: 0 })
      }

      // w = L*y + Σ 2^k w_k
      let wRhs = LinExpr.var(y).scale(L)
      for (let k = 0; k < bits; k++) {
        wRhs = wRhs.add(LinExpr.var(wVars[k] as string).scale(Frac.fromBigInt(1n << BigInt(k))))
      }
      linkConstraints.push({ left: LinExpr.var(aux), op: '=', right: wRhs, line: 0 })
    } else {
      // B 类：只登记，链接由空间 B&B 逐节点生成
      bTerms.push({ aux, i: p.i, j: p.j })
    }
  }

  // 5. 替换原约束与目标里的 bilinear 项为 coef * aux
  const replaceIn = (lin: LinExpr, terms: BilinearTerm[] | undefined): LinExpr => {
    let out = lin
    for (const t of terms ?? []) {
      const aux = auxOf.get(pairKey(t.i, t.j))
      if (!aux) throw new ModelError(`内部错误：缺少 (${t.i}, ${t.j}) 的辅助变量`, 0, 1)
      out = out.add(LinExpr.var(aux).scale(t.coef))
    }
    return out
  }

  const newConstraints: Constraint[] = model.constraints.map((c) => ({
    name: c.name,
    left: replaceIn(c.left, c.bilinear),
    op: c.op,
    right: c.right,
    line: c.line,
  }))
  newConstraints.push(...linkConstraints)

  let newObjective: Objective | undefined
  if (model.objective) {
    newObjective = {
      sense: model.objective.sense,
      expr: replaceIn(model.objective.expr, model.objective.bilinear),
      line: model.objective.line,
    }
  }

  return {
    model: {
      vars: newVars,
      constants: model.constants,
      constraints: newConstraints,
      objective: newObjective,
    },
    boxes,
    bTerms,
    internal,
  }
}
