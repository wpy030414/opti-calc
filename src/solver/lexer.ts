import { ParseError } from './errors'
import { Frac, normalizeWidth } from './frac'
import type { Pos, Token } from './ast'

/**
 * 词法分析。
 *
 * 输入是整份模型文本，逐字符扫描产出 Token 流。支持：
 * - 全角数字与符号（自动归一化，列号仍按归一化后字符计）
 * - `#` 或 `//` 行注释
 * - 数字（含小数、科学计数法）
 * - 标识符（变量名 / 函数名，支持中文，首字符不能是数字）
 * - 运算符 `+ - * / ^ ( )` 与比较符 `= == != < <= > >=`
 */

const OP_CHARS = new Set(['+', '-', '*', '/', '^'])
const BRACKETS = new Set(['[', ']', '{', '}'])
const PAREN = new Set(['(', ')'])

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/** 标识符首字符：字母、下划线或任意中日韩文字。 */
function isIdentStart(ch: string): boolean {
  if (ch === '_' || ch === '$') return true
  const cp = ch.codePointAt(0) ?? 0
  if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a)) return true
  // CJK 统一表意文字、扩展、假名等
  return cp >= 0x80
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}

/**
 * 统一比较符字面量。返回 [规范值, 消耗字符数]，无匹配返回 null。
 *
 * `==` 在这里归一化为 `=`：语法层只保留一套比较符，`RelOp` 类型才不会
 * 被 `as` 断言塞进类型里根本不存在的值。
 */
function matchCmp(src: string, i: number): [string, number] | null {
  const two = src.slice(i, i + 2)
  if (two === '<=' || two === '>=' || two === '!=' || two === ':=') return [two, 2]
  if (two === '==') return ['=', 2]
  const one = src[i]
  if (one === '<') return ['<', 1]
  if (one === '>') return ['>', 1]
  if (one === '=') return ['=', 1]
  if (one === ':') return [':', 1]
  return null
}

/** 数字字面量的正则（十进制 + 可选科学计数法），从 i 处开始匹配。 */
const NUMBER_RE = /\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?/y

export function tokenize(input: string): Token[] {
  const src = normalizeWidth(input)
  const tokens: Token[] = []
  let i = 0
  let line = 1
  let col = 1

  const advance = (count: number): void => {
    for (let k = 0; k < count; k++) {
      if (src[i] === '\n') {
        line++
        col = 1
      } else {
        col++
      }
      i++
    }
  }

  const here = (): Pos => ({ offset: i, line, col })

  while (i < src.length) {
    const ch = src[i] as string

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance(1)
      continue
    }

    // 行注释
    if (ch === '#' || src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') advance(1)
      continue
    }

    const pos = here()

    // 数字
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] ?? ''))) {
      NUMBER_RE.lastIndex = i
      const m = NUMBER_RE.exec(src)
      if (!m || m[0] === '') throw new ParseError('非法数字', line, col)
      tokens.push({ type: 'num', value: m[0], pos })
      advance(m[0].length)
      continue
    }

    // 标识符
    if (isIdentStart(ch)) {
      let j = i
      while (j < src.length && isIdentPart(src[j] as string)) j++
      const name = src.slice(i, j)
      tokens.push({ type: 'ident', value: name, pos })
      advance(name.length)
      continue
    }

    // 运算符
    if (OP_CHARS.has(ch)) {
      tokens.push({ type: 'op', value: ch, pos })
      advance(1)
      continue
    }

    // 方括号 / 花括号（区间与集合边界），按 op 类型输出
    if (BRACKETS.has(ch)) {
      tokens.push({ type: 'op', value: ch, pos })
      advance(1)
      continue
    }

    // 括号
    if (PAREN.has(ch)) {
      tokens.push({ type: ch === '(' ? 'lparen' : 'rparen', value: ch, pos })
      advance(1)
      continue
    }

    // 比较符
    const cmp = matchCmp(src, i)
    if (cmp) {
      tokens.push({ type: 'cmp', value: cmp[0], pos })
      advance(cmp[1])
      continue
    }

    // 逗号（用于函数多参数）
    if (ch === ',') {
      tokens.push({ type: 'op', value: ',', pos })
      advance(1)
      continue
    }

    throw new ParseError(`无法识别的字符「${ch}」`, line, col)
  }

  tokens.push({ type: 'eof', value: '', pos: here() })
  return tokens
}

/** 把数字 Token 的字面量转为精确 Frac。 */
export function tokenToNum(tok: Token): Frac {
  if (tok.type !== 'num') throw new ParseError('期望数字', tok.pos.line, tok.pos.col)
  return Frac.parse(tok.value)
}
