import { describe, it, expect } from 'vitest'
import { Frac } from '@/solver/frac'
import { solveLp, type LpStandard } from '@/solver/lp'
import { solve } from '@/solver/solve'

/** 构造标准形：全变量 >= 0。 */
function lp(A: number[][], sense: LpStandard['sense'], b: number[], c: number[]): LpStandard {
  return {
    n: c.length,
    A: A.map((row) => row.map((v) => Frac.of(v))),
    sense,
    b: b.map((v) => Frac.of(v)),
    c: c.map((v) => Frac.of(v)),
  }
}

describe('单纯形 LP', () => {
  it('经典生产计划：max 3x+5y', () => {
    // max 3x + 5y  s.t. x<=4, 2y<=12, 3x+2y<=18
    // 写成 min -3x-5y
    const p = lp(
      [
        [1, 0],
        [0, 2],
        [3, 2],
      ],
      ['le', 'le', 'le'],
      [4, 12, 18],
      [-3, -5],
    )
    const r = solveLp(p)
    expect(r.status).toBe('optimal')
    expect(r.objective.eq(Frac.parse('-36'))).toBe(true) // min = -36 → max = 36
    expect(r.x[0]?.eq(Frac.parse('2'))).toBe(true)
    expect(r.x[1]?.eq(Frac.parse('6'))).toBe(true)
  })

  it('不可行：约束互相矛盾', () => {
    const p = lp([[1], [1]], ['le', 'ge'], [2, 5], [1])
    const r = solveLp(p)
    expect(r.status).toBe('infeasible')
  })

  it('无界：max x 且 x 无上界', () => {
    const p = lp([[1]], ['ge'], [0], [-1]) // min -x, x >= 0 → 无界
    const r = solveLp(p)
    expect(r.status).toBe('unbounded')
  })

  it('等式约束', () => {
    // x + y = 10, min x → x=0
    const p = lp([[1, 1]], ['eq'], [10], [1, 0])
    const r = solveLp(p)
    expect(r.status).toBe('optimal')
    expect(r.x[0]?.eq(Frac.ZERO)).toBe(true)
    expect(r.x[1]?.eq(Frac.parse('10'))).toBe(true)
  })

  it('分数最优解保持精确', () => {
    // 3x = 1 → x = 1/3
    const p = lp([[3]], ['eq'], [1], [0])
    const r = solveLp(p)
    expect(r.status).toBe('optimal')
    expect(r.x[0]?.toString()).toBe('1/3')
  })

  it('退化的可行域（单点）', () => {
    // x <= 5, x >= 5 → x = 5
    const p = lp([[1], [1]], ['le', 'ge'], [5, 5], [1])
    const r = solveLp(p)
    expect(r.status).toBe('optimal')
    expect(r.x[0]?.eq(Frac.parse('5'))).toBe(true)
  })

  it('负 rhs 自动规整', () => {
    // -x <= -5 等价 x >= 5，min x → 5
    const p = lp([[-1]], ['le'], [-5], [1])
    const r = solveLp(p)
    expect(r.status).toBe('optimal')
    expect(r.x[0]?.eq(Frac.parse('5'))).toBe(true)
  })
})

