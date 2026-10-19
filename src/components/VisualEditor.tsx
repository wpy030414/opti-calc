import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Trash2, HelpCircle, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { parse } from '@/solver/parser'
import { Frac } from '@/solver/frac'
import { exprToString } from '@/lib/expr-to-string'
import type { Stmt } from '@/solver/parser'
import type { VarKind } from '@/solver/model'
import type { EditorError } from '@/components/ModelEditor'

// ── types ──────────────────────────────────────────────────────────

interface BoundField {
  value: string
  strict: boolean
}

interface VisualVariable {
  id: string
  name: string
  varKind: string
  free: boolean
  lowerBound: BoundField
  upperBound: BoundField
}

interface VisualConstant {
  id: string
  name: string
  expression: string
}

interface VisualConstraint {
  id: string
  label: string
  leftExpr: string
  operator: string
  rightExpr: string
}

interface VisualObjective {
  sense: 'max' | 'min'
  expression: string
}

interface VisualModel {
  constants: VisualConstant[]
  variables: VisualVariable[]
  constraints: VisualConstraint[]
  objective: VisualObjective | null
}

export interface VisualEditorProps {
  source: string
  onChange: (source: string) => void
  error?: EditorError | null
  /** 哪些常量名被标记为参数（在对比视图中可变）。 */
  paramNames: Set<string>
  /** 参数标记变更回调。 */
  onParamNamesChange: (names: Set<string>) => void
}

// ── constants ──────────────────────────────────────────────────────

const VAR_KIND_OPTIONS = [
  { value: '实数', label: '实数', hint: '任意数字（含小数、负数）' },
  { value: '整数', label: '整数', hint: '整数，可正可负' },
  { value: '非负', label: '非负', hint: '≥ 0 的任意数字' },
  { value: '非负整数', label: '非负整数', hint: '0、1、2、3… 份数、个数' },
  { value: '正整数', label: '正整数', hint: '1、2、3… 至少为 1' },
  { value: '二元', label: '二元', hint: '只有 0 或 1，做不做 / 选不选' },
] as const

const OP_OPTIONS = ['=', '<=', '>=', '<', '>'] as const

const EMPTY_BOUND: BoundField = { value: '', strict: false }

// ── id generator ───────────────────────────────────────────────────

let _nextId = 0
function uid(): string {
  return String(++_nextId)
}

// ── helpers ────────────────────────────────────────────────────────

function emptyVariable(name?: string): VisualVariable {
  return {
    id: uid(),
    name: name ?? '',
    varKind: '实数',
    free: false,
    lowerBound: { ...EMPTY_BOUND },
    upperBound: { ...EMPTY_BOUND },
  }
}

function emptyConstant(): VisualConstant {
  return { id: uid(), name: '', expression: '' }
}

function emptyConstraint(): VisualConstraint {
  return { id: uid(), label: '', leftExpr: '', operator: '=', rightExpr: '' }
}

function emptyModel(): VisualModel {
  return { constants: [], variables: [], constraints: [], objective: null }
}

/** 返回类型隐含的下界值，没有隐含下界则返回 null。 */
function implicitLowerByKind(varKind: string): string | null {
  if (varKind === '非负' || varKind === '非负整数') return '0'
  if (varKind === '正整数') return '1'
  if (varKind === '二元') return '0'
  return null
}

/** 返回类型隐含的上界值，没有隐含上界则返回 null。 */
function implicitUpperByKind(varKind: string): string | null {
  if (varKind === '二元') return '1'
  return null
}

// ── compile VisualModel → DSL ──────────────────────────────────────

