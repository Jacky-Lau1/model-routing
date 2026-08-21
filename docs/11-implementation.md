# 11｜最小实现与 CLI

> 历史实现说明：本文描述整改前的 TypeScript Phase 0/1 主体。S0 已于 2026-08-21 完成默认入口退役；主 working tree 执行和后台 Codex planning/review 仍不代表目标架构。当前执行基线见 `docs/16-orchestrator-first-implementation-plan.md`。

## 已实现边界

当前实现是 Windows 优先的 TypeScript 控制层：确定性任务分类、显式推理预算、计划/路由审批哈希、失败关闭状态机、阶段检查点、Codex ephemeral 调用、DeepSeek Responses provider 配置、本地质量门、一次修复和 Sol 二次失败诊断。

它仍属于 Phase 0/1。`benchmark` 只证明离线策略稳定性；真实路由身份、工具闭环、缓存用量与质量成本必须用供应商请求 ID 和固定基准集另行认证。

## 命令

正常入口是 `pnpm terminal` 或 `scripts/router-terminal.ps1`，两者只启动 Orchestrator 的计划与审批流程。`scripts/install-router-terminal.ps1` 只安装一个 Orchestrator 快捷方式；测试时必须使用临时目录和 `-ShortcutBackend Mock`，仅预览时再加 `-DryRun`。

- `route auto <objective>`：Terra 规划并保存 `WAITING_APPROVAL` 检查点，不执行。
- `route approve <task-id>`：绑定计划哈希后执行、验证和审查。
- `route revise <task-id> <instruction>`：重新规划并使旧审批失效。
- `route status [task-id]`、`route resume <task-id>`、`route abort <task-id>`：查看、恢复或终止。
- `route benchmark --iterations 10`：运行六类确定性路由矩阵。
- `route live-benchmark`：显式真实 API 基准命令；会产生请求和费用，绝不由安装、默认检查或 S0-S9 测试触发。
- `route cleanup --dry-run --older-than 7d`：预览过期路由元数据；去掉 `--dry-run` 后才删除。

## 模型与思考模式

每个阶段都在 `src/policy.ts` 中显式指定模型、effort、输出 token、工具轮数、超时和修复次数。自动策略不产生 OpenAI `high/xhigh/max/pro` 或 DeepSeek `max`。敏感任务不进入 DeepSeek，改用 ephemeral Terra，且不生成可复用 cache key。

OpenAI 阶段通过 Codex CLI 执行。启动前会读取 `codex exec --help` 并确认 `--ephemeral`；不支持时直接停止，不会回退为持久会话。受控 DeepSeek 执行器使用官方 Chat Completions API 和受限文件工具直连。native DeepSeek Responses profiles 已从默认路径退役，不是完整 Codex Agent 终端的受支持入口。

DeepSeek 官方 V4 思考模式只提供关闭、`high` 和 `max`；`low/medium` 实际映射为 `high`。因此普通 Flash 执行和纯文本扩写明确关闭思考，复杂 Pro 使用 `high`，自动模式仍禁止 `max`。工具调用期间的 `reasoning_content` 只保留在内存消息链中并完整回传，阶段结束即释放。

如果 Windows Store 版 `codex.exe` 能被发现但当前终端无权启动，可将 `CODEX_CLI_PATH` 指向一个可执行的 Codex CLI 安装。路由器不会绕过 Windows 权限或自动复制应用程序文件。

`scripts/install-store-codex.ps1` 是独立、显式的历史环境准备工具，不由 Router Terminal 或快捷方式安装器调用。它会同步 Store CLI、设置用户级变量并建立认证硬链接，因此不得在离线测试或未明确授权的会话中运行。

旧 native provider switch 与 profile 安装脚本保留在 `scripts/deprecated-experimental/native-codex/`，仅供协议兼容性考古。它们会触碰 Codex config/profile/catalog，不得作为正常安装、恢复或测试入口。

## 本地写入

普通事件只在内存中流转，`.router-state/tasks/<task-id>/state.json` 仅在审批、验证、审查、完成或阻塞边界原子更新。默认不保存 Codex history、关闭 memories、限制工具输出进入会话的大小，并在 7 天后清理路由器状态。

项目构建产物、依赖缓存与目标仓库自身写入不计入路由器 10 MB 元数据上限。真实磁盘降幅必须通过 Windows I/O 计数器与完整持久会话基线对比验证。

运行状态按调用保存 token 和缓存命中/写入指标，并用 `src/cost.ts` 的日期化公开 API 费率计算 `normalizedEquivalentUsd`。它只是对比基线，不是 Codex/ChatGPT 登录额度的实际账单；未知模型费率保持为空。

## 安全限制

- `allowedFiles` 仅是 Phase 0 兼容字段。S1 新合同必须使用独立 `read_scope` / `write_scope`，并把二者、policy 和预算全部绑定到审批；旧 Orchestrator 接线留待后续阶段按边界迁移。
- 本地验证命令来自经用户批准的计划，但仍只应对可信项目运行。
- 不提交 `.env`、API key、完整对话或 reasoning 内容。
- 上游模型、API 或 Codex CLI 能力改变后，模型状态应回退到待认证。
