import { ParseError, ModelError } from './errors'
import { Frac, normalizeWidth } from './frac'
import type { Expr, Pos, Token } from './ast'
import { tokenize, tokenToNum } from './lexer'
import type { RelOp, VarKind } from './model'

/**
 * 递归下降解析器。
 *
 * 语法（每一非空、非注释行是一条独立语句）：
 *
 * ```
 * 语句      := 变量声明 | 常量赋值 | 目标函数 | 约束
 * 变量声明  := name ":" 类型 [bounds]           # x : 非负整数 <= 40
 * 常量赋值  := name ":=" 表达式                 # 单价 := 34 / 10
 * 目标函数  := ("max"|"min") 表达式             # max 收益
 * 约束      := [label ":"] 表达式 比较符 表达式  # 预算 : 3*x + 2*y <= 100
 * ```
 *
 * 表达式支持 `+ - * / ^`、括号、隐式乘法（`2x`、`3(a+b)`）、
 * 取整函数 `ceil/floor/round/abs/max/min`（参数须为常量）。
 */

/** 单条语句的 AST（尚未线性化）。 */
export type Stmt =
  | {
      kind: 'var'
      name: string
      varKind: VarKind
      /** 类型别名自带的隐式下界（如「非负整数」→ 0）；显式 bounds 优先。 */
      implicitLower?: Frac
      free?: boolean
      lower?: Expr
      upper?: Expr
      lowerStrict?: boolean
      upperStrict?: boolean
      line: number
    }
  | { kind: 'const'; name: string; expr: Expr; line: number }
  | { kind: 'objective'; sense: 'max' | 'min'; expr: Expr; line: number }
  | { kind: 'constraint'; name?: string; left: Expr; op: RelOp; right: Expr; line: number }
  | { kind: 'blank'; line: number }

/**
 * 变量类型别名表。
 *
 * 关键语义约定：**未声明的变量默认无下界（free）**，因为算账里负数是有意义的
 * （亏损、欠款）。需要非负时显式写 `非负` / `非负整数`，或写 `x : 实数 >= 0`。
 */
const VAR_KINDS: Record<string, { kind: VarKind; implicitLower?: Frac }> = {
  real: { kind: 'real' },
  实数: { kind: 'real' },
  连续: { kind: 'real' },
  nonneg: { kind: 'real', implicitLower: Frac.ZERO },
  非负: { kind: 'real', implicitLower: Frac.ZERO },
  非负数: { kind: 'real', implicitLower: Frac.ZERO },
  int: { kind: 'integer' },
  integer: { kind: 'integer' },
  整数: { kind: 'integer' },
  nonnegint: { kind: 'integer', implicitLower: Frac.ZERO },
  非负整数: { kind: 'integer', implicitLower: Frac.ZERO },
  自然数: { kind: 'integer', implicitLower: Frac.ZERO },
  posint: { kind: 'integer', implicitLower: Frac.ONE },
  正整数: { kind: 'integer', implicitLower: Frac.ONE },
  binary: { kind: 'binary' },
  bool: { kind: 'binary' },
  布尔: { kind: 'binary' },
  二元: { kind: 'binary' },
}

const MAX_WORDS = new Set(['max', 'maximize', '最大化', '最大'])
const MIN_WORDS = new Set(['min', 'minimize', '最小化', '最小'])
const FN_ARITY: Record<string, number> = {
  ceil: 1,
  ceiling: 1,
  floor: 1,
  round: 1,
  abs: 1,
  max: 2,
  min: 2,
}

const EOF_TOKEN: Token = { type: 'eof', value: '', pos: { offset: 0, line: 1, col: 1 } }

/** 把某一行的 Token 序列喂给下降解析器；行号统一为真实行号。 */
class LineParser {
  private idx = 0
  constructor(
    private readonly toks: Token[],
    private readonly line: number,
  ) {}

  private peek(): Token {
    return this.toks[this.idx] ?? { ...EOF_TOKEN, pos: { ...EOF_TOKEN.pos, line: this.line } }
  }

  private next(): Token {
    const t = this.peek()
    if (t.type !== 'eof') this.idx++
    return t
  }

  private at(type: Token['type'], value?: string): boolean {
    const t = this.peek()
    return t.type === type && (value === undefined || t.value === value)
  }

  private eat(type: Token['type'], value?: string): Token | null {
    if (this.at(type, value)) return this.next()
    return null
  }

  private expect(type: Token['type'], value: string, what: string): Token {
    const t = this.eat(type, value)
    if (!t) {
      const p = this.peek().pos
      throw new ParseError(
        `第 ${this.line} 行期望 ${what}，实际得到「${this.peek().value || 'EOF'}」`,
        p.line,
        p.col,
      )
    }
    return t
  }

  private pos(): Pos {
    return this.peek().pos
  }

