import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../types.js";
import { LOCAL_ADAPTER_ID } from "../route-preflight.js";

export class LocalValidationAdapter implements ProviderAdapter {
  readonly provider = "local" as const;
  readonly adapterId = LOCAL_ADAPTER_ID;
  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const commands = request.dynamicInput.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const results: Array<{ command: string; code: number; output: string }> = [];
    for (const command of commands) {
      const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
      const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command];
      const child = spawn(shell, args, { cwd: request.workingDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, request.route.timeoutMs);
      const [code] = await once(child, "close") as [number | null];
      clearTimeout(timer);
      results.push({ command, code: timedOut ? 124 : (code ?? 1), output: redact(`${output}${timedOut ? `\nTimed out after ${request.route.timeoutMs}ms` : ""}`).slice(-16_000) });
      if (code !== 0) break;
    }
    const passed = results.length === commands.length && results.every(result => result.code === 0);
    return { text: JSON.stringify({ passed, results }), requestId: "local", provider: "local", model: "local-quality-gates", usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }, raw: results };
  }
}

function redact(value: string): string {
  return value
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]+/gi, match => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`);
}
