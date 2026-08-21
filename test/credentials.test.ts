import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildCredentialSubprocessEnvironment, loadDeepSeekApiKey, resolveWindowsPowerShell } from "../src/credentials.js";
import { DEEPSEEK_DPAPI_AUTH_ALIAS, DEEPSEEK_ENV_AUTH_ALIAS } from "../src/route-preflight.js";

describe("S4 credential environment boundary", () => {
  it("returns an explicit synthetic key without invoking the DPAPI dependency", () => {
    const decrypt = vi.fn();
    expect(loadDeepSeekApiKey(DEEPSEEK_ENV_AUTH_ALIAS, { DEEPSEEK_API_KEY: "synthetic-key" }, { platform: "win32", fileExists: () => true, decrypt })).toBe("synthetic-key");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("rejects control characters and oversized credential values", () => {
    expect(() => loadDeepSeekApiKey(DEEPSEEK_ENV_AUTH_ALIAS, { DEEPSEEK_API_KEY: "synthetic\nheader" }, { platform: "linux" })).toThrow(/invalid/);
    expect(() => loadDeepSeekApiKey(DEEPSEEK_ENV_AUTH_ALIAS, { DEEPSEEK_API_KEY: "x".repeat(513) }, { platform: "linux" })).toThrow(/invalid/);
    expect(loadDeepSeekApiKey(DEEPSEEK_ENV_AUTH_ALIAS, { DEEPSEEK_API_KEY: "   " }, { platform: "linux" })).toBeUndefined();
  });

  it("passes only an explicit allowlist to the synthetic decrypt dependency", () => {
    const environment = {
      LOCALAPPDATA: "C:\\SyntheticLocal",
      SystemRoot: "C:\\SyntheticWindows",
      TEMP: "C:\\SyntheticTemp",
      PATH: "C:\\SyntheticBin",
      PATHEXT: ".EXE",
      UNAPPROVED_SENTINEL: "must-not-pass",
      DEEPSEEK_API_KEY: "",
    };
    const decrypt = vi.fn((_secretPath: string, childEnvironment: NodeJS.ProcessEnv, executable: string) => {
      expect(childEnvironment).toEqual({
        SystemRoot: environment.SystemRoot,
        TEMP: environment.TEMP,
        CODEX_ROUTER_SECRET_PATH: path.win32.join(environment.LOCALAPPDATA, "CodexRouter", "deepseek-key.dpapi"),
      });
      expect(childEnvironment.UNAPPROVED_SENTINEL).toBeUndefined();
      expect(childEnvironment.DEEPSEEK_API_KEY).toBeUndefined();
      expect(childEnvironment.PATH).toBeUndefined();
      expect(executable).toBe("C:\\SyntheticWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      return "synthetic-decrypted-key";
    });
    expect(loadDeepSeekApiKey(DEEPSEEK_DPAPI_AUTH_ALIAS, environment, { platform: "win32", fileExists: () => true, decrypt })).toBe("synthetic-decrypted-key");
    expect(decrypt).toHaveBeenCalledOnce();
  });

  it("keeps the secret path out of the command surface and redacts dependency failures", () => {
    const environment = { LOCALAPPDATA: "C:\\SyntheticLocal", SystemRoot: "C:\\SyntheticWindows", UNAPPROVED_SENTINEL: "hidden" };
    const built = buildCredentialSubprocessEnvironment(environment, "C:\\SyntheticSecret\\value.dpapi");
    expect(Object.keys(built).sort()).toEqual(["CODEX_ROUTER_SECRET_PATH", "SystemRoot"]);
    expect(resolveWindowsPowerShell(built)).toBe("C:\\SyntheticWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(() => loadDeepSeekApiKey(DEEPSEEK_DPAPI_AUTH_ALIAS, environment, {
      platform: "win32", fileExists: () => true,
      decrypt: () => { throw new Error("synthetic key and physical path must not escape"); },
    })).toThrow("Unable to decrypt the stored DeepSeek API Key for the current Windows user");
  });

  it("resolves exactly one approved alias and never falls back across sources", () => {
    const decrypt = vi.fn(() => "synthetic-decrypted-key");
    const environment = { DEEPSEEK_API_KEY: "synthetic-env-key", LOCALAPPDATA: "C:\\SyntheticLocal", SystemRoot: "C:\\SyntheticWindows" };
    expect(loadDeepSeekApiKey(DEEPSEEK_ENV_AUTH_ALIAS, environment, { platform: "win32", fileExists: () => true, decrypt })).toBe("synthetic-env-key");
    expect(decrypt).not.toHaveBeenCalled();
    expect(() => loadDeepSeekApiKey("openai-cross-provider", environment, { platform: "win32", fileExists: () => true, decrypt })).toThrow(/alias/);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("rejects missing, relative, UNC, or traversal-bearing Windows roots", () => {
    for (const environment of [{}, { SystemRoot: "relative" }, { SystemRoot: "\\\\server\\share" }, { SystemRoot: "C:\\Windows\\..\\Other" }]) {
      expect(() => resolveWindowsPowerShell(environment)).toThrow(/system root/);
    }
  });
});