describe('solve 编排：LP / MILP 端到端', () => {
  it('线性规划：最大化利润', () => {
    const sol = solve(`
      x : 非负
      y : 非负
      x <= 4
      2*y <= 12
      3*x + 2*y <= 18
      max 3*x + 5*y
    `)
    expect(sol.status.kind).toBe('optimal')
    expect(sol.objectiveValue?.eq(Frac.parse('36'))).toBe(true)
    expect(sol.values.get('x')?.eq(Frac.parse('2'))).toBe(true)
    expect(sol.values.get('y')?.eq(Frac.parse('6'))).toBe(true)
  })

  it('整数规划：LP 最优非整数时向上分支', () => {
    // max x + y, x <= 2.5, y <= 2.5, x,y 整数 → x=y=2, obj=4
    const sol = solve(`
      x : 非负整数
      y : 非负整数
      x <= 2.5
      y <= 2.5
      max x + y
    `)
    expect(sol.status.kind).toBe('optimal')
    expect(sol.objectiveValue?.eq(Frac.parse('4'))).toBe(true)
    expect(sol.values.get('x')?.eq(Frac.parse('2'))).toBe(true)
    expect(sol.values.get('y')?.eq(Frac.parse('2'))).toBe(true)
  })

  it('整数规划不可行', () => {
    // x 整数，0 < x < 1 → 无解
    const sol = solve(`
      x : 整数
      x >= 0.2
      x <= 0.8
      max x
    `)
    expect(sol.status.kind).toBe('infeasible')
  })

  it('无界目标', () => {
    const sol = solve(`
      x : 非负
      max x
    `)
    expect(sol.status.kind).toBe('unbounded')
  })

  it('等式定点：无目标时直接解出', () => {
    const sol = solve('x + y = 10\nx - y = 4')
    expect(sol.status.kind).toBe('optimal')
    expect(sol.values.get('x')?.eq(Frac.parse('7'))).toBe(true)
    expect(sol.values.get('y')?.eq(Frac.parse('3'))).toBe(true)
  })

  it('等式定点 + 整数约束', () => {
    const sol = solve('x : 整数\ny : 整数\nx + y = 10\nx - y = 4')
    expect(sol.status.kind).toBe('optimal')
    expect(sol.values.get('x')?.eq(Frac.parse('7'))).toBe(true)
  })

  it('唯一等式解违反边界 → 不可行', () => {
    const sol = solve('x = 10\nx <= 5')
    expect(sol.status.kind).toBe('infeasible')
  })

  it('无穷多解：给出一个可行点并提示维度', () => {
    const sol = solve(`
      x : 非负
      y : 非负
      x + y = 10
    `)
    expect(sol.status.kind).toBe('optimal')
    const sum = (sol.values.get('x') ?? Frac.ZERO).add(sol.values.get('y') ?? Frac.ZERO)
    expect(sum.eq(Frac.parse('10'))).toBe(true)
    expect(sol.warnings.some((w) => w.includes('解不唯一') || w.includes('无穷多'))).toBe(true)
  })

  it('最小化目标', () => {
    const sol = solve(`
      x : 非负
      y : 非负
      x + y >= 10
      min 2*x + 3*y
    `)
    expect(sol.status.kind).toBe('optimal')
    expect(sol.objectiveValue?.eq(Frac.parse('20'))).toBe(true) // x=10,y=0
  })

  it('目标函数含常数项', () => {
    const sol = solve(`
      x : 非负
      x <= 5
      max 2*x + 100
    `)
    expect(sol.objectiveValue?.eq(Frac.parse('110'))).toBe(true)
  })

  it('max 与目标常数项组合（验证符号还原）', () => {
    // min -(x) + 7，x<=3 → min = -3 + 7 = 4
    const sol = solve(`
      x : 非负
      x <= 3
      min 7 - x
    `)
    expect(sol.objectiveValue?.eq(Frac.parse('4'))).toBe(true)
  })

  it('约束报告标注哪些取等', () => {
    const sol = solve('预算 : 2*x <= 10\nx : 非负\nmax x')
    expect(sol.constraintReport).toBeDefined()
    expect(sol.constraintReport?.[0]?.tight).toBe(true)
    expect(sol.constraintReport?.[0]?.satisfied).toBe(true)
  })

  it('!= 约束被拒绝并说明原因', () => {
    expect(() => solve('x = 1\nx != 2')).toThrow()
  })

  it('自由变量可取负值', () => {
    const sol = solve(`
      盈亏 : free 实数
      盈亏 = -50
    `)
    expect(sol.status.kind).toBe('optimal')
    expect(sol.values.get('盈亏')?.eq(Frac.parse('-50'))).toBe(true)
  })

  it('未声明变量默认自由（可负）', () => {
    const sol = solve('x = -3')
    expect(sol.values.get('x')?.eq(Frac.parse('-3'))).toBe(true)
  })

  it('二元变量只能取 0/1', () => {
    const sol = solve(`
      b : 二元
      b >= 0.5
      max b
    `)
    expect(sol.status.kind).toBe('optimal')
    expect(sol.values.get('b')?.eq(Frac.ONE)).toBe(true)
  })

  it('空模型报错', () => {
    expect(() => solve('')).toThrow()
  })
})
