import { describe, it, expect } from 'vite-plus/test'
import { Frac } from '@/solver/frac'
import { solve } from '@/solver/solve'

/** 断言近似解满足原模型的全部约束。 */
function expectAllConstraintsSatisfied(sol: ReturnType<typeof solve>): void {
  expect(sol.constraintReport?.every((r) => r.satisfied)).toBe(true)
}

describe('二次项：A 类精确线性化', () => {
  it('二元 × 连续，结果精确', () => {
    const sol = solve(`
      是否买 : 二元
      单价 : 非负 <= 10
      花费 = 是否买 * 单价
      max 花费
    `)
    expect(sol.status.kind).toBe('optimal')
    expect(sol.objectiveValue?.eq(Frac.parse('10'))).toBe(true)
    expect(sol.approximation).toBeUndefined()
  })

  it('整数 × 连续，结果精确', () => {
    const sol = solve(`
      份数 : 非负整数 <= 5
      单价 : 非负 <= 10
      花费 = 份数 * 单价
      max 花费
    `)
    expect(sol.objectiveValue?.eq(Frac.parse('50'))).toBe(true)
    expect(sol.values.get('份数')?.eq(Frac.parse('5'))).toBe(true)
    expect(sol.approximation).toBeUndefined()
  })

  it('整数平方：x^2 精确', () => {
    const sol = solve(`
      x : 非负整数 <= 5
      max x^2
    `)
    expect(sol.objectiveValue?.eq(Frac.parse('25'))).toBe(true)
    expect(sol.approximation).toBeUndefined()
  })

  it('整数 × 整数，结果仍精确', () => {
    const sol = solve(`
      a : 非负整数 <= 4
      b : 非负整数 <= 5
      max a * b
    `)
    expect(sol.objectiveValue?.eq(Frac.parse('20'))).toBe(true)
    expect(sol.approximation).toBeUndefined()
  })
})

describe('二次项：B 类空间分支定界', () => {
  it('连续 × 连续：近似值落在损失率保证区间内且满足约束', () => {
    const src = `
      x : 非负 <= 10
      y : 非负 <= 10
      x + y <= 10
      收益 = x * y
      max 收益
    `
    const sol = solve(src)
    expect(sol.status.kind).toBe('optimal')
    expect(sol.approximation).toBeDefined()
    expectAllConstraintsSatisfied(sol)

    // 真实最优 25（x=y=5）；近似值的下界是 25 * (1 - gap)
    const gap = sol.approximation?.relativeGap ?? Frac.ZERO
    expect(gap.gt(Frac.ZERO)).toBe(true)
    const obj = sol.objectiveValue as Frac
    expect(obj.le(Frac.parse('25'))).toBe(true)
    expect(obj.ge(Frac.parse('25').mul(Frac.ONE.sub(gap)))).toBe(true)
  })

  it('连续相乘但无目标函数时明确拒绝并给出出路', () => {
    expect(() =>
      solve(`
        x : 非负 <= 10
        y : 非负 <= 10
        x + y <= 10
        x * y = 20
      `),
    ).toThrow(/目标函数|max|min/)
  })

  it('gapTolerance 收紧后损失率不超过阈值', () => {
    const sol = solve(
      `
      x : 非负 <= 10
      y : 非负 <= 10
      x + y <= 10
      max x * y
    `,
      { gapTolerance: Frac.parse('0.001') },
    )
    expect(sol.approximation).toBeDefined()
    expect(sol.approximation?.relativeGap.le(Frac.parse('0.001'))).toBe(true)
  })

  it('参与乘积的变量无界时给出可操作提示', () => {
    expect(() =>
      solve(`
        x : 非负
        y : 非负 <= 10
        max x * y
      `),
    ).toThrow(/有限上界|有限下界|上下界/)
  })
})
