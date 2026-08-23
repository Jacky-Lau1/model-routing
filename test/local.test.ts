import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalValidationAdapter } from "../src/providers/local.js";
import { decideRoute } from "../src/policy.js";
import { classifyTask } from "../src/classifier.js";
import type { ProviderRequest } from "../src/types.js";

describe("local validation adapter boundary", () => {
  it("rejects legacy dynamic command strings before any execution", async () => {
    const adapter = new LocalValidationAdapter();
    const request = { stage: "VALIDATE", route: decideRoute("VALIDATE", classifyTask("synthetic validation")), stablePrefix: "", projectSummary: "", dynamicInput: "npm test && synthetic-side-effect", sensitivity: "normal", workingDirectory: path.resolve("synthetic-worktree") } satisfies ProviderRequest;
    await expect(adapter.preflight(request)).rejects.toThrow(/structured quality-gate request/);
    await expect(adapter.invoke(request)).rejects.toThrow(/structured quality-gate request/);
  });

  it("contains no shell command compatibility path", async () => {
    const source = await readFile(path.resolve("src/providers/local.ts"), "utf8");
    expect(source).not.toMatch(/powershell|cmd\.exe|\/bin\/sh|\s-lc\b|-Command|shell\s*:/i);
    expect(source).not.toMatch(/dynamicInput\.(?:split|trim)|spawn\(|exec(?:File|Sync)?\(/);
  });
});
