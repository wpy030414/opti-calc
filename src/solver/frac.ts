import { NumericError } from './errors'

/**
 * 精确有理数。
 *
 * 全流程使用 BigInt 分子 / 分母，不做任何浮点近似。这是本求解器的地基：
 * 「QQ 农场」这类算账场景里，0.1 + 0.2 必须等于 0.3，
 * 且 11.9 / 24 * 60 必须精确得到 29.75 分钟而非 29.749999。
 *
 * 不变量：`d > 0`，且 `gcd(|n|, d) === 1`。零统一表示为 `0/1`。
 */

function bigAbs(v: bigint): bigint {
  return v < 0n ? -v : v
}

/** 最大公约数；两个参数都为 0 时返回 1，避免构造出 0/0。 */
export function gcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a)
  let y = bigAbs(b)
  while (y !== 0n) {
    const t = x % y
    x = y
    y = t
  }
  return x === 0n ? 1n : x
}

/** 向下取整除法（d 必须为正）。JS 的 BigInt 除法是向零截断，负数需要修正。 */
export function floorDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new NumericError('floorDiv 要求除数为正')
  const q = n / d
  return n % d !== 0n && n < 0n ? q - 1n : q
}

/** 向上取整除法（d 必须为正）。 */
export function ceilDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new NumericError('ceilDiv 要求除数为正')
  const q = n / d
  return n % d !== 0n && n > 0n ? q + 1n : q
}

/** 四舍五入（远离零方向，符合日常「保留两位小数」的直觉）。 */
export function roundDiv(n: bigint, d: bigint): bigint {
  const sign = n < 0n ? -1n : 1n
  const abs = bigAbs(n)
  return sign * floorDiv(2n * abs + d, 2n * d)
}

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/
/** 分数写法 `a/b`（分子可带符号），用于回读 `toString()` 的输出。 */
const FRACTION_RE = /^([+-]?)(\d+)\s*\/\s*(\d+)$/

/** 全角数字与符号（U+FF01..U+FF5E）1:1 映射到 ASCII，不改变字符偏移。 */
const FULLWIDTH_OFFSET = 0xfee0

export function normalizeWidth(src: string): string {
  let out = ''
  for (const ch of src) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out += String.fromCodePoint(cp - FULLWIDTH_OFFSET)
    } else if (cp === 0x3000) {
      out += ' '
    } else {
      out += ch
    }
  }
  return out
}

export type RoundMode = 'nearest' | 'up' | 'down'

export class Frac {
  readonly n: bigint
  readonly d: bigint

  private constructor(n: bigint, d: bigint) {
    this.n = n
    this.d = d
  }

  /** 构造并归一化。`d` 为 0 时抛错。 */
  static make(n: bigint, d: bigint): Frac {
    if (d === 0n) throw new NumericError('分母不能为 0')
    if (n === 0n) return Frac.ZERO
    let sign = 1n
    if (d < 0n) {
      sign = -1n
    }
    const g = gcd(n, d)
    return new Frac((sign * n) / g, (sign * d) / g)
  }

  static fromBigInt(v: bigint): Frac {
    return v === 0n ? Frac.ZERO : new Frac(v, 1n)
  }

