# 新对话继续研发 Prompt

当前实施已经收敛为三个 Agent Team 部分。唯一总交接见 `docs/17-orchestrator-first-stage-handoffs.md`。

按阶段门顺序复制：

1. [`part-1-offline-engineering-closure.md`](part-1-offline-engineering-closure.md)：离线工程闭环；当前应从这里开始。
2. [`part-2-live-routing-and-cost-proof.md`](part-2-live-routing-and-cost-proof.md)：真实链路与至少 30% 的可审计降费证明；只有 Part 1 PASS 后才可开始。
3. [`part-3-hardening-and-release.md`](part-3-hardening-and-release.md)：日常能力硬化与发布闭环；只有 Part 2 给出 `expand` 后才可开始。

每个 Prompt 都要求主 agent 调用 agent team，并把真实配置、credential、provider 请求和 apply 保留为主 agent 的串行、逐次授权动作。
