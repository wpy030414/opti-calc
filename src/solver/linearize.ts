import { Frac, ceilDiv, floorDiv, roundDiv } from './frac'
import { ModelError, NumericError } from './errors'
import { LinExpr } from './linexpr'
import type { Expr } from './ast'
import type { Stmt } from './parser'
import type { Constraint, Model, VarDecl, VarKind } from './model'

/**
 * 线性化。
 *
 * 把 AST 折叠为 `LinExpr`。遇到真正的非线性结构（变量乘变量、变量做除数、
 * 变量做指数、含未知量的 ceil/floor/abs/max/min）时抛 `ModelError` 并指明行号，
 * 而不是悄悄给出错误答案。常量参数上的取整函数会被折叠（`ceil(5.3)` → `6`）。
 */

/** 严格边界收紧为非严格：x > c 且 x 为整数 => x >= c + 1；实数则原样保留。 */
function tightenStrict(bound: Frac, strict: boolean, kind: VarKind, dir: 'lower' | 'upper'): Frac {
  if (!strict || kind === 'real') return bound
  return dir === 'lower' ? bound.add(Frac.ONE) : bound.sub(Frac.ONE)
}

function linearize(e: Expr, constants: ReadonlyMap<string, Frac>): LinExpr {
  switch (e.kind) {
    case 'num':
      return LinExpr.const(e.value)
    case 'var': {
      const c = constants.get(e.name)
      if (c !== undefined) return LinExpr.const(c)
      return LinExpr.var(e.name)
    }
    case 'add':
      return linearize(e.left, constants).add(linearize(e.right, constants))
    case 'sub':
      return linearize(e.left, constants).sub(linearize(e.right, constants))
    case 'neg':
      return linearize(e.arg, constants).neg()
    case 'mul': {
      const m = linearize(e.left, constants).tryMul(linearize(e.right, constants))
      if (m === null) {
        throw new ModelError(
          '非线性项：变量之间不能相乘。本求解器只处理线性模型。',
          e.pos.line,
          e.pos.col,
        )
      }
      return m
    }
    case 'div': {
      const q = linearize(e.left, constants).tryDiv(linearize(e.right, constants))
      if (q === null) {
        throw new ModelError('非线性项：除数必须是常量。', e.pos.line, e.pos.col)
      }
      return q
    }
    case 'pow': {
      const base = linearize(e.base, constants)
      const exp = linearize(e.exp, constants)
      if (!exp.isConstant) {
        throw new ModelError('非线性项：指数必须是常量。', e.pos.line, e.pos.col)
      }
      const k = exp.constant
      if (!k.isInteger) {
        throw new ModelError(
          `非线性项：指数必须是整数（实际为 ${k.toString()}）。`,
          e.pos.line,
          e.pos.col,
        )
      }
      const n = k.toBigInt()
      if (n === 0n) return LinExpr.const(Frac.ONE)
      if (n === 1n) return base
      if (n < 0n) {
        if (!base.isConstant || base.constant.isZero) {
          throw new ModelError('非线性项：负指数要求底数为非零常量。', e.pos.line, e.pos.col)
        }
        return LinExpr.const(base.constant.pow(n))
      }
      if (!base.isConstant) {
        throw new ModelError(`非线性项：变量的 ${n} 次幂不是线性表达式。`, e.pos.line, e.pos.col)
      }
      return LinExpr.const(base.constant.pow(n))
    }
    case 'call': {
      const args = e.args.map((a) => linearize(a, constants))
      for (const a of args) {
        if (!a.isConstant) {
          throw new ModelError(
            `函数 ${e.name}() 的参数含未知量，属于非线性/非凸结构。` +
              `请把它移到约束里，或先给相关变量赋值。`,
            e.pos.line,
            e.pos.col,
          )
        }
      }
      return LinExpr.const(
        applyFn(
          e.name,
          args.map((a) => a.constant),
          e.pos.line,
          e.pos.col,
        ),
      )
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
  const lin = linearize(e, constants)
  if (!lin.isConstant) {
    throw new ModelError('边界必须是常量表达式', line, 1)
  }
  return lin.constant
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
    let val: Frac
    try {
      val = linearize(s.expr, constants).constantOnly(s.line)
    } catch (err) {
      if (err instanceof ModelError || err instanceof NumericError) throw err
      throw new ModelError(`常量「${s.name}」的定义无效`, s.line, 1)
    }
    constants.set(s.name, val)
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
      constraints.push({
        name: s.name,
        left: linearize(s.left, constants),
        op: s.op,
        right: linearize(s.right, constants),
        line: s.line,
      })
    } else if (s.kind === 'objective') {
      if (objective) {
        throw new ModelError('只能有一个目标函数', s.line, 1)
      }
      objective = { sense: s.sense, expr: linearize(s.expr, constants), line: s.line }
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
  for (const v of model.vars) {
    if (!names.includes(v.name) && !model.constants.has(v.name)) names.push(v.name)
  }
  for (const c of model.constraints) {
    push(c.left)
    push(c.right)
  }
  if (model.objective) push(model.objective.expr)
  return names
}
