import { Frac, ceilDiv, floorDiv, roundDiv } from './frac'
import { ModelError, NumericError } from './errors'
import { LinExpr } from './linexpr'
import type { Expr } from './ast'
import type { Stmt } from './parser'
import type { BilinearTerm, Constraint, Model, VarDecl, VarKind } from './model'

/**
 * 线性化（含二次项）。
 *
 * 把 AST 折叠为「线性部分 `LinExpr` + 二次单项 `BilinearTerm[]`」。
 * 遇到真正的非线性结构（变量做除数、变量的 ≥3 次幂、三个以上变量相乘、
 * 含未知量的 ceil/floor/abs/max/min）时抛 `ModelError` 并指明行号，
 * 而不是悄悄给出错误答案。常量参数上的取整函数会被折叠（`ceil(5.3)` → `6`）。
 *
 * 二次项（`x*y`、`x^2`）不再拒绝，而是收集为 bilinear monomial，
 * 交由上层决定走「精确线性化」还是「近似求解」。
 */

/** 折叠结果：线性部分 + 二次单项列表。 */
interface Folded {
  linear: LinExpr
  bilinear: BilinearTerm[]
}

/** 严格边界收紧为非严格：x > c 且 x 为整数 => x >= c + 1；实数则原样保留。 */
function tightenStrict(bound: Frac, strict: boolean, kind: VarKind, dir: 'lower' | 'upper'): Frac {
  if (!strict || kind === 'real') return bound
  return dir === 'lower' ? bound.add(Frac.ONE) : bound.sub(Frac.ONE)
}

function isPureConst(f: Folded): boolean {
  return f.linear.isConstant && f.bilinear.length === 0
}

function scaleBilinear(terms: BilinearTerm[], k: Frac): BilinearTerm[] {
  if (k.isZero) return []
  return terms.map((t) => ({ coef: t.coef.mul(k), i: t.i, j: t.j }))
}

function negBilinear(terms: BilinearTerm[]): BilinearTerm[] {
  return terms.map((t) => ({ coef: t.coef.neg(), i: t.i, j: t.j }))
}

/** 合并同 (i,j) 单项（系数相加、去零、规范 i <= j）。 */
function combineBilinear(terms: BilinearTerm[]): BilinearTerm[] {
  const map = new Map<string, Frac>()
  for (const t of terms) {
    if (t.coef.isZero) continue
    const [i, j] = t.i <= t.j ? [t.i, t.j] : [t.j, t.i]
    const key = `${i}\u0000${j}`
    map.set(key, (map.get(key) ?? Frac.ZERO).add(t.coef))
  }
  const out: BilinearTerm[] = []
  for (const [key, coef] of map) {
    if (coef.isZero) continue
    const [i, j] = key.split('\u0000') as [string, string]
    out.push({ coef, i, j })
  }
  return out
}

/** 两个线性式的乘积：变量×变量 → bilinear，其余 → 线性。 */
function foldMul(a: LinExpr, b: LinExpr): Folded {
  const bilinear: BilinearTerm[] = []
  for (const [i, ci] of a.terms) {
    for (const [j, cj] of b.terms) {
      bilinear.push({ coef: ci.mul(cj), i, j })
    }
  }
  // 线性部分 = a·(b 的常数) + b·(a 的常数) − a₀b₀
  const linear = a
    .scale(b.constant)
    .add(b.scale(a.constant))
    .sub(LinExpr.const(a.constant.mul(b.constant)))
  return { linear, bilinear: combineBilinear(bilinear) }
}

