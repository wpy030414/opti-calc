# ARCHITECTURE — opti-calc

## 系统概述

两层结构，单向依赖：**内核不依赖 UI，UI 只依赖内核的唯一入口**。

```
┌─────────────────────────────────────────────────────────────┐
│  界面层 (src/components, src/hooks, src/lib)                 │
│                                                             │
│   ModelEditor ──┐                                           │
│   Toolbar       ├──→ App ──useMemo──→ solve(source)         │
│   SolutionPanel ┘         │                  │              │
│   SyntaxHelp              ↓                  ↓              │
│                      useLocalStorage    Solution            │
│                      useDebouncedValue       │              │
│                                              ↓              │
│                                    format.ts (展示格式化)    │
└──────────────────────────────────────────────┼──────────────┘
                                               │ 只穿过 index.ts
┌──────────────────────────────────────────────┼──────────────┐
│  求解内核 (src/solver)                       ↓              │
│                                                             │
│   文本 ─→ lexer ─→ parser ─→ linearize ─→ solve ─→ Solution  │
│            │        │           │           │               │
│            ↓        ↓           ↓           ↓               │
│         Token[]   Stmt[]      Model    ┌────┴────┐          │
│                                  │      ↓         ↓          │
│                                  │  gaussian   standardize    │
│                                  │  (RREF 诊断)    │          │
│                                  │      │          ↓          │
│                                  └──────┴───→   milp          │
│                                                 │              │
│                                                 ↓              │
│                                                lp              │
│                                                             │
│   贯穿全层：frac (BigInt 有理数) / linexpr / errors          │
└─────────────────────────────────────────────────────────────┘
```

## 核心模块

| 模块                           | 职责                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frac.ts`                      | BigInt 精确有理数。不可变值对象，恒满足 `d > 0` 且已约分。十进制字符串解析不经 `number`，因此 `0.1` 就是 `1/10`。附带 `floorDiv` / `ceilDiv` / `roundDiv` / `zeros` 等内核通用工具 |
| `errors.ts`                    | `SolverError` 及三个子类（`ParseError` / `ModelError` / `NumericError`），携带 `line` / `col`。`describe()` 生成「第 N 行：语义」的完整文本                                        |
| `ast.ts`                       | 表达式 AST 与 `Pos` 位置类型的纯声明，无逻辑                                                                                                                                       |
| `lexer.ts`                     | 词法分析。全角字符归一化（1:1 映射，不改变列号）、`#` 与 `//` 行注释、中文标识符、`==` 归一化为 `=`                                                                                |
| `parser.ts`                    | 递归下降语法分析，**按行分句**。产出 `Stmt[]`（变量声明 / 常量 / 目标 / 约束）。导出 `KEYWORDS` 与 `commentStart` 供编辑器高亮复用                                                 |
| `linexpr.ts`                   | 稀疏线性表达式 `Σ coef·x + const`。合并同类项、求值、`tryMul` / `tryDiv`（非线性时返回 `null` 而非抛错，由调用方决定）                                                             |
| `linearize.ts`                 | AST → `LinExpr` 折叠，并组装 `Model`。所有非线性结构在此**带行号拒绝**；常量参数上的取整函数在此折叠                                                                               |
| `model.ts`                     | 模型与结果的类型声明：`Model` / `Constraint` / `VarDecl` / `Solution` / `SolveStatus`                                                                                              |
| `gaussian.ts`                  | 精确 Gauss-Jordan 消元至 RREF。区分唯一解 / 无穷多解（给出解空间基）/ 矛盾行，并算出「尚缺几个条件」                                                                               |
| `standardize.ts`               | 转 LP 标准形。下界平移、自由变量拆分为 `x⁺ - x⁻`、整数变量的非整数边界收紧、严格不等式处理、上界转约束行                                                                           |
| `lp.ts`                        | 两阶段单纯形。第一阶段人工变量找可行基，第二阶段求原目标；Bland 规则防循环                                                                                                         |
| `milp.ts`                      | 分支定界。深度优先 + 当前最优值剪枝，节点上限 20 万                                                                                                                                |
| `solve.ts`                     | **编排层，内核唯一入口**。选路、诊断、唯一性探测、约束核对报告、把结果拼成 `Solution`                                                                                              |
| `index.ts`                     | 内核总出口，控制暴露给界面层的表面积                                                                                                                                               |
| `components/ModelEditor.tsx`   | 透明 textarea 叠加语法高亮层，行号栏、错误行标记、滚动同步                                                                                                                         |
| `components/SolutionPanel.tsx` | 目标值卡片、变量取值表、约束核对表、诊断横幅、提示列表                                                                                                                             |
| `lib/format.ts`                | 展示层格式化：精确值 / 近似值 / 小时转「x 小时 y 分钟」                                                                                                                            |
| `hooks/useLocalStorage.ts`     | 惰性写入的持久化状态，跨标签页同步，读写失败静默降级                                                                                                                               |
| `hooks/useDebouncedValue.ts`   | 输入停顿后再求解，避免逐字符重算与面板闪烁                                                                                                                                         |
| `data/examples.ts`             | 内置算例。前四个取自真实算账文档，后四个覆盖其它模型形态                                                                                                                           |

## 模块关系

**分层原则**

- 内核（`src/solver/`）不含任何 React / DOM 依赖，可独立测试。
- 界面层只通过 `index.ts` 使用内核，不直接 import `lp.ts` / `milp.ts`——避免界面依赖矩阵布局，日后换算法要连着改 UI。
- 例外：`parser.ts` 的 `commentStart` / `KEYWORDS` 被 `ModelEditor` 直接使用。这是刻意的——高亮与解析必须共用同一份注释与关键字规则，否则会出现「高亮认为是代码、解析器认为是注释」的不一致。