  /**
   * 从 number 构造。走 `String(v)` 再按十进制解析，
   * 因此 `Frac.of(0.1)` 得到的是精确的 1/10，而不是 0.1 的 IEEE 754 二进制近似。
   */
  static of(v: number | bigint | string | Frac): Frac {
    if (v instanceof Frac) return v
    if (typeof v === 'bigint') return Frac.fromBigInt(v)
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new NumericError(`无法精确表示数值：${v}`)
      return Frac.parse(String(v))
    }
    return Frac.parse(v)
  }

  /** 解析十进制字符串或 `a/b` 分数，支持小数与科学计数法，结果精确。 */
  static parse(src: string): Frac {
    const s = normalizeWidth(src.trim())
    const fm = FRACTION_RE.exec(s)
    if (fm) {
      const sign = fm[1] === '-' ? -1n : 1n
      const num = fm[2] ?? ''
      const den = fm[3] ?? ''
      if (num === '' || den === '') throw new NumericError(`无法解析为数值：「${src}」`)
      return Frac.make(sign * BigInt(num), BigInt(den))
    }
    const m = DECIMAL_RE.exec(s)
    if (!m) throw new NumericError(`无法解析为数值：「${src}」`)
    const sign = m[1] === '-' ? -1n : 1n
    const intPart = m[2] ?? ''
    const fracPart = m[3] ?? ''
    if (intPart === '' && fracPart === '') {
      throw new NumericError(`无法解析为数值：「${src}」`)
    }
    let num = BigInt(`${intPart}${fracPart}` === '' ? '0' : `${intPart}${fracPart}`)
    let den = 10n ** BigInt(fracPart.length)
    const exp = m[4]
    if (exp !== undefined && exp !== '') {
      const e = Number(exp)
      if (!Number.isSafeInteger(e)) throw new NumericError(`指数超出范围：「${src}」`)
      if (e >= 0) {
        num *= 10n ** BigInt(e)
      } else {
        den *= 10n ** BigInt(-e)
      }
    }
    return Frac.make(sign * num, den)
  }

  static readonly ZERO = new Frac(0n, 1n)
  static readonly ONE = new Frac(1n, 1n)

  get isZero(): boolean {
    return this.n === 0n
  }

  get isInteger(): boolean {
    return this.d === 1n
  }

  get isNegative(): boolean {
    return this.n < 0n
  }

  neg(): Frac {
    return this.n === 0n ? this : new Frac(-this.n, this.d)
  }

  abs(): Frac {
    return this.n < 0n ? this.neg() : this
  }

  inv(): Frac {
    if (this.n === 0n) throw new NumericError('不能对 0 求倒数')
    return Frac.make(this.d, this.n)
  }

  add(o: Frac): Frac {
    if (this.d === o.d) return Frac.make(this.n + o.n, this.d)
    return Frac.make(this.n * o.d + o.n * this.d, this.d * o.d)
  }

  sub(o: Frac): Frac {
    return this.add(o.neg())
  }

  mul(o: Frac): Frac {
    if (this.isZero || o.isZero) return Frac.ZERO
    // 交叉约分，避免 BigInt 无谓膨胀
    const g1 = gcd(this.n, o.d)
    const g2 = gcd(o.n, this.d)
    return new Frac((this.n / g1) * (o.n / g2), (this.d / g2) * (o.d / g1))
  }

  div(o: Frac): Frac {
    if (o.isZero) throw new NumericError('除数不能为 0')
    return this.mul(o.inv())
  }

  /** 整数次幂。负指数要求底数非零。 */
  pow(k: bigint): Frac {
    if (k === 0n) return Frac.ONE
    if (k < 0n) return this.inv().pow(-k)
    return Frac.powPositive(this, k)
  }

  /**
   * 二进制快速幂（正指数）。
   *
   * 提成静态方法而不是写成实例方法里的 `let base = this`：
   * 后者会被 lint 判为 this 别名，而这里确实需要逐轮平方，
   * 用参数传递比抑制警告更直接。
   */
  private static powPositive(base: Frac, k: bigint): Frac {
    let acc = Frac.ONE
    let b = base
    let exp = k
    while (exp > 0n) {
      if (exp & 1n) acc = acc.mul(b)
      b = b.mul(b)
      exp >>= 1n
    }
    return acc
  }

  cmp(o: Frac): number {
    if (this.d === o.d) {
      return this.n < o.n ? -1 : this.n > o.n ? 1 : 0
    }
    const l = this.n * o.d
    const r = o.n * this.d
    return l < r ? -1 : l > r ? 1 : 0
  }

  eq(o: Frac): boolean {
    return this.n === o.n && this.d === o.d
  }

  lt(o: Frac): boolean {
    return this.cmp(o) < 0
  }

  le(o: Frac): boolean {
    return this.cmp(o) <= 0
  }

  gt(o: Frac): boolean {
    return this.cmp(o) > 0
  }

  ge(o: Frac): boolean {
    return this.cmp(o) >= 0
  }

  min(o: Frac): Frac {
    return this.le(o) ? this : o
  }

  max(o: Frac): Frac {
    return this.ge(o) ? this : o
  }

  toBigInt(): bigint {
    return floorDiv(this.n, this.d)
  }

  /** 转为 JS number，仅用于展示与非关键路径；大数会损失精度。 */
  toNumber(): number {
    if (this.d === 1n) return Number(this.n)
    return Number(this.n) / Number(this.d)
  }

  /** 精确字符串：整数直接输出，否则输出 `n/d`。 */
  toString(): string {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`
  }

  /** 按指定小数位舍入后返回新的 Frac（仍是精确值）。 */
  roundToDigits(digits: number, mode: RoundMode = 'nearest'): Frac {
    if (!Number.isInteger(digits) || digits < 0) {
      throw new NumericError('小数位数必须是非负整数')
    }
    const scale = 10n ** BigInt(digits)
    const scaled = this.n * scale
    const q =
      mode === 'up'
        ? ceilDiv(scaled, this.d)
        : mode === 'down'
          ? floorDiv(scaled, this.d)
          : roundDiv(scaled, this.d)
    return Frac.make(q, scale)
  }

  /**
   * 展示用十进制字符串，按 `digits` 位舍入。
   *
   * 直接从「值 × 10^digits 的整数商」切分整数位与小数位，
   * 不依赖 `roundToDigits` 的返回值——后者会约分，分母不再是 10^digits，
   * 按位数硬切会错位（如 -1/2 被切成 `-0.01`）。
   */
  toDecimalString(digits = 6, mode: RoundMode = 'nearest'): string {
    if (!Number.isInteger(digits) || digits < 0) {
      throw new NumericError('小数位数必须是非负整数')
    }
    const scale = 10n ** BigInt(digits)
    const scaled = this.n * scale
    const q =
      mode === 'up'
        ? ceilDiv(scaled, this.d)
        : mode === 'down'
          ? floorDiv(scaled, this.d)
          : roundDiv(scaled, this.d)
    const sign = q < 0n ? '-' : ''
    const abs = bigAbs(q)
      .toString()
      .padStart(digits + 1, '0')
    const cut = abs.length - digits
    const intPart = abs.slice(0, cut)
    const fracPart = digits === 0 ? '' : abs.slice(cut).replace(/0+$/, '')
    return fracPart === '' ? `${sign}${intPart}` : `${sign}${intPart}.${fracPart}`
  }

  /** 是否为有限小数（分母只含因子 2 和 5）。 */
  get terminates(): boolean {
    let d = this.d
    while (d % 2n === 0n) d /= 2n
    while (d % 5n === 0n) d /= 5n
    return d === 1n
  }
}

/** 便捷构造。 */
export function frac(v: number | bigint | string | Frac): Frac {
  return Frac.of(v)
}

/**
 * 构造长度为 `n`、全部为 `Frac.ZERO` 的数组。
 *
 * 用 `Array.from` 而非 `new Array(n).fill(...)`：后者创建的是稀疏数组，
 * `fill` 之后虽然可用，但写法上「参数到底是长度还是唯一元素」有歧义，
 * 而且求解器里这类零向量出现十余次，集中成一个具名函数更清楚。
 */
export function zeros(n: number): Frac[] {
  return Array.from({ length: n }, () => Frac.ZERO)
}