function linearize(e: Expr, constants: ReadonlyMap<string, Frac>): Folded {
  switch (e.kind) {
    case 'num':
      return { linear: LinExpr.const(e.value), bilinear: [] }
    case 'var': {
      const c = constants.get(e.name)
      if (c !== undefined) return { linear: LinExpr.const(c), bilinear: [] }
      return { linear: LinExpr.var(e.name), bilinear: [] }
    }
    case 'add': {
      const l = linearize(e.left, constants)
      const r = linearize(e.right, constants)
      return {
        linear: l.linear.add(r.linear),
        bilinear: combineBilinear([...l.bilinear, ...r.bilinear]),
      }
    }
    case 'sub': {
      const l = linearize(e.left, constants)
      const r = linearize(e.right, constants)
      return {
        linear: l.linear.sub(r.linear),
        bilinear: combineBilinear([...l.bilinear, ...negBilinear(r.bilinear)]),
      }
    }
    case 'neg': {
      const a = linearize(e.arg, constants)
      return { linear: a.linear.neg(), bilinear: negBilinear(a.bilinear) }
    }
    case 'mul': {
      const left = linearize(e.left, constants)
      const right = linearize(e.right, constants)
      // 次数超过 2：一侧已含二次项，另一侧又不是纯常数
      if (left.bilinear.length > 0 && !isPureConst(right)) {
        throw new ModelError('非线性项：乘积次数超过 2（如三个变量相乘）。', e.pos.line, e.pos.col)
      }
      if (right.bilinear.length > 0 && !isPureConst(left)) {
        throw new ModelError('非线性项：乘积次数超过 2（如三个变量相乘）。', e.pos.line, e.pos.col)
      }
      // 一侧是二次式、另一侧是纯常数 → 整体缩放
      if (left.bilinear.length > 0) {
        const k = right.linear.constant
        return { linear: left.linear.scale(k), bilinear: scaleBilinear(left.bilinear, k) }
      }
      if (right.bilinear.length > 0) {
        const k = left.linear.constant
        return { linear: right.linear.scale(k), bilinear: scaleBilinear(right.bilinear, k) }
      }
      return foldMul(left.linear, right.linear)
    }
    case 'div': {
      const left = linearize(e.left, constants)
      const right = linearize(e.right, constants)
      if (right.bilinear.length > 0 || !right.linear.isConstant || right.linear.constant.isZero) {
        throw new ModelError('非线性项：除数必须是常量。', e.pos.line, e.pos.col)
      }
      const k = right.linear.constant.inv()
      return { linear: left.linear.scale(k), bilinear: scaleBilinear(left.bilinear, k) }
    }
    case 'pow': {
      const base = linearize(e.base, constants)
      const exp = linearize(e.exp, constants)
      if (exp.bilinear.length > 0 || !exp.linear.isConstant) {
        throw new ModelError('非线性项：指数必须是常量。', e.pos.line, e.pos.col)
      }
      const k = exp.linear.constant
      if (!k.isInteger) {
        throw new ModelError(
          `非线性项：指数必须是整数（实际为 ${k.toString()}）。`,
          e.pos.line,
          e.pos.col,
        )
      }
      const n = k.toBigInt()
      if (n === 0n) return { linear: LinExpr.const(Frac.ONE), bilinear: [] }
      if (n === 1n) return base
      if (n < 0n) {
        if (!isPureConst(base) || base.linear.constant.isZero) {
          throw new ModelError('非线性项：负指数要求底数为非零常量。', e.pos.line, e.pos.col)
        }
        return { linear: LinExpr.const(base.linear.constant.pow(n)), bilinear: [] }
      }
      if (base.bilinear.length > 0) {
        throw new ModelError(`非线性项：乘积的 ${n} 次幂次数超过 2。`, e.pos.line, e.pos.col)
      }
      if (base.linear.isConstant) {
        return { linear: LinExpr.const(base.linear.constant.pow(n)), bilinear: [] }
      }
      // 底数是含变量的线性式；n == 2 转为 x*x 的二次项，更高次幂拒绝
      if (n !== 2n) {
        throw new ModelError(`非线性项：变量的 ${n} 次幂不是线性表达式。`, e.pos.line, e.pos.col)
      }
      return foldMul(base.linear, base.linear)
    }
    case 'call': {
      const args = e.args.map((a) => linearize(a, constants))
      for (const a of args) {
        if (a.bilinear.length > 0 || !a.linear.isConstant) {
          throw new ModelError(
            `函数 ${e.name}() 的参数含未知量，属于非线性/非凸结构。` +
              `请把它移到约束里，或先给相关变量赋值。`,
            e.pos.line,
            e.pos.col,
          )
        }
      }
      return {
        linear: LinExpr.const(
          applyFn(
            e.name,
            args.map((a) => a.linear.constant),
            e.pos.line,
            e.pos.col,
          ),
        ),
        bilinear: [],
      }
    }
  }
}

function applyFn(name: string, args: Frac[], line: number, col: number): Frac {
  const [a = Frac.ZERO, b = Frac.ZERO] = args
  switch (name) {
    case 'ceil':
    case 'ceiling':
      return Frac.fromBigInt(ceilDiv(a.n, a.d))
    case 'floor':
      return Frac.fromBigInt(floorDiv(a.n, a.d))
    case 'round':
      return Frac.fromBigInt(roundDiv(a.n, a.d))
    case 'abs':
      return a.abs()
    case 'max':
      return a.max(b)
    case 'min':
      return a.min(b)
    default:
      throw new ModelError(`未知函数 ${name}()`, line, col)
  }
}

function evalConst(e: Expr, constants: ReadonlyMap<string, Frac>, line: number): Frac {
  const folded = linearize(e, constants)
  if (folded.bilinear.length > 0 || !folded.linear.isConstant) {
    throw new ModelError('边界必须是常量表达式', line, 1)
  }
  return folded.linear.constant
}

