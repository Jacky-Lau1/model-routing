import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("thin repository Router skill", () => {
  it("is discoverable, instruction-only, and delegates every operation to the shared core tools", async () => {
    const root = path.resolve(".agents/skills/codex-router");
    const text = await readFile(path.join(root, "SKILL.md"), "utf8");
    expect(text).toMatch(/^---\nname: codex-router\ndescription: [^\n]+\n---\n/);
    for (const name of ["router.prepare", "router.execute", "router.status", "router.abort", "router.review_evidence", "router.finalize", "router.repair", "router.apply"]) expect(text).toContain(`\`${name}\``);
    expect(text).toMatch(/Never include full chat history, hidden reasoning/i);
    expect(text).toMatch(/Do not reproduce policy, route, credential, filesystem, retry, or evidence validation in the skill/i);
    await expect(access(path.join(root, "scripts"))).rejects.toThrow();
  });
});
