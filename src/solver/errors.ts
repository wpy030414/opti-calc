/**
 * 求解器错误类型。
 *
 * 所有面向用户的失败都收敛为 `SolverError` 及其子类，携带可选的行列号，
 * 便于编辑器把错误精确地标注到某一行。
 */

export class SolverError extends Error {
  readonly line?: number
  readonly col?: number

  constructor(message: string, line?: number, col?: number) {
    super(message)
    this.name = new.target.name
    this.line = line
    this.col = col
  }
}

/** 词法 / 语法错误：输入不是合法的表达式。 */
export class ParseError extends SolverError {}

/** 模型语义错误：表达式合法但模型本身不成立（非线性、重复声明等）。 */
export class ModelError extends SolverError {}

/** 数值域错误：除零、无法精确表示等。 */
export class NumericError extends SolverError {}
