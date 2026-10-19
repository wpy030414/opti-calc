import { describe, it, expect } from 'vite-plus/test'
import { solve } from '@/solver/solve'
import { Frac } from '@/solver/frac'

/**
 * 参数替换单元测试。
 *
 * 参数替换不修改求解器内核——它只是把 DSL 中的 `paramName := oldValue`
 * 行替换为 `paramName := newValue`，然后调用 `solve()` 得到新结果。
 *
 * 这些测试验证字符串替换逻辑以及参数化求解的端到端正确性。
 */

/** 行级替换：把 DSL 中 `name := ...` 替换为 `name := value`。 */
function substituteParams(source: string, paramValues: Record<string, string>): string {
  const lines = source.split('\n')
  const result = lines.map((line) => {
    for (const [name, val] of Object.entries(paramValues)) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`^(\\s*${esc}\\s*:=\\s*).*$`)
      const m = line.match(re)
      if (m) return `${m[1]}${val}`
    }
    return line
  })
  return result.join('\n')
}

function extractConstValue(source: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*${esc}\\s*:=\\s*(.*?)$`, 'm')
  const m = source.match(re)
  return m?.[1]?.trim() ?? ''
}

function solved(source: string) {
  const sol = solve(source)
  expect(sol.status.kind).toBe('optimal')
  return sol
}

function val(sol: ReturnType<typeof solved>, name: string): Frac {
  const v = sol.values.get(name)
  expect(v, `variable "${name}" not found`).toBeDefined()
  return v!
}

// ── 字符串替换 ─────────────────────────────────────────────────

describe('substituteParams 字符串替换', () => {
  it('基本替换：单参数', () => {
    const src = 'x := 10\nx + y = 5'
    const result = substituteParams(src, { x: '20' })
    expect(result).toBe('x := 20\nx + y = 5')
  })

  it('多参数替换', () => {
    const src = 'a := 1\nb := 2\nx + y = a + b'
    const result = substituteParams(src, { a: '10', b: '20' })
    expect(result).toBe('a := 10\nb := 20\nx + y = a + b')
  })

  it('参数名是另一个常量的前缀时不误替换', () => {
    const src = 'x := 1\nxx := 2'
    const result = substituteParams(src, { x: '10' })
    expect(result).toBe('x := 10\nxx := 2')
  })

  it('注释行不会被匹配', () => {
    const src = '# x := 5 这是注释\nx := 10'
    const result = substituteParams(src, { x: '20' })
    expect(result).toBe('# x := 5 这是注释\nx := 20')
  })

  it('参数不在 DSL 中不报错', () => {
    const src = 'y := 20'
    const result = substituteParams(src, { x: '10' })
    expect(result).toBe(src)
  })

  it('空 paramValues 返回原 DSL', () => {
    const src = 'x := 10\ny := 20'
    const result = substituteParams(src, {})
    expect(result).toBe(src)
  })

  it('参数值为复杂表达式——原样插入', () => {
    const src = 'price := 34'
    const result = substituteParams(src, { price: '3.14 * 2 + 1' })
    expect(result).toBe('price := 3.14 * 2 + 1')
  })

  it('中文标识符', () => {
    const src = '单价 := 34\n数量 : 非负整数\n总价 := 单价 * 数量\n总价 = 100'
    const result = substituteParams(src, { 单价: '50' })
    expect(result).toBe('单价 := 50\n数量 : 非负整数\n总价 := 单价 * 数量\n总价 = 100')
  })

  it('保持原有缩进', () => {
    const src = '  price := 34\n  amount : 非负整数'
    const result = substituteParams(src, { price: '50' })
    expect(result).toBe('  price := 50\n  amount : 非负整数')
  })
})

// ── extractConstValue ───────────────────────────────────────────

describe('extractConstValue 提取常量表达式', () => {
  it('提取存在的常量值', () => {
    expect(extractConstValue('x := 10\ny := 20', 'x')).toBe('10')
    expect(extractConstValue('x := 10\ny := 20', 'y')).toBe('20')
  })

  it('提取含表达式的值', () => {
    expect(extractConstValue('price := 34 / 10', 'price')).toBe('34 / 10')
  })

  it('常量不存在返回空字符串', () => {
    expect(extractConstValue('x := 10', 'nonexistent')).toBe('')
  })

  it('中文常量名', () => {
    expect(extractConstValue('单价 := 34 / 10', '单价')).toBe('34 / 10')
  })
})

// ── 端到端：替换 + solve ───────────────────────────────────────

describe('参数替换后求解端到端', () => {
  const baseModel = `
    固定成本 := 12000
    单价 := 45
    单位变动成本 := 21
    保本量 : 非负
    收入 : 非负
    支出 : 非负
    收入 = 单价 * 保本量
    支出 = 固定成本 + 单位变动成本 * 保本量
    收入 = 支出
  `

  it('原始参数值：保本量 = 500', () => {
    const sol = solved(baseModel)
    expect(val(sol, '保本量').eq(Frac.parse('500'))).toBe(true)
  })

  it('涨价后保本量降低', () => {
    const src = substituteParams(baseModel, { 单价: '60' })
    const sol = solved(src)
    // 12000 / (60 - 21) = 12000 / 39 ≈ 307.69
    expect(val(sol, '保本量').eq(Frac.parse('12000/39'))).toBe(true)
  })

  it('成本降低后保本量降低', () => {
    const src = substituteParams(baseModel, { 固定成本: '6000' })
    const sol = solved(src)
    // 6000 / (45 - 21) = 6000 / 24 = 250
    expect(val(sol, '保本量').eq(Frac.parse('250'))).toBe(true)
  })

  it('参数值使模型无解时返回 infeasible', () => {
    // 单价 <= 变动成本 → 利润率为负或零，需要负的保本量（但变量为非负）
    const src = substituteParams(baseModel, { 单价: '10' })
    const sol = solve(src)
    expect(sol.status.kind).toBe('infeasible')
  })
})

// ── QQ Farm 模型参数替换 ──────────────────────────────────────

describe('QQ Farm 预算模型参数替换', () => {
  const qqFarm = `
    每包小时 := 10
    单价 := 34
    总缺口 := 31.9
    地块数 := 24
    手头现金 := 100
    份数 : 非负整数
    已买小时 : 非负
    仍缺小时 : 非负
    等待分钟 : 非负
    手头现金 >= 份数 * 单价
    已买小时 = 每包小时 * 份数
    仍缺小时 = 总缺口 - 已买小时
    等待分钟 = 仍缺小时 * 60 / 地块数
    max 份数
  `

  it('原始参数：最多买 2 包', () => {
    const sol = solved(qqFarm)
    expect(val(sol, '份数').eq(Frac.parse('2'))).toBe(true)
  })

  it('增加预算到 200：可以买更多', () => {
    const src = substituteParams(qqFarm, { 手头现金: '200' })
    const sol = solved(src)
    // 200 / 34 = 5.88..., 最多 5 包，但受缺口约束（31.9 小时 / 10 = 3.19 包→3 包）
    expect(val(sol, '份数').eq(Frac.parse('3'))).toBe(true)
  })

  it('缺口扩大：需更多包', () => {
    const src = substituteParams(qqFarm, { 总缺口: '50' })
    const sol = solved(src)
    // 50 小时需要 5 包，但预算只够 2 包（100 / 34 = 2.94）
    expect(val(sol, '份数').eq(Frac.parse('2'))).toBe(true)
  })

  it('同时改预算和缺口', () => {
    const src = substituteParams(qqFarm, { 手头现金: '500', 总缺口: '50' })
    const sol = solved(src)
    // 500 / 34 = 14.7 包，50 / 10 = 5 包 → 取 min = 5
    expect(val(sol, '份数').eq(Frac.parse('5'))).toBe(true)
  })
})
