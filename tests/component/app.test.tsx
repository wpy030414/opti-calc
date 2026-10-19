// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { App } from '@/App'

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
 *
 * 默认模式已改为"简易"（simple），因此挂载后先看到 VisualEditor 表单而非
 * textarea。需要 textarea 的测试必须先切换到"专家"模式。
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

/** 切换到专家模式，返回 textarea 元素。 */
async function switchToExpert(container: HTMLElement): Promise<HTMLTextAreaElement> {
  const expertBtn = Array.from(container.querySelectorAll('button')).find(
    (el) => el.textContent === '专家',
  ) as HTMLElement | undefined
  if (expertBtn) {
    await act(async () => {
      expertBtn.click()
    })
    await flush()
  }
  const ta = container.querySelector('textarea') as HTMLTextAreaElement
  return ta
}

/** 切换到简易模式。 */
async function switchToSimple(container: HTMLElement): Promise<void> {
  const simpleBtn = Array.from(container.querySelectorAll('button')).find(
    (el) => el.textContent === '简易',
  ) as HTMLElement | undefined
  if (simpleBtn) {
    await act(async () => {
      simpleBtn.click()
    })
    await flush()
  }
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

  it('挂载后默认简易模式，渲染 VisualEditor 表单而非 textarea', () => {
    root = mount(container)
    expect(container.querySelector('h1')?.textContent).toContain('OptiCalc')
    // 简易模式：应有卡片表单，不应有 textarea
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.textContent).toContain('常量')
    expect(container.textContent).toContain('变量')
    expect(container.textContent).toContain('约束')
    expect(container.textContent).toContain('目标')
  })

  it('默认算例（钱不够时要等多久）在简易模式下自动求解并显示结果', async () => {
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

    const ta = await switchToExpert(container)
    // 第二行才出错：若行号定位失效（永远报第 1 行），本断言会失败
    await setInput(ta, 'x = 1\ny + ')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('第 2 行')
    expect(text).toContain('EOF')
    // 即使报错，页面骨架仍在
    expect(container.querySelector('h1')?.textContent).toContain('OptiCalc')
    expect(container.querySelector('textarea')).not.toBeNull()
  })

  it('错误消息不重复显示行号', async () => {
    root = mount(container)
    await flush()

    const ta = await switchToExpert(container)
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

    const ta = await switchToExpert(container)
    const lineCount = ta.value.split('\n').length
    // 行号栏在 textarea 之前，取 aria-hidden 的第一个兄弟容器
    const gutter = container.querySelector('[aria-hidden="true"]') as HTMLElement
    const gutterRows = gutter.querySelectorAll('div').length
    expect(gutterRows).toBe(lineCount)
  })

  it('切换到另一个模型后重新求解', async () => {
    root = mount(container)
    await flush()

    const ta = await switchToExpert(container)
    await setInput(ta, 'x + y = 10\nx - y = 4\n')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('已求解')
    expect(text).toContain('7') // x = 7
    expect(text).toContain('3') // y = 3
  })

  it('仅编辑后写盘：挂载后自动求解会触发编译→写盘，用户编辑后再次写盘', async () => {
    // 简易模式下 mount → decompile → compile → onChange → 持久化这个路径
    // 是 VisualEditor 的固有行为（区别于 Expert 真正惰性）。
    root = mount(container)
    await flush()

    // 清空此前写盘以验证后续编辑写盘
    window.localStorage.clear()
    const ta = await switchToExpert(container)
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

    const ta = await switchToExpert(container)
    expect(ta.value).toBe(custom)
    expect(container.textContent ?? '').toContain('苹果')
  })

  it('localStorage 损坏时回退到默认模型而非崩溃', async () => {
    window.localStorage.setItem('opti-calc:source', '{ 这不是 JSON')
    root = mount(container)
    await flush()

    const ta = await switchToExpert(container)
    // 反编译→编译回 DSL 会丢失注释，但关键内容（变量、约束、目标）应保留
    expect(ta.value).toContain('份数')
    expect(ta.value).toContain('非负整数')
    expect(ta.value).toContain('max 份数')
    expect(container.querySelector('h1')?.textContent).toContain('OptiCalc')
  })

  it('无解模型显示可操作的提示', async () => {
    root = mount(container)
    await flush()

    const ta = await switchToExpert(container)
    await setInput(ta, 'x = 10\nx <= 5\n')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('无解')
    expect(text).toContain('放宽')
  })

  it('乘积变量缺少边界时给出可操作提示', async () => {
    root = mount(container)
    await flush()

    const ta = await switchToExpert(container)
    await setInput(ta, 'x : 非负\ny : 非负\n收益 = x * y\nmax 收益\n')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('参与乘积')
    expect(text).toContain('上界')
  })

  it('连续相乘的近似解被明确标注损失率', async () => {
    root = mount(container)
    await flush()

    const ta = await switchToExpert(container)
    await setInput(ta, 'x : 非负 <= 10\ny : 非负 <= 10\nx + y <= 10\n收益 = x * y\nmax 收益\n')
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('近似')
    expect(text).toContain('损失率')
  })

  // ── 新需求验收 ────────────────────────────────────────────────

  it('header 只有标题 OptiCalc 与 GitHub 链接，无 favicon 图片', () => {
    root = mount(container)
    const header = container.querySelector('header')
    expect(header).not.toBeNull()

    // 标题
    expect(header!.querySelector('h1')?.textContent).toBe('OptiCalc')

    // 无 favicon img
    const img = header!.querySelector('img')
    expect(img).toBeNull()

    // 无副标题
    expect(header!.textContent).not.toContain('多元方程组')
    expect(header!.textContent).not.toContain('无浮点误差')

    // GitHub 链接
    const gh = header!.querySelector('a[aria-label="GitHub 仓库"]')
    expect(gh).not.toBeNull()
  })

  it('模型库（我的）在编辑器标题区，header 仅含标题和 GitHub 链接', () => {
    root = mount(container)
    const header = container.querySelector('header')!
    // header 中不包含模型库按钮
    const headerButtons = Array.from(header.querySelectorAll('button'))
    expect(headerButtons.every((b) => !b.textContent?.includes('我的'))).toBe(true)

    const main = container.querySelector('main')!
    // 模型库按钮「我的」和示例按钮都在主区域
    const mainButtons = Array.from(main.querySelectorAll('button'))
    expect(mainButtons.some((b) => b.textContent === '我的')).toBe(true)
    expect(mainButtons.some((b) => b.textContent === '示例')).toBe(true)
  })

  it('切换到简易模式后渲染 VisualEditor 表单', async () => {
    // 默认已是简易模式，先切到专家再切回来验证切换功能
    root = mount(container)
    await flush()

    // 先切到专家
    await switchToExpert(container)
    expect(container.querySelector('textarea')).toBeTruthy()

    // 再切回简易
    await switchToSimple(container)

    // VisualEditor 应该显示常量、变量、约束、目标四个 Card
    const text = container.textContent ?? ''
    expect(text).toContain('常量')
    expect(text).toContain('变量')
    expect(text).toContain('约束')
    expect(text).toContain('目标')
  })

  it('简易模式下添加变量后切换到专家模式，textarea 包含对应 DSL', async () => {
    root = mount(container)
    await flush()

    // 默认简易模式，先点"自己动手写"关闭引导面板
    const startBtn = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === '自己动手写',
    ) as HTMLElement | undefined
    if (startBtn) {
      await act(async () => {
        startBtn.click()
      })
      await flush()
    }

    // 找到变量卡片中的"添加"按钮
    const addButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('添加'),
    )
    // 常量卡片在前，变量是第二个
    const addVarBtnEl = addButtons[1] ?? addButtons[0]
    await act(async () => {
      addVarBtnEl!.click()
    })

    // 填写变量名
    const nameInput = container.querySelector('input[placeholder="变量名"]') as HTMLInputElement
    expect(nameInput).toBeTruthy()
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeSetter?.call(nameInput, '测试变量')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    // 切换回专家模式
    const ta = await switchToExpert(container)

    // textarea 中应包含编译出的 DSL
    expect(ta.value).toContain('测试变量')
    // 类型继承自被覆盖变量的设置，不是默认类型（类型在 DSL 中表现为级别声明）
    expect(ta.value).toMatch(/测试变量\s*:\s*\S+/)
  })

  it('加载示例后在简易模式下正确反编译', async () => {
    root = mount(container)
    await flush()

    // 默认简易模式，先点"自己动手写"关闭引导面板
    const startBtn = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === '自己动手写',
    ) as HTMLElement | undefined
    if (startBtn) {
      await act(async () => {
        startBtn.click()
      })
      await flush()
    }

    // 默认源应被反编译 — 至少有一个变量名输入框已填充
    const inputs = container.querySelectorAll('input')
    const filledNames = Array.from(inputs).filter(
      (i) => (i as HTMLInputElement).value && (i as HTMLInputElement).placeholder === '变量名',
    )
    expect(filledNames.length).toBeGreaterThan(0)
  })

  it('模式持久化到 localStorage', async () => {
    root = mount(container)
    await flush()

    // 默认已是简易模式 → 切到专家验证持久化
    const ta = await switchToExpert(container)
    expect(ta).toBeTruthy()

    const stored = window.localStorage.getItem('opti-calc:mode')
    expect(stored).toBe(JSON.stringify('expert'))
  })

  it('从 localStorage 恢复专家模式偏好', async () => {
    window.localStorage.setItem('opti-calc:mode', JSON.stringify('expert'))
    root = mount(container)
    await flush()

    // 应直接以专家模式渲染（textarea 可见）
    expect(container.querySelector('textarea')).toBeTruthy()
  })

  it('语法速查仅在专家模式下显示', async () => {
    root = mount(container)
    await flush()

    // 简易模式：语法速查不应显示
    expect(container.textContent).not.toContain('语法速查')

    // 切换到专家模式，语法速查应显示
    await switchToExpert(container)
    expect(container.textContent).toContain('语法速查')
  })

  it('语法速查默认展开', async () => {
    root = mount(container)
    await flush()

    // 简易模式下不显示，先切换到专家模式
    await switchToExpert(container)

    // 无需点击"展开"即可看到内容
    expect(container.textContent).toContain('语法速查')
    expect(container.textContent).toContain('变量声明')
  })

  it('示例按钮不显示选中示例名称', () => {
    root = mount(container)
    const exampleBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '示例',
    )
    expect(exampleBtn).toBeTruthy()
    // 不应出现 "· 某标题" 后缀
    expect(exampleBtn!.textContent).not.toContain('·')
  })
})
