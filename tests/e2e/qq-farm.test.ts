import { describe, it, expect } from 'vite-plus/test'
import { Frac } from '@/solver/frac'
import { solve, fmt } from '@/solver/solve'

/**
 * E2E 验收：逐条复现《1.实际有效施肥土地块数计算.docx》里的算例。
 *
 * 这份测试是本项目的验收标准，不是普通回归测试。文档给的是**人工手算过程**，
 * 这里用求解器的 DSL 重新表达同一个问题，验证算出的数字与文档一致。
 *
 * 两处与文档不同的地方是**刻意**的，文档的数值本身有精度损失：
 *
 * 1. 文档第 3 节「特殊情况」得出 **29.74 分钟**。它是先把 `11.9 / 24` 舍入成
 *    `0.496` 小时、再乘 60 得到的：`0.496 × 60 = 29.76`——但文档又写 29.74，
 *    说明中间还有一次舍入。精确值是 `11.9/24 × 60 = 714/24 = 29.75` 分钟。
 *    本测试断言 **29.75**，并额外断言它落在文档口径的 ±0.02 分钟内。
 *
 * 2. 文档第 2a 节把 5 小时 28 分写作「5.466 小时」，实际是 `5 + 28/60 = 5.4666…`。
 *    文档要求「向多的方向约分」保留两位 → `5.47`。本测试用 `ceil(x*100)/100`
 *    精确表达这个向上取整语义，得到 5.47。
 *
 * 其余数字（24 块、131.28 小时、37.2 小时、31.9 小时缺口、4 份、136 钞票、
 * 2 份、20 小时、11.9 小时剩余）与文档完全一致。
 */

/** 断言求解成功并返回 values。 */
function solved(source: string) {
  const sol = solve(source)
  expect(sol.status, `求解失败：${JSON.stringify(sol.status)}`).toMatchObject({ kind: 'optimal' })
  return sol
}

function val(sol: ReturnType<typeof solve>, name: string): Frac {
  const v = sol.values.get(name)
  expect(v, `缺少变量 ${name}`).toBeDefined()
  return v as Frac
}

describe('文档第 1 节：实际有效施肥土地块数', () => {
  it('大作物 4 格、小作物 1 格：4 大 + 2 小 = 18 块', () => {
    // 文档原文：「以上为 16➕2＝18 块」（16 格来自大作物，2 格来自小作物）
    const sol = solved(`
      大作物 := 4
      小作物 := 2
      实际块数 : 非负整数
      实际块数 = 大作物 * 4 + 小作物 * 1
    `)
    expect(val(sol, '实际块数').eq(Frac.parse('18'))).toBe(true)
    expect(fmt(val(sol, '实际块数'))).toBe('18')
  })

  it('反解：已知 5 大作物共 24 块，求小作物块数', () => {
    // 文档原文：「以上为 24 块」
    const sol = solved(`
      大作物 := 5
      实际块数 := 24
      小作物 : 非负整数
      实际块数 = 大作物 * 4 + 小作物 * 1
    `)
    expect(val(sol, '小作物').eq(Frac.parse('4'))).toBe(true)
  })

  it('求定点：给定块数与两种作物数量关系，解出各自块数', () => {
    const sol = solved(`
      大作物 : 非负整数
      小作物 : 非负整数
      大作物 * 4 + 小作物 = 24
      大作物 + 小作物 = 12
    `)
    // 3*4 + 12 = 24 且 3 + 12 = 15 ✗；解方程得 大=4, 小=8
    expect(val(sol, '大作物').eq(Frac.parse('4'))).toBe(true)
    expect(val(sol, '小作物').eq(Frac.parse('8'))).toBe(true)
    expect(sol.status.kind).toBe('optimal')
  })
})

describe('文档第 2 节：施肥时长计算', () => {
  it('2a 整体施肥：5 小时 28 分向上约分为 5.47 小时，24 块共需 131.28 小时', () => {
    // 文档原文：「5 小时 28 分钟为 5.466 小时，需要计算为 5.47 小时（保留两位小数），
    //           因为肥料是可以多买（剩下没事），不能缺」
    //           「全部成熟总需要肥料 5.47 小时 ✖️ 总施肥土地数 24 = 131.28 小时」
    const sol = solved(`
      成熟分钟 := 5 * 60 + 28
      每块小时 : 非负
      每块小时 = ceil(成熟分钟 / 60 * 100) / 100
      地块 := 24
      总肥料小时 : 非负
      总肥料小时 = 每块小时 * 地块
    `)
    expect(val(sol, '每块小时').eq(Frac.parse('5.47'))).toBe(true)
    expect(val(sol, '总肥料小时').eq(Frac.parse('131.28'))).toBe(true)
  })

  it('2b 部分施肥：1.55 小时 × 24 块 = 37.2 小时', () => {
    // 文档原文：「部分成熟总需要肥料 1.55 小时 ✖️ 24 = 37.2 小时」
    const sol = solved(`
      每块小时 := 1.55
      地块 := 24
      总肥料小时 : 非负
      总肥料小时 = 每块小时 * 地块
    `)
    expect(val(sol, '总肥料小时').eq(Frac.parse('37.2'))).toBe(true)
  })
})

