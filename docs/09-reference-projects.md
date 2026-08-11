# 09｜现成项目参考

这些项目提供思路或实现参考，不等于已替本仓库验证可用。

| 项目 | 可借鉴内容 | 采用时的注意点 |
| --- | --- | --- |
| [gajae-code](https://github.com/Yeachan-Heo/gajae-code) | 角色化工作流、状态目录、模型预设、规划/执行/批评分层 | 是独立运行时路线，不是 Codex Desktop 原生委派；其 benchmark 不能代替本地验证 |
| [Codex-Orchestration](https://github.com/Cjbuilds/Codex-Orchestration) | 将 Codex 保留为最终权威，并用受控外部执行通道处理特定角色 | 项目较新；成本和稳定性主张必须本地复测 |
| [codex-router](https://github.com/duolahypercho/codex-router) | Codex 的多提供商/网关配置思路 | 重点验证 Responses API、工具循环和日志，而非只测普通文本响应 |
| [codex-litellm](https://github.com/avikalpa/codex-litellm) | 用 LiteLLM 等层连接 Codex 与不同模型的实测思路 | 供应商支持、协议和模型能力会变，不能照抄生产配置 |
| [Aider](https://github.com/Aider-AI/aider) | architect/editor 的成熟角色分离模式 | 是类比参考，不是 Codex Desktop 的直接替代品 |

## 上游资料（实施前重新核验）

- [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex 自定义代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI 定价](https://learn.chatgpt.com/docs/pricing)
- [Prompt caching 指南](https://developers.openai.com/api/docs/guides/prompt-caching)

产品、价格、可用模型和 API 行为均会变化。本仓库中的结论以“设计时资料”为准，实施时必须重新验证。
