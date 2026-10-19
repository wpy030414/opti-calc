import { describe, it, expect } from 'vitest'
import { Frac } from '@/solver/frac'
import { LinExpr } from '@/solver/linexpr'
import { buildModel, collectVariables } from '@/solver/linearize'
import { parse } from '@/solver/parser'
import { solveLinearSystem, describeRank } from '@/solver/gaussian'
import { ModelError } from '@/solver/errors'

function systemOf(src: string) {
  const model = buildModel(parse(src))
  const varNames = collectVariables(model)
  const eqs = model.constraints.filter((c) => c.op === '=' || c.op === '==')
  return { res: solveLinearSystem(eqs, varNames), varNames }
}

describe('高斯消元（精确 RREF）', () => {
  it('唯一解：2×2', () => {
    const { res } = systemOf('x + y = 10\nx - y = 4')
    expect(res.kind).toBe('unique')
    expect(res.particular.get('x')?.eq(Frac.parse('7'))).toBe(true)
    expect(res.particular.get('y')?.eq(Frac.parse('3'))).toBe(true)
  })

  it('分数解不出浮点误差', () => {
    // x + 2y = 1, 3x + 4y = 2 → x = 0, y = 1/2
    const { res } = systemOf('x + 2*y = 1\n3*x + 4*y = 2')
    expect(res.kind).toBe('unique')
    expect(res.particular.get('x')?.eq(Frac.ZERO)).toBe(true)
    expect(res.particular.get('y')?.toString()).toBe('1/2')
  })

  it('1/3 这类无限小数也精确', () => {
    const { res } = systemOf('3*x = 1')
    expect(res.kind).toBe('unique')
    expect(res.particular.get('x')?.toString()).toBe('1/3')
  })

  it('无穷多解：一个方程两个未知数', () => {
    const { res } = systemOf('x + y = 10')
    expect(res.kind).toBe('infinite')
    expect(res.freeVars).toHaveLength(1)
    expect(res.basis).toHaveLength(1)
    // 基向量：自由变量 +1 时另一个 -1
    const [bv] = res.basis
    expect(bv?.vec.get('x')?.neg().eq(bv.vec.get('y') ?? Frac.ONE)).toBe(true)
  })

  it('矛盾方程组', () => {
    const { res } = systemOf('x + y = 10\nx + y = 11')
    expect(res.kind).toBe('infeasible')
    // 11 - 10 = 1，消元后得到 0 = 1 的矛盾行
    expect(res.reason).toContain('0 = 1')
  })

  it('反序矛盾方程组同样被识别', () => {
    const { res } = systemOf('x + y = 11\nx + y = 10')
    expect(res.kind).toBe('infeasible')
    expect(res.reason).toContain('矛盾等式')
  })

  it('冗余方程不改变解', () => {
    const { res } = systemOf('x = 5\n2*x = 10')
    expect(res.kind).toBe('unique')
    expect(res.particular.get('x')?.eq(Frac.parse('5'))).toBe(true)
  })

  it('超定但相容', () => {
    const { res } = systemOf('x + y = 3\nx = 1\ny = 2')
    expect(res.kind).toBe('unique')
  })

  it('没有等式时解空间是整个 R^n', () => {
    const { res } = systemOf('x <= 5')
    expect(res.kind).toBe('infinite')
    expect(res.freeVars).toEqual(['x'])
  })

  it('describeRank 说明缺几个条件', () => {
    const { res } = systemOf('x + y + z = 6')
    expect(describeRank(res)).toContain('尚缺 2 个条件')
  })

  it('3×3 需要消元的系统', () => {
    const { res } = systemOf('2*x + y - z = 8\n-3*x - y + 2*z = -11\n-2*x + y + 2*z = -3')
    expect(res.kind).toBe('unique')
    expect(res.particular.get('x')?.eq(Frac.parse('2'))).toBe(true)
    expect(res.particular.get('y')?.eq(Frac.parse('3'))).toBe(true)
    expect(res.particular.get('z')?.eq(Frac.parse('-1'))).toBe(true)
  })
})

