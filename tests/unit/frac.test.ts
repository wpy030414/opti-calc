import { describe, it, expect } from 'vite-plus/test'
import { Frac, ceilDiv, floorDiv, roundDiv } from '@/solver/frac'

describe('Frac 精确有理数', () => {
  it('十进制解析不引入浮点误差', () => {
    // 这是整套求解器的地基：0.1 必须是精确的 1/10，而非 IEEE 754 近似
    expect(Frac.parse('0.1').eq(Frac.make(1n, 10n))).toBe(true)
    expect(Frac.parse('5.47').eq(Frac.make(547n, 100n))).toBe(true)
    expect(Frac.parse('0.3').eq(Frac.parse('0.1').add(Frac.parse('0.2')))).toBe(true)
  })

  it('归一化：约分且分母恒为正', () => {
    const f = Frac.make(4n, -6n)
    expect(f.n).toBe(-2n)
    expect(f.d).toBe(3n)
    expect(Frac.make(0n, 5n).toString()).toBe('0')
  })

  it('零的表示唯一', () => {
    expect(Frac.make(0n, 7n).eq(Frac.ZERO)).toBe(true)
    expect(Frac.ZERO.isZero).toBe(true)
  })

  it('四则运算保持精确', () => {
    const a = Frac.parse('5.47')
    const b = Frac.parse('24')
    expect(a.mul(b).eq(Frac.parse('131.28'))).toBe(true)
    expect(Frac.parse('1.55').mul(b).eq(Frac.parse('37.2'))).toBe(true)
    expect(Frac.parse('37.2').sub(Frac.parse('5.3')).eq(Frac.parse('31.9'))).toBe(true)
  })

  it('除法与倒数', () => {
    expect(Frac.parse('11.9').div(Frac.parse('24')).toString()).toBe('119/240')
    expect(Frac.parse('3/4').inv().eq(Frac.parse('4/3'))).toBe(true)
    expect(() => Frac.parse('1').div(Frac.ZERO)).toThrow()
  })

  it('QQ 农场算例：11.9 小时缺口摊到 24 块地等于 29.75 分钟', () => {
    // 原始文档写的是 29.74 分钟，那是先把 11.9/24 舍入成 0.496 再乘 60 造成的精度损失。
    // 精确值是 11.9/24*60 = 714/24 = 119/4 = 29.75 分钟，一分不差。
    const minutes = Frac.parse('11.9').div(Frac.parse('24')).mul(Frac.parse('60'))
    expect(minutes.eq(Frac.parse('29.75'))).toBe(true)
    expect(minutes.toString()).toBe('119/4')
    expect(minutes.toDecimalString(2)).toBe('29.75')
  })

  it('整数幂', () => {
    expect(Frac.parse('2').pow(10n).eq(Frac.fromBigInt(1024n))).toBe(true)
    expect(Frac.parse('2').pow(-2n).eq(Frac.parse('0.25'))).toBe(true)
    expect(Frac.parse('7').pow(0n).eq(Frac.ONE)).toBe(true)
    expect(() => Frac.ZERO.pow(-1n)).toThrow()
  })

  it('比较与极值', () => {
    expect(Frac.parse('1/3').lt(Frac.parse('1/2'))).toBe(true)
    expect(Frac.parse('-1/3').gt(Frac.parse('-1/2'))).toBe(true)
    expect(Frac.parse('1/3').cmp(Frac.parse('2/6'))).toBe(0)
    expect(Frac.parse('1.5').min(Frac.parse('2')).eq(Frac.parse('1.5'))).toBe(true)
  })

  it('向上取整：肥料只能多买不能少', () => {
    // 缺口 31.9 小时，每份 10 小时，31.9/10 = 3.19 份 → 必须买 4 份
    const shares = Frac.parse('31.9').div(Frac.parse('10'))
    expect(shares.eq(Frac.parse('3.19'))).toBe(true)
    expect(ceilDiv(shares.n, shares.d)).toBe(4n)
    // 整数份不应多买：30/10 = 3 份恰好
    const exact = Frac.parse('30').div(Frac.parse('10'))
    expect(ceilDiv(exact.n, exact.d)).toBe(3n)
    // 文档口径：5 小时 28 分 = 5.4667 小时，「向多的方向约分」得 5.47
    const h28 = Frac.make(28n, 60n).add(Frac.parse('5'))
    expect(h28.roundToDigits(2, 'up').eq(Frac.parse('5.47'))).toBe(true)
  })

  it('roundToDigits 三种舍入模式', () => {
    const v = Frac.parse('5.4666')
    expect(v.roundToDigits(2, 'nearest').eq(Frac.parse('5.47'))).toBe(true)
    expect(v.roundToDigits(2, 'up').eq(Frac.parse('5.47'))).toBe(true)
    expect(v.roundToDigits(2, 'down').eq(Frac.parse('5.46'))).toBe(true)
    // 文档口径：5 小时 28 分 = 5.4667 小时，「向多的方向约分」得 5.47
    const h28 = Frac.make(28n, 60n).add(Frac.parse('5'))
    expect(h28.roundToDigits(2, 'up').eq(Frac.parse('5.47'))).toBe(true)
  })

  it('toDecimalString 处理负数与整数', () => {
    expect(Frac.parse('-5.47').toDecimalString(2)).toBe('-5.47')
    expect(Frac.parse('3').toDecimalString(2)).toBe('3')
    expect(Frac.parse('-0.5').toDecimalString(2)).toBe('-0.5')
  })

  it('terminates 判断有限小数', () => {
    expect(Frac.parse('0.25').terminates).toBe(true)
    expect(Frac.parse('1/3').terminates).toBe(false)
    expect(Frac.parse('1/6').terminates).toBe(false)
  })

  it('floorDiv / ceilDiv / roundDiv 的负数语义', () => {
    expect(floorDiv(-7n, 2n)).toBe(-4n)
    expect(ceilDiv(-7n, 2n)).toBe(-3n)
    expect(roundDiv(7n, 2n)).toBe(4n)
    expect(roundDiv(-7n, 2n)).toBe(-4n)
    expect(() => floorDiv(1n, 0n)).toThrow()
  })

  it('from 便捷入口接受多种类型', () => {
    expect(Frac.of(0.1).eq(Frac.parse('0.1'))).toBe(true)
    expect(Frac.of('2/3').eq(Frac.make(2n, 3n))).toBe(true)
    expect(Frac.of(5n).eq(Frac.fromBigInt(5n))).toBe(true)
    const f = Frac.parse('1.5')
    expect(Frac.of(f)).toBe(f)
  })

  it('科学计数法与非有限值', () => {
    expect(Frac.parse('1e3').eq(Frac.fromBigInt(1000n))).toBe(true)
    expect(Frac.parse('1.5e-2').eq(Frac.parse('0.015'))).toBe(true)
    expect(() => Frac.of(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => Frac.of(Number.NaN)).toThrow()
  })

  it('全角字符归一化', () => {
    // 中文输入法下很容易打出全角数字与括号，必须能正常解析
    expect(Frac.parse('５.４７').eq(Frac.parse('5.47'))).toBe(true)
  })
})
