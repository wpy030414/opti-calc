import { EXAMPLES, type Example } from '@/data/examples'
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
 * 示例下拉按钮。
 *
 * 只做一件事：列出内置算例，选中后加载到编辑器。
 */

const KIND_LABEL: Record<Example['kind'], string> = {
  定点: '求定点',
  最优: '求最优',
  整数规划: '整数规划',
  组合: '组合优化',
}

interface ExamplesButtonProps {
  onLoadExample: (source: string) => void
}

export function ExamplesButton({ onLoadExample }: ExamplesButtonProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          示例
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
  )
}
