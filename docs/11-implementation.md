# 11｜最小实现与 CLI

> 历史实现说明：本文描述 Draft PR #1 在 Orchestrator-first 整改前的代码状态。native DeepSeek profile、主 working tree 执行和后台 Codex planning/review 不再代表目标架构。当前执行基线见 `docs/16-orchestrator-first-implementation-plan.md`；S0 尚未完成前，不要把下述脚本当作推荐安装流程。

## 已实现边界

当前实现是 Windows 优先的 TypeScript 控制层：确定性任务分类、显式推理预算、计划/路由审批哈希、失败关闭状态机、阶段检查点、Codex ephemeral 调用、DeepSeek Responses provider 配置、本地质量门、一次修复和 Sol 二次失败诊断。

它仍属于 Phase 0/1。`benchmark` 只证明离线策略稳定性；真实路由身份、工具闭环、缓存用量与质量成本必须用供应商请求 ID 和固定基准集另行认证。

## 命令

- `route auto <objective>`：Terra 规划并保存 `WAITING_APPROVAL` 检查点，不执行。
- `route approve <task-id>`：绑定计划哈希后执行、验证和审查。
- `route revise <task-id> <instruction>`：重新规划并使旧审批失效。
- `route status [task-id]`、`route resume <task-id>`、`route abort <task-id>`：查看、恢复或终止。
- `route benchmark --iterations 10`：运行六类确定性路由矩阵。
- `route live-benchmark`：调用一次真实 DeepSeek V4 Flash，执行隔离修复夹具并输出 100 分质量评分、token、缓存和公开费率估算成本。
- `route cleanup --dry-run --older-than 7d`：预览过期路由元数据；去掉 `--dry-run` 后才删除。

## 模型与思考模式

每个阶段都在 `src/policy.ts` 中显式指定模型、effort、输出 token、工具轮数、超时和修复次数。自动策略不产生 OpenAI `high/xhigh/max/pro` 或 DeepSeek `max`。敏感任务不进入 DeepSeek，改用 ephemeral Terra，且不生成可复用 cache key。

OpenAI 阶段通过 Codex CLI 执行。启动前会读取 `codex exec --help` 并确认 `--ephemeral`；不支持时直接停止，不会回退为持久会话。受控 DeepSeek 执行器使用官方 Chat Completions API 和受限文件工具直连；DeepSeek 现已同时原生支持 Responses API，因此 Flash/Pro Profile 可以直接运行完整 Codex Agent 终端。

DeepSeek 官方 V4 思考模式只提供关闭、`high` 和 `max`；`low/medium` 实际映射为 `high`。因此普通 Flash 执行和纯文本扩写明确关闭思考，复杂 Pro 使用 `high`，自动模式仍禁止 `max`。工具调用期间的 `reasoning_content` 只保留在内存消息链中并完整回传，阶段结束即释放。

如果 Windows Store 版 `codex.exe` 能被发现但当前终端无权启动，可将 `CODEX_CLI_PATH` 指向一个可执行的 Codex CLI 安装。路由器不会绕过 Windows 权限或自动复制应用程序文件。

本仓库提供 `scripts/install-store-codex.ps1`：它将 Store 包内同版本 CLI 和必需 sidecar 同步到 `%LOCALAPPDATA%\Programs\CodexStoreCLI`，对已有文件先比较 SHA-256，并设置用户级 `CODEX_CLI_PATH`。Store 更新后重新运行脚本即可同步，不修改 WindowsApps ACL。

脚本还会创建 `%LOCALAPPDATA%\CodexRouter\codex-home`，通过同盘硬链接复用现有 `~/.codex/auth.json`，并设置 `CODEX_ROUTER_HOME`。路由器的子进程使用这个隔离目录，从而复用 ChatGPT 登录但不加载个人 skills/plugins；主 Codex 配置保持不变。

## 本地写入

普通事件只在内存中流转，`.router-state/tasks/<task-id>/state.json` 仅在审批、验证、审查、完成或阻塞边界原子更新。默认不保存 Codex history、关闭 memories、限制工具输出进入会话的大小，并在 7 天后清理路由器状态。

项目构建产物、依赖缓存与目标仓库自身写入不计入路由器 10 MB 元数据上限。真实磁盘降幅必须通过 Windows I/O 计数器与完整持久会话基线对比验证。

运行状态按调用保存 token 和缓存命中/写入指标，并用 `src/cost.ts` 的日期化公开 API 费率计算 `normalizedEquivalentUsd`。它只是对比基线，不是 Codex/ChatGPT 登录额度的实际账单；未知模型费率保持为空。

## 安全限制

- `allowedFiles` 是模型约束和审批内容；Phase 0 尚需通过真实 diff 监控验证越界率。
- 本地验证命令来自经用户批准的计划，但仍只应对可信项目运行。
- 不提交 `.env`、API key、完整对话或 reasoning 内容。
- 上游模型、API 或 Codex CLI 能力改变后，模型状态应回退到待认证。
