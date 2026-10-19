import { forwardRef, useCallback, useMemo, useRef } from 'react'
import { commentStart, KEYWORDS } from '@/solver/parser'
import { cn } from '@/lib/utils'

/**
 * 模型编辑器。
 *
 * 实现方式是经典的「透明 textarea 叠在高亮层上」：两层字体、行高、内边距完全一致，
 * 因此光标位置与高亮文字始终对齐。滚动由 textarea 驱动、高亮层跟随。
 *
 * 高亮是**按行独立着色**的，不做跨行状态机——本语法每条语句独立成行，
 * 按行处理既简单又不会出现「前面写错导致后面全乱」的连锁失准。
 */

export interface EditorError {
  line: number
  message: string
}

interface ModelEditorProps {
  value: string
  onChange: (value: string) => void
  error?: EditorError | null
  className?: string
  id?: string
}

/** 语法着色的类别。 */
type SpanKind = 'comment' | 'keyword' | 'number' | 'operator' | 'variable' | 'plain'

interface Span {
  kind: SpanKind
  text: string
}

const SPAN_CLASS: Record<SpanKind, string> = {
  comment: 'text-slate-400 italic dark:text-slate-500',
  keyword: 'font-medium text-violet-600 dark:text-violet-400',
  number: 'text-amber-600 dark:text-amber-400',
  operator: 'text-sky-600 dark:text-sky-400',
  variable: 'text-slate-800 dark:text-slate-200',
  plain: 'text-slate-700 dark:text-slate-300',
}

// 标识符允许中文：U+0080 以上全部视作字母，覆盖 CJK 与全角字符。
const IDENT_CHAR = 'A-Za-z_$\\u0080-\\uffff'
/**
 * Token 正则。注意带 `g` 标志，使用前必须重置 `lastIndex`，
 * 否则模块级复用会漏匹配。
 */
const TOKEN_RE = new RegExp(
  [
    '\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?', // 数字
    `[${IDENT_CHAR}][${IDENT_CHAR}0-9]*`, // 标识符
    '[-+*/^=<>!:,()\\[\\]]+', // 运算符与括号
    '\\s+', // 空白
    '.', // 其它单字符
  ].join('|'),
  'g',
)

const IDENT_START_RE = new RegExp(`^[${IDENT_CHAR}]`)

/** 一行文本拆成着色片段。 */
function highlightLine(line: string): Span[] {
  const cut = commentStart(line)
  const code = cut < 0 ? line : line.slice(0, cut)
  const comment = cut < 0 ? '' : line.slice(cut)

  const spans: Span[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(code)) !== null) {
    const text = m[0]
    let kind: SpanKind
    if (/^\d/.test(text)) {
      kind = 'number'
    } else if (IDENT_START_RE.test(text)) {
      kind = KEYWORDS.has(text) || KEYWORDS.has(text.toLowerCase()) ? 'keyword' : 'variable'
    } else if (/^\s+$/.test(text)) {
      kind = 'plain'
    } else {
      kind = 'operator'
    }
    spans.push({ kind, text })
  }
  if (comment !== '') spans.push({ kind: 'comment', text: comment })
  return spans
}

export const ModelEditor = forwardRef<HTMLTextAreaElement, ModelEditorProps>(function ModelEditor(
  { value, onChange, error, className, id },
  ref,
) {
  const highlightRef = useRef<HTMLPreElement>(null)
  // forwardRef 与内部 ref 合并；内部 ref 供滚动同步使用
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const lines = useMemo(() => value.split('\n'), [value])

  const onScroll = useCallback(() => {
    const ta = innerRef.current
    const pre = highlightRef.current
    if (!ta || !pre) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  }, [])

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    },
    [ref],
  )

  const errorLine = error?.line ?? -1

  return (
    <div
      className={cn(
        'relative flex overflow-hidden rounded-md border bg-slate-50 font-mono text-[13px] leading-6 dark:bg-slate-950',
        error && 'border-destructive/60',
        className,
      )}
    >
      {/* 行号 + 错误标记 */}
      <div
        aria-hidden="true"
        className="w-[3.25rem] shrink-0 border-r bg-slate-100/80 py-3 text-right select-none dark:bg-slate-900/60"
      >
        {lines.map((_, i) => (
          <div
            key={i}
            className={cn(
              'px-2',
              i + 1 === errorLine
                ? 'bg-destructive/15 font-semibold text-destructive'
                : 'text-slate-400 dark:text-slate-500',
            )}
          >
            {i + 1}
          </div>
        ))}
      </div>

      <div className="relative flex-1">
        {/* 高亮层：与 textarea 共用字号、行高、内边距、换行策略 */}
        <pre
          ref={highlightRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-auto p-3 break-words whitespace-pre-wrap"
        >
          {lines.map((line, i) => (
            <span key={i} className={cn('block', i + 1 === errorLine && 'bg-destructive/10')}>
              {highlightLine(line).map((s, j) => (
                <span key={j} className={SPAN_CLASS[s.kind]}>
                  {s.text}
                </span>
              ))}
              {/* 空行需要一个占位字符撑住行高 */}
              {line === '' ? ' ' : ''}
            </span>
          ))}
          {/* 末尾补一行，滚动到最后一行时高亮层不会短一截 */}
          <span className="block"> </span>
        </pre>

        {/* 输入层：文字透明、光标可见 */}
        <textarea
          ref={setRefs}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={onScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="soft"
          aria-label="模型编辑器"
          aria-invalid={error ? true : undefined}
          className="relative block h-full min-h-[22rem] w-full resize-y bg-transparent p-3 text-transparent break-words whitespace-pre-wrap caret-slate-900 outline-none selection:bg-sky-200/60 dark:caret-slate-100 dark:selection:bg-sky-500/40"
        />
      </div>
    </div>
  )
})
