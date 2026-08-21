import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repositoryRoot, "scripts", "install-router-terminal.ps1");
const terminal = path.join(repositoryRoot, "scripts", "router-terminal.ps1");
const windowsIt = process.platform === "win32" ? it : it.skip;

function runPowerShell(script: string, args: string[]): string {
  return execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...args
  ], { cwd: repositoryRoot, encoding: "utf8", windowsHide: true });
}

describe("S0 default entrypoints", () => {
  it("have no native provider/profile/config write call chain", () => {
    const defaultScripts = [installer, terminal].map(file => readFileSync(file, "utf8")).join("\n");
    expect(defaultScripts).not.toMatch(/switch-codex-native-mode|install-codex-deepseek-profiles/i);
    expect(defaultScripts).not.toMatch(/config\.toml|auth\.json|model_catalog_json/i);
    expect(defaultScripts).not.toMatch(/deepseek-(?:flash|pro)|restore openai/i);
  });

  windowsIt("creates only the Orchestrator shortcut through the mock backend", () => {
    const shortcutRoot = mkdtempSync(path.join(tmpdir(), "router-s0-shortcuts-"));
    try {
      const output = runPowerShell(installer, [
        "-RepositoryRoot", repositoryRoot,
        "-ShortcutDirectories", shortcutRoot,
        "-ShortcutBackend", "Mock",
        "-IconPath", "powershell.exe"
      ]);
      const files = readdirSync(shortcutRoot);
      expect(files).toEqual(["Codex Router - Orchestrator.lnk.mock.json"]);
      const manifest = readFileSync(path.join(shortcutRoot, files[0]), "utf8").replace(/^\uFEFF/, "");
      expect(manifest).toContain("Orchestrator");
      expect(`${output}\n${manifest}`).not.toMatch(/native menu|restore openai|deepseek-(?:flash|pro)/i);
    } finally {
      rmSync(shortcutRoot, { recursive: true, force: true });
    }
  });

  windowsIt("dry-run reports only Orchestrator and writes nothing", () => {
    const shortcutRoot = mkdtempSync(path.join(tmpdir(), "router-s0-dry-run-"));
    try {
      const output = runPowerShell(installer, [
        "-RepositoryRoot", repositoryRoot,
        "-ShortcutDirectories", shortcutRoot,
        "-ShortcutBackend", "Mock",
        "-IconPath", "powershell.exe",
        "-DryRun"
      ]);
      expect(readdirSync(shortcutRoot)).toEqual([]);
      expect(output).toContain("Orchestrator");
      expect(output).not.toMatch(/native menu|restore openai|deepseek-(?:flash|pro)/i);
    } finally {
      rmSync(shortcutRoot, { recursive: true, force: true });
    }
  });

  windowsIt("terminal help advertises only Orchestrator", () => {
    const output = runPowerShell(terminal, ["-Help"]);
    expect(output).toContain("Orchestrator");
    expect(output).not.toMatch(/native|restore openai|deepseek (?:flash|pro)|openai codex/i);
  });
});