  private fail(msg: string): never {
    const t = this.peek()
    throw new ParseError(`${msg}（第 ${this.line} 行第 ${t.pos.col} 列）`, t.pos.line, t.pos.col)
  }

  parseStatement(): Stmt {
    if (this.at('eof')) return { kind: 'blank', line: this.line }

    // 目标函数：max / min ...
    if (this.at('ident')) {
      const v = (this.peek().value ?? '').toLowerCase()
      if (MAX_WORDS.has(v) || MIN_WORDS.has(v)) {
        this.next()
        const expr = this.parseExpr()
        this.expectEof()
        return { kind: 'objective', sense: MAX_WORDS.has(v) ? 'max' : 'min', expr, line: this.line }
      }
    }

    // name 开头的三种可能：常量 / 变量声明 / 带标签的约束
    if (this.at('ident')) {
      const nameTok = this.peek()
      const after = this.toks[this.idx + 1]
      if (after?.type === 'cmp' && after.value === ':=') {
        this.next()
        this.next()
        const expr = this.parseExpr()
        this.expectEof()
        return { kind: 'const', name: nameTok.value, expr, line: this.line }
      }
      if (after?.type === 'cmp' && after.value === ':') {
        const decl = this.tryParseVarDecl(nameTok.value)
        if (decl) {
          this.expectEof()
          return decl
        }
        // 不是变量声明 → 带标签的约束
        this.next()
        this.next()
        const c = this.parseConstraintBody(nameTok.value)
        this.expectEof()
        return c
      }
    }

    const c = this.parseConstraintBody(undefined)
    this.expectEof()
    return c
  }

  /** 尝试解析变量声明；类型别名不认识时回退（返回 null），让调用方按标签约束处理。 */
  private tryParseVarDecl(name: string): Stmt | null {
    const save = this.idx
    this.next() // name
    this.next() // ':'

    let free = false
    if (this.atIdentWord('free') || this.atIdentWord('自由')) {
      free = true
      this.next()
    }
    if (!this.at('ident')) {
      this.idx = save
      return null
    }
    const kindTok = this.next()
    const spec = VAR_KINDS[kindTok.value.toLowerCase()]
    if (!spec) {
      this.idx = save
      return null
    }
    // free 也可写在类型之后：`x : 实数 free`
    if (!free && (this.atIdentWord('free') || this.atIdentWord('自由'))) {
      free = true
      this.next()
    }
    if (free && spec.implicitLower) {
      throw new ModelError(
        `变量「${name}」同时声明为 free 与「${kindTok.value}」（自带下界 ${spec.implicitLower.toString()}），二者矛盾（第 ${this.line} 行）`,
        this.line,
        kindTok.pos.col,
      )
    }

    let lower: Expr | undefined
    let upper: Expr | undefined
    let lowerStrict = false
    let upperStrict = false

    // 区间形式 [lo, hi]
    if (this.eat('op', '[')) {
      lower = this.parseExpr()
      this.expect('op', ',', '逗号')
      upper = this.parseExpr()
      this.expect('op', ']', '右方括号')
    } else {
      // 零到两个边界子句
      for (;;) {
        if (this.at('cmp', '>=')) {
          this.next()
          lower = this.parseExpr()
          lowerStrict = false
        } else if (this.at('cmp', '>')) {
          this.next()
          lower = this.parseExpr()
          lowerStrict = true
        } else if (this.at('cmp', '<=')) {
          this.next()
          upper = this.parseExpr()
          upperStrict = false
        } else if (this.at('cmp', '<')) {
          this.next()
          upper = this.parseExpr()
          upperStrict = true
        } else {
          break
        }
      }
    }

    return {
      kind: 'var',
      name,
      varKind: spec.kind,
      implicitLower: spec.implicitLower,
      free: free || undefined,
      lower,
      upper,
      lowerStrict,
      upperStrict,
      line: this.line,
    }
  }

  private atIdentWord(word: string): boolean {
    return this.at('ident') && this.peek().value.toLowerCase() === word
  }

  private parseConstraintBody(label?: string): Stmt {
    const left = this.parseExpr()
    const cmpTok = this.peek()
    if (cmpTok.type !== 'cmp') {
      throw new ParseError(
        `第 ${this.line} 行缺少比较符（= < <= > >= !=）`,
        cmpTok.pos.line,
        cmpTok.pos.col,
      )
    }
    this.next()
    if (cmpTok.value === ':' || cmpTok.value === ':=') {
      throw new ParseError(
        `第 ${this.line} 行约束的比较符非法：「${cmpTok.value}」`,
        cmpTok.pos.line,
        cmpTok.pos.col,
      )
    }
    const right = this.parseExpr()
    return { kind: 'constraint', name: label, left, op: cmpTok.value as RelOp, right, line: this.line }
  }

  private expectEof(): void {
    if (!this.at('eof')) this.fail(`存在多余内容「${this.peek().value}」`)
  }

