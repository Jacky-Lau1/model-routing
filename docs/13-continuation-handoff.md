# 13｜继续研发交接（2026-08-20）

> 已被后续交接替代：本文保留 native menu 故障前的历史上下文，其中“先验证原生菜单”和相关安装建议不再执行。当前基线见 `docs/14-orchestrator-first-proposal.md`、`docs/16-orchestrator-first-implementation-plan.md` 和 `docs/17-orchestrator-first-stage-handoffs.md`。

这是一份给后续 Codex 对话使用的简明交接记录。它描述当前仓库状态和安全边界，不包含 API Key、真实用户路径、设备标识或本机配置内容。

## 当前状态

- GitHub 仓库：`Jacky-Lau1/model-routing`；开发分支为 `agent/implement-auto-model-router`；已有 Draft PR #1。
- 最近提交：`7637166 Add native DeepSeek menu switcher`。
- TypeScript 路由器已包含任务分类、审批状态机、预算/范围保护、低写入检查点、成本统计和 DeepSeek 适配器。
- 本地离线测试最近一次为 24/24 通过。不要据此宣称生产可用。
- 已实现 Windows 的原生菜单模式切换脚本：`scripts/switch-codex-native-mode.ps1`；快捷方式安装器：`scripts/install-router-terminal.ps1`。
- DeepSeek 目录与认证材料均在仓库外。认证通过当前 Windows 用户的 DPAPI 命令式读取；仓库不保存 Key。
- `auto` 是工作流路由入口，不是供应商模型，因此不能与 OpenAI/DeepSeek 模型混排到同一个 Codex 原生模型菜单。

## 原生菜单实现边界

Codex Desktop 的原生菜单读取一个全局 provider。切换到 DeepSeek 时，菜单应显示 DeepSeek V4 Flash/Pro；恢复 OpenAI 时恢复原 OpenAI 菜单与会话视图。供应商切换会造成任务列表按登录/提供商分组而暂时隐藏，**不是删除任务**。

三个安全入口由安装脚本创建：

- `Codex Native Menu - DeepSeek Flash`
- `Codex Native Menu - DeepSeek Pro`
- `Codex Native Menu - Restore OpenAI`

它们只原子更新全局 Codex 配置，不强制结束正在运行的 Codex。用户应自行正常关闭并重新打开应用。首次切换会备份 OpenAI 配置；恢复操作会保留对模型档位的合法改动，但若发现其它 Codex 设置被改动，会停止并要求人工处理，避免覆盖用户设置。

## 继续研发时必须遵守

1. 未得到当前用户的明确许可，不读取、写入、复制、打印或提交任何本机 Codex/DeepSeek 配置、DPAPI 凭据、环境变量或日志运行产物。
2. 不运行真实 API 测评、不产生费用，除非用户明确说“运行”。
3. 不把私有源码、截图、完整聊天、密钥或用户目录发送给 DeepSeek 或其它第三方供应商。
4. 不把 `high/xhigh/max` 当作自动默认；Sol 只用于高风险规划、重大歧义和二次失败诊断。
5. 任何计划、允许修改范围、模型路由或验收条件出现实质变化，都必须重新等待用户批准。
6. 发布 GitHub 前只暂存明确核对的文件，执行敏感信息扫描；不得提交 `.env`、凭据、运行日志、绝对用户路径或 API 响应原文。

## 下一阶段建议顺序

1. 先确认原生 DeepSeek 菜单在用户机器上的实际可见行为（Flash/Pro 是否出现、切换后是否能发送请求、恢复 OpenAI 是否正常）。不要自动修改配置来“修复”。
2. 根据 `docs/12-evaluation-plan.md` 审阅并敲定一次不含私有内容的 Pilot-30 测评任务集；目前只设计，不运行。
3. 为原生菜单切换脚本增加可隔离的单元/集成测试，避免测试碰触真实 `%USERPROFILE%`。
4. 再决定是否需要将 Desktop 的全局 provider 切换封装为插件或独立小工具；不要承诺原生菜单可同时显示多供应商模型。

## 排障时需要用户提供什么

让用户只提供以下**已脱敏**信息：

- 出问题的入口名称、时间、预期与实际现象；
- Codex 版本、Windows 版本；
- 终端错误的前后 20 行（Key、Bearer 值、用户名、完整路径须替换为 `<REDACTED>`）；
- 原生菜单的截图（隐藏任务标题、代码、文件路径和账号信息）；
- 若涉及路由器，提供 `route status` 的脱敏输出和对应 `RunReport` 的指标字段，而非完整会话。

不要要求用户粘贴 `config.toml`、DPAPI 文件、API Key、完整模型响应或项目私有源码。

## 先读哪些文件

- `docs/00-overview.md`：总体目标和阶段。
- `docs/02-routing-policy.md`：模型和推理预算规则。
- `docs/03-context-and-memory.md`：缓存、上下文与本地写入约束。
- `docs/11-implementation.md`：当前最小实现。
- `docs/12-evaluation-plan.md`：尚未执行的安全测评设计。
- `docs/08-decisions.md` 与 `logs/`：既有决定和验证记录。