function compileToDsl(model: VisualModel): string {
  const lines: string[] = []

  // constants
  for (const c of model.constants) {
    const n = c.name.trim()
    const e = c.expression.trim()
    if (!n || !e) continue
    lines.push(`${n} := ${e}`)
  }
  if (model.constants.some((c) => c.name.trim() && c.expression.trim())) {
    lines.push('')
  }

  // variables
  for (const v of model.variables) {
    if (!v.name.trim()) continue
    let line = `${v.name.trim()} :`
    if (v.free) line += ' free'
    line += ` ${v.varKind}`
    if (v.lowerBound.value.trim()) {
      const op = v.lowerBound.strict ? '>' : '>='
      line += ` ${op} ${v.lowerBound.value.trim()}`
    }
    if (v.upperBound.value.trim()) {
      const op = v.upperBound.strict ? '<' : '<='
      line += ` ${op} ${v.upperBound.value.trim()}`
    }
    lines.push(line)
  }
  if (model.variables.some((v) => v.name.trim())) {
    lines.push('')
  }

  // constraints
  for (const c of model.constraints) {
    if (!c.leftExpr.trim() || !c.rightExpr.trim()) continue
    const label = c.label.trim() ? `${c.label.trim()} : ` : ''
    lines.push(`${label}${c.leftExpr.trim()} ${c.operator} ${c.rightExpr.trim()}`)
  }
  if (model.constraints.some((c) => c.leftExpr.trim() && c.rightExpr.trim())) {
    lines.push('')
  }

  // objective
  if (model.objective?.expression.trim()) {
    lines.push(`${model.objective.sense} ${model.objective.expression.trim()}`)
  }

  return lines.join('\n').replace(/\n+$/, '\n')
}

// ── decompile DSL → VisualModel ────────────────────────────────────

function mapVarKind(vk: VarKind, implicitLower?: Frac): string {
  if (vk === 'binary') return '二元'
  if (vk === 'integer') {
    if (implicitLower?.eq(Frac.ZERO)) return '非负整数'
    if (implicitLower?.eq(Frac.ONE)) return '正整数'
    return '整数'
  }
  // real
  if (implicitLower?.eq(Frac.ZERO)) return '非负'
  return '实数'
}

function tryDecompile(source: string): VisualModel | null {
  if (!source.trim()) return emptyModel()

  let stmts: Stmt[]
  try {
    stmts = parse(source)
  } catch {
    return null
  }

  const model = emptyModel()

  for (const s of stmts) {
    switch (s.kind) {
      case 'const':
        model.constants.push({
          id: uid(),
          name: s.name,
          expression: exprToString(s.expr),
        })
        break

      case 'var': {
        const varKind = mapVarKind(s.varKind, s.implicitLower)
        model.variables.push({
          id: uid(),
          name: s.name,
          varKind,
          free: !!s.free,
          lowerBound: s.lower
            ? { value: exprToString(s.lower), strict: !!s.lowerStrict }
            : { ...EMPTY_BOUND },
          upperBound: s.upper
            ? { value: exprToString(s.upper), strict: !!s.upperStrict }
            : { ...EMPTY_BOUND },
        })
        break
      }

      case 'constraint':
        model.constraints.push({
          id: uid(),
          label: s.name ?? '',
          leftExpr: exprToString(s.left),
          operator: s.op,
          rightExpr: exprToString(s.right),
        })
        break

      case 'objective':
        model.objective = {
          sense: s.sense,
          expression: exprToString(s.expr),
        }
        break
    }
  }

  return model
}

// ── component ──────────────────────────────────────────────────────