**求解路径选择（`solve.ts` 的核心决策）**

| 模型形态         | 路径                                | 为什么                        |
| ---------------- | ----------------------------------- | ----------------------------- |
| 等式系统自相矛盾 | 直接判 infeasible                   | 矛盾行已足够解释，无需再跑 LP |
| 有目标函数       | `standardize` → `milp` → `lp`       | 求最优解                      |
| 无目标函数       | 零目标 `milp` 找可行点 + 唯一性探测 | 求「满足条件的解」            |

**高斯消元只做诊断，不出解。** 它能区分唯一 / 无穷多 / 矛盾并给出解空间维度，这是 LP 做不到的——LP 只返回一个顶点，无法告诉用户「其实还差一个条件」。但实际解统一由 MILP 给出，避免两套可行性判定逻辑互相漂移。

**唯一性探测的两个方向（容易混淆，务必区分）**

- 无目标：在**整个可行域**上逐变量求 max/min。可行域含多于一点即意味着答案不唯一。
- 有目标：必须先把「目标值 = 最优值」锁成一条等式，在该**切面**上探测。否则变量只要能动就会误报「最优解不唯一」，而实际上那些变动会改变目标值、并非最优。

变量数超过 40 时跳过探测（代价是 2n 次求解），只给出其中一个解并提示。

## 数据流

```
source: string
  ↓ lexer.tokenize        全角归一化 → Token[]（含 Pos）
  ↓ parser.parse          按行分句 → Stmt[]（真实行号回填）
  ↓ linearize.buildModel  三遍扫描：常量 → 变量声明 → 约束与目标
  │                       非线性在此拒绝（带行号）
  ↓ Model
  ├─ gaussian.solveLinearSystem   等式诊断（unique / infinite / infeasible）
  ↓ standardize.standardize       下界平移、自由变量拆分、上界转约束行
  ↓ Standardized { lp, subs, integerIdx, warnings }
  ↓ milp.solveMilp                无整数变量则直通 LP；否则分支定界
  ↓ standardize.denormalize       x⁺/x⁻ 合并、平移量还原
  ↓ solve.reportConstraints       逐条约束算余量与是否取等
  ↓ Solution { status, values, objectiveValue, warnings, stats, varOrder }
  ↓ format.ts                     Frac → 展示字符串
  ↓ SolutionPanel                 渲染
```

**错误流**：任一环节抛 `SolverError` 子类 → `App.runSolve` 捕获 → 转为 `{ line, message }` → `ModelEditor` 高亮该行、面板显示原因。非 `SolverError` 的异常也显示为「内部错误」，不静默吞掉。

**持久化流**：`source` 存于 localStorage（key `opti-calc:source`）。**惰性写入**——仅在用户编辑时落盘，挂载不写。若挂载即写，日后调整默认算例会把老用户存档顶掉。读取失败（隐私模式 / 配额满 / JSON 损坏）静默回退到默认模型。

## 外部系统

无。

- 无服务端、无数据库、无第三方 API、无 CDN 运行时依赖。
- 所有计算在浏览器本地完成，模型与结果不上传。
- 唯一的外部交互是 GitHub Pages 静态托管与 Actions 构建。

## 重要技术边界

**1. 数值边界：全程不使用浮点**

`Frac` 以 BigInt 分子 / 分母表示，`number` 只出现在展示层的 `toNumber()`。这条边界的意义：`11.9 / 24 * 60` 必须精确得到 `29.75`，而不是 `29.749999`。算账场景对这类误差零容忍——它会一路传导到「买几份」的最终决策。

代价是 BigInt 位数会随消元膨胀，因此高斯消元选主元时优先取绝对值最小的非零元。

**2. 模型边界：只处理线性 / 凸结构**

超出边界的输入必须**明确拒绝并说明出路**，不能近似后当精确解给出：

| 结构                              | 处理                                  |
| --------------------------------- | ------------------------------------- |
| 变量相乘、变量做除数、变量做指数  | 拒绝，提示「本求解器只处理线性模型」  |
| `!=` 约束                         | 拒绝，建议拆成两个模型或引入 0/1 变量 |
| 含未知量的 `ceil` / `abs` / `max` | 拒绝（非凸），建议移到约束或先赋值    |
| 常量参数上的取整函数              | 折叠求值（`ceil(5.3)` → `6`）         |
| 实数变量上的严格不等式            | 放宽为闭区间 + warning（开集无最值）  |
| 整数变量上的严格不等式            | 精确收紧（`x < 5` → `x <= 4`）        |

**3. 规模边界**

- 唯一性探测：变量数 ≤ 40，否则跳过并提示。
- 分支定界：节点数 ≤ 200,000，超出报 `degenerate` 并建议收紧变量上界。
- 单纯形迭代：上限 `400 × (m + n + 1)`，超出报 `degenerate`。

这些是防挂死的保险，不是性能优化目标。日常算账规模（几十个变量）远低于此。

**4. 部署边界：`base` 由 CI 注入**

代码不对仓库名或域名做任何推断，本地恒为 `/`，CI 用 `PAGES_BASE_PATH` 决定线上前缀。HTML 里引用资源必须用 `%BASE_URL%`，TS 里用 `import.meta.env.BASE_URL`，否则部署到子路径后 404。

**5. 同步边界：求解在渲染路径上**

求解是同步精确算术，小模型毫秒级，因此直接用 `useMemo` 计算，不引入 Web Worker——多一层线程边界只会让错误处理与类型共享变复杂。求解入口只有 `solve(source)` 一个纯函数，将来规模增长到需要秒级求解时迁移成本很低。
