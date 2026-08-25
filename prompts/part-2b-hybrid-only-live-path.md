# Part 2b｜hybrid-only 真实链路 Prompt

```text
继续项目：

G:\OneDrive\个人文档\个人AI\模型路由开发

执行“三部分 Agent Team 闭环计划”的 Part 2 续：真实 MCP 注册、credential 隔离、一次 hybrid smoke、hybrid-only 绝对成本 Pilot。GPT-only 成本对照臂保持 BLOCKED（无 OpenAI key），本部分不宣称相对降费。

【当前进度交接（2026-08-25，主 agent 已核对，直接采信勿重做）】
- Part 1 已全部 PASS 并提交：远程 `origin/codex/router-three-part-closure` = `b16ea05`（`ca32fd3` Part 1 完成 + `b16ea05` junction 修复）。本地分支指针可能被 OneDrive 回退到 `da2ac98`，一律以远程为准。
- Part 2 离线修复已完成并在 working tree（尚未 commit/push，OneDrive 会回退 refs，但文件内容正确，**勿 reset --hard / checkout 丢弃**）：
  1. P1-a：`src/orchestrator.ts` `createBundle` 成本聚合由 `EXECUTE||REPAIR` 改为 `BILLABLE_MODEL_STAGES`（PLAN/TEXT_FRAME/TEXT_EXPAND/EXECUTE/REPAIR/REVIEW/VISUAL_REVIEW/SOL_DIAGNOSIS 共 8 阶段），补上 GPT planning/review/诊断计费，消除 hybrid 漏计。
  2. P1-b：`src/orchestrator.ts` `evidence()` list 价估算新增 `cacheHitTokens && cacheMissTokens` 可用性门控，cache 缺失 fail-closed（null）而非「全 miss 高估」。
  3. 直连 OpenAI Responses 适配器：新增 `src/providers/openai-responses.ts`（`OpenAiResponsesAdapter`，adapter_id `openai-responses-direct`，auth alias `openai-env`/`openai-dpapi`），权威 usage/cache/list-cost/route evidence 全解析；`src/credentials.ts` 新增 `loadOpenAiApiKey`（DPAPI 文件 `%LOCALAPPDATA%\CodexRouter\openai-key.dpapi`）；`src/route-preflight.ts` 新增 3 个常量；测试 `test/openai-responses.test.ts` 7/7。**无 key 时 fail-closed，未接入生产路由。**
  4. 测试基础设施：`test/skill.test.ts` CRLF 归一化（`core.autocrlf=true` 且无 `.gitattributes` 导致 SKILL.md 检出为 CRLF）；`vitest.config.ts` `hookTimeout` 30s→120s。
- 已验证：`tsc --noEmit` exit 0；定向隔离全绿（orchestrator 36/36、openai-responses 7/7、pilot-report 8/8、contracts 11/11、skill 1/1）。**新对话开始应先串行单进程跑一次全量确认 414/414 或接近**（见下一条环境坑）。

【用户三项决策（2026-08-25）】
1. **没有 OpenAI API key**（OPENAI_API_KEY 未设置、无 `openai-key.dpapi`）→ GPT-only 可审计对照臂 BLOCKED，30% 降费对照无法完成，只能报告 hybrid 臂**绝对成本与质量**，不得宣称相对 GPT-only 降费。
2. 先修复并实现（已完成，见上）。
3. 部署根 **`D:\CodexRouter`**（D 盘存在、516G 可用、可写）。

【本机环境坑（跨会话持续，详见 `~/.workbuddy/MEMORY.md` 与 `.workbuddy/memory/2026-08-25.md`，勿重复诊断）】
1. Windows 非管理员 + 开发者模式未开启 → file/dir symlink 不可用（`fs.symlink` 静默建空文件），测 reparse 越界用 **junction**（免权限，`lstat().isSymbolicLink()` 返回 true）。
2. OneDrive 实时回退 `.git` refs（commit/reset/fetch 后 packed-refs 被回退）→ 提交用 `git commit-tree <tree> -p <base>` + `git push <commit>:refs/heads/<branch>` 直接推远程，不依赖本地分支指针。
3. push credential 是多值链（system `helper-selector` → global GCM，弹 GUI 挂起）→ 用 askpass 脚本输出 `gh auth token` + `GIT_CONFIG_NOSYSTEM=1` + `HOME=<空目录>` + `GIT_ASKPASS=<脚本绝对路径>` + URL 带 username，保留 `-c http.proxy`。
4. 测试慢（git worktree 15–45s/用例），testTimeout/hookTimeout 已 120s；**并发跑多个 vitest 进程会严重争用 git worktree、把全量从 6 失败放大到 21 失败（同一批测试隔离跑全过）→ 必须串行、单进程跑全量**。
5. http.proxy = `127.0.0.1:7890`（本地代理），git/gh 网络操作走代理。
6. managed node：`C:\Users\ASUS\.workbuddy\binaries\node\versions\22.22.2\node.exe`（跑 tsc/vitest 用它 + 本地 `node_modules` 里的 `typescript/bin/tsc`、`vitest/vitest.mjs`）。

【环境事实（只读存在性，已探测）】
- Codex config：`C:\Users\ASUS\.codex\config.toml`（存在）、`auth.json`（存在）。`codex` CLI 不在 PATH。
- DeepSeek DPAPI 凭据：`%LOCALAPPDATA%\CodexRouter\deepseek-key.dpapi` **存在**（hybrid 臂可用，auth alias `deepseek-dpapi`）。
- OpenAI 凭据：无（env 未设置、无 dpapi 文件）。

【下一步执行顺序】（真实副作用由主 agent 串行、当次逐项授权；未授权只允许只读/离线/dry-run）
一、离线构建与就绪（无需授权）：
  1. `tsc -p tsconfig.build.json --outDir D:\CodexRouter\distribution`（消除用户名/OneDrive/AppData/bundled runtime 硬编码）。
  2. 建立外部 roots：`D:\CodexRouter\{state,evidence,worktrees,visible-fixture,hidden}`；拷贝/生成严格 JSON 的 quality-gate policy、trusted command catalog、user/project policy、route profile（pilot 模式）。
  3. 构建 20 个 public/synthetic fixture（覆盖单文件 bug、多文件 bug、测试补充、有限重构、API 边界、文档一致性、不应路由），每个算 base commit tree 的 sha256 作为 `base_fixture_hash`；hidden 测试/参考答案只存 `hidden` root，绝不进入模型上下文。
  4. `route config-preview` + `install --dry-run` 生成 **exact MCP block + SHA-256 + backup/rollback + before/after hash**（不写）。
二、真实 MCP 注册（需授权）：展示 exact target(`C:\Users\ASUS\.codex\config.toml`)、exact block、SHA-256、before hash、backup、rollback → 等用户明确批准 → 只写 exact Router MCP block（不改 auth/provider/model/profile/其他 MCP）→ 验证可解析、hash 正确、其余不变 → 重启/新会话后验证 9 个 `router.*` tools 的 name/schema/annotations 及 CLI/MCP 同一 state root。
三、credential 隔离（需授权）：`credential-status` 只做存在性检查，不输出 secret；展示 alias、存储类别、用户边界、读取进程与 child environment allowlist。
四、一次 hybrid smoke（需授权）：固定边界 = 单一 public fixture、DeepSeek Flash、禁 Pro escalation/redirect/private data/full chat、hidden 数据不入模型上下文、只读批准 fixture、只写 isolated worktree、≤2 attempts/6 HTTP requests/一次 repair、禁静默 retry、禁 apply 到开发仓库、禁 commit/push。先 prepare 展示完整 summary/hash，等 exact hash 授权后才 execute。通过要求：visible+hidden 全过、final acceptance=true、secret/scope/privacy/routing/duplicate/main pollution=0、ambiguity=0、provider/model/endpoint/request ID/usage/round cost 完整、PilotRunRecord 可验证、开发仓库与 Codex config/auth/provider 不变。
五、hybrid-only Pilot（需授权）：20 对任务只跑 hybrid 臂，每 task/arm 用全新 isolated repo/state，arm 间不泄漏输出，不人工修代码、不删失败样本、不降 acceptance、不把 null 当零、不自动 Flash→Pro。允许按证据调优 TaskPackage/context 大小、稳定前缀/cache、budget、Flash 适用范围、本地门顺序；不得改 paired acceptance。
六、最终输出：hybrid 臂绝对可审计成本（provider_reported/estimated_list/invoice/quota 分层）、质量、token/cache/request/wall、违规与 ambiguity/duplicate 计数、失败分类、`expand|simplify|stop` 与阶段门、Git status。

【硬门 / blocker】
- hybrid 臂：regression=0、scope/privacy/routing/secret/main pollution=0、ambiguity=0、unexplained duplicate=0、intervention 不高于 baseline、repair 不显著增加。
- **30% 降费对照无法达成**（无可靠 GPT-only telemetry）→ 本部分只报告 hybrid 绝对成本，**不得宣称相对 GPT-only 降费**；最终 recommendation 除非用户后续提供 OpenAI API key（DPAPI 存储）否则为 `stop`，不进入 Part 3。

【权限规则】
1. 写真实 Codex config 前，展示 exact target、exact block、SHA-256、before hash、backup 和 rollback，等待用户明确批准。
2. credential 与 MCP 注册分开授权；不得让用户把 API key 粘贴到聊天、仓库、日志或命令参数。
3. 每次 provider side effect 前展示完整 approval summary、approval_summary_hash、最大 request/token/wall/cost 和 stop conditions，等待包含 exact hash 的授权。
4. 未获批准时只允许只读检查、官方资料核验、离线准备和 dry-run。
5. commit、push、tag、PR、merge 仍需单独授权；一个动作的授权不隐含另一个。
```