/**
 * 把语句 AST 组装为 Model。
 *
 * 三遍扫描：常量（按出现顺序求值，可引用更早的常量）→ 变量声明 → 约束与目标。
 * 常量必须先于使用它的语句出现。
 */
export function buildModel(stmts: Stmt[]): Model {
  const constants = new Map<string, Frac>()
  const vars: VarDecl[] = []
  const seen = new Set<string>()
  const constraints: Constraint[] = []
  let objective: Model['objective']

  // 第一遍：常量
  for (const s of stmts) {
    if (s.kind !== 'const') continue
    if (constants.has(s.name)) {
      throw new ModelError(`常量「${s.name}」重复定义`, s.line, 1)
    }
    let folded: Folded
    try {
      folded = linearize(s.expr, constants)
    } catch (err) {
      if (err instanceof ModelError || err instanceof NumericError) throw err
      throw new ModelError(`常量「${s.name}」的定义无效`, s.line, 1)
    }
    if (folded.bilinear.length > 0) {
      throw new ModelError(`常量「${s.name}」的定义不能包含变量乘积`, s.line, 1)
    }
    constants.set(s.name, folded.linear.constantOnly(s.line))
  }

  // 第二遍：变量声明
  for (const s of stmts) {
    if (s.kind !== 'var') continue
    if (seen.has(s.name)) {
      throw new ModelError(`变量「${s.name}」重复声明`, s.line, 1)
    }
    if (constants.has(s.name)) {
      throw new ModelError(`「${s.name}」既是常量又是变量`, s.line, 1)
    }
    seen.add(s.name)

    const decl: VarDecl = { name: s.name, kind: s.varKind, line: s.line }

    // 下界：显式 > 类型别名隐含（非负/正整数）> free（无下界）> 默认无下界
    if (s.lower) {
      decl.lower = tightenStrict(
        evalConst(s.lower, constants, s.line),
        s.lowerStrict === true,
        s.varKind,
        'lower',
      )
    } else if (s.implicitLower) {
      decl.lower = s.implicitLower
    } else if (s.free) {
      decl.free = true
    }

    if (s.upper) {
      decl.upper = tightenStrict(
        evalConst(s.upper, constants, s.line),
        s.upperStrict === true,
        s.varKind,
        'upper',
      )
    }

    // binary 自动收紧到 [0,1]
    if (s.varKind === 'binary') {
      decl.lower = (decl.lower ?? Frac.ZERO).max(Frac.ZERO)
      decl.upper = (decl.upper ?? Frac.ONE).min(Frac.ONE)
    }

    if (decl.lower && decl.upper && decl.upper.lt(decl.lower)) {
      throw new ModelError(
        `变量「${s.name}」的取值范围为空：下界 ${decl.lower.toString()} > 上界 ${decl.upper.toString()}`,
        s.line,
        1,
      )
    }
    vars.push(decl)
  }

  // 第三遍：约束与目标
  for (const s of stmts) {
    if (s.kind === 'constraint') {
      const l = linearize(s.left, constants)
      const r = linearize(s.right, constants)
      constraints.push({
        name: s.name,
        left: l.linear,
        op: s.op,
        right: r.linear,
        bilinear: combineBilinear([...l.bilinear, ...negBilinear(r.bilinear)]),
        line: s.line,
      })
    } else if (s.kind === 'objective') {
      if (objective) {
        throw new ModelError('只能有一个目标函数', s.line, 1)
      }
      const folded = linearize(s.expr, constants)
      objective = {
        sense: s.sense,
        expr: folded.linear,
        bilinear: folded.bilinear,
        line: s.line,
      }
    }
  }

  return { vars, constants, constraints, objective }
}

/** 收集模型中实际出现的全部变量名（声明过的排前面；常量名不算变量）。 */
export function collectVariables(model: Model): string[] {
  const names: string[] = []
  const push = (lin: LinExpr): void => {
    for (const v of lin.terms.keys()) {
      if (!names.includes(v) && !model.constants.has(v)) names.push(v)
    }
  }
  const pushBilinear = (terms: BilinearTerm[] | undefined): void => {
    for (const t of terms ?? []) {
      if (!names.includes(t.i) && !model.constants.has(t.i)) names.push(t.i)
      if (!names.includes(t.j) && !model.constants.has(t.j)) names.push(t.j)
    }
  }
  for (const v of model.vars) {
    if (!names.includes(v.name) && !model.constants.has(v.name)) names.push(v.name)
  }
  for (const c of model.constraints) {
    push(c.left)
    push(c.right)
    pushBilinear(c.bilinear)
  }
  if (model.objective) {
    push(model.objective.expr)
    pushBilinear(model.objective.bilinear)
  }
  return names
}
