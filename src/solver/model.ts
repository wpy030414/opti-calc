import type { Frac } from './frac'

/** 变量声明中的取值类型约束。 */
export type VarKind =
  | 'real' // 连续实数（默认）
  | 'integer' // 整数
  | 'binary' // 0/1

export interface VarDecl {
  name: string
  kind: VarKind
  /** 下界；undefined 表示未显式声明（求解时按默认 0 处理）。 */
  lower?: Frac
  /** 上界；undefined 表示 +∞。 */
  upper?: Frac
  /** 显式声明为无下界（free），覆盖默认下界 0。 */
  free?: boolean
  /** 声明所在行号，用于错误定位。 */
  line: number
}

/**
 * 关系运算符。
 *
 * 没有 `==`——lexer 已把它归一化为 `=`，因此这里不需要两套等号，
 * 各处 switch 也不必为同一个语义写两个分支。
 */
export type RelOp = '=' | '!=' | '<' | '<=' | '>' | '>='

export interface Constraint {
  /** 约束名（可选，`label:` 前缀）。 */
  name?: string
  /** 线性表达式（已折叠为 `lhs op rhs` 形式）。 */
  left: import('./linexpr').LinExpr
  op: RelOp
  right: import('./linexpr').LinExpr
  line: number
}

export type ObjectiveSense = 'max' | 'min'

export interface Objective {
  sense: ObjectiveSense
  expr: import('./linexpr').LinExpr
  line: number
}

/** 一份完整的模型。 */
export interface Model {
  vars: VarDecl[]
  /** 常量赋值：`name := 表达式` 中的常量（不含未知量）。 */
  constants: Map<string, Frac>
  constraints: Constraint[]
  objective?: Objective
}

/** 求解状态。 */
export type SolveStatus =
  | { kind: 'optimal' }
  | { kind: 'infeasible'; reason?: string }
  | { kind: 'unbounded'; direction?: string }
  | { kind: 'degenerate'; reason?: string }

/** 求解结果。 */
export interface Solution {
  status: SolveStatus
  /** 各变量取值（仅在 optimal 时有意义）。 */
  values: Map<string, Frac>
  /** 目标函数值（仅在有目标且 optimal 时有意义）。 */
  objectiveValue?: Frac
  /** 每个约束的松弛量 / 是否取等，用于展示。 */
  constraintReport?: ConstraintReport[]
  /**
   * 求解过程中的语义提示（非错误）。
   *
   * 例如：实数变量上的严格不等式被放宽为闭区间、约束冗余、解不唯一等。
   * 这些不改变结果的正确性，但用户有权知道模型被如何解释。
   */
  warnings: string[]
  /** 模型规模统计，用于展示。 */
  stats?: { vars: number; constraints: number; integerVars: number; lpNodes?: number }
  /**
   * 变量展示顺序：按其在模型中首次出现的次序。
   *
   * 比字母序更符合阅读直觉——用户写下条件的顺序就是他期望看到答案的顺序。
   */
  varOrder: string[]
  /** 目标方向；无目标时为 undefined。用于决定结果标题写「最大值」还是「最小值」。 */
  objectiveSense?: ObjectiveSense
}

export interface ConstraintReport {
  name?: string
  /** `left - right` 的取值。 */
  slack: Frac
  /** 是否恰好取到边界（对不等式即 slack==0）。 */
  tight: boolean
  satisfied: boolean
  line: number
}
