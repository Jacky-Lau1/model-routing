# 22｜S5 Immutable RouteBinding、Endpoint Preflight 与 RouteEvidence

> 状态：S5 离线阶段门 PASS（2026-08-21）。
>
> 结论范围：只证明 immutable binding、durable local preflight 和 injected mock transport 的 **observable route tuple** 失败关闭；未运行真实 API，不证明 DNS/socket peer、系统代理、TLS、真实 provider identity 或 production readiness。

## 1. 阶段目标与边界

S5 消除“model、endpoint、auth 或 protocol 来自不同配置源”的 invoke-time 拼接。canonical S1 builder 与 legacy bridge 都从批准数据创建深度 clone/freeze 的 RouteBinding；legacy plan、approval、request fingerprint 与 provider request 绑定同一 hash。S5 不修改 S1 JSON Schema 或 S2 AttemptRecord，不生成 S6 EvidenceBundle，也不实现 S6–S9。

Direct DeepSeek 是本阶段唯一具备完整 observable tuple 检查的 transport。Codex CLI 不能独立观测实际 endpoint、auth source 和 response header，因此有 bound RouteBinding 的调用在 spawn 前失败关闭；无 binding 的 legacy planning/review 仍为兼容路径，RouteEvidence 明确不完整。

## 2. 准确文件范围（28 files）

生产源码（10）：

- `src/route-preflight.ts`
- `src/types.ts`
- `src/contracts.ts`
- `src/credentials.ts`
- `src/orchestrator.ts`
- `src/cli.ts`
- `src/providers/deepseek-chat.ts`
- `src/providers/codex-cli.ts`
- `src/providers/routing.ts`
- `src/providers/local.ts`

测试（7）：

- `test/route-preflight.test.ts`
- `test/deepseek-chat.test.ts`
- `test/credentials.test.ts`
- `test/codex-cli.test.ts`
- `test/contracts.test.ts`
- `test/orchestrator.test.ts`
- `test/policy.test.ts`

治理文档与日志（11）：

- `README.md`
- `ROADMAP.md`
- `CHANGELOG.md`
- `docs/08-decisions.md`
- `docs/11-implementation.md`
- `docs/13-continuation-handoff.md`
- `docs/16-orchestrator-first-implementation-plan.md`
- `docs/17-orchestrator-first-stage-handoffs.md`
- `docs/22-s5-route-preflight.md`
- `logs/decision-log.md`
- `logs/routing-validation-log.md`

扩围说明：初始 24-file 范围在独立门审查后增加 `src/contracts.ts`、`src/providers/local.ts`、`test/contracts.test.ts` 和 `test/codex-cli.test.ts`。这是关闭 canonical immutability、统一 stable adapter ID 和 Codex evidence 不伪造所必需的 S5 修复；没有修改 schema、attempt persistence 或后续阶段文件。

## 3. Immutable RouteBinding

`createRouteBinding` 在 canonical 创建边界 clone 并 freeze request budget、read/write/network/environment/command scopes 和顶层对象。正式 S1 `buildRouteBinding` 与 legacy `buildLegacyRouteBinding` 共用该不变量；从 JSON 持久化恢复的对象在执行前重新验证 hash、clone 并 freeze。

legacy tuple 固定为：

| Provider | Adapter ID | Model | Origin + path | Protocol | Auth |
| --- | --- | --- | --- | --- | --- |
| DeepSeek | `deepseek-chat-direct` | `deepseek-v4-flash` / `deepseek-v4-pro` | `https://api.deepseek.com/chat/completions` | `chat_completions` | `deepseek-env` 或 `deepseek-dpapi` |
| OpenAI Codex | `codex-cli` | `gpt-5.6-terra` / `gpt-5.6-sol` | 批准 tuple 中的 OpenAI target | `responses` | `codex-cli-managed` |
| Local | `local-validation` | local gate model | `local://quality-gate/validate` | `local` | N/A |

Provider registry 复制构造输入，并同时核对 map key、adapter `provider`、稳定 `adapterId` 和 bound tuple。RouteBinding 的 provider/model/reasoning/budget/origin/path/protocol/auth/network/environment/command 与 read/write scopes 任一变化都会改变 approval/fingerprint；未重新批准不得复用。

## 4. Durable preflight 与 credential 顺序

结构/hash 无效的 RouteBinding 在审批入口失败。结构有效但配置不兼容的 tuple 在 DurableAttemptExecutor 的 `operation.prepare` 内执行 central + adapter preflight，形成 `FAILED_BEFORE_SEND/local_preflight`；`send_started_at` 和 `provider_request_id` 保持 `null`。

DeepSeek 顺序为：

1. contract/hash 与 cross-field tuple；
2. code/non-code、public classification 与 S4 capability grant；
3. physical SafeExecutor preflight；
4. 只按 approved auth alias 解析一个 synthetic credential source；
5. 持久化 `SENDING` 后才允许 injected fetch。

`deepseek-env` 不回退 DPAPI，`deepseek-dpapi` 不回退 env。CLI 删除未绑定 `DEEPSEEK_BASE_URL` 第二来源。WeakMap 仅缓存同一冻结 ProviderRequest 的内存 credential，使 prepare、Routing 防御性 preflight 与 Direct invoke preflight 仍只解析一次；不持久化 secret。