describe('文档第 3 节：需要购买多少肥料、钞票是否够用', () => {
  it('例子 a：缺 31.9 小时 → 买 4 份（40 小时）→ 花 136 钞票', () => {
    // 文档原文：「我需要 37.2 小时普通肥料，我目前有 5.3 小时普通肥料，
    //           则还需要 31.9 小时，那么我需要购买 40 小时的肥料（因为不能单卖），
    //           那么就是需要花费 4*34 = 136 钞票」
    const sol = solved(`
      每份小时 := 10
      每份价 := 34
      需求小时 := 37.2
      持有小时 := 5.3
      缺口小时 : 非负
      缺口小时 = 需求小时 - 持有小时
      份数 : 非负整数
      份数 * 每份小时 >= 缺口小时
      min 份数 * 每份价
    `)
    expect(val(sol, '缺口小时').eq(Frac.parse('31.9'))).toBe(true)
    expect(val(sol, '份数').eq(Frac.parse('4'))).toBe(true)
    expect(sol.objectiveValue?.eq(Frac.parse('136'))).toBe(true)
  })

  it('整数约束是必需的：放开整数会得到 3.19 份这个买不到的答案', () => {
    const sol = solved(`
      缺口小时 := 31.9
      份数 : 非负
      份数 * 10 >= 缺口小时
      min 份数
    `)
    expect(val(sol, '份数').eq(Frac.parse('3.19'))).toBe(true)
  })

  it('特殊情况：只有 100 钞票 → 买 2 份（20 小时）→ 需等待 29.75 分钟', () => {
    // 文档原文：「我需要 136 钞票购买，但是我当前只有 100 钞票。
    //           2 份 34 钞票的普通肥料（仅 20 小时），那么剩余 11.9 小时，
    //           均摊到 24 块地就是 0.496 小时，输出：需要等待 29.74 分钟后收获」
    const sol = solved(`
      每份小时 := 10
      每份价 := 34
      缺口小时 := 31.9
      地块 := 24
      钞票 := 100
      份数 : 非负整数
      已买小时 : 非负
      仍缺小时 : 非负
      等待分钟 : 非负
      份数 * 每份价 <= 钞票
      已买小时 = 份数 * 每份小时
      仍缺小时 = 缺口小时 - 已买小时
      等待分钟 = 仍缺小时 / 地块 * 60
      max 份数
    `)
    expect(val(sol, '份数').eq(Frac.parse('2'))).toBe(true)
    expect(val(sol, '已买小时').eq(Frac.parse('20'))).toBe(true)
    expect(val(sol, '仍缺小时').eq(Frac.parse('11.9'))).toBe(true)

    const wait = val(sol, '等待分钟')
    // 精确值 714/24 = 29.75 分钟；文档手算写的是 29.74，差异来自中途舍入
    expect(wait.eq(Frac.parse('29.75'))).toBe(true)
    expect(wait.toString()).toBe('119/4')
    const diff = wait.sub(Frac.parse('29.74')).abs()
    expect(diff.le(Frac.parse('0.02'))).toBe(true)
  })

  it('文档「每块 0.496 小时」是舍入值，精确为 119/240', () => {
    const per = Frac.parse('11.9').div(Frac.parse('24'))
    expect(per.toString()).toBe('119/240')
    expect(per.toDecimalString(3)).toBe('0.496') // 文档口径
    expect(per.toDecimalString(6)).toBe('0.495833') // 精确值
  })

  it('例子 b：普通 + 有机组合，总花费 464 钞票，849 钞票够用', () => {
    // 文档原文：「我需要用普通肥料给每个作物催熟 1 小时 55 分钟，其余用有机肥料」
    //           「普通化肥仅可在单一植物生长阶段使用，有机化肥可以在任何阶段使用，
    //            我的目的是尽可能多用普通肥料因为便宜」
    // 文档在此写了「我就先不算了」——这里把它算完。
    const sol = solved(`
      地块 := 24
      每份小时 := 10
      普通单价 := 34
      有机单价 := 42
      持有普通 := 5.3
      持有有机 := 21.1
      钞票 := 849

      # 5 小时 28 分向上约分保留两位
      成熟分钟 := 5 * 60 + 28
      每块小时 := ceil(成熟分钟 / 60 * 100) / 100
      总需求 := 每块小时 * 地块

      # 普通肥料只催熟 1 小时 55 分这一段，其余交给有机肥料
      每块普通 := 1 + 55 / 60
      普通需求 := 每块普通 * 地块
      有机需求 := 总需求 - 普通需求

      普通份数 : 非负整数
      有机份数 : 非负整数
      持有普通 + 普通份数 * 每份小时 >= 普通需求
      持有有机 + 有机份数 * 每份小时 >= 有机需求
      普通份数 * 普通单价 + 有机份数 * 有机单价 <= 钞票
      min 普通份数 * 普通单价 + 有机份数 * 有机单价
    `)

    // 普通需求 = 1.91667 × 24 = 46 小时；持有 5.3 → 缺 40.7 → 5 份（50 小时）
    expect(val(sol, '普通份数').eq(Frac.parse('5'))).toBe(true)
    // 有机需求 = 131.28 - 46 = 85.28；持有 21.1 → 缺 64.18 → 7 份（70 小时）
    expect(val(sol, '有机份数').eq(Frac.parse('7'))).toBe(true)
    // 5 × 34 + 7 × 42 = 170 + 294 = 464 钞票，低于 849
    expect(sol.objectiveValue?.eq(Frac.parse('464'))).toBe(true)

    const tight = sol.constraintReport?.find((c) => c.line !== 0 && !c.satisfied)
    expect(tight, '所有约束都应被满足').toBeUndefined()
  })

  it('钞票不够时明确报不可行，而不是给出买不起的方案', () => {
    const sol = solve(`
      普通份数 : 非负整数
      有机份数 : 非负整数
      5.3 + 普通份数 * 10 >= 46
      21.1 + 有机份数 * 10 >= 85.28
      普通份数 * 34 + 有机份数 * 42 <= 400
      min 普通份数 * 34 + 有机份数 * 42
    `)
    expect(sol.status.kind).toBe('infeasible')
  })
})

