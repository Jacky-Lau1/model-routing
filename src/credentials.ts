import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function loadDeepSeekApiKey(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (environment.DEEPSEEK_API_KEY) return environment.DEEPSEEK_API_KEY;
  if (process.platform !== "win32" || !environment.LOCALAPPDATA) return undefined;
  const encrypted = path.join(environment.LOCALAPPDATA, "CodexRouter", "deepseek-key.dpapi");
  if (!existsSync(encrypted)) return undefined;
  const command = "$s=ConvertTo-SecureString ([IO.File]::ReadAllText($args[0]).Trim());$c=[pscredential]::new('router',$s);[Console]::Out.Write($c.GetNetworkCredential().Password)";
  try {
    const key = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command, encrypted], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return key || undefined;
  } catch {
    throw new Error("Unable to decrypt the stored DeepSeek API Key for the current Windows user");
  }
}
