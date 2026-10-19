import type { Expr } from '@/solver/ast'

/**
 * 将求解器 AST 表达式节点序列化为 DSL 文本。
 *
 * 用途：可视化编辑器的反编译路径（`tryDecompile`）需要把解析后的
 * `Stmt` 中的约束/常数/目标表达式还原为可读的文本串，填入表单字段。
 *
 * 括号规则按运算符优先级：
 *
 *   call > pow > neg > mul/div > add/sub
 *
 * 仅在子表达式优先级低于当前节点时才加括号；相同优先级中
 * 左结合（add/sub/mul/div）仅将括号加在右侧非结合子节点上，
 * 右结合（pow）加在所有同优先级子节点上。
 */

function prec(e: Expr): number {
  switch (e.kind) {
    case 'call':
      return 6
    case 'pow':
      return 5
    case 'neg':
      return 4
    case 'mul':
    case 'div':
      return 3
    case 'add':
    case 'sub':
      return 2
    default:
      return 99
  }
}

function paren(cond: boolean, s: string): string {
  return cond ? `(${s})` : s
}

export function exprToString(e: Expr): string {
  switch (e.kind) {
    case 'num':
      return e.value.toDecimalString(15)
    case 'var':
      return e.name

    case 'add': {
      const l = exprToString(e.left)
      const r = exprToString(e.right)
      return `${l} + ${paren(prec(e.right) <= prec(e), r)}`
    }
    case 'sub': {
      const l = exprToString(e.left)
      const r = exprToString(e.right)
      // 右结合体 `a - (b - c)` 需要括号
      return `${l} - ${paren(prec(e.right) <= prec(e), r)}`
    }
    case 'neg':
      return `-${paren(prec(e.arg) <= prec(e), exprToString(e.arg))}`

    case 'mul': {
      const l = exprToString(e.left)
      const r = exprToString(e.right)
      return `${paren(prec(e.left) < prec(e), l)} * ${paren(prec(e.right) < prec(e), r)}`
    }
    case 'div': {
      const l = exprToString(e.left)
      const r = exprToString(e.right)
      return `${paren(prec(e.left) < prec(e), l)} / ${paren(prec(e.right) <= prec(e), r)}`
    }

    case 'pow': {
      const b = exprToString(e.base)
      const x = exprToString(e.exp)
      return `${paren(prec(e.base) <= prec(e), b)} ^ ${paren(prec(e.exp) < prec(e), x)}`
    }

    case 'call': {
      const args = e.args.map((a) => exprToString(a)).join(', ')
      return `${e.name}(${args})`
    }

    default:
      return ''
  }
}
