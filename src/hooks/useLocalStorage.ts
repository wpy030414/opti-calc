import { useCallback, useEffect, useState } from 'react'

/**
 * localStorage 持久化状态。
 *
 * 纯前端应用没有数据库，用户写的模型必须存在本地，否则刷新即丢。
 * 三个细节：
 * - 读取失败（隐私模式 / 配额满 / JSON 损坏）静默回退到初始值，绝不让应用白屏；
 * - 写入失败同样只忽略，不打断用户输入；
 * - 跨标签页同步（`storage` 事件），多开页面时不会互相覆盖成旧值。
 */
export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial))

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
        write(key, resolved)
        return resolved
      })
    },
    [key],
  )

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key !== key) return
      if (e.newValue === null) {
        setValue(initial)
        return
      }
      try {
        setValue(JSON.parse(e.newValue) as T)
      } catch {
        // 其它标签页写了非法 JSON，忽略即可
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key, initial])

  return [value, update]
}

function read<T>(key: string, initial: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return initial
    return JSON.parse(raw) as T
  } catch {
    return initial
  }
}

function write<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 配额满或隐私模式：保持内存态可用，不向用户抛错
  }
}

/** 直接读取（用于非响应式场景，如初始化主题）。 */
export function readStorage<T>(key: string, initial: T): T {
  return read(key, initial)
}
