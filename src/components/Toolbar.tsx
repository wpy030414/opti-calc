import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { EXAMPLES, findExample, type Example } from '@/data/examples'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'

/**
 * 顶部工具栏：示例选择、复制、清空。
 *
 * 示例下拉是本产品「面向一般人群」的关键入口——用户不必先学 DSL，
 * 挑一个接近自己问题的算例改数字即可上手。
 */

interface ToolbarProps {
  onLoadExample: (source: string) => void
  onCopy: () => void
  onClear: () => void
  activeExampleId?: string
  canCopy: boolean
}

const KIND_LABEL: Record<Example['kind'], string> = {
  定点: '求定点',
  最优: '求最优',
  整数规划: '整数规划',
  组合: '组合优化',
}

export function Toolbar({
  onLoadExample,
  onCopy,
  onClear,
  activeExampleId,
  canCopy,
}: ToolbarProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (): void => {
    onCopy()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const active = activeExampleId ? findExample(activeExampleId) : undefined

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            示例
            {active ? (
              <span className="ml-1 hidden text-muted-foreground sm:inline">· {active.title}</span>
            ) : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>内置算例</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {EXAMPLES.map((ex) => (
            <DropdownMenuItem
              key={ex.id}
              onSelect={() => onLoadExample(ex.source)}
              className="flex-col items-start gap-0.5"
            >
              <div className="flex w-full items-center gap-2">
                <span className="font-medium">{ex.title}</span>
                <Badge variant="secondary" className="ml-auto px-1.5 py-0 text-[10px]">
                  {KIND_LABEL[ex.kind]}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">{ex.summary}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="sm" onClick={handleCopy} disabled={!canCopy}>
        {copied ? <Check className="text-emerald-600" /> : <Copy />}
        {copied ? '已复制' : '复制'}
      </Button>

      <Button variant="ghost" size="sm" onClick={onClear}>
        清空
      </Button>
    </div>
  )
}
