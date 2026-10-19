import { describe, it, expect } from 'vite-plus/test'
import { exprToString } from '@/lib/expr-to-string'
import { parseExprLine } from '@/solver/parser'

/**
 * exprToString 应把求解器 AST 表达式还原为语义等价的 DSL 文本。
 * 输出不需要逐字符匹配输入，但必须：
 * 1. 可被 `parseExprLine` 重新解析
 * 2. 再次 stringify 后一致（幂等）
 */

function roundTrip(input: string): string {
  const e = parseExprLine(input)
  return exprToString(e)
}

function expectRoundTrip(input: string, expected?: string): void {
  const out = roundTrip(input)
  const target = expected ?? input
  expect(out).toBe(target)
  // 幂等
  expect(roundTrip(out)).toBe(target)
}

describe('exprToString', () => {
  it('数字——分数还原为小数', () => {
    expect(roundTrip('42')).toBe('42')
    // 3.14 会被 Frac 解析为 157/50
    expect(roundTrip('3.14')).toBe('3.14')
    expect(roundTrip('0')).toBe('0')
    expect(roundTrip('0.1')).toBe('0.1')
  })

  it('变量名', () => {
    expect(roundTrip('x')).toBe('x')
    expect(roundTrip('农场面积')).toBe('农场面积')
  })

  it('加法', () => {
    expectRoundTrip('x + y')
    expectRoundTrip('x + y + z')
  })

  it('减法——右结合子树需括号', () => {
    // "x - (y - z)" 必须保留括号，否则语义不同
    expect(roundTrip('x - (y - z)')).toBe('x - (y - z)')
    // "x - y" 不需括号
    expect(roundTrip('x - y')).toBe('x - y')
    // "x - y - z" 也不需括号（左结合）
    expect(roundTrip('x - y - z')).toBe('x - y - z')
  })

  it('乘法——加法子树需括号', () => {
    expect(roundTrip('2 * (x + y)')).toBe('2 * (x + y)')
    expect(roundTrip('(x + y) * 3')).toBe('(x + y) * 3')
    expect(roundTrip('2 * x')).toBe('2 * x')
  })

  it('除法——加法子树需括号，右结合需括号', () => {
    expect(roundTrip('(x + y) / 2')).toBe('(x + y) / 2')
    expect(roundTrip('x / (y / z)')).toBe('x / (y / z)')
    // 单纯左结合除法不需要括号
    expect(roundTrip('x / y')).toBe('x / y')
  })

  it('负号——加法子树需括号', () => {
    expect(roundTrip('-x')).toBe('-x')
    expect(roundTrip('-(x + y)')).toBe('-(x + y)')
    expect(roundTrip('-3.14')).toBe('-3.14')
  })

  it('幂——底数与指数都需括号', () => {
    expect(roundTrip('x ^ y')).toBe('x ^ y')
    expect(roundTrip('(x + 1) ^ 2')).toBe('(x + 1) ^ 2')
    expect(roundTrip('2 ^ (x + 1)')).toBe('2 ^ (x + 1)')
  })

  it('函数调用', () => {
    expect(roundTrip('ceil(x)')).toBe('ceil(x)')
    expect(roundTrip('floor(x + y)')).toBe('floor(x + y)')
  })

  it('复杂嵌套', () => {
    expect(roundTrip('(a + b) * (c - d)')).toBe('(a + b) * (c - d)')
  })

  it('幂等：连续两次序列化结果一致', () => {
    const cases = [
      'x + y + z',
      '2 * x + 3 * y',
      '(a + b) * (c + d)',
      'x ^ (y + 1)',
      'ceil(x / y)',
      '-3 * x + 4',
    ]
    for (const c of cases) {
      const first = roundTrip(c)
      const second = roundTrip(first)
      expect(second).toBe(first)
    }
  })
})
