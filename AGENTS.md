# AGENTS.md

opti-calc 是一个纯前端的多元方程组 / 约束优化求解编辑器，核心价值在自研的精确求解内核。

## 概述

- **本项目是什么**：用户在编辑器里写下一份「模型」（变量声明、约束、目标），前端同步求解并展示结果。没有服务端、没有数据库，模型存 localStorage。
- **两条独立的价值线**：一是求解内核（`src/solver/`），与 UI 完全解耦，是纯函数；二是编辑器界面（`src/components/`），只负责把文本喂给内核、把结果渲染出来。

## 边界与范围

**范围内**

- 线性模型：多元一次方程组、线性不等式约束、线性目标的最值、整数 / 二元变量。
- 精确算术：所有数值以 BigInt 有理数表示，输入十进制字符串不经过 `number`。
- 诊断能力：区分「无解 / 无界 / 解不唯一 / 缺几个条件」，并给出可操作的下一步。

**非目标（明确排除）**

- 非线性与非凸问题：变量相乘、多项式、分式规划、`!=` 约束。这类需求应明确告知用户超出范围，而不是尝试近似求解。
- 服务端能力：账号、云存储、协作、模型分享链接。需要时改走 monorepo 路线，不要在纯前端上叠后端假设。
- 大规模 MILP 性能优化：分支定界用的是深度优先 + 界剪枝，够算账场景用；不要为了跑工业级算例引入割平面或启发式。
- SEO / 预渲染：客户端渲染的 SPA，部署在 GitHub Pages 上。

## Agent 操作指南

**如何理解本项目**

改动前先分清落在哪条价值线上：

- 改**求解语义** → 动 `src/solver/`，必须同步补 `tests/unit/` 或 `tests/e2e/`。内核的行为契约由测试定义，尤其 `tests/e2e/qq-farm.test.ts`（真实算账文档的逐条复现）是验收标准，不要为了通过测试而放宽断言。
- 改**呈现方式** → 动 `src/components/`，验收看 `tests/component/app.test.tsx`。

**必须遵守的约定**

1. **不要在数值路径上引入 `number`。** `Frac` 存在的唯一理由就是消除浮点误差；`toNumber()` 只用于展示等非关键路径。任何 `parseFloat` / `Number()` 出现在求解链路里都是缺陷。
2. **不要吞掉错误。** `SolverError` 及子类携带 `line` / `col`，必须冒泡到 UI 让用户看到出错行。
3. **位置信息只放结构化字段。** 异常 `message` 只描述语义，行号由 `line` / `col` 承载、UI 决定如何呈现。例外是 `warnings`（纯字符串数组，没有结构化字段），它必须自带行号。
4. **拒绝非线性要给出理由和出路**，不要只说「不支持」。用户看到的消息要能指导下一步。
5. **构建、检查、测试统一走 vp**，不要绕过它直接调 `tsc` / `prettier` / `vitest`。`package.json` 里不写 `packageManager` 字段。
6. **提交前跑 `vp check` 与 `vp test`**，两者都要零错误零警告。

**已知易踩的坑**

- `vite.config.ts` 必须用 `lazyPlugins(() => react())`。直接写 `plugins: [react()]` 会让 tsc 崩溃——`defineConfig` 的多重载在比较真实 `vite` 与 vp 别名包的 `Plugin` 巨型类型时触发 TS 内部断言失败。详见 ADR-005。
- 测试从 `vite-plus/test` 导入，不是 `vitest`。vitest 是 vp 的依赖、未提升到顶层 `node_modules`，直接导入 `tsc` 找不到类型。
- 组件测试文件首行需要 `// @vitest-environment jsdom` docblock（项目默认环境是 node）。
- 在 Git Bash 里传 `PAGES_BASE_PATH=/opti-calc/` 会被 MSYS 路径转换成 `C:\Program Files\Git\...`，需设 `MSYS_NO_PATHCONV=1`。CI 跑在 ubuntu 上无此问题。

## 目录速查

- `src/solver/` — 求解内核（纯函数，无 React 依赖）
- `src/solver/frac.ts` — BigInt 精确有理数，整套内核的数值地基
- `src/solver/lexer.ts` / `parser.ts` — 词法与递归下降语法分析，按行分句以精确定位错误
- `src/solver/linearize.ts` — AST 折叠为稀疏线性式，非线性结构在此拒绝
- `src/solver/gaussian.ts` — 精确 RREF，负责「唯一 / 无穷多 / 矛盾」诊断
- `src/solver/lp.ts` — 两阶段单纯形（Bland 规则）
- `src/solver/milp.ts` — 分支定界整数规划
- `src/solver/standardize.ts` — 标准形转换：下界平移、自由变量拆分、严格不等式处理
- `src/solver/solve.ts` — 编排层，内核唯一入口 `solve(text) → Solution`
- `src/solver/index.ts` — 内核总出口，控制暴露给 UI 的表面积
- `src/components/` — 应用组件（编辑器、结果面板、工具栏、语法速查）
- `src/components/ui/` — shadcn/ui 基础组件
- `src/lib/format.ts` — 展示层数值格式化（精确值 / 近似值 / 时长换算）
- `src/hooks/` — `useLocalStorage`（持久化）、`useDebouncedValue`（防抖）
- `src/data/examples.ts` — 内置算例；前四个逐条取自真实算账文档，后四个为覆盖其它模型形态而构造
- `tests/unit/` — 内核单元测试
- `tests/e2e/qq-farm.test.ts` — 验收标准：逐条复现真实算账文档
- `tests/component/app.test.tsx` — jsdom 渲染验收，覆盖单元测试看不到的挂载期错误
- `docs/` — PRD / ARCHITECTURE / DECISIONS / specs
