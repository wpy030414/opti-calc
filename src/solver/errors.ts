/**
 * 求解器错误类型。
 *
 * 所有面向用户的失败都收敛为 `SolverError` 及其子类，携带可选的行列号。
 *
 * ## 位置信息的归属
 *
 * 行号与列号**只**存放在 `line` / `col` 字段里，`message` 只描述语义。
 * 早期实现把位置也拼进 message，结果 UI 显示成
 * 「第 1 行：出现意外的「EOF」（第 1 行第 5 列）」——同一个信息说了两遍。
 *
 * 约定：
 * - 抛异常处不要往 message 里写行号；
 * - UI 决定如何呈现位置（编辑器高亮整行，因此通常只显示行号）；
 * - 需要一次性拿到「位置 + 语义」的完整文本时用 `describe()`。
 *
 * 例外：`warnings` 是纯字符串数组，没有结构化字段承载位置，
 * 因此警告文本里必须自带行号，否则用户无从定位。
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

  /** 「第 N 行：语义」形式的完整描述；无位置信息时退化为纯语义。 */
  describe(): string {
    if (this.line === undefined) return this.message
    return `第 ${this.line} 行：${this.message}`
  }
}

/** 词法 / 语法错误：输入不是合法的表达式。 */
export class ParseError extends SolverError {}

/** 模型语义错误：表达式合法但模型本身不成立（非线性、重复声明等）。 */
export class ModelError extends SolverError {}

/** 数值域错误：除零、无法精确表示等。 */
export class NumericError extends SolverError {}
