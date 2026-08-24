import { PassThrough } from "node:stream";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStdioMcpServer } from "../src/mcp.js";
import { canonicalFixture, directoryHash } from "./router-fixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("thin STDIO MCP", () => {
  it("drives the whole S7 flow through one foreground session without config registration or sentinel changes", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const input = new PassThrough(); const output = new PassThrough();
    const running = runStdioMcpServer(fixture.core, input, output);
    const send = async (id: number, method: string, params?: unknown) => {
      const response = once(output, "data");
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
      const [chunk] = await response;
      return JSON.parse(chunk.toString()) as any;
    };
    const mainBefore = await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8");
    const sentinelBefore = await directoryHash(fixture.sentinels);
    const initialized = await send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-codex", version: "1" } });
    expect(initialized.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } } });
    expect(initialized.result.instructions).toMatch(/never send full chat history or hidden reasoning/i);
    const listed = await send(2, "tools/list");
    expect(listed.result.tools.map((item: any) => item.name)).toEqual(["router.prepare", "router.execute", "router.status", "router.abort", "router.review_evidence", "router.finalize", "router.repair", "router.apply"]);
    expect(listed.result.tools.find((item: any) => item.name === "router.execute").annotations).toMatchObject({ idempotentHint: false, openWorldHint: true });
    expect(listed.result.tools.find((item: any) => item.name === "router.prepare").inputSchema.properties.task_package.properties.egress_policy.oneOf).toHaveLength(2);
    const preparedRpc = await send(3, "tools/call", { name: "router.prepare", arguments: { task_package: fixture.task } });
    const prepared = preparedRpc.result.structuredContent;
    expect(prepared).toMatchObject({ state: "AWAITING_APPROVAL", next: "execute" });
    const executedRpc = await send(4, "tools/call", { name: "router.execute", arguments: { task_id: prepared.task_id, approval_summary_hash: prepared.approval_summary.approval_summary_hash } });
    const executed = executedRpc.result.structuredContent;
    expect(executed).toMatchObject({ state: "REVIEW_PENDING", evidence_bundle: { quality_passed: true } });
    const reviewedRpc = await send(5, "tools/call", { name: "router.review_evidence", arguments: { task_id: prepared.task_id } });
    const reviewed = reviewedRpc.result.structuredContent;
    expect(reviewed).toMatchObject({ quality_passed: true, files_changed: ["src/parser.ts"] });
    const finalizedRpc = await send(6, "tools/call", { name: "router.finalize", arguments: { task_id: prepared.task_id, evidence_bundle_hash: reviewed.evidence_bundle_hash, decision: "PASS", summary: "Foreground GPT accepted the synthetic evidence." } });
    expect(finalizedRpc.result.structuredContent).toMatchObject({ state: "APPLY_PENDING", final_review: { decision: "PASS" }, next: "apply" });
    input.end(); await running;
    expect(fixture.model.sends).toBe(1);
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe(mainBefore);
    expect(await directoryHash(fixture.sentinels)).toBe(sentinelBefore);
  });

  it("drives repair, second review, and explicit apply through one temporary STDIO MCP session", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const input = new PassThrough(); const output = new PassThrough();
    const running = runStdioMcpServer(fixture.core, input, output);
    const send = async (id: number, name: string, arguments_: Record<string, unknown>) => {
      const response = once(output, "data");
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } })}\n`);
      const [chunk] = await response;
      return JSON.parse(chunk.toString()).result.structuredContent as any;
    };
    const mainBefore = await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8");
    const sentinelBefore = await directoryHash(fixture.sentinels);

    const prepared = await send(1, "router.prepare", { task_package: fixture.task });
    const executed = await send(2, "router.execute", { task_id: prepared.task_id, approval_summary_hash: prepared.approval_summary.approval_summary_hash });
    const firstEvidence = await send(3, "router.review_evidence", { task_id: prepared.task_id });
    const repairPending = await send(4, "router.finalize", { task_id: prepared.task_id, evidence_bundle_hash: firstEvidence.evidence_bundle_hash, decision: "REPAIR_REQUIRED", summary: "Change the synthetic parser result from 2 to 3." });
    expect(executed.state).toBe("REVIEW_PENDING");
    expect(repairPending).toMatchObject({ state: "REPAIR_REQUIRED", next: "repair" });

    const repaired = await send(5, "router.repair", { task_id: prepared.task_id, evidence_bundle_hash: firstEvidence.evidence_bundle_hash, approval_summary_hash: prepared.approval_summary.approval_summary_hash });
    const secondEvidence = await send(6, "router.review_evidence", { task_id: prepared.task_id });
    const applyPending = await send(7, "router.finalize", { task_id: prepared.task_id, evidence_bundle_hash: secondEvidence.evidence_bundle_hash, decision: "PASS", summary: "The repaired synthetic evidence satisfies acceptance." });
    expect(repaired).toMatchObject({ state: "REVIEW_PENDING", repair_count: 1 });
    expect(secondEvidence.evidence_bundle_hash).not.toBe(firstEvidence.evidence_bundle_hash);
    expect(applyPending).toMatchObject({ state: "APPLY_PENDING", applied: false, next: "apply" });
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe(mainBefore);

    const applied = await send(8, "router.apply", { task_id: prepared.task_id, evidence_bundle_hash: secondEvidence.evidence_bundle_hash });
    expect(applied).toMatchObject({ state: "PASSED", repair_count: 1, applied: true, next: "none" });
    expect(fixture.model.sends).toBe(2);
    expect(await readFile(path.join(fixture.project, "src", "parser.ts"), "utf8")).toBe("export const parser = 3;\n");
    expect(await directoryHash(fixture.sentinels)).toBe(sentinelBefore);
    input.end(); await running;
  });

  it("rejects hidden chat-shaped additions instead of forwarding them", async () => {
    const fixture = await canonicalFixture(); roots.push(fixture.root);
    const input = new PassThrough(); const output = new PassThrough(); const running = runStdioMcpServer(fixture.core, input, output);
    const response = once(output, "data");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "router.prepare", arguments: { task_package: { ...fixture.task, chat_history: ["should never pass"] } } } })}\n`);
    const [chunk] = await response; const parsed = JSON.parse(chunk.toString());
    expect(parsed.result).toMatchObject({ isError: true }); expect(fixture.model.sends).toBe(0);
    input.end(); await running;
  });
});
