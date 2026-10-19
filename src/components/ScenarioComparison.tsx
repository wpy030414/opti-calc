import { useMemo, useCallback } from 'react'
import { Plus, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { solve } from '@/solver/solve'
import { SolverError } from '@/solver/errors'
import { displayValue } from '@/lib/format'
import type { Solution } from '@/solver/model'
import type { Scenario, ScenarioResult } from '@/lib/saved-models'
import { SCENARIOS_KEY } from '@/lib/saved-models'

interface ScenarioComparisonProps {
  source: string
  paramNames: string[]
  className?: string
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 从 DSL 中提取某常量 `:=` 后的原始表达式。
 * 返回空字符串表示常量不存在。
 */
function extractConstValue(source: string, name: string): string {
  const re = new RegExp(`^\\s*${escapeRegExp(name)}\\s*:=\\s*(.*?)$`, 'm')
  const m = source.match(re)
  return m?.[1]?.trim() ?? ''
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 字符串替换构建带参数的 DSL：把 `paramName := oldValue` 替换为 `paramName := newValue`。
 * 行级替换，保持缩进与注释不变。
 */
function substituteParams(source: string, paramValues: Record<string, string>): string {
  const lines = source.split('\n')
  const result = lines.map((line) => {
    for (const [name, val] of Object.entries(paramValues)) {
      const re = new RegExp(`^(\\s*${escapeRegExp(name)}\\s*:=\\s*).*$`)
      const m = line.match(re)
      if (m) return `${m[1]}${val}`
    }
    return line
  })
  return result.join('\n')
}

/**
 * 运行一个场景：替换参数 → solve，返回 ScenarioResult。
 */
function runScenario(source: string, scenario: Scenario): ScenarioResult {
  try {
    const substituted = substituteParams(source, scenario.paramValues)
    const solution = solve(substituted)
    return {
      scenarioId: scenario.id,
      label: scenario.label,
      paramValues: scenario.paramValues,
      solution,
    }
  } catch (err) {
    const msg =
      err instanceof SolverError ? err.message : err instanceof Error ? err.message : String(err)
    return {
      scenarioId: scenario.id,
      label: scenario.label,
      paramValues: scenario.paramValues,
      solution: null,
      error: msg,
    }
  }
}

/** 合并所有场景中出现的变量名，保持 first-appearance 启发式顺序。 */
function unionVarOrder(results: ScenarioResult[]): string[] {
  const seen = new Set<string>()
  const order: string[] = []
  for (const r of results) {
    if (!r.solution) continue
    for (const name of r.solution.varOrder) {
      if (!seen.has(name)) {
        seen.add(name)
        order.push(name)
      }
    }
    // 追加 values 中有但 varOrder 遗漏的
    for (const name of r.solution.values.keys()) {
      if (!seen.has(name)) {
        seen.add(name)
        order.push(name)
      }
    }
  }
  return order
}

/** 所有场景中存在目标值的场景数 */
function hasObjective(results: ScenarioResult[]): boolean {
  return results.some((r) => r.solution?.objectiveValue !== undefined)
}

function cellCls(ok: boolean): string {
  return ok ? 'font-mono text-xs tabular-nums' : 'font-mono text-xs tabular-nums text-destructive'
}

export function ScenarioComparison({ source, paramNames, className }: ScenarioComparisonProps) {
  const [scenarios, setScenarios] = useLocalStorage<Scenario[]>(SCENARIOS_KEY, [])

  // 合并场景列表：按 paramNames 生成/更新场景
  const effective = useMemo(() => {
    // 过滤掉已不在 paramNames 中的旧 key
    return scenarios.map((s) => {
      const clean: Record<string, string> = {}
      for (const name of paramNames) {
        clean[name] = s.paramValues[name] ?? extractConstValue(source, name)
      }
      return { ...s, paramValues: clean }
    })
  }, [scenarios, paramNames, source])

  // 求解所有场景
  const results = useMemo(() => effective.map((s) => runScenario(source, s)), [source, effective])

  const varOrder = useMemo(() => unionVarOrder(results), [results])
  const showObjective = hasObjective(results)

  // 判断各场景是否有目标值（用于列显示）
  const objLabel = useMemo(() => {
    for (const r of results) {
      if (r.solution?.objectiveSense) {
        return r.solution.objectiveSense === 'max' ? '最大值' : '最小值'
      }
    }
    return '目标值'
  }, [results])

  const addScenario = useCallback(() => {
    const vals: Record<string, string> = {}
    for (const name of paramNames) {
      vals[name] = extractConstValue(source, name)
    }
    const label = `方案 ${effective.length + 1}`
    setScenarios((prev) => [...prev, { id: genId(), label, paramValues: vals }])
  }, [source, paramNames, effective.length, setScenarios])

  const removeScenario = useCallback(
    (id: string) => {
      setScenarios((prev) => prev.filter((s) => s.id !== id))
    },
    [setScenarios],
  )

  const updateLabel = useCallback(
    (id: string, label: string) => {
      setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)))
    },
    [setScenarios],
  )

  const updateParam = useCallback(
    (id: string, name: string, value: string) => {
      setScenarios((prev) =>
        prev.map((s) =>
          s.id === id ? { ...s, paramValues: { ...s.paramValues, [name]: value } } : s,
        ),
      )
    },
    [setScenarios],
  )

  if (paramNames.length === 0) {
    return (
      <Card className={className}>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          <p>当前模型没有标记参数常量。</p>
          <p className="mt-1">请在左侧编辑器常量区勾选「参数」复选框，标记可作为输入的常量。</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>场景对比</CardTitle>
            <Button variant="outline" size="sm" onClick={addScenario}>
              <Plus className="mr-1 size-3.5" />
              添加场景
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {effective.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有添加场景。点「添加场景」创建第一个参数组合。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="sticky left-0 z-10 bg-card pb-2 pr-3 font-normal">场景</th>
                    {paramNames.map((name) => (
                      <th key={name} className="pb-2 px-2 font-normal whitespace-nowrap">
                        {name}
                        <span className="ml-0.5 text-[10px] text-muted-foreground/60">(入)</span>
                      </th>
                    ))}
                    {showObjective ? (
                      <th className="pb-2 px-2 font-normal whitespace-nowrap">
                        {objLabel}
                        <span className="ml-0.5 text-[10px] text-muted-foreground/60">(出)</span>
                      </th>
                    ) : null}
                    {varOrder.map((name) => (
                      <th key={name} className="pb-2 px-2 font-normal whitespace-nowrap">
                        {name}
                        <span className="ml-0.5 text-[10px] text-muted-foreground/60">(出)</span>
                      </th>
                    ))}
                    <th className="pb-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, ri) => (
                    <tr key={r.scenarioId} className="border-b last:border-0">
                      {/* 场景标签（sticky 左） */}
                      <td className="sticky left-0 z-10 bg-card py-2 pr-3">
                        <div className="flex items-center gap-1">
                          <input
                            className="w-20 rounded border border-transparent bg-transparent px-1 py-0.5 font-medium text-sm hover:border-border focus:border-ring focus:outline-none"
                            value={r.label}
                            onChange={(e) => updateLabel(r.scenarioId, e.target.value)}
                          />
                          {r.error || (r.solution && r.solution.status.kind !== 'optimal') ? (
                            <AlertTriangle className="size-3 text-amber-500 shrink-0" />
                          ) : null}
                        </div>
                      </td>

                      {/* 参数输入列 */}
                      {paramNames.map((name) => (
                        <td key={name} className="py-2 px-2">
                          <input
                            className="w-24 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-xs hover:border-border focus:border-ring focus:outline-none"
                            value={effective[ri]?.paramValues[name] ?? ''}
                            onChange={(e) => updateParam(r.scenarioId, name, e.target.value)}
                          />
                        </td>
                      ))}

                      {/* 目标值列 */}
                      {showObjective ? (
                        <td className={cellCls(r.solution?.status.kind === 'optimal')}>
                          {renderResultCell(r, (s) => {
                            if (!s.objectiveValue) return '—'
                            const approx = s.approximation ? '≈ ' : ''
                            return `${approx}${displayValue(s.objectiveValue)}`
                          })}
                        </td>
                      ) : null}

                      {/* 变量值列 */}
                      {varOrder.map((name) => (
                        <td key={name} className={cellCls(r.solution?.status.kind === 'optimal')}>
                          {renderResultCell(r, (s) => {
                            const v = s.values.get(name)
                            return v ? displayValue(v) : '—'
                          })}
                        </td>
                      ))}

                      {/* 删除 */}
                      <td className="py-2 text-right">
                        <button
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => removeScenario(r.scenarioId)}
                          aria-label={`删除 ${r.label}`}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            🛈 修改参数值后自动重新求解。不同场景之间独立运行，不会互相影响。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

/** 根据场景结果渲染单元格：optimal 显示值，否则显示错误标记。 */
function renderResultCell(r: ScenarioResult, f: (s: Solution) => string): string {
  if (!r.solution) {
    return r.error ?? '错误'
  }
  if (r.solution.status.kind !== 'optimal') {
    const labels: Record<string, string> = {
      infeasible: '无解',
      unbounded: '无界',
      degenerate: '退化',
    }
    return labels[r.solution.status.kind] ?? r.solution.status.kind
  }
  return f(r.solution)
}