  // ---- 加减 ----
  parseExpr(): Expr {
    let node = this.parseTerm()
    for (;;) {
      if (this.at('op', '+')) {
        const p = this.pos()
        this.next()
        node = { kind: 'add', left: node, right: this.parseTerm(), pos: p }
      } else if (this.at('op', '-')) {
        const p = this.pos()
        this.next()
        node = { kind: 'sub', left: node, right: this.parseTerm(), pos: p }
      } else {
        break
      }
    }
    return node
  }

  // ---- 乘除 + 隐式乘法 ----
  private parseTerm(): Expr {
    let node = this.parseUnary()
    for (;;) {
      if (this.at('op', '*')) {
        const p = this.pos()
        this.next()
        node = { kind: 'mul', left: node, right: this.parseUnary(), pos: p }
      } else if (this.at('op', '/')) {
        const p = this.pos()
        this.next()
        node = { kind: 'div', left: node, right: this.parseUnary(), pos: p }
      } else if (this.startsFactor()) {
        const p = this.pos()
        node = { kind: 'mul', left: node, right: this.parseUnary(), pos: p }
      } else {
        break
      }
    }
    return node
  }

  /** 是否处在「隐式乘法右因子」的开头。 */
  private startsFactor(): boolean {
    const t = this.peek()
    return t.type === 'num' || t.type === 'ident' || t.type === 'lparen'
  }

  // ---- 一元符号 ----
  private parseUnary(): Expr {
    if (this.at('op', '-')) {
      const p = this.pos()
      this.next()
      return { kind: 'neg', arg: this.parseUnary(), pos: p }
    }
    if (this.at('op', '+')) {
      this.next()
      return this.parseUnary()
    }
    return this.parsePower()
  }

  // ---- 幂（右结合）----
  private parsePower(): Expr {
    const base = this.parsePrimary()
    if (this.at('op', '^')) {
      const p = this.pos()
      this.next()
      const exp = this.parseUnary()
      return { kind: 'pow', base, exp, pos: p }
    }
    return base
  }

  // ---- 原子 ----
  private parsePrimary(): Expr {
    const t = this.peek()
    if (t.type === 'num') {
      this.next()
      return { kind: 'num', value: tokenToNum(t), pos: t.pos }
    }
    if (t.type === 'lparen') {
      this.next()
      const e = this.parseExpr()
      this.expect('rparen', ')', '右括号')
      return e
    }
    if (t.type === 'ident') {
      this.next()
      if (this.at('lparen')) {
        const name = t.value.toLowerCase()
        const arity = FN_ARITY[name]
        if (arity === undefined) {
          throw new ModelError(
            `未知函数「${t.value}」（第 ${this.line} 行第 ${t.pos.col} 列）`,
            t.pos.line,
            t.pos.col,
          )
        }
        this.next()
        const args: Expr[] = []
        if (!this.at('rparen')) {
          args.push(this.parseExpr())
          while (this.eat('op', ',')) args.push(this.parseExpr())
        }
        this.expect('rparen', ')', '右括号')
        if (args.length !== arity) {
          throw new ModelError(
            `函数「${t.value}」需要 ${arity} 个参数，实际 ${args.length} 个（第 ${this.line} 行第 ${t.pos.col} 列）`,
            t.pos.line,
            t.pos.col,
          )
        }
        return { kind: 'call', name, args, pos: t.pos }
      }
      return { kind: 'var', name: t.value, pos: t.pos }
    }
    return this.fail(`出现意外的「${t.value || 'EOF'}」`)
  }
}

/** 去掉 `#` 或 `//` 之后的内容（本语法没有字符串字面量，无需考虑引号）。 */
function stripLineComment(line: string): string {
  const hash = line.indexOf('#')
  const slash = line.indexOf('//')
  let cut = line.length
  if (hash >= 0) cut = Math.min(cut, hash)
  if (slash >= 0) cut = Math.min(cut, slash)
  return line.slice(0, cut)
}

/**
 * 把整份模型文本解析为语句 AST 列表。
 *
 * 按行分句，行号即真实行号，编辑器可据此高亮出错行。
 */
export function parse(input: string): Stmt[] {
  const lines = normalizeWidth(input).split('\n')
  const stmts: Stmt[] = []
  for (let i = 0; i < lines.length; i++) {
    const noComment = stripLineComment(lines[i] as string)
    if (noComment.trim() === '') continue
    const toks = tokenize(noComment)
    for (const t of toks) t.pos = { ...t.pos, line: i + 1 }
    const stmt = new LineParser(toks, i + 1).parseStatement()
    if (stmt.kind !== 'blank') stmts.push(stmt)
  }
  return stmts
}

/** 便捷：把单行文本解析为唯一表达式（用于交互式求值）。 */
export function parseExprLine(line: string): Expr {
  const toks = tokenize(stripLineComment(line))
  return new LineParser(toks, 1).parseExpr()
}

export type { Expr, Pos, Frac }
