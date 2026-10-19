// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { App } from '@/App'
import { DEFAULT_SOURCE } from '@/data/examples'

/**
 * 组件渲染验收。
 *
 * 内核逻辑已由 112 个单元测试与 E2E 算例覆盖，本文件只验证一件单元测试
 * 覆盖不到的事：**React 能否真的挂载起来并把解算结果显示到 DOM 上**。
 *
 * 挂载期错误（hook 顺序、ref 误用、渲染中抛异常、Radix 在 jsdom 下的兼容问题）
 * 在 node 环境的测试里完全不可见，而它们恰恰是「构建成功但页面白屏」的常见成因。
 * 构建验收只能证明代码能打包，证明不了能渲染。
 *
 * 注意文件顶部的 `@vitest-environment jsdom` docblock：项目默认环境是 node，
 * 只有本文件需要 DOM。
 */

/** act() 要求显式声明当前处于 React 测试环境，否则 React 会拒绝批次更新。 */
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
})

afterEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
})

/** 等待防抖（300ms）结束并完成一次求解。 */
async function flush(ms = 400): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function mount(el: HTMLElement): Root {
  let root!: Root
  act(() => {
    root = createRoot(el)
    root.render(<App />)
  })
  return root
}

/**
 * 给受控 textarea 设值。
 *
 * React 的受控组件会忽略直接赋值的 `value`——必须走原型上的原生 setter
 * 绕过 React 的 value tracker，再派发 input 事件，onChange 才会触发。
 *
 * 这里把描述符转成「set 是函数属性」的接口：lib.d.ts 把 `PropertyDescriptor.set`
 * 声明为方法（`set?(v: any): void`），因此单纯读取它就会触发 unbound-method 警告，
 * 而我们随后是以 `.call(ta, …)` 显式绑定调用的，语义上并没有丢 this。
 * 转成属性类型让声明与实际用法一致，比抑制警告更诚实。
 */
interface TypedValueDescriptor {
  set?: (this: HTMLTextAreaElement, v: string) => void
}

async function setInput(ta: HTMLTextAreaElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value') as
    | TypedValueDescriptor
    | undefined
  const setter = descriptor?.set
  await act(async () => {
    setter?.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('App 渲染验收', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  it('挂载后渲染出标题与编辑器，无异常抛出', () => {
    root = mount(container)
    expect(container.querySelector('h1')?.textContent).toContain('opti-calc')
    // textarea 是输入层，必须存在且带默认模型
    const ta = container.querySelector('textarea')
    expect(ta).not.toBeNull()
    expect(ta?.value).toBe(DEFAULT_SOURCE)
  })

  it('默认算例（钱不够时要等多久）自动求解并显示结果', async () => {
    root = mount(container)
    await flush()

    const text = container.textContent ?? ''
    // 求解成功横幅
    expect(text).toContain('已求解')
    // 文档算例的关键数字：买 2 份、等待 29.75 分钟
    expect(text).toContain('份数')
    expect(text).toContain('等待分钟')
    expect(text).toContain('29.75')
    // 约束核对表存在
    expect(text).toContain('约束核对')
  })

  it('语法错误时显示行号与原因，而非白屏', async () => {
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    // 第二行才出错：若行号定位失效（永远报第 1 行），本断言会失败
    await setInput(ta, 'x = 1\ny + ')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('第 2 行')
    expect(text).toContain('EOF')
    // 即使报错，页面骨架仍在
    expect(container.querySelector('h1')?.textContent).toContain('opti-calc')
    expect(container.querySelector('textarea')).not.toBeNull()
  })

  it('错误消息不重复显示行号', async () => {
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    await setInput(ta, 'x @ 1')
    await flush()

    // 位置信息只应出现一次：面板前缀「第 N 行：」+ 纯语义消息
    const text = container.textContent ?? ''
    expect(text).toContain('第 1 行：')
    expect(text).toContain('无法识别的字符「@」')
    expect(text).not.toContain('第 1 行第')
  })

  it('行号数量与模型行数一致', async () => {
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    const lineCount = ta.value.split('\n').length
    // 行号栏在 textarea 之前，取 aria-hidden 的第一个兄弟容器
    const gutter = container.querySelector('[aria-hidden="true"]') as HTMLElement
    const gutterRows = gutter.querySelectorAll('div').length
    expect(gutterRows).toBe(lineCount)
  })

  it('切换到另一个模型后重新求解', async () => {
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    await setInput(ta, 'x + y = 10\nx - y = 4\n')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('已求解')
    expect(text).toContain('7') // x = 7
    expect(text).toContain('3') // y = 3
  })

  it('仅编辑后写盘：默认模型不覆盖用户存档', async () => {
    // 惰性写入是刻意设计：若挂载即写盘，日后调整默认算例会把老用户的存档顶掉。
    root = mount(container)
    await flush()
    expect(window.localStorage.getItem('opti-calc:source')).toBeNull()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    await setInput(ta, 'x = 3\n')
    await flush()

    const stored = window.localStorage.getItem('opti-calc:source')
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored as string)).toBe('x = 3\n')
  })

  it('从 localStorage 恢复用户上次的模型', async () => {
    const custom = '苹果 = 3\n'
    window.localStorage.setItem('opti-calc:source', JSON.stringify(custom))
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.value).toBe(custom)
    expect(container.textContent ?? '').toContain('苹果')
  })

  it('localStorage 损坏时回退到默认模型而非崩溃', async () => {
    window.localStorage.setItem('opti-calc:source', '{ 这不是 JSON')
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.value).toBe(DEFAULT_SOURCE)
    expect(container.querySelector('h1')?.textContent).toContain('opti-calc')
  })

  it('无解模型显示可操作的提示', async () => {
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    await setInput(ta, 'x = 10\nx <= 5\n')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('无解')
    expect(text).toContain('放宽')
  })

  it('非线性模型被拒绝并说明原因', async () => {
    root = mount(container)
    await flush()

    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    await setInput(ta, 'x : 非负\ny : 非负\n收益 = x * y\nmax 收益\n')
    await flush()

    expect(container.textContent ?? '').toContain('非线性')
  })
})