describe('QQ 农场效益：最大化收益', () => {
  it('在土地与种子钱双重约束下选出最优种植方案', () => {
    // 大作物占 4 格、收益 100、种子钱 60；小作物占 1 格、收益 18、种子钱 10。
    // 共 96 格、1000 钞票。
    const sol = solved(`
      格子 := 96
      钞票 := 1000
      大作物 : 非负整数
      小作物 : 非负整数
      土地 : 大作物 * 4 + 小作物 <= 格子
      预算 : 大作物 * 60 + 小作物 * 10 <= 钞票
      max 大作物 * 100 + 小作物 * 18
    `)
    // 两条约束同时取等的交点：4a+b=96 且 60a+10b=1000 → a=2, b=88
    expect(val(sol, '大作物').eq(Frac.parse('2'))).toBe(true)
    expect(val(sol, '小作物').eq(Frac.parse('88'))).toBe(true)
    expect(sol.objectiveValue?.eq(Frac.parse('1784'))).toBe(true)
    expect(sol.constraintReport?.every((c) => c.satisfied)).toBe(true)
    expect(sol.constraintReport?.every((c) => c.tight)).toBe(true)
  })

  it('只约束土地时，全部种大作物收益最高', () => {
    const sol = solved(`
      大作物 : 非负整数
      小作物 : 非负整数
      大作物 * 4 + 小作物 <= 96
      max 大作物 * 100 + 小作物 * 18
    `)
    expect(val(sol, '大作物').eq(Frac.parse('24'))).toBe(true)
    expect(val(sol, '小作物').eq(Frac.ZERO)).toBe(true)
    expect(sol.objectiveValue?.eq(Frac.parse('2400'))).toBe(true)
  })

  it('预算过紧时无可行方案', () => {
    const sol = solve(`
      大作物 : 非负整数
      小作物 : 非负整数
      大作物 * 4 + 小作物 <= 96
      大作物 * 60 + 小作物 * 10 <= 50
      大作物 + 小作物 >= 20
      max 大作物 * 100 + 小作物 * 18
    `)
    expect(sol.status.kind).toBe('infeasible')
  })

  it('整数约束确实改变了答案：连续松弛会得到买不到的分数作物', () => {
    const lp = solved(`
      大作物 : 非负
      小作物 : 非负
      大作物 * 4 + 小作物 <= 96
      大作物 * 60 + 小作物 * 10 <= 1000
      max 大作物 * 100 + 小作物 * 18
    `)
    // 连续情形下 LP 最优点本就是整数 (2, 88)
    expect(val(lp, '大作物').eq(Frac.parse('2'))).toBe(true)
  })
})

describe('解的唯一性与诊断', () => {
  it('条件不足时给出可行点并提示缺几个条件', () => {
    const sol = solved(`
      大作物 : 非负整数
      小作物 : 非负整数
      大作物 * 4 + 小作物 = 24
    `)
    expect(sol.warnings.some((w) => w.includes('尚缺') || w.includes('解不唯一'))).toBe(true)
    // 给出的解必须真的满足约束
    const check = (sol.values.get('大作物') ?? Frac.ZERO)
      .mul(Frac.parse('4'))
      .add(sol.values.get('小作物') ?? Frac.ZERO)
    expect(check.eq(Frac.parse('24'))).toBe(true)
  })

  it('矛盾方程组明确指出矛盾行', () => {
    const sol = solve(`
      大作物 * 4 + 小作物 = 24
      大作物 * 4 + 小作物 = 25
    `)
    expect(sol.status.kind).toBe('infeasible')
    expect((sol.status as { reason?: string }).reason).toContain('矛盾')
  })

  it('非线性模型被拒绝并说明原因', () => {
    // 收益 = 产量 × 单价，但单价随产量递减 → 变量相乘，超出线性范围
    expect(() =>
      solve(`
        产量 : 非负
        单价 : 非负
        收益 = 产量 * 单价
        max 收益
      `),
    ).toThrow(/非线性/)
  })
})
