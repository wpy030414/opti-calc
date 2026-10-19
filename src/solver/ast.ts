import type { Frac } from './frac'

/** 表达式抽象语法树。保留结构以便给出精确的错误定位。 */
export type Expr =
  | { kind: 'num'; value: Frac; pos: Pos }
  | { kind: 'var'; name: string; pos: Pos }
  | { kind: 'add'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'sub'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'neg'; arg: Expr; pos: Pos }
  | { kind: 'mul'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'div'; left: Expr; right: Expr; pos: Pos }
  | { kind: 'pow'; base: Expr; exp: Expr; pos: Pos }
  | { kind: 'call'; name: string; args: Expr[]; pos: Pos }

export interface Pos {
  /** 相对整份模型文本的偏移。 */
  offset: number
  /** 1 起始的行号。 */
  line: number
  /** 1 起始的列号。 */
  col: number
}

export const POS_ZERO: Pos = { offset: 0, line: 1, col: 1 }

export type TokenType = 'num' | 'ident' | 'op' | 'cmp' | 'lparen' | 'rparen' | 'eof'

export interface Token {
  type: TokenType
  /** 归一化后的字面量（比较符统一为 `= != < <= > >=`）。 */
  value: string
  pos: Pos
}
