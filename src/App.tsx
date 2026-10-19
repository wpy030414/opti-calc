import { useCallback, useMemo, useState } from 'react'
import { Github } from 'lucide-react'
import { ModelEditor, type EditorError } from '@/components/ModelEditor'
import { SolutionPanel } from '@/components/SolutionPanel'
import { SyntaxHelp } from '@/components/SyntaxHelp'
import { ModeToggle } from '@/components/ModeToggle'
import { VisualEditor } from '@/components/VisualEditor'
import { ExamplesButton } from '@/components/ExamplesButton'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { DEFAULT_SOURCE } from '@/data/examples'
import { solve } from '@/solver/solve'
import { SolverError } from '@/solver/errors'
import type { Solution } from '@/solver/model'

/**
 * 应用主体。
 *
 * 求解是同步的精确算术，小模型耗时在毫秒级，因此直接放在渲染路径里用 `useMemo` 计算，
 * 不引入 Web Worker——多一层线程边界只会让错误处理和类型共享变复杂。
 * 若将来模型规模增长到需要秒级求解，再把这段 `useMemo` 换成 Worker 即可，
 * 因为求解入口只有 `solve(source)` 一个纯函数，迁移成本很低。
 *
 * 输入用 300ms 防抖：连续敲键盘时不重解，避免结果面板闪烁。
 */

const STORAGE_KEY = 'opti-calc:source'
const MODE_KEY = 'opti-calc:mode'
const GITHUB_URL = 'https://github.com/xrl/opti-calc'

type EditorMode = 'simple' | 'expert'

/**
 * 求解一次，把结果或错误收敛成单一状态。
 *
 * 这里**不**为了拿变量顺序而二次解析模型——`solve()` 的返回值已经带上了
 * `varOrder` 与 `objectiveSense`，重复解析既浪费又可能与求解时的结果不一致。
 */
function runSolve(source: string): { solution: Solution | null; error: EditorError | null } {
  if (source.trim() === '') return { solution: null, error: null }
  try {
    return { solution: solve(source), error: null }
  } catch (err) {
    if (err instanceof SolverError) {
      return { solution: null, error: { line: err.line ?? 1, message: err.message } }
    }
    // 非预期错误也要显示出来，不能静默吞掉——否则用户会以为是自己写错了
    return { solution: null, error: { line: 1, message: `内部错误：${(err as Error).message}` } }
  }
}

const OBJECTIVE_LABEL: Record<string, string> = {
  max: '最大值',
  min: '最小值',
}

function readMode(): EditorMode {
  try {
    const raw = window.localStorage.getItem(MODE_KEY)
    if (raw === '"simple"') return 'simple'
  } catch {
    // ignore
  }
  return 'expert'
}

export function App() {
  const [source, setSource] = useLocalStorage<string>(STORAGE_KEY, DEFAULT_SOURCE)
  const [mode, setMode] = useState<EditorMode>(readMode)
  const debounced = useDebouncedValue(source, 300)
  const outcome = useMemo(() => runSolve(debounced), [debounced])

  const handleLoadExample = useCallback(
    (next: string) => {
      setSource(next)
    },
    [setSource],
  )

  const handleModeChange = useCallback((next: EditorMode) => {
    setMode(next)
    try {
      window.localStorage.setItem(MODE_KEY, JSON.stringify(next))
    } catch {
      // ignore
    }
  }, [])

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <h1 className="mr-auto text-sm font-semibold">OptiCalc</h1>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-label="GitHub 仓库"
          >
            <Github className="size-4" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-medium">模型</h2>
              <ModeToggle mode={mode} onModeChange={handleModeChange} />
            </div>
            <ExamplesButton onLoadExample={handleLoadExample} />
          </div>

          {mode === 'simple' ? (
            <VisualEditor source={source} onChange={setSource} error={outcome.error} />
          ) : (
            <ModelEditor value={source} onChange={setSource} error={outcome.error} />
          )}

          {outcome.error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              第 {outcome.error.line} 行：{outcome.error.message}
            </p>
          ) : null}

          {mode === 'expert' ? <SyntaxHelp /> : null}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium">结果</h2>
          <SolutionPanel
            solution={outcome.solution}
            objectiveLabel={
              outcome.solution?.objectiveSense
                ? (OBJECTIVE_LABEL[outcome.solution.objectiveSense] ?? '目标值')
                : '目标值'
            }
          />
        </section>
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-6 text-xs text-muted-foreground">
        全部计算在浏览器本地完成，模型与结果不会上传。
      </footer>
    </div>
  )
}
