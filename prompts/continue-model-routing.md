# 新对话继续研发 Prompt

实施已拆成 S0-S10，一个阶段一个新对话。S0、S1 已通过；优先从 `docs/17-orchestrator-first-stage-handoffs.md` 复制对应阶段的完整 Prompt。下面是当前默认的 S2 简版入口；不要附上密钥或完整本机配置。

```text
继续维护 GitHub 仓库 Jacky-Lau1/model-routing。本会话只实施 Orchestrator-first 计划的 S2：Workflow/Attempt 持久化与幂等语义。

开始前请先阅读：
1. docs/14-orchestrator-first-proposal.md
2. docs/16-orchestrator-first-implementation-plan.md
3. docs/17-orchestrator-first-stage-handoffs.md
4. docs/18-s1-data-contracts.md
5. docs/08-decisions.md
6. README.md、ROADMAP.md、CHANGELOG.md
7. logs/decision-log.md
8. logs/routing-validation-log.md
9. S2 涉及的状态、持久化和并发测试

开始前确认 S1 阶段门仍通过。目标：把 S1 AttemptRecord 接入双层 Workflow/Attempt 状态与持久化；副作用前保存 PREPARED/SENDING，未知发送结果进入 AMBIGUOUS/BLOCKED，重复或并发 execute 不重复副作用。

约束：
- 不读取、修改或打印任何本机 Codex/DeepSeek 配置、DPAPI 凭据、环境变量值、认证缓存或密钥，除非我本次明确授权。
- 不运行真实 DeepSeek/OpenAI API、基准或会产生费用的操作，除非我明确说“运行”。
- 不向第三方模型发送私有源码、完整聊天、截图原件或敏感内容。
- 不修改真实 Codex provider/config/auth/catalog；所有测试使用临时目录、mock provider 和 synthetic data。
- 不删除或暂存无关 dist/、node_modules/。
- 开始前报告准确文件和测试范围，只实施 S2，不提前实现 S3-S10。
- GitHub 提交前必须做脱敏扫描，只提交明确核对的文件。
- 结束时维护 README、ROADMAP、CHANGELOG、ADR、decision/validation log 和 docs/17 阶段状态。

实施前先确认 PR、分支、工作树和 S2 范围。完成后报告 changed files、零费用测试、阶段门、TODO、commit/push 状态和下一阶段入口。
```
