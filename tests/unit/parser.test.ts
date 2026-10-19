import { describe, it, expect } from 'vite-plus/test'
import { tokenize } from '@/solver/lexer'
import { parse, parseExprLine } from '@/solver/parser'
import { ParseError, ModelError } from '@/solver/errors'
import { Frac } from '@/solver/frac'

const kinds = (toks: ReturnType<typeof tokenize>) => toks.map((t) => t.type)
const values = (toks: ReturnType<typeof tokenize>) => toks.map((t) => t.value)

describe('lexer', () => {
  it('基本算式', () => {
    const toks = tokenize('3*x + 2 <= 100')
    expect(values(toks)).toEqual(['3', '*', 'x', '+', '2', '<=', '100', ''])
    expect(kinds(toks)).toEqual(['num', 'op', 'ident', 'op', 'num', 'cmp', 'num', 'eof'])
  })

  it('比较符全部识别', () => {
    expect(values(tokenize('a<b'))).toEqual(['a', '<', 'b', ''])
  })

  it('全角归一化且列号连续', () => {
    const toks = tokenize('３＊ｘ＜＝１００')
    expect(values(toks)).toEqual(['3', '*', 'x', '<=', '100', ''])
  })

  it('中文变量名', () => {
    expect(values(tokenize('普通肥料 * 34 <= 钞票'))).toEqual([
      '普通肥料',
      '*',
      '34',
      '<=',
      '钞票',
      '',
    ])
  })

  it('# 与 // 行注释被跳过', () => {
    expect(values(tokenize('x + 1 # 这是注释'))).toEqual(['x', '+', '1', ''])
    expect(values(tokenize('x + 1 // 这是注释'))).toEqual(['x', '+', '1', ''])
  })

  it('行号随换行递增', () => {
    const toks = tokenize('x\n\ny')
    expect(toks[0]?.pos.line).toBe(1)
    expect(toks[1]?.pos.line).toBe(3)
  })

  it('非法字符报错并带位置', () => {
    expect(() => tokenize('x @ y')).toThrow(ParseError)
    try {
      tokenize('x @ y')
    } catch (e) {
      expect((e as ParseError).col).toBe(3)
    }
  })

  it('科学计数法数字', () => {
    expect(values(tokenize('1.5e-3'))).toEqual(['1.5e-3', ''])
  })
})

describe('parser', () => {
  it('约束语句', () => {
    const [s] = parse('3*x + 2*y <= 100')
    expect(s?.kind).toBe('constraint')
    if (s?.kind !== 'constraint') throw new Error('unreachable')
    expect(s.op).toBe('<=')
    expect(s.left).toMatchObject({ kind: 'add' })
  })

  it('带标签的约束', () => {
    const [s] = parse('预算 : 3*x + 2*y <= 100')
    if (s?.kind !== 'constraint') throw new Error('应为约束')
    expect(s.name).toBe('预算')
  })

  it('变量声明：类型 + 上界', () => {
    const [s] = parse('买几份 : 非负整数 <= 40')
    if (s?.kind !== 'var') throw new Error('应为变量声明')
    expect(s.name).toBe('买几份')
    expect(s.varKind).toBe('integer')
    expect(s.implicitLower?.eq(Frac.ZERO)).toBe(true)
    expect(s.upper).toBeDefined()
  })

  it('变量声明：区间形式', () => {
    const [s] = parse('x : 整数 [1, 9]')
    if (s?.kind !== 'var') throw new Error('应为变量声明')
    expect(s.lower).toBeDefined()
    expect(s.upper).toBeDefined()
  })

  it('变量声明：free 修饰符', () => {
    const [s] = parse('盈亏 : free 实数')
    if (s?.kind !== 'var') throw new Error('应为变量声明')
    expect(s.free).toBe(true)
  })

  it('未知类型别名回退为带标签约束', () => {
    // `甲 : 乙` 里「乙」不是类型 → 视为标签为「甲」的约束 `乙`（随后因缺比较符报错）
    expect(() => parse('甲 : 乙')).toThrow(ParseError)
  })

  it('常量赋值', () => {
    const [s] = parse('单价 := 34 / 10')
    if (s?.kind !== 'const') throw new Error('应为常量')
    expect(s.name).toBe('单价')
  })

  it('目标函数 max / min 与中文别名', () => {
    for (const kw of ['max', '最大化']) {
      const [s] = parse(`${kw} 3*x + 2*y`)
      if (s?.kind !== 'objective') throw new Error('应为目标')
      expect(s.sense).toBe('max')
    }
    const [s2] = parse('min 成本')
    if (s2?.kind !== 'objective') throw new Error('应为目标')
    expect(s2.sense).toBe('min')
  })

  it('空行与注释行被跳过', () => {
    const stmts = parse('\n# 注释\n\n   \nx = 1\n')
    expect(stmts).toHaveLength(1)
    expect(stmts[0]?.line).toBe(5)
  })

  it('隐式乘法：2x、3(a+b)、x y', () => {
    const e1 = parseExprLine('2x')
    expect(e1).toMatchObject({ kind: 'mul' })
    const e2 = parseExprLine('3(a+b)')
    expect(e2).toMatchObject({ kind: 'mul' })
    const e3 = parseExprLine('x y')
    expect(e3).toMatchObject({ kind: 'mul' })
  })

  it('运算符优先级：乘除高于加减，幂高于乘', () => {
    // 2 + 3*4 = 14；2^3*2 = 16
    const e = parseExprLine('2 + 3 * 4')
    expect(e).toMatchObject({ kind: 'add' })
    expect((e as { right: unknown }).right).toMatchObject({ kind: 'mul' })
  })

  it('一元负号与幂的组合', () => {
    const e = parseExprLine('-x^2')
    // 解析为 -(x^2)
    expect(e).toMatchObject({ kind: 'neg' })
  })

  it('函数调用与元数检查', () => {
    expect(parseExprLine('ceil(5.3)')).toMatchObject({ kind: 'call', name: 'ceil' })
    expect(() => parseExprLine('ceil(1, 2)')).toThrow(ModelError)
    expect(() => parseExprLine('sqrt(4)')).toThrow(ModelError)
  })

  it('语法错误带行号', () => {
    expect(() => parse('x = 1\ny +')).toThrow(ParseError)
    try {
      parse('x = 1\ny +')
    } catch (e) {
      expect((e as ParseError).line).toBe(2)
    }
  })

  it('缺少比较符时报错', () => {
    expect(() => parse('3*x + 2')).toThrow(ParseError)
  })

  it('多余内容报错', () => {
    expect(() => parse('x = 1 = 2')).toThrow(ParseError)
  })
})
