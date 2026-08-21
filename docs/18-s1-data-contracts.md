# 18｜S1 数据合同、隐私与 Schema

> 状态：S1 合同基线。这里只定义、验证和哈希数据；不创建 worktree、不调用 provider、不实现 MCP。

## 合同边界

S1 把不同生命周期的数据拆为六个独立对象：

| 对象 | 责任 | 自身稳定哈希 |
| --- | --- | --- |
| `TaskPackage` | 任务语义、最小上下文、读写请求、隐私与任务预算 | `task_package_hash` |
| `RouteBinding` | provider/model/endpoint/auth/protocol/reasoning、能力范围与请求预算 | `route_binding_hash` |
| `ExecutionContext` | run、base commit、workspace snapshot、逻辑 worktree 标识及上述对象引用 | `execution_context_hash` |
| `ApprovalRecord` | 用户实际批准的 task/route/context/policy 哈希及有效期 | `approval_hash` |
| `AttemptRecord` | 单次副作用的状态与脱敏结果；S2 才实现持久化状态机 | 无自引用哈希，使用 `request_fingerprint` |
| `EvidenceBundle` | diff、质量门、scope/privacy、usage/cost 与剩余风险引用 | `bundle_hash` |

TypeScript 线协议类型位于 `src/types.ts`；严格解析、路径/敏感文本校验和 factory 位于 `src/contracts.ts`。当前 Phase 0 的 `PlanPacket`、`RouteDecision` 与 `LegacyApprovalRecord` 暂时保留给旧 Orchestrator，不能作为新合同使用。

## 隐私是两个维度

`data_classification` 描述数据本身，只允许：

- `public`
- `private`
- `secret_restricted`

`egress_policy` 描述一次明确授权，默认是 `{ "mode": "deny" }`。允许外发时必须同时绑定：

- provider；
- 相对路径；
- 内容 SHA-256；
- 用户授权 ID、时间和可选到期时间。

`PRIVATE_THIRD_PARTY_ALLOWED` 只接受为便利输入，并立即规范化为 `data_classification: private` 加独立的 allow policy；它不会进入持久合同。未分类、无 allow policy、授权过期或 `secret_restricted` 都不能构造 DeepSeek `RouteBinding`。private 的分类不会因为一次授权而改成 public。

## User policy 与 project policy

真实 user policy 是权限来源，应保存在仓库外。project policy 是仓库内的权限上限，只能做交集和取更小预算：

```text
effective read/write scope = project scope，且必须是 user scope 子集
effective budget           = project ceiling，且不得高于 user ceiling
effective egress           = user allow ∩ project allow
user deny                  = 永久 deny，project allow 不得覆盖
```

第一版对包含 glob 的 policy 采用保守子集证明；无法证明收窄就拒绝，不猜测权限关系。`config/user-policy.example.yaml` 和 `config/routing-policy.example.yaml` 仅使用合成值，前者不代表真实 user policy 应提交进仓库。

## 规范化序列化与哈希

`canonicalSerialize` 使用 UTF-8 JSON：

1. 对象键按 locale 无关的 UTF-16 code-unit 升序排列；
2. 数组顺序保留，因此 scope/步骤重排属于内容变化；
3. 字符串和有限数字按 JSON 表示，`-0` 规范化为 `0`；
4. 拒绝 `undefined`、非有限数字、函数、symbol、bigint 和非普通对象；
5. SHA-256 输出为 64 位小写十六进制；
6. 自身 `*_hash` 字段不参加自身哈希，其余字段全部参加。

ApprovalRecord 绑定 TaskPackage、RouteBinding、ExecutionContext 和 EffectivePolicy 的哈希。因此 route、read/write scope、policy 或 budget 任一变化都会失效；RouteBinding 不包含 approval hash，避免循环依赖。

## 失败关闭校验

TypeScript 严格解析器和 JSON Schema 都采用 `additionalProperties: false`，并拒绝：

- 未知或缺失字段；
- 空的 `read_scope` / `write_scope`；
- 盘符路径、UNC/反斜杠、根路径、`~`、`..`、ADS 冒号、重复分隔符和控制字符；
- `.env`/凭据式路径由后续 S4 做更完整的 capability 检查；
- private key、赋值形式的 key/token/password、Bearer token、AWS access key、`sk-...` 等高置信度 secret-like 文本；
- 非 SHA-256 内容引用、无效时间和不匹配的规范化哈希。

S1 的检查是合同入口保护，不替代 S4 的文件系统/reparse/symlink 检查或 S6 的 baseline-aware secret scan。

## Schema 与合成示例

总 schema 是 `config/data-contracts.schema.json`，独立入口包括：

- `task-package.schema.json`
- `route-binding.schema.json`
- `execution-context.schema.json`
- `approval-record.schema.json`
- `attempt-record.schema.json`
- `evidence-bundle.schema.json`
- `routing-policy.schema.json`

旧文件名 `task-packet.schema.json` 和 `run-report.schema.json` 仅保留为 `$ref` 兼容入口。`examples/` 下的对应 JSON 全部是合成数据，哈希由本地 factory 生成；它们不代表真实调用、真实 endpoint 认证或完成证据。

## S1 非目标

- 不把新合同接进 provider invoke；
- 不读取 auth alias 对应的 secret；
- 不验证 DNS、redirect、response model 或 provider request ID；
- 不创建或清理 worktree；
- 不实现 attempt 持久化、MCP、质量门或真实 EvidenceBundle 生成链；
- 不调用真实 API 或运行付费 benchmark。

这些能力分别属于 S2–S7；S1 只确保它们将来共享同一组严格、可哈希的数据边界。
