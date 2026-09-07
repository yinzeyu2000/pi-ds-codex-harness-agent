# pi-ds-codex-harness agent: 开发交底与过渡说明 (Handover Guide)

> **文档性质**：跨 Agent 协作交底指南 / Onboarding & Transition Guide  
> **更新时间**：2026-09-07  
> **当前版本**：v1.0 (M0–M5 已固化交付，准备推进 M7a / M6)  
> **公开仓库**：[https://github.com/yinzeyu2000/pi-ds-codex-harness-agent](https://github.com/yinzeyu2000/pi-ds-codex-harness-agent)  
> **所属用户**：`yinzeyu2000` (唯一作者与所有者)

---

## 1. 项目简介与架构愿景

本项目以 **Pi** 轻量 Agent 为源码基线，深度融合 **DeepSeek-Harness**（DSH）的插件组合平面与 **Codex-Harness** 的工业级 Runtime 规范，打造具备轻量内核、强组合、工业级执行能力的下一代自主 Agent 运行时。

### 1.1 三层职责划分

```text
Pi Execution Core (执行核心)
  负责模型适配、消息流、轻量 agentLoop、可嵌入 API 与开发工具链
                 │
                 ▼
Codex-style Industrial Runtime Plane (工业级运行平面)
  负责 Thread / Turn / Step / Task / Process / Persistence / Protocol v2
                 ▲
                 │
DSH-style Composition Plane (组合平面)
  负责 Plugin / Service / Scope (4级生命周期) / Effect / Profile / Middleware
```

### 1.2 长期坚守的“七个唯一”原则

在新 Agent 接手开发过程中，**严禁引入第二套实现**，必须坚守以下七个唯一事实源：
1. **一个前台 Runtime 状态机**：`ThreadRuntime`（管理单前台 ActiveTurn 与 LoadedThreadMailbox）。
2. **一个 Agent Loop**：统一使用 Pi `agentLoop`（由 `PiAgentDriver` 驱动，双向事件投影）。
3. **一个 Canonical Durable Log**：唯一规范 Journal（扩展自 Pi Entry，支持物理 `fsync` 与崩溃恢复）。
4. **一个 ModelGateway**：所有向 LLM 发起的模型请求，必须经过受审计的统一 Dispatch 边界。
5. **一个 ExecutionBroker**：所有 Agent 发起的产生副作用的 Tool 动作（Bash、文件写、网络、进程），必须经过 ExecutionBroker，严禁绕过 Broker 直接调用底层 OS。
6. **一套正式 Plugin API**：项目自有强类型体系与 4 级 Scope（`RuntimeScope -> ThreadScope -> TurnScope -> TaskScope`），支持事务回滚。
7. **一套公开语义协议**：Protocol v2，Headless SDK、CLI、TUI 及未来 Web/IDE 共享唯一协议与 Projection。

---

## 2. 核心开发依据与文档体系

接手开发的新 Agent **必须严格按照以下文档体系进行架构设计与代码实现**：

| 文档路径 | 作用与约束 |
|---|---|
| [`EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) | **最高纲领执行报告**（2200+ 行），定义了 0~16 章节的完整融合规范、ADR 决策、详细架构设计与 M0~M9 路线图。开发每个模块前必读相应章节。 |
| [`AGENTS.md`](../AGENTS.md) | **开发行为准则**：代码风格、TypeScript 限制（无 `any`、Node strip-only 语法、无内联 import）、Git 提交规则、测试运行规则等。 |
| [`docs/milestones/`](./milestones/) | **已交付里程碑记录**：`M1_STATUS.md` 至 `M5_STATUS.md`（及根目录 `M0_STATUS.md`），详述每个里程碑的契约设计、实现路径、文件清单和验收标准。 |
| [`docs/adr/`](./adr/) | **架构决策记录**：ADR-001 至 ADR-005，记录微内核划分、七个唯一、持久化模型、Scope 生命周期等不可动摇的决议。 |
| `tools/architecture-guards/` | **架构守卫规则**：`check-m0` 至 `check-m5` 脚本，自动化拦截违规导入、第二事实源与跨层污染。 |

**只读参考源码目录（外部只读，已脱钩）**：
- Pi 原始基线参考：`..\pi`
- DeepSeek Harness 插件与调度参考：`..\deepseek-harness`
- Codex Harness Runtime/Process 契约参考：`..\codex`

---

## 3. 当前工程进展与成果状态 (M0–M5 已完成)

目前仓库已完整实现 M0 至 M5 阶段的所有代码、单元测试、集成测试与架构守卫，质量门禁全部全绿。

### 3.1 已交付里程碑全景

```text
[M0: 基线固化] ────> [M1: 协议与契约] ────> [M2: 纵向闭环] ────> [M3: Journal持久化] ────> [M4: 插件组合] ────> [M5: 进程与Broker]
  • 固定Pi基线        • Protocol v2 规范      • ThreadRuntimeImpl   • 单写入者独占文件锁      • 4级Scope所有权树       • ExecutionBrokerImpl
  • Windows兼容修复   • Branded IDs 强类型    • Mailbox 互斥调度    • 3档回执(物理fsync)      • Semver DAG 拓扑解析    • 不透明 ProcessId
  • 4项金样全绿      • 纯函数状态机矩阵       • 单ActiveTurn防护   • Torn-tail 截断修复      • 事务激活/逆序LIFO回滚  • 有界 RingBuffer(防洪水)
  • 质量CI脚手架      • 自研轻量PluginHost    • 100次中断竞态0错    • 崩溃恢复outcome_unknown • 64-bit FNV-1a Hash    • TERM->KILL->Await协议
                                                                  • 100%无损重建Thread索引  • 旧Pi Extension适配器  • Write-Before-Execute
```

### 3.2 关键实现模块与文件索引

- **协议层 (`packages/protocol/src/v2/`)**:
  - `branded-ids.ts`: 强类型领域 ID（`ThreadId`, `TurnId`, `StepId`, `ProcessId`, `ControllerEpoch` 等）。
  - `wire-types.ts` & `schemas.ts`: Protocol v2 握手、Controller 租约、去重信封与事件线协议。
- **状态机与核心类型 (`packages/agent/src/runtime/`)**:
  - `state-machines/models.ts` & `transitions.ts`: 纯函数状态机（Thread/Turn/Step/Model/Tool/Process）。
  - `types/errors.ts`: 标准错误分类法（Terminal vs Non-terminal, retryable 分级）。
- **线程调度与纵向闭环 (`packages/agent/src/runtime/thread/`)**:
  - `thread-runtime-impl.ts`: Thread 生命周期、单 ActiveTurn 互斥、中断与事件广播。
  - `mailbox.ts`: `LoadedThreadMailboxImpl` 请求串行化与快速准入。
  - `driver/pi-agent-driver.ts`: 桥接 Pi 原生 `runAgentLoop`，实现双向事件翻译。
- **规范日志与容错恢复 (`packages/agent/src/runtime/journal/`)**:
  - `jsonl-journal.ts`: 独占文件锁（`.lock`）、物理 `fsync` 落盘、Torn-tail 自动截断、Mid-log 损坏 fail-closed 拒载。
  - `blob-store.ts`: SHA-256 内容寻址大对象存储，严格实施 Write-Before-Publish。
  - `recovery.ts`: 崩溃恢复矩阵，未结状态确定性收敛为 `outcome_unknown`。
  - `thread-index.ts`: 可从 JSONL 100% 重建的二级 Thread 索引。
- **插件组合系统 (`packages/agent/src/runtime/plugin/`)**:
  - `scopes.ts`: 4 级所有权 Scope 树（`RuntimeScope -> ThreadScope -> TurnScope -> TaskScope`）。
  - `plugin-host.ts`: 事务级激活，出错时 LIFO 严格回滚至资源归零。
  - `profile.ts`: 声明式 Profile/Bundle/Patch，基于 64-bit FNV-1a 的确定性 `manifestHash`。
  - `extension-adapter.ts`: 兼容旧 Pi Extension 的桥接适配器。
- **进程与执行中心 (`packages/agent/src/runtime/process/` & `adapters/`)**:
  - `process-registry.ts`: 解耦 OS PID 的不透明 `ProcessId` 注册表与代际隔离。
  - `output-buffer.ts`: `BoundedOutputBuffer`，支持头部截断元数据与增量游标长轮询读取。
  - `process-supervisor-impl.ts`: 严格执行 `TERM -> 宽限期 -> KILL -> Await OS 回收` 终止协议。
  - `execution-broker-impl.ts`: 副作用执行前强制 `Write-Before-Execute` 规范 Journal 落盘屏障。

---

## 4. 质量门禁与验证命令

在新 Agent 编写任何代码前后，必须运行以下测试套件以确保契约完整性：

```bash
# 1. 运行所有单元与集成测试 (72 项测试，全绿通过)
node node_modules/vitest/dist/cli.js --config packages/agent/vitest.config.ts --run
node node_modules/vitest/dist/cli.js --run packages/protocol/test/v2/protocol-v2.test.ts packages/protocol/test/v2/fixtures.test.ts

# 2. 运行 6 个架构守卫脚本 (M0 ~ M5 全部通过)
node tools/architecture-guards/check-m0-baseline.mjs
node tools/architecture-guards/check-m1-contracts.mjs
node tools/architecture-guards/check-m2-runtime.mjs
node tools/architecture-guards/check-m3-persistence.mjs
node tools/architecture-guards/check-m4-plugins.mjs
node tools/architecture-guards/check-m5-processes.mjs

# 3. 跨平台金样比对 (4 场景全部匹配)
npx tsx scripts/m0-golden-traces.ts --check

# 4. Monorepo 完整静态检查 (0 错误，0 警告，1180 个文件)
npm run check
```

---

## 5. 接续开发指南：下一阶段目标 (M7a 与 M6)

根据 `EXECUTION_PLAN.md` 章节 15.1 的拓扑依赖：
```text
M3 + M4 + M5 + M7a ─────────→ M6 (Policy, Approval, Sandbox)
M6 + M7a ────────────────────→ M7b (Approval, 多 UI, App Server)
M3 + M4 + M5 + M6 + M7b ────→ M8 (Coding Profile, Tools, CLI/TUI) ────→ M9 (Soak, 发布)
```

**M7a 是 M6 的前置依赖**（拆分解耦了多 UI 审批与底层协议租约），因此建议接续的 Agent 优先推进 **M7a**，或同步启动 **M6** 的准备工作。

### 5.1 优先任务选项 A：推进 M7a（协议、连接与 Controller Fencing）

- **开发依据**：`EXECUTION_PLAN.md` 章节 4、5.5、10 及 15.1 M7a。
- **目标交付**：
  1. **Transport 抽象与实现**：完善 Stdio JSONL Transport 及本地 IPC（Windows Named Pipe / Unix Domain Socket）。
  2. **Controller 租约分栅**：实现 Controller Lease（acquire/renew/release/expiry）与 `ControllerEpoch` 单调递增校验，彻底阻断旧 Controller 的晚到命令。
  3. **请求去重机制**：实现 `clientRequestId` 命名空间管理、payload hash 与 dedupe receipt。
  4. **增量事件流与游标**：实现 Live Epoch、Durable Watermark、快照与 Watch 订阅。
  5. **架构守卫**：创建 `tools/architecture-guards/check-m7a-protocol.mjs`。
- **退出标准**：慢客户端不拖慢 Runtime；重复请求不重复执行；双 Observer 视图完全一致。

### 5.2 优先任务选项 B：推进 M6（Policy、Approval 与强 Sandbox 隔离）

- **开发依据**：`EXECUTION_PLAN.md` 章节 9、11、12 及 15.1 M6。
- **目标交付**：
  1. **PermissionProfile**：实现宿主拥有的策略配置与单调交集计算（Policy Intersection）。
  2. **Approval 机制**：实现审批请求、响应指纹比对（Fingerprint SHA-256）与 TOCTOU 二次校验。
  3. **Sandbox Provider**：实现 Windows（Job Object + 受限 Token / AppContainer）或 Linux（bwrap / seccomp）首发强沙箱隔离；不支持环境必须 Fail-Closed 拒绝执行。
  4. **架构守卫**：创建 `tools/architecture-guards/check-m6-sandbox.mjs`。
- **退出标准**：拒绝/过期的命令执行计数严格为 0；路径穿越与符号链接逃逸测试全部通过；绝无静默降级。

---

## 6. 新 Agent 开发与 Git 纪律红线

新接手的 Agent 必须严格遵守以下规则（源自 `AGENTS.md`）：

1. **禁止代码与 Commit 包含 Emoji**：严禁任何 emoji 符号。
2. **禁止内联动态导入**：严禁在代码中使用 `await import(...)` 或 `import("...").Type`，所有 import 必须位于文件顶部。
3. **TypeScript 语法约束**：遵循 Node strip-only erasable 模式，禁止使用 `enum`、`namespace`、参数属性（`constructor(public x: number)`）。
4. **Git 显式添加**：严禁执行 `git add -A` 或 `git add .`，必须使用 `git add <explicit-path>` 显式暂存修改的文件。
5. **严禁破坏性 Git 命令**：严禁 `git reset --hard`、`git checkout .`、`git clean -fd`、`git stash`；严禁 `git push --force`（除用户特殊授权外）。
6. **保持单人作者身份**：仓库所有提交必须保持以 `yinzeyu2000 <yinzeyu20000@gmail.com>` 作为唯一 Author/Committer，切断任何上游仓库的历史血缘。
7. **每次代码修改后必跑**：运行 `npm run check`，必须保持 0 错误 0 警告后方可向用户汇报。
