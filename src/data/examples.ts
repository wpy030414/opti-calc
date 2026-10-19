/**
 * 内置示例。
 *
 * 前四个直接取自《实际有效施肥土地块数计算》这份真实算账文档
 * （地块数反解、施肥时长、钱不够时的等待时长、普通+有机组合），
 * 数字经 E2E 测试（tests/e2e/qq-farm.test.ts）逐条校验。
 * 后四个为覆盖其它模型形态而构造：收益最大化、配料配比、盈亏平衡、条件不足诊断。
 *
 * 示例是产品「面向一般人群」的关键入口——用户不必先学 DSL，
 * 挑一个接近自己问题的算例改数字即可上手。
 */

export interface Example {
  id: string
  title: string
  /** 一句话说清这个例子在算什么。 */
  summary: string
  /** 问题类型标签，用于列表分组。 */
  kind: '定点' | '最优' | '整数规划' | '组合'
  source: string
}

const QQ_FARM_BLOCKS: Example = {
  id: 'qq-farm-blocks',
  title: '施肥地块数反解',
  summary: '大作物占 4 格、小作物占 1 格，已知总块数求小作物有几块。',
  kind: '定点',
  source: `# 大作物 1 株占 4 格，小作物 1 株占 1 格
大作物 := 5
实际块数 := 24

小作物 : 非负整数
实际块数 = 大作物 * 4 + 小作物 * 1
`,
}

const QQ_FARM_FERTILIZER: Example = {
  id: 'qq-farm-fertilizer',
  title: '施肥时长与肥料份数',
  summary: '成熟 5 小时 28 分向上约分为 5.47 小时，24 块共需 131.28 小时肥料。',
  kind: '定点',
  source: `# 肥料可以多买（剩下没事），但不能缺，所以时长向多的方向约分保留两位小数
成熟分钟 := 5 * 60 + 28
每块小时 : 非负
每块小时 = ceil(成熟分钟 / 60 * 100) / 100

地块 := 24
总肥料小时 : 非负
总肥料小时 = 每块小时 * 地块
`,
}

const QQ_FARM_BUDGET: Example = {
  id: 'qq-farm-budget',
  title: '钱不够时要等多久',
  summary: '缺 31.9 小时肥料但只有 100 钞票，最多买 2 份，剩下的摊到 24 块地要等 29.75 分钟。',
  kind: '整数规划',
  source: `# 普通肥料 34 钞票 / 份，每份 10 小时，不能单卖
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
`,
}

const QQ_FARM_COMBO: Example = {
  id: 'qq-farm-combo',
  title: '普通 + 有机肥料最省组合',
  summary: '普通肥料便宜但只能催熟一个阶段，有机肥料任意阶段可用，求最省钱的买法。',
  kind: '最优',
  source: `# 普通化肥只能在一个生长阶段内用，有机化肥任意阶段可用
# 目标是尽可能多用便宜的普通化肥
地块 := 24
每份小时 := 10
普通单价 := 34
有机单价 := 42
持有普通 := 5.3
持有有机 := 21.1
钞票 := 849

成熟分钟 := 5 * 60 + 28
每块小时 := ceil(成熟分钟 / 60 * 100) / 100
总需求 := 每块小时 * 地块

每块普通 := 1 + 55 / 60
普通需求 := 每块普通 * 地块
有机需求 := 总需求 - 普通需求

普通份数 : 非负整数
有机份数 : 非负整数
持有普通 + 普通份数 * 每份小时 >= 普通需求
持有有机 + 有机份数 * 每份小时 >= 有机需求
预算 : 普通份数 * 普通单价 + 有机份数 * 有机单价 <= 钞票

min 普通份数 * 普通单价 + 有机份数 * 有机单价
`,
}

const QQ_FARM_PROFIT: Example = {
  id: 'qq-farm-profit',
  title: '种什么最赚钱',
  summary: '96 格土地、1000 钞票预算，在两种作物间分配使总收益最大。',
  kind: '组合',
  source: `# 大作物：占 4 格，种子钱 60，收益 100
# 小作物：占 1 格，种子钱 10，收益 18
格子 := 96
钞票 := 1000

大作物 : 非负整数
小作物 : 非负整数

土地 : 大作物 * 4 + 小作物 <= 格子
预算 : 大作物 * 60 + 小作物 * 10 <= 钞票

max 大作物 * 100 + 小作物 * 18
`,
}

const MIXTURE: Example = {
  id: 'mixture',
  title: '配料比例',
  summary: '两种原料按营养与成本约束配比，求最省钱的混合方案。',
  kind: '最优',
  source: `# 甲料：每份蛋白 3、脂肪 1、价 8
# 乙料：每份蛋白 1、脂肪 2、价 6
甲 : 非负
乙 : 非负

蛋白 : 甲 * 3 + 乙 * 1 >= 12
脂肪 : 甲 * 1 + 乙 * 2 >= 8
甲 <= 6

min 甲 * 8 + 乙 * 6
`,
}

const BREAK_EVEN: Example = {
  id: 'break-even',
  title: '盈亏平衡点',
  summary: '固定成本摊到单价与变动成本之差上，求保本销量。',
  kind: '定点',
  source: `固定成本 := 12000
单价 := 45
单位变动成本 := 21

保本量 : 非负整数
收入 := 单价 * 保本量
支出 := 固定成本 + 单位变动成本 * 保本量
收入 = 支出
`,
}

const UNIQUE_CHECK: Example = {
  id: 'unique-check',
  title: '条件不足的方程组',
  summary: '三个未知数只有两个方程，求解器会指出还缺一个条件并给出其中一个解。',
  kind: '定点',
  source: `苹果 : 非负整数
香蕉 : 非负整数
橘子 : 非负整数

苹果 + 香蕉 + 橘子 = 20
苹果 + 2 * 香蕉 = 25
`,
}

export const EXAMPLES: Example[] = [
  QQ_FARM_BLOCKS,
  QQ_FARM_FERTILIZER,
  QQ_FARM_BUDGET,
  QQ_FARM_COMBO,
  QQ_FARM_PROFIT,
  MIXTURE,
  BREAK_EVEN,
  UNIQUE_CHECK,
]

export const DEFAULT_SOURCE = QQ_FARM_BUDGET.source

export function findExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id)
}
