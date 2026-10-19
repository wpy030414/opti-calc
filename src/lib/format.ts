import { Frac } from '@/solver/frac'

/**
 * 展示层格式化。
 *
 * 求解器内部一律用精确有理数，但「24」「5.47」「119/240」这三种写法
 * 在界面上给一般人的观感完全不同，因此这里集中处理三件事：
 * 精确小数的判定、分数的近似展示、以及金额/时长这类带单位场景的取舍。
 */

/** 精确值：整数或有限小数时给出无误差的写法。 */
export function exactText(v: Frac): string {
  if (v.d === 1n) return v.n.toString()
  if (v.terminates) return v.toDecimalString(12)
  return v.toString()
}

/**
 * 主展示值。
 *
 * 有限小数直接给小数（`5.47`）；无限小数给「分数 ≈ 小数」（`119/240 ≈ 0.495833`），
 * 因为算账场景里用户需要看到精确分数才敢信这个数。
 */
export function displayValue(v: Frac, digits = 6): string {
  if (v.d === 1n) return v.n.toString()
  if (v.terminates) return v.toDecimalString(12)
  return `${v.toString()} ≈ ${v.toDecimalString(digits)}`
}

/** 近似值，用于图表 / 紧凑表格。 */
export function approxValue(v: Frac, digits = 4): string {
  return v.toDecimalString(digits)
}

/** 百分比文本，如 0.0081 → 「0.81%」。用于损失率展示。 */
export function percentText(v: Frac, digits = 2): string {
  return `${v.mul(Frac.parse('100')).toDecimalString(digits)}%`
}

/** 是否为整数（用于决定要不要显示小数部分）。 */
export function isIntegral(v: Frac): boolean {
  return v.d === 1n
}

/** 时长（小时）→ 「x 小时 y 分钟」，便于对照游戏内界面。 */
export function hoursToClock(v: Frac): string {
  const totalMinutes = v.mul(Frac.parse('60'))
  const whole = totalMinutes.d === 1n ? totalMinutes.n : 0n
  if (whole === 0n) return `${displayValue(v)} 小时`
  const h = whole / 60n
  const m = whole % 60n
  if (h === 0n) return `${m} 分钟`
  if (m === 0n) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}