describe('LinExpr', () => {
  it('合并同类项', () => {
    const e = LinExpr.var('x').scale(Frac.parse('2')).add(LinExpr.var('x').scale(Frac.parse('3')))
    expect(e.coef('x').eq(Frac.parse('5'))).toBe(true)
  })

  it('系数相消后变量消失', () => {
    const e = LinExpr.var('x').sub(LinExpr.var('x'))
    expect(e.isConstant).toBe(true)
    expect(e.terms.size).toBe(0)
  })

  it('变量相乘返回 null（非线性）', () => {
    expect(LinExpr.var('x').tryMul(LinExpr.var('y'))).toBeNull()
  })

  it('常数乘变量保持线性', () => {
    const e = LinExpr.var('x').tryMul(LinExpr.const(Frac.parse('3')))
    expect(e?.coef('x').eq(Frac.parse('3'))).toBe(true)
  })

  it('除以变量返回 null', () => {
    expect(LinExpr.var('x').tryDiv(LinExpr.var('y'))).toBeNull()
    expect(LinExpr.var('x').tryDiv(LinExpr.zero())).toBeNull()
  })

  it('求值', () => {
    const e = LinExpr.var('x').scale(Frac.parse('2')).add(LinExpr.var('y')).add(LinExpr.const(Frac.parse('1')))
    const assign = new Map([
      ['x', Frac.parse('3')],
      ['y', Frac.parse('4')],
    ])
    expect(e.eval(assign).eq(Frac.parse('11'))).toBe(true)
  })

  it('constantOnly 对含未知量的式子报错', () => {
    expect(() => LinExpr.var('x').constantOnly(3)).toThrow(ModelError)
  })
})

describe('线性化与非线性拒绝', () => {
  it('变量相乘报非线性错误并带行号', () => {
    expect(() => buildModel(parse('x * y = 2'))).toThrow(ModelError)
    try {
      buildModel(parse('x = 1\nx * x = 4'))
    } catch (e) {
      expect((e as ModelError).line).toBe(2)
      expect((e as ModelError).message).toContain('非线性')
    }
  })

  it('变量的平方报非线性', () => {
    expect(() => buildModel(parse('x^2 = 4'))).toThrow(ModelError)
  })

  it('变量做除数报非线性', () => {
    expect(() => buildModel(parse('1 / x = 2'))).toThrow(ModelError)
  })

  it('含未知量的 ceil 报非线性', () => {
    expect(() => buildModel(parse('ceil(x) <= 5'))).toThrow(ModelError)
  })

  it('常量参数上的 ceil 被折叠', () => {
    const m = buildModel(parse('x <= ceil(5.3) * 2'))
    const c = m.constraints[0]
    expect(c?.right.constant.eq(Frac.parse('12'))).toBe(true)
  })

  it('常量可被后续语句引用', () => {
    const m = buildModel(parse('a := 34 / 10\nb := a * 10\nx <= b'))
    expect(m.constants.get('a')?.eq(Frac.parse('3.4'))).toBe(true)
    expect(m.constants.get('b')?.eq(Frac.parse('34'))).toBe(true)
  })

  it('常量重复定义报错', () => {
    expect(() => buildModel(parse('a := 1\na := 2'))).toThrow(ModelError)
  })

  it('变量重复声明报错', () => {
    expect(() => buildModel(parse('x : 实数\nx : 整数'))).toThrow(ModelError)
  })

  it('空取值范围报错', () => {
    expect(() => buildModel(parse('x : 实数 [5, 1]'))).toThrow(ModelError)
  })

  it('两个目标函数报错', () => {
    expect(() => buildModel(parse('max x\nmin y\nx <= 1'))).toThrow(ModelError)
  })

  it('隐式乘法 2x 与 3(a+b) 正确展开', () => {
    const m = buildModel(parse('2x + 3(a+b) <= 100'))
    const c = m.constraints[0]
    expect(c?.left.coef('x').eq(Frac.parse('2'))).toBe(true)
    expect(c?.left.coef('a').eq(Frac.parse('3'))).toBe(true)
    expect(c?.left.coef('b').eq(Frac.parse('3'))).toBe(true)
  })

  it('幂运算在常量底数上折叠', () => {
    const m = buildModel(parse('x <= 2^10'))
    expect(m.constraints[0]?.right.constant.eq(Frac.parse('1024'))).toBe(true)
  })
})
