# Part 2b｜hybrid-only 真实链路与绝对成本证明 Prompt

```text
继续项目：

G:\OneDrive\个人文档\个人AI\模型路由开发

执行“三部分 Agent Team 闭环计划”的 Part 2 延续（2b）：hybrid-only 真实链路与绝对成本证明。

【当前进度交接（2026-08-25，主 agent 已核对，直接采信勿重做）】
- Part 1 已全部 PASS 并提交：远程 `origin/codex/router-three-part-closure` = `b16ea05`（`ca32fd3` Part 1 + `b16ea05` junction 修复）。本地分支指针可能被 OneDrive 回退到 `da2ac98`，一律以远程为准。
- Part 2 启动阶段（本会话）已完成并留在 working tree（**尚未 commit/push，需单独授权**）：
  1. Agent A/B/C 只读产出：官方文档复核（核心价格/模型名/端点全部仍有效，无失效项；新增 gpt-5.6-sol 促销价、gpt-5.6-luna、deepseek flash-vision-exp；Codex MCP 新增 env/env_vars/enabled/required/startup_timeout_sec/tool_timeout_sec/disabled_tools）；20 对 paired task 设计（7 类 + counterbalance）；成本审计（无 P0，发现并已修 P1×2）。
  2. 用户三项决策：①**没有 OpenAI API key**；②先修复并实现；③部署根 `D:\CodexRouter`（D 盘存在、516G 可用、可写）。
  3. 离线修复已落地：P1-a（`src/orchestrator.ts` createBundle 成本聚合从 `EXECUTE||REPAIR` 改为 `BILLABLE_MODEL_STAGES` 8 个计费阶段，补上 GPT planning/review/诊断成本）；P1-b（`src/orchestrator.ts` evidence() 的 list 价估算新增 `cacheHitTokens && cacheMissTokens` 可用性门控，cache 缺失 fail-closed）。
  4. 已实现直连 OpenAI Responses 适配器：`src/providers/openai-responses.ts`（`OpenAiResponsesAdapter` + `openai-env`/`openai-dpapi` 别名 + `src/credentials.ts` 的 `loadOpenAiApiKey` + `src/route-preflight.ts` 的 3 个常量），无 key 时 fail-closed、未接入生产路由；测试 `test/openai-responses.test.ts` 7/7。
  5. 已修 2 处测试基础设施：`test/skill.test.ts` 读取后 `.replace(/\r\n/g,"\n")`（修复 core.autocrlf 导致的 CRLF 失配）；`vitest.config.ts` hookTimeout 30s→120s。
  6. 全量测试：**30 files / 421 tests 全部通过**（含新增 7 个 openai-responses 测试）。
- 关键决策（用户已确认，2026-08-25）：**没有 OpenAI API key**（`OPENAI_API_KEY` 未设置、无 `%LOCALAPPDATA%\CodexRouter\openai-key.dpapi`），且**不等待 key**——按现有 hybrid-only 方案计算。即：GPT-only 可审计对照臂本阶段**不启用**，无法取得权威 GPT model/request/token/cost telemetry → **30% 降费对照 BLOCKED**。只做 hybrid-only 路径，报告 hybrid 绝对成本与质量，**不得宣称相对 GPT-only 降费**；成本严格按现有四层口径（provider_reported / estimated_list / invoice / quota），GPT 前景规划/审查成本不可审计 → 保留 `null`，绝不伪造、绝不把 null 当零。
- 本机环境事实（只读存在性已探测）：Codex `config.toml` + `auth.json` 存在于 `C:\Users\ASUS\.codex\`；`codex` CLI 不在 PATH；DeepSeek DPAPI 凭据存在（`%LOCALAPPDATA%\CodexRouter\deepseek-key.dpapi`）；`DEEPSEEK_API_KEY` 环境变量未设置。
- 本机环境坑（跨会话持续，详见 `~/.workbuddy/MEMORY.md`，勿重复诊断）：
  1. Windows 非管理员 + 开发者模式未开启 → 用 **junction** 替代 file/dir symlink（`fs.symlink(target, path, "junction")` 免权限）。
  2. OneDrive 实时回退 `.git` refs → 提交用 `git commit-tree <tree> -p <base>` + `git push <commit>:refs/heads/<branch>`，不依赖本地分支指针。
  3. push credential 多值链（helper-selector→GCM）→ askpass 输出 `gh auth token` + `GIT_CONFIG_NOSYSTEM=1` + `HOME=<空目录>` + `GIT_ASKPASS=<脚本绝对路径>` + URL 带 username，保留 `-c http.proxy`。
  4. 测试慢（git worktree 15–45s/用例），testTimeout/hookTimeout 已 120s；**必须串行单进程跑测试，严禁并发多个 vitest**（并发争用 git worktree 会把全量从 6 失败放大到 21 失败，同批测试隔离运行全过）。
  5. http.proxy = `127.0.0.1:7890`。
  6. managed node = `C:\Users\ASUS\.workbuddy\binaries\node\versions\22.22.2\node.exe`（跑 tsc/vitest 用绝对路径，勿用裸命令）。

只有上述离线修复通过 typecheck + 全量 421/421 后，才可开始真实副作用。先读取本文件、`README.md`、`ROADMAP.md`、`docs/17-orchestrator-first-stage-handoffs.md`、`docs/27-s10-preflight-remediation.md`、`docs/28-s10-gpt-only-baseline-adr.md`、`config/pilot-report.schema.json`、`config/pricing-catalog.example.json`、`config/quality-gate-policy.pilot.example.json`、`config/codex-mcp-registration.s10a.toml.example`、安装/回滚脚本与完整 Git 状态。

请作为主 agent 组织 agent team：
- Agent A：只读复核官方文档与价格（沿用已复核结论，只在需要时刷新）；
- Agent B：把 20 对 paired task 设计落成实际 fixture 仓库 + base hash + hidden gates；
- Agent C：审计成本统计、Pilot aggregation、null/estimate/invoice/quota 分层（沿用已审计结论，复核修复是否落地）；
- 主 agent：唯一负责真实配置、credential 授权、exact approval、provider 请求和 hard-stop。

子 agent 不得并行执行真实配置写入、credential 操作、provider 请求或 apply。所有真实副作用由主 agent 串行执行。

权限规则：
1. 写真实 Codex config 前，展示 exact target、exact block、SHA-256、before hash、backup 和 rollback，等待用户明确批准。
2. credential 与 MCP 注册分开授权；不得让用户把 API key 粘贴到聊天、仓库、日志或命令参数。
3. 每次 provider side effect 前展示完整 approval summary、approval_summary_hash、最大 request/token/wall/cost 和 stop conditions，等待包含 exact hash 的授权。
4. 未获批准时只允许只读检查、官方资料核验、离线准备和 dry-run。
5. commit、push、tag、PR、merge 仍需单独授权（本会话离线修复未提交，需授权后用 commit-tree + askpass push）。

按顺序执行：

一、构建生产分发与外部 roots（离线，无需授权）
- 根 `D:\CodexRouter`，结构：`distribution\`（tsc 编译产物，含 `dist/src/mcp.js`）、`state\`、`evidence\`、`worktrees\`、`visible-fixture\`、`hidden\`、`config\`。
- 用 managed node 构建：`tsc -p tsconfig.build.json --outDir D:\CodexRouter\distribution`；消除 OneDrive/AppData/bundled runtime 硬编码。
- 生成/复制 `config\` 下的 quality-gate-policy、trusted-quality-command-catalog、user-policy、project-policy、route-profile JSON（不含密钥）。
- 用 `config-preview`/`doctor`/`pricing-verify`/`credential-status` dry-run 验证（不写真实配置）。

二、构建 20 个 fixture + base hash（离线）
- 按 Agent B 设计（7 类：单文件 bug / 多文件 bug / 测试补充 / 有限重构 / API 边界 / 文档一致性 / 不应路由；pair-01..10 GPT-only 先、pair-11..20 hybrid 先 counterbalance）。
- 每个 fixture：public/synthetic 仓库 + visible tests + hidden tests + reference；hidden tests/reference 存 `D:\CodexRouter\hidden\`（模型不可读、不可外发），visible 存 `visible-fixture\`。
- 计算 base_fixture_hash = sha256(base commit tree 内容)，任一文件变化即失效。

三、生成 exact MCP 注册审批包（展示 + 等待批准才写）
- `buildMcpRegistrationPreview(...)` + `config-preview` 生成 exact TOML block + SHA-256 + before/after hash + backup/rollback。
- 展示 exact target（`C:\Users\ASUS\.codex\config.toml`）、exact block、block SHA-256、backup、rollback，等待用户明确批准。
- 获批后只写 exact Router MCP block（9 个 router.* 工具：prepare/execute/status/abort/review_evidence/finalize/repair/apply/pilot_report），不改 auth/provider/model/profile/其他 MCP。
- 写后验证 block hash 正确、其他配置 byte-for-byte 不变；重启 Codex/新会话后验证 discovery 全部 9 工具；discovery 失败则移除 exact block、重启、保持 BLOCKED。

四、credential 隔离
- DeepSeek DPAPI 凭据已存在；只做 `credential-status` 存在性检查，绝不输出 secret。
- 展示 credential alias、存储类别、用户边界、读取进程和 child environment allowlist；smoke approval 前不发送探测请求。

五、一次 hybrid smoke（需 exact-hash 授权）
- 固定边界：单一 public fixture、DeepSeek Flash、禁止 Pro escalation/redirect/private data/full chat、hidden data 不进入模型上下文、只读批准 fixture、只写 isolated worktree、最多 2 attempts/6 HTTP requests/一次 repair、禁止静默 retry、禁止 apply 到开发仓库、禁止 commit/push。
- 先 prepare 并展示完整 summary/hash，等待 exact hash 授权后才 execute；重复/并发调用不得重发。
- 通过要求：visible 与 hidden 全通过；final acceptance=true；secret/scope/privacy/routing/duplicate/main pollution=0；ambiguity=0；provider/model/endpoint/request ID/usage/round cost 完整；PilotRunRecord 可验证；开发仓库和 Codex config/auth/provider 不变。

六、hybrid-only paired Pilot（需整批授权）
- 20 对任务，每个 task/arm 使用全新 isolated repo/state，arm 间不泄漏输出。
- 规则：不人工修代码、不删除失败样本、不降低 acceptance、不把 null 当零、不忽略 GPT planning/review/repair/失败请求、不自动 Flash→Pro；任一安全/隐私/路由/主目录污染、ambiguity 或 unexplained duplicate 立即停止整批。
- 记录权威 response model、request ID、token/cache、wall time、list-cost；provider/invoice/quota 缺失保留 null。
- 降费对照保持 BLOCKED（无 GPT-only 基线）：只报告 hybrid 绝对成本与质量，不宣称相对降费；recommendation=stop，不进入 Part 3。GPT-only 对照臂本阶段不启用。

硬门：
- hybrid acceptance 不低于可用基线；regression=0；scope/privacy/routing/secret/main pollution=0；ambiguity=0；unexplained duplicate=0；intervention 不高于 baseline；repair 没有显著增加。
- hybrid 绝对成本完整、分层（provider_reported / estimated_list / invoice / quota），零伪造、零「null 当零」。
- 降费门 BLOCKED（无 OpenAI key），不得进入 Part 3。

最终输出：agent team 产出、MCP/config/credential 变更、所有真实请求批准 hash、smoke 结果、paired run records、聚合质量/token/cache/request/wall/成本、失败分类、expand|simplify|stop、阶段门逐项 PASS/BLOCKED、Git status，以及是否发生任何网络/credential/config/provider side effect。

结束前运行（串行单进程，managed node 绝对路径）：
- TypeScript `--noEmit`；
- 全量 Vitest（30 files 421 tests，禁止并发多个 vitest）；
- `git diff --check`；
- schema/examples 验证；
- 外置 `D:\CodexRouter\distribution` 生产 build。
```
