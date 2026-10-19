import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, Trash2 } from 'lucide-react'
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

const VAR_KIND_LABELS = ['实数', '整数', '非负', '非负整数', '正整数', '二元'] as const

const OP_OPTIONS = ['=', '<=', '>=', '<', '>', '!='] as const

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

  // ── render ──────────────────────────────────────────────────

  const inputCls =
    'h-7 rounded-md border border-input bg-transparent px-2 text-xs font-mono placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

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
          <div className="flex items-center gap-3">
            <CardTitle className="text-xs font-medium">常量</CardTitle>
            <span className="text-[10px] text-muted-foreground">参数</span>
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
                    placeholder="表达式，如 34 / 10"
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
            <p className="text-xs text-muted-foreground">暂无常量，点击"添加"创建</p>
          </CardContent>
        )}
      </Card>

      {/* ── variables ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-xs font-medium">变量</CardTitle>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addVariable}>
            <Plus className="size-3" /> 添加
          </Button>
        </CardHeader>
        {model.variables.length > 0 ? (
          <CardContent className="space-y-2 pt-0">
            {model.variables.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-1.5">
                <input
                  className={inputCls + ' w-24'}
                  placeholder="变量名"
                  value={v.name}
                  onChange={(e) => updateVariable(v.id, { name: e.target.value })}
                />
                <span className="text-xs text-muted-foreground">:</span>

                {/* varKind select */}
                <select
                  className={inputCls + ' w-22 appearance-none bg-background'}
                  value={v.varKind}
                  onChange={(e) => updateVariable(v.id, { varKind: e.target.value })}
                >
                  {VAR_KIND_LABELS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>

                {/* lower bound */}
                <select
                  className={inputCls + ' w-14 appearance-none bg-background'}
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
                  className={inputCls + ' w-20'}
                  placeholder="下界"
                  value={v.lowerBound.value}
                  onChange={(e) =>
                    updateVariable(v.id, {
                      lowerBound: { ...v.lowerBound, value: e.target.value },
                    })
                  }
                />

                {/* upper bound */}
                <select
                  className={inputCls + ' w-14 appearance-none bg-background'}
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
                  className={inputCls + ' w-20'}
                  placeholder="上界"
                  value={v.upperBound.value}
                  onChange={(e) =>
                    updateVariable(v.id, {
                      upperBound: { ...v.upperBound, value: e.target.value },
                    })
                  }
                />

                <Button
                  variant="ghost"
                  size="sm"
                  className="size-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeVariable(v.id)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </CardContent>
        ) : (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">暂无变量，点击"添加"创建</p>
          </CardContent>
        )}
      </Card>

      {/* ── constraints ────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-xs font-medium">约束</CardTitle>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addConstraint}>
            <Plus className="size-3" /> 添加
          </Button>
        </CardHeader>
        {model.constraints.length > 0 ? (
          <CardContent className="space-y-2 pt-0">
            {model.constraints.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-1.5">
                <input
                  className={inputCls + ' w-16'}
                  placeholder="标签"
                  value={c.label}
                  onChange={(e) => updateConstraint(c.id, { label: e.target.value })}
                />
                <input
                  className={inputCls + ' min-w-0 flex-1'}
                  placeholder="左表达式"
                  value={c.leftExpr}
                  onChange={(e) => updateConstraint(c.id, { leftExpr: e.target.value })}
                />
                <select
                  className={inputCls + ' w-16 appearance-none bg-background'}
                  value={c.operator}
                  onChange={(e) => updateConstraint(c.id, { operator: e.target.value })}
                >
                  {OP_OPTIONS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
                <input
                  className={inputCls + ' min-w-0 flex-1'}
                  placeholder="右表达式"
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
            ))}
          </CardContent>
        ) : (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">暂无约束，点击"添加"创建</p>
          </CardContent>
        )}
      </Card>

      {/* ── objective ──────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium">目标</CardTitle>
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
            <input
              className={inputCls + ' w-full'}
              placeholder="目标表达式，如 利润"
              value={model.objective.expression}
              onChange={(e) => setObjectiveExpr(e.target.value)}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
