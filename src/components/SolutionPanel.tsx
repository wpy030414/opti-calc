import { Frac } from '@/solver/frac'
import { displayValue, exactText, percentText } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Solution } from '@/solver/model'

/**
 * 求解结果面板。
 *
 * 展示顺序遵循「算账的人先看什么」：先看目标值（花了多少钱 / 赚了多少钱），
 * 再看各变量取值，最后才是约束核对表。诊断信息（无解 / 无界 / 提示）永远置顶，
 * 因为它是用户下一步该改哪里的唯一线索。
 */

interface SolutionPanelProps {
  solution: Solution | null
  /** 目标值的标题；无目标函数时面板不显示该卡片，此值不被使用。 */
  objectiveLabel: string
  className?: string
}

export function SolutionPanel({ solution, objectiveLabel, className }: SolutionPanelProps) {
  if (!solution) {
    return (
      <Card className={className}>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          在左侧写下条件后自动求解
        </CardContent>
      </Card>
    )
  }

  const status = solution.status

  return (
    <div className={className}>
      <StatusBanner status={status} approximate={solution.approximation !== undefined} />

      {solution.objectiveValue && status.kind === 'optimal' ? (
        <Card className="mb-3">
          <CardContent className="py-4">
            <div className="text-xs tracking-wide text-muted-foreground uppercase">
              {objectiveLabel}
              {solution.approximation ? '（近似）' : ''}
            </div>
            <div className="mt-1 font-mono text-3xl font-semibold tabular-nums">
              {solution.approximation ? '≈ ' : ''}
              {displayValue(solution.objectiveValue)}
            </div>
            {solution.approximation ? (
              <p className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                连续变量相乘属于非凸问题，这里给出的是近似最优解； 与真实最优值的相对损失率不超过{' '}
                <span className="font-mono">{percentText(solution.approximation.relativeGap)}</span>
                。
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {status.kind === 'optimal' ? (
        <Card className="mb-3">
          <CardHeader>
            <CardTitle>各变量取值</CardTitle>
          </CardHeader>
          <CardContent>
            <VariableTable values={solution.values} order={solution.varOrder} />
          </CardContent>
        </Card>
      ) : null}

      {solution.constraintReport && solution.constraintReport.length > 0 ? (
        <Card className="mb-3">
          <CardHeader>
            <CardTitle>约束核对</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-64">
              <ConstraintTable report={solution.constraintReport} />
            </ScrollArea>
          </CardContent>
        </Card>
      ) : null}

      {solution.warnings.length > 0 ? (
        <Card className="mb-3 border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
              需要注意
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-amber-900/90 dark:text-amber-200/90">
              {solution.warnings.map((w, i) => (
                <li key={i} className="leading-relaxed">
                  {w}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {solution.stats ? <StatsFooter stats={solution.stats} /> : null}
    </div>
  )
}

function StatusBanner({
  status,
  approximate,
}: {
  status: Solution['status']
  approximate: boolean
}) {
  if (status.kind === 'optimal') {
    if (approximate) {
      return (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900/50 dark:bg-amber-950/30">
          <Badge variant="warning">近似解</Badge>
          <span className="text-sm text-amber-900 dark:text-amber-200">
            非凸问题无法精确求解，以下为带损失率保证的近似最优解
          </span>
        </div>
      )
    }
    return (
      <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900/50 dark:bg-emerald-950/30">
        <Badge variant="success">已求解</Badge>
        <span className="text-sm text-emerald-900 dark:text-emerald-200">
          找到满足全部条件的答案
        </span>
      </div>
    )
  }
  if (status.kind === 'infeasible') {
    return (
      <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
        <Badge variant="destructive">无解</Badge>
        <p className="mt-2 text-sm leading-relaxed text-destructive">
          {status.reason ?? '条件互相矛盾，没有任何一组取值能同时满足。'}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          试着放宽某个上限、降低某个下限，或检查是否把不等号写反了。
        </p>
      </div>
    )
  }
  if (status.kind === 'unbounded') {
    return (
      <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-900/50 dark:bg-amber-950/30">
        <Badge variant="warning">无界</Badge>
        <p className="mt-2 text-sm leading-relaxed text-amber-900 dark:text-amber-200">
          目标值可以无限增大（或减小），说明还缺一个限制条件。
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          现实中总会有预算、库存或时间上限，把它写成一条 <code>&lt;=</code> 约束即可。
        </p>
      </div>
    )
  }
  return (
    <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
      <Badge variant="destructive">未能求解</Badge>
      <p className="mt-2 text-sm leading-relaxed text-destructive">
        {status.reason ?? '问题规模超出求解器上限。'}
      </p>
    </div>
  )
}

function VariableTable({ values, order }: { values: ReadonlyMap<string, Frac>; order: string[] }) {
  const names = order.filter((n) => values.has(n))
  // order 里可能漏掉某些变量（例如仅在常量折叠后出现），补上以防遗漏
  for (const n of values.keys()) {
    if (!names.includes(n)) names.push(n)
  }

  if (names.length === 0) {
    return <p className="text-sm text-muted-foreground">没有待求的未知量。</p>
  }

  return (
    <table className="w-full text-sm">
      <tbody>
        {names.map((name) => {
          const v = values.get(name) as Frac
          const integral = v.d === 1n
          return (
            <tr key={name} className="border-b last:border-0">
              <td className="py-2 pr-3 font-mono text-slate-700 dark:text-slate-300">{name}</td>
              <td className="py-2 text-right font-mono tabular-nums">
                {displayValue(v)}
                {integral ? null : (
                  <span className="ml-2 text-xs text-muted-foreground">精确值 {exactText(v)}</span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ConstraintTable({ report }: { report: NonNullable<Solution['constraintReport']> }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="pb-2 font-normal">约束</th>
          <th className="pb-2 text-right font-normal">余量</th>
          <th className="pb-2 pl-3 text-right font-normal">状态</th>
        </tr>
      </thead>
      <tbody>
        {report.map((r, i) => (
          <tr key={i} className="border-b last:border-0">
            <td className="py-2 pr-3 font-mono text-xs text-slate-600 dark:text-slate-400">
              {r.name ?? `第 ${r.line} 行`}
            </td>
            <td className="py-2 text-right font-mono text-xs tabular-nums">
              {displayValue(r.slack)}
            </td>
            <td className="py-2 pl-3 text-right">
              {r.satisfied ? (
                r.tight ? (
                  <Badge variant="secondary">取等</Badge>
                ) : (
                  <Badge variant="success">满足</Badge>
                )
              ) : (
                <Badge variant="destructive">违反</Badge>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StatsFooter({ stats }: { stats: NonNullable<Solution['stats']> }) {
  const items = [
    ['未知量', stats.vars],
    ['约束', stats.constraints],
    ['整数变量', stats.integerVars],
  ]
  if (stats.lpNodes !== undefined && stats.lpNodes > 1) items.push(['搜索节点', stats.lpNodes])

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([label, n]) => (
        <span key={label as string}>
          {label as string} <span className="font-mono tabular-nums">{String(n)}</span>
        </span>
      ))}
    </div>
  )
}
