import { Frac } from './frac'
import { ModelError } from './errors'

/**
 * 稀疏线性表达式： `Σ coef[i] * x[i] + const`。
 *
 * 变量按名字索引，系数为 0 的项不进 map（稀疏）。所有算术都在精确有理数域上，
 * 因此合并同类项不会引入任何舍入误差。
 */
export class LinExpr {
  /** 变量名 -> 非零系数。 */
  readonly terms: Map<string, Frac>
  readonly constant: Frac

  constructor(terms: Map<string, Frac> = new Map(), constant: Frac = Frac.ZERO) {
    this.terms = terms
    this.constant = constant
  }

  static const(v: Frac): LinExpr {
    return new LinExpr(new Map(), v)
  }

  static var(name: string): LinExpr {
    const m = new Map<string, Frac>()
    m.set(name, Frac.ONE)
    return new LinExpr(m, Frac.ZERO)
  }

  static zero(): LinExpr {
    return LinExpr.const(Frac.ZERO)
  }

  clone(): LinExpr {
    return new LinExpr(new Map(this.terms), this.constant)
  }

  /** 参与的变量名集合（有序，按首次插入顺序）。 */
  get variables(): string[] {
    return [...this.terms.keys()]
  }

  get isConstant(): boolean {
    return this.terms.size === 0
  }

  coef(name: string): Frac {
    return this.terms.get(name) ?? Frac.ZERO
  }

  private static norm(m: Map<string, Frac>): void {
    for (const [k, v] of m) {
      if (v.isZero) m.delete(k)
    }
  }

  add(o: LinExpr): LinExpr {
    const m = new Map(this.terms)
    for (const [k, v] of o.terms) {
      const cur = m.get(k)
      m.set(k, cur ? cur.add(v) : v)
    }
    LinExpr.norm(m)
    return new LinExpr(m, this.constant.add(o.constant))
  }

  sub(o: LinExpr): LinExpr {
    const m = new Map(this.terms)
    for (const [k, v] of o.terms) {
      const cur = m.get(k)
      m.set(k, cur ? cur.sub(v) : v.neg())
    }
    LinExpr.norm(m)
    return new LinExpr(m, this.constant.sub(o.constant))
  }

  neg(): LinExpr {
    const m = new Map<string, Frac>()
    for (const [k, v] of this.terms) m.set(k, v.neg())
    return new LinExpr(m, this.constant.neg())
  }

  /**
   * 与另一个线性表达式相乘。仅当其中一方为常数时结果仍是线性，
   * 否则返回 null，交由上层判定为「非线性模型」。
   */
  tryMul(o: LinExpr): LinExpr | null {
    if (o.isConstant) return this.scale(o.constant)
    if (this.isConstant) return o.scale(this.constant)
    return null
  }

  /**
   * 除以另一个线性表达式。仅当除数为非零常数时结果为线性。
   */
  tryDiv(o: LinExpr): LinExpr | null {
    if (!o.isConstant || o.constant.isZero) return null
    return this.scale(o.constant.inv())
  }

  scale(k: Frac): LinExpr {
    if (k.isZero) return LinExpr.zero()
    const m = new Map<string, Frac>()
    for (const [name, v] of this.terms) m.set(name, v.mul(k))
    return new LinExpr(m, this.constant.mul(k))
  }

  /** 按给定赋值求值（缺失变量视为 0）。 */  eval(assign: ReadonlyMap<string, Frac>): Frac {
    let acc = this.constant
    for (const [name, c] of this.terms) {
      const v = assign.get(name)
      if (v) acc = acc.add(c.mul(v))
    }
    return acc
  }

  /** 断言为纯常量并返回其值；含未知量时抛 ModelError（带行号）。 */
  constantOnly(line: number): Frac {
    if (!this.isConstant) {
      throw new ModelError(`常量定义不能包含未知量（第 ${line} 行）`, line, 1)
    }
    return this.constant
  }

  /** 人类可读形式，用于结果展示与调试。 */
  toString(): string {
    const parts: string[] = []
    for (const [name, c] of this.terms) {
      if (c.eq(Frac.ONE)) parts.push(name)
      else if (c.eq(Frac.ONE.neg())) parts.push(`-${name}`)
      else parts.push(`${c.toString()}*${name}`)
    }
    if (!this.constant.isZero || parts.length === 0) {
      const c = this.constant.toString()
      parts.push(parts.length === 0 ? c : this.constant.isNegative ? c : `+${c}`)
    }
    return parts.join(' ')
  }
}
