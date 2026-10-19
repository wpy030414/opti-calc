import { useState, useCallback } from 'react'
import { Bookmark, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import type { SavedModel } from '@/lib/saved-models'
import { MODELS_KEY } from '@/lib/saved-models'

interface ModelLibraryButtonProps {
  source: string
  paramNames: string[]
  onLoad: (source: string, paramNames: string[]) => void
}

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ModelLibraryButton({ source, paramNames, onLoad }: ModelLibraryButtonProps) {
  const [models, setModels] = useLocalStorage<SavedModel[]>(MODELS_KEY, [])
  const [open, setOpen] = useState(false)

  const handleSave = useCallback(() => {
    const name = window.prompt('给当前模型起个名字：')
    if (!name || name.trim() === '') return

    const trimmed = name.trim()
    const existing = models.find((m) => m.name === trimmed)

    if (existing) {
      if (!window.confirm(`模型「${trimmed}」已存在，是否覆盖？`)) return
      setModels((prev) =>
        prev.map((m) =>
          m.name === trimmed
            ? { ...m, source, paramNames: [...paramNames], createdAt: Date.now() }
            : m,
        ),
      )
    } else {
      const model: SavedModel = {
        id: genId(),
        name: trimmed,
        source,
        paramNames: [...paramNames],
        createdAt: Date.now(),
      }
      setModels((prev) => [...prev, model])
    }
    setOpen(false)
  }, [source, paramNames, models, setModels])

  const handleLoad = useCallback(
    (m: SavedModel) => {
      onLoad(m.source, m.paramNames)
      setOpen(false)
    },
    [onLoad],
  )

  const handleDelete = useCallback(
    (m: SavedModel) => {
      if (!window.confirm(`确认删除模型「${m.name}」？此操作不可撤销。`)) return
      setModels((prev) => prev.filter((x) => x.id !== m.id))
    },
    [setModels],
  )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Bookmark className="mr-1 size-3.5" />
          模型库
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>我的模型</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => handleSave()} className="gap-2">
          <Save className="size-3.5" />
          <span>保存当前模型…</span>
        </DropdownMenuItem>

        {models.length > 0 ? <DropdownMenuSeparator /> : null}

        {models.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
            还没有保存的模型。
            <br />
            写好条件并标记参数后，点「保存当前模型」即可。
          </div>
        ) : (
          models.map((m) => (
            <DropdownMenuItem
              key={m.id}
              onSelect={() => handleLoad(m)}
              className="group flex-col items-start gap-0.5"
            >
              <div className="flex w-full items-center gap-2">
                <span className="font-medium">{m.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {fmtTime(m.createdAt)}
                </span>
                <button
                  className="ml-1 hidden rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:inline-flex"
                  onClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    handleDelete(m)
                  }}
                  aria-label={`删除 ${m.name}`}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
              <span className="text-xs text-muted-foreground">
                {m.paramNames.length > 0
                  ? `${m.paramNames.length} 个参数：${m.paramNames.join('、')}`
                  : '无参数'}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