## 5. Direct transport observation

每次 fetch 只使用由 binding origin + path 构造的 exact target，并设置 `redirect: manual`。以下响应都在任何模型工具调用之前失败：

- 301/302/303/307/308，不论 Location 为 relative、same-origin 或 cross-origin；
- `Response.redirected=true`；
- 缺失或不等于 exact target 的 `Response.url`；
- 非 2xx status、无效 JSON 或错误/缺失 model；
- request/response ID 证据缺失、控制字符、超长、逗号组合值或多个 allowlisted header 同时出现。

每轮 observation 记录 approved target、actual response URL/origin/path、status、redirected、actual model、body response ID、header request ID/header name和该轮 primary audit ID。body completion/response ID 与 transport header request ID 属于不同命名空间：分别保存，允许不同，不猜测两者必须相等。header 存储只允许 `x-request-id`、`x-ds-request-id`、`request-id` 中的单一候选；不保存完整 header、body、auth 或 raw response。

多轮 tool loop 在每轮证据通过后才执行本地 manifest/read/propose 工具。后续轮 URL/model/ID 失败会返回不完整 evidence，且不暴露此前内存 proposal；Orchestrator 不会 apply。

## 6. RouteEvidence 语义

成功的 Direct mock response 使用：

- `routeTupleVerified=true`
- `evidenceComplete=true`（仅指本地可观测 tuple 字段完整）
- `verificationStatus=route_tuple_verified_peer_unobserved`
- `peerVerification=not_observable`
- `proxyVerification=not_observable`
- `unverifiedReasons=[network_peer_not_observable, proxy_not_observable]`

因此 legacy `RouteEvidence.verified` 保持 false，不把 `Response.url` 误称为 DNS/socket peer 或真实供应商身份证明。Orchestrator 重新核对 binding hash、adapter ID、expected tuple、exact target/response URL、2xx status、model、redirect、primary/body/header ID 数组和每轮 observation；不信任 adapter 自报布尔值。

缺失 request ID 保持 `null`。收到 HTTP response 但 route evidence 不完整时，adapter 返回不含 patch 的 ProviderResponse，由 S2 async validation 抛出并记录 `response_invalid → AMBIGUOUS/BLOCKED`；重复 approve 不重发。只有 fetch/timeout/reset 等真正未取得完整 response 的异常保留 transport-unknown 语义。

## 7. Codex CLI 可观测边界

Codex parser 只接受显式 `response_id` / `request_id` 和实际 `model` 字段。generic event/item `id` 不等于 provider request ID，缺 model 不以 approved model 回填；无证据分别保持 `null` / empty 并由上层失败关闭。

当前 CLI 无法独立证明 endpoint、auth source、redirect 和 response header。bound RouteBinding 调用在 spawn 前 BLOCKED；unbound legacy planning/review 仅用于 Phase 0 兼容，不计入 S5 route-tuple 认证。S7 full core 接入不得绕开这一边界。

## 8. 零费用验证

实际命令与结果：

- bundled Node 运行 `tsc -p tsconfig.json --noEmit`：PASS。
- S5 定向 Vitest（route-preflight、DeepSeek、credentials、Codex CLI、contracts、Orchestrator、policy）：7/7 files、160/160 tests PASS。
- 全量 Vitest：17/17 files、279/279 tests PASS。

覆盖包括 canonical/legacy freeze、registry adapter ID、11 类 hash-valid durable tuple mismatch、endpoint origin/path 混淆、cross-provider tuple、15 种 3xx Location 组合、redirected flag、wrong/missing response URL、status/model/JSON、body/header ID 独立/缺失/歧义、多轮后续证据失败、approval 逐字段失效、credential missing/valid-once、adapter fake evidence、missing-ID AMBIGUOUS/no replay、Codex generic-ID/model no fallback 和 S0–S4 全量回归。

全部 fixture 使用系统临时目录、synthetic repo、synthetic credential/environment、injected resolver、mock provider 与 mock fetch。没有读取真实 Codex/DeepSeek config/auth、DPAPI、环境变量值或密钥；没有真实网络、API、live benchmark、安装或费用。

## 9. 未测试项与剩余风险

- DNS rebinding、resolved IP/socket peer、系统/透明代理、证书链与 TLS termination 不可由当前 Node fetch evidence 证明。
- 未使用真实 DeepSeek/OpenAI 响应或 header 合同；body/header ID 的语义只做分源保存，不声称供应商认证。
- Codex CLI bound transport 当前不可用而非“已认证”。
- OS sandbox、任意 Windows reparse tag 与 concurrent TOCTOU 仍为 S4/TODO-03 边界。
- S6 quality gate、baseline-aware secret scan、diff freeze 与 EvidenceBundle 尚未实施；S8 apply/merge/commit 尚未实施。

## 10. S5 阶段门

**PASS。** 结论只限 synthetic/mock 环境中的 immutable RouteBinding、durable pre-send failure 和 observable route-tuple evidence。S6 可以开始；不得据此运行 S10、真实 API、live benchmark，或宣称真实 provider route、peer identity、production readiness。
