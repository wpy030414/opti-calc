import type { Solution } from '@/solver/model'

/**
 * 用户保存的带参数标记的模型。
 *
 * 参数是 UI 层面的元数据——DSL 本身不会改变，
 * 只是某些 `:=` 常量在这里被标注为「求解时可变」。
 */

export interface SavedModel {
  id: string
  name: string
  source: string
  paramNames: string[] // 哪些常量名被标记为参数
  createdAt: number // Date.now()
}

/** 一个场景：一组参数赋值。值以表达式字符串存储（与 DSL 语法一致）。 */
export interface Scenario {
  id: string
  label: string // 场景名，如 "乐观"、"基准"
  paramValues: Record<string, string> // paramName → 表达式字符串
}

/** 一个场景的求解结果。不需要持久化——每次渲染时从 DSL + Scenario 实时求解。 */
export interface ScenarioResult {
  scenarioId: string
  label: string
  paramValues: Record<string, string>
  solution: Solution | null // null = 求解出错
  error?: string // 错误信息，有值时 solution 为 null
}

/** localStorage 存储键 */
export const MODELS_KEY = 'opti-calc:models'
export const PARAMS_KEY = 'opti-calc:params'
export const SCENARIOS_KEY = 'opti-calc:scenarios'