export function VisualEditor({
  source,
  onChange,
  error: _error,
  paramNames,
  onParamNamesChange,
}: VisualEditorProps) {
  const [model, setModel] = useState<VisualModel>(() => {
    const m = tryDecompile(source)
    return m ?? emptyModel()
  })

  const isCompilingRef = useRef(false)
  const _sourceRef = useRef(source)
  _sourceRef.current = source

  // 编译：visualModel → DSL
  useEffect(() => {
    if (isCompilingRef.current) return
    isCompilingRef.current = true
    onChange(compileToDsl(model))
    // 用微任务在 React 处理完 source 变更后复位
    void Promise.resolve().then(() => {
      isCompilingRef.current = false
    })
  }, [model]) // eslint-disable-line react-hooks/exhaustive-deps

  // 反编译：外部 source 变更 → visualModel
  useEffect(() => {
    if (isCompilingRef.current) return
    const m = tryDecompile(source)
    if (m) setModel(m)
  }, [source])

  // ── mutation helpers ─────────────────────────────────────────

  const updateVariable = useCallback((id: string, patch: Partial<VisualVariable>) => {
    setModel((prev) => ({
      ...prev,
      variables: prev.variables.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    }))
  }, [])

  const removeVariable = useCallback((id: string) => {
    setModel((prev) => ({
      ...prev,
      variables: prev.variables.filter((v) => v.id !== id),
    }))
  }, [])

  const addVariable = useCallback(() => {
    setModel((prev) => ({ ...prev, variables: [...prev.variables, emptyVariable()] }))
  }, [])

  const updateConstant = useCallback((id: string, patch: Partial<VisualConstant>) => {
    setModel((prev) => ({
      ...prev,
      constants: prev.constants.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }))
  }, [])

  const removeConstant = useCallback((id: string) => {
    setModel((prev) => ({
      ...prev,
      constants: prev.constants.filter((c) => c.id !== id),
    }))
  }, [])

  const addConstant = useCallback(() => {
    setModel((prev) => ({ ...prev, constants: [...prev.constants, emptyConstant()] }))
  }, [])

  const updateConstraint = useCallback((id: string, patch: Partial<VisualConstraint>) => {
    setModel((prev) => ({
      ...prev,
      constraints: prev.constraints.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }))
  }, [])

  const removeConstraint = useCallback((id: string) => {
    setModel((prev) => ({
      ...prev,
      constraints: prev.constraints.filter((c) => c.id !== id),
    }))
  }, [])

  const addConstraint = useCallback(() => {
    setModel((prev) => ({
      ...prev,
      constraints: [...prev.constraints, emptyConstraint()],
    }))
  }, [])

  const setObjectiveSense = useCallback((sense: 'max' | 'min' | null) => {
    setModel((prev) => {
      if (!sense) return { ...prev, objective: null }
      if (prev.objective) {
        return { ...prev, objective: { ...prev.objective, sense } }
      }
      return { ...prev, objective: { sense, expression: '' } }
    })
  }, [])

  const setObjectiveExpr = useCallback((expression: string) => {
    setModel((prev) => {
      if (!prev.objective) return prev
      return { ...prev, objective: { ...prev.objective, expression } }
    })
  }, [])

  // 检查当前 source 是否能被 parse 解析
  const parseOk =
    !source.trim() ||
    (() => {
      try {
        parse(source)
        return true
      } catch {
        return false
      }
    })()

  // 模型是否完全为空（用于显示引导面板）
  const isModelEmpty =
    model.constants.length === 0 &&
    model.variables.length === 0 &&
    model.constraints.length === 0 &&
    !model.objective

  const [showGuide, setShowGuide] = useState(isModelEmpty)

  // 已声明变量的名称列表，用于约束和目标中的变量标签提示
  const varNames = model.variables.map((v) => v.name.trim()).filter(Boolean)

  // ── render helpers ────────────────────────────────────────────

  const inputCls =
    'h-7 rounded-md border border-input bg-transparent px-2 text-xs font-mono placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

  /** 复制文本到剪贴板，失败时静默忽略 */
  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  // ── guide panel ───────────────────────────────────────────────

  if (showGuide && isModelEmpty) {
    return (
      <div className="space-y-3">
        {!parseOk ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            当前模型无法在可视化编辑器中完整展示。切换到"专家"模式可查看和编辑原文。
          </p>
        ) : null}

        <Card className="border-emerald-200 bg-emerald-50/30 dark:border-emerald-900/30 dark:bg-emerald-950/10">
          <CardContent className="py-8">
            <div className="text-center space-y-4">
              <p className="text-lg">🎯 你要算什么？</p>
              <div className="text-sm text-muted-foreground leading-relaxed max-w-md mx-auto text-left space-y-2">
                <p>
                  告诉 OptiCalc <strong>三件事</strong>就够了：
                </p>
                <ol className="list-decimal list-inside space-y-1.5 ml-1">
                  <li>
                    <span className="font-medium text-foreground">你能改什么？</span>
                    <span className="text-xs ml-1">——比如：买几份、种几棵、算几个</span>
                  </li>
                  <li>
                    <span className="font-medium text-foreground">有什么限制？</span>
                    <span className="text-xs ml-1">——比如：不能超预算、格子不够用</span>
                  </li>
                  <li>
                    <span className="font-medium text-foreground">想求什么？</span>
                    <span className="text-xs ml-1">——比如：花钱最少、收益最高</span>
                  </li>
                </ol>
              </div>
              <div className="flex items-center justify-center gap-3 pt-2">
                <Button
                  size="sm"
                  onClick={() => {
                    // 打开示例下拉
                    const btn = document.querySelector(
                      '[data-examples-trigger]',
                    ) as HTMLElement | null
                    btn?.click()
                  }}
                >
                  从示例开始
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowGuide(false)
                    // 自动添加一个空变量行
                    setModel((prev) => {
                      if (prev.variables.length > 0) return prev
                      return { ...prev, variables: [emptyVariable()] }
                    })
                  }}
                >
                  自己动手写
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── main form ─────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {!parseOk ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          当前模型无法在可视化编辑器中完整展示。切换到"专家"模式可查看和编辑原文。
        </p>
      ) : null}

      {/* ── constants ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <div className="flex items-center gap-3">
              <CardTitle className="text-xs font-medium">常量</CardTitle>
              <span className="text-[10px] text-muted-foreground">参数</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              不会变的已知数：单价、预算、面积……定义一次，下面引用
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addConstant}>
            <Plus className="size-3" /> 添加
          </Button>
        </CardHeader>
        {model.constants.length > 0 ? (
          <CardContent className="space-y-2 pt-0">
            {model.constants.map((c) => {
              const name = c.name.trim()
              const isParam = name !== '' && paramNames.has(name)
              return (
                <div key={c.id} className="flex items-center gap-1.5">
                  <label
                    className="flex shrink-0 cursor-pointer items-center"
                    title={
                      name ? '标记为参数：可在对比视图中为不同场景填入不同值' : '请先填写常量名称'
                    }
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 accent-violet-600"
                      checked={isParam}
                      disabled={name === ''}
                      onChange={() => {
                        if (!name) return
                        const next = new Set(paramNames)
                        if (isParam) {
                          next.delete(name)
                        } else {
                          next.add(name)
                        }
                        onParamNamesChange(next)
                      }}
                    />
                  </label>
                  <input
                    className={inputCls + ' w-24'}
                    placeholder="名称"
                    value={c.name}
                    onChange={(e) => updateConstant(c.id, { name: e.target.value })}
                  />
                  <span className="text-xs text-muted-foreground shrink-0">:=</span>
                  <input
                    className={inputCls + ' flex-1'}
                    placeholder="如 34 / 10 或 5 * 60 + 28"
                    value={c.expression}
                    onChange={(e) => updateConstant(c.id, { expression: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeConstant(c.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              )
            })}
            <p className="text-[10px] text-muted-foreground">
              勾选「参数」后，该常量在对比视图中可填入多组不同值。
            </p>
          </CardContent>
        ) : (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              还没添加已知条件。比如你的预算、面积、价格——这些是计算前就知道的数字。
            </p>
          </CardContent>
        )}
      </Card>

      {/* ── variables ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-xs font-medium">变量</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              你要决定的量：买几份？种几棵？——求解器帮你算
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addVariable}>
            <Plus className="size-3" /> 添加
          </Button>
        </CardHeader>
        {model.variables.length > 0 ? (
          <CardContent className="space-y-2 pt-0">
            {model.variables.map((v) => {
              const hasImplicitLower = implicitLowerByKind(v.varKind) !== null
              const hasImplicitUpper = implicitUpperByKind(v.varKind) !== null
              const hasImplicitBounds = hasImplicitLower && hasImplicitUpper
              const showBoundControls = !hasImplicitBounds
              const showLowerOnly = hasImplicitUpper && !hasImplicitLower
              const showUpperOnly = hasImplicitLower && !hasImplicitUpper
              const currentHint = VAR_KIND_OPTIONS.find((k) => k.value === v.varKind)?.hint ?? ''

              return (
                <div key={v.id} className="flex flex-wrap items-center gap-1.5">
                  <input
                    className={inputCls + ' w-24'}
                    placeholder="变量名"
                    value={v.name}
                    onChange={(e) => updateVariable(v.id, { name: e.target.value })}
                  />
                  <span className="text-xs text-muted-foreground">:</span>

                  {/* varKind select with help tooltip */}
                  <select
                    className={inputCls + ' w-24 appearance-none bg-background'}
                    value={v.varKind}
                    title={currentHint}
                    onChange={(e) => {
                      const newKind = e.target.value
                      // 切换类型时自动清除已被隐含覆盖的边界
                      const patch: Partial<VisualVariable> = { varKind: newKind }
                      if (implicitLowerByKind(newKind) !== null) {
                        patch.lowerBound = { ...EMPTY_BOUND }
                      }
                      if (implicitUpperByKind(newKind) !== null) {
                        patch.upperBound = { ...EMPTY_BOUND }
                      }
                      updateVariable(v.id, patch)
                    }}
                  >
                    {VAR_KIND_OPTIONS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                  <span title={currentHint} className="shrink-0">
                    <HelpCircle className="size-3 text-muted-foreground" />
                  </span>

                  {/* bounds for variables without full implicit coverage */}
                  {showBoundControls || showLowerOnly || showUpperOnly ? (
                    <>
                      {!hasImplicitLower ? (
                        <>
                          <select
                            className={inputCls + ' w-12 appearance-none bg-background'}
                            value={v.lowerBound.strict ? '>' : '>='}
                            onChange={(e) =>
                              updateVariable(v.id, {
                                lowerBound: { ...v.lowerBound, strict: e.target.value === '>' },
                              })
                            }
                          >
                            <option value=">=">&gt;=</option>
                            <option value=">">&gt;</option>
                          </select>
                          <input
                            className={inputCls + ' w-18'}
                            placeholder="最小值"
                            value={v.lowerBound.value}
                            onChange={(e) =>
                              updateVariable(v.id, {
                                lowerBound: { ...v.lowerBound, value: e.target.value },
                              })
                            }
                          />
                        </>
                      ) : null}
                      {showBoundControls || showLowerOnly || showUpperOnly ? (
                        <span className="text-xs text-muted-foreground">
                          {hasImplicitLower ? `≥ ${implicitLowerByKind(v.varKind)}` : ''}
                        </span>
                      ) : null}
                      {!hasImplicitUpper ? (
                        <>
                          <select
                            className={inputCls + ' w-12 appearance-none bg-background'}
                            value={v.upperBound.strict ? '<' : '<='}
                            onChange={(e) =>
                              updateVariable(v.id, {
                                upperBound: { ...v.upperBound, strict: e.target.value === '<' },
                              })
                            }
                          >
                            <option value="<=">&lt;=</option>
                            <option value="<">&lt;</option>
                          </select>
                          <input
                            className={inputCls + ' w-18'}
                            placeholder="最大值"
                            value={v.upperBound.value}
                            onChange={(e) =>
                              updateVariable(v.id, {
                                upperBound: { ...v.upperBound, value: e.target.value },
                              })
                            }
                          />
                        </>
                      ) : null}
                    </>
                  ) : null}

                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeVariable(v.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              )
            })}
          </CardContent>
        ) : (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              还没添加要算的量。这就是你要的答案，比如"买几份"、"种多少棵"。
            </p>
          </CardContent>
        )}
      </Card>

      {/* ── constraints ────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle className="text-xs font-medium">约束</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              必须遵守的条件：预算不能超、格子不够用、至少买多少……
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addConstraint}>
            <Plus className="size-3" /> 添加
          </Button>
        </CardHeader>

        {/* variable name chips */}
        {varNames.length > 0 ? (
          <div className="px-4 pb-1 flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-muted-foreground mr-1">可用变量：</span>
            {varNames.map((name) => (
              <button
                key={name}
                type="button"
                className="inline-flex h-5 items-center rounded-full border border-input bg-background px-2 text-[10px] font-mono text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-copy"
                title={`点击复制 "${name}"`}
                onClick={() => copyToClipboard(name)}
              >
                {name}
                <Copy className="size-2.5 ml-1 opacity-40" />
              </button>
            ))}
          </div>
        ) : null}

        {model.constraints.length > 0 ? (
          <CardContent className="space-y-2 pt-0">
            {model.constraints.map((c) => {
              const ops =
                c.operator === '!=' ? (['=', '<=', '>=', '<', '>', '!='] as const) : OP_OPTIONS
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-1.5">
                  <input
                    className={inputCls + ' w-20'}
                    placeholder="标签（可选）"
                    value={c.label}
                    onChange={(e) => updateConstraint(c.id, { label: e.target.value })}
                  />
                  <input
                    className={inputCls + ' min-w-0 flex-1'}
                    placeholder="如 4 * 大作物 + 小作物"
                    value={c.leftExpr}
                    onChange={(e) => updateConstraint(c.id, { leftExpr: e.target.value })}
                  />
                  <select
                    className={inputCls + ' w-16 appearance-none bg-background'}
                    value={c.operator}
                    onChange={(e) => updateConstraint(c.id, { operator: e.target.value })}
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputCls + ' min-w-0 flex-1'}
                    placeholder="如 96 或 预算上限"
                    value={c.rightExpr}
                    onChange={(e) => updateConstraint(c.id, { rightExpr: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeConstraint(c.id)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              )
            })}
          </CardContent>
        ) : (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              还没添加限制规则。比如"总花费不能超过预算"、"总面积不能超过土地大小"。
            </p>
          </CardContent>
        )}
      </Card>

      {/* ── objective ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <div>
            <CardTitle className="text-xs font-medium">目标</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              想让什么最大或最小？赚钱最多？花钱最少？——不写也行，求出任意可行解
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 pt-0">
          <div className="flex items-center gap-2">
            {(
              [
                ['无', null],
                ['最大化', 'max'],
                ['最小化', 'min'],
              ] as const
            ).map(([label, sense]) => {
              const active = model.objective?.sense === sense || (!model.objective && !sense)
              return (
                <button
                  key={label}
                  type="button"
                  className={`inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-colors ${
                    active
                      ? 'border-transparent bg-accent text-accent-foreground shadow-sm'
                      : 'border-input bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                  onClick={() => setObjectiveSense(sense)}
                >
                  {label}
                </button>
              )
            })}
          </div>
          {model.objective ? (
            <>
              {/* variable name chips */}
              {varNames.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 pt-1">
                  <span className="text-[10px] text-muted-foreground mr-1">可用变量：</span>
                  {varNames.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="inline-flex h-5 items-center rounded-full border border-input bg-background px-2 text-[10px] font-mono text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-copy"
                      title={`点击复制 "${name}"`}
                      onClick={() => copyToClipboard(name)}
                    >
                      {name}
                      <Copy className="size-2.5 ml-1 opacity-40" />
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                className={inputCls + ' w-full'}
                placeholder="如 大作物 * 100 + 小作物 * 18"
                value={model.objective.expression}
                onChange={(e) => setObjectiveExpr(e.target.value)}
              />
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
