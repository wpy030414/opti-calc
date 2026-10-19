import { useState } from 'react'
import { BookOpen, ChevronDown } from 'lucide-react'
import { FUNCTION_NAMES } from '@/solver/parser'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

/**
 * 语法速查。
 *
 * 折叠式，默认收起——一般用户靠示例入门就够了，只有想写新模型时才需要展开。
 * 内容按「最常写错的顺序」排列：变量声明、约束、目标、常量、注释。
 */

const SNIPPETS: { title: string; code: string; note: string }[] = [
  {
    title: '变量声明',
    code: '份数 : 非负整数 <= 40\n盈亏 : free 实数\n是否采用 : 二元',
    note: '类型可用：实数 / 整数 / 非负 / 非负整数 / 正整数 / 二元。未声明的变量默认可取负值。',
  },
  {
    title: '约束条件',
    code: '预算 : 34*x + 42*y <= 849\n土地 : 4*大 + 小 <= 96\nx + y = 20',
    note: '支持 = <= >= < >。冒号前的标签会显示在结果核对表里。',
  },
  {
    title: '目标函数',
    code: 'max 大 * 100 + 小 * 18\nmin 34*x + 42*y',
    note: '一个模型最多一个目标。不写目标就是「求满足条件的任意一组解」。',
  },
  {
    title: '常量与注释',
    code: '每份小时 := 10\n总价 := 每份小时 * 34   # 行尾注释\n// 整行注释也可以',
    note: '常量必须先定义再使用，可以引用更早定义的常量。',
  },
]

export function SyntaxHelp() {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <BookOpen className="size-4 text-muted-foreground" />
            语法速查
          </span>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? '收起' : '展开'}
            <ChevronDown
              className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            />
          </Button>
        </CardTitle>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            一行写一条。变量名可以用中文，<code>2x</code> 这类省略乘号的写法也认； 全角符号（
            <code>＜＝</code>、全角数字）会自动转成半角。
          </p>

          {SNIPPETS.map((s) => (
            <div key={s.title}>
              <div className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {s.title}
              </div>
              <pre className="overflow-x-auto rounded-md bg-slate-100 p-3 font-mono text-xs leading-5 dark:bg-slate-900">
                {s.code}
              </pre>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.note}</p>
            </div>
          ))}

          <div>
            <div className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              取整函数
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              <code>{FUNCTION_NAMES.filter((f) => !['max', 'min'].includes(f)).join('、')}</code>{' '}
              可用于常量表达式（如 <code>ceil(成熟分钟 / 60 * 100) / 100</code>{' '}
              表示向上保留两位小数）。
              参数必须是已知数值——对未知量取整属于整数规划问题，请直接声明整数变量。
            </p>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              不支持
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              变量相乘（<code>x * y</code>）、变量的平方、变量做除数、
              <code>!=</code> 约束。这些都是非线性或非凸结构，需要换算法。
            </p>
          </div>
        </CardContent>
      ) : null}
    </Card>
  )
}
