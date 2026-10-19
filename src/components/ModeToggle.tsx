import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

interface ModeToggleProps {
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
}

export function ModeToggle({ mode, onModeChange }: ModeToggleProps) {
  return (
    <ToggleGroup
      type="single"
      value={mode}
      onValueChange={(v) => v && onModeChange(v as EditorMode)}
    >
      <ToggleGroupItem value="simple">简易</ToggleGroupItem>
      <ToggleGroupItem value="expert">专家</ToggleGroupItem>
    </ToggleGroup>
  )
}

type EditorMode = 'simple' | 'expert'
