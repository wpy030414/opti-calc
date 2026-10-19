import { useEffect, useState } from 'react'

/**
 * 延迟同步值。
 *
 * 求解是同步的精确算术，小模型开销可忽略，但用户连续敲键盘时
 * 每敲一个字符就重解一次既浪费也会让结果面板闪烁。
 * 输入停顿后再求解，体感上更像「算完了」而不是「一直在算」。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return debounced
}
