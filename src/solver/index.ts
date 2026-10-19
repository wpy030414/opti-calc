/**
 * 求解内核总出口。
 *
 * 只导出界面层需要的东西：`solve()` 是唯一入口，其余都是围绕它的类型与
 * 少量底层工具（`Frac`、词法着色用的 `commentStart` / `KEYWORDS`）。
 * `lp.ts` / `milp.ts` 的标准形细节虽然也导出，但仅供测试使用——
 * 界面层不应该依赖矩阵布局，否则日后换算法要连着改 UI。
 *
 * 展示格式化在 `@/lib/format`，不属于内核。
 */

export { solve, fmt, type SolveOptions } from './solve'

export { Frac, zeros } from './frac'
export { SolverError, ParseError, ModelError, NumericError } from './errors'
export { LinExpr } from './linexpr'
export { parse, parseExprLine, commentStart, KEYWORDS, FUNCTION_NAMES } from './parser'
export { buildModel, collectVariables } from './linearize'
export { standardize, denormalize } from './standardize'
export { solveLinearSystem, describeRank } from './gaussian'
export { solveLp } from './lp'
export { solveMilp } from './milp'

export type {
  Model,
  VarDecl,
  VarKind,
  Constraint,
  Objective,
  ObjectiveSense,
  RelOp,
  SolveStatus,
  Solution,
  ConstraintReport,
} from './model'

export type { LinearSystemResult, BasisVector } from './gaussian'
export type { LpStandard, LpResult, LpStatus, RelSense } from './lp'
export type { Standardized, Substitution } from './standardize'
export type { MilpResult } from './milp'
export type { Expr, Pos, Token, TokenType } from './ast'
export type { Stmt } from './parser'
