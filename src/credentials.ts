import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const CHILD_ENV_ALLOWLIST = new Set(["systemroot", "windir", "temp", "tmp"]);

export interface CredentialLoaderDependencies {
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  decrypt?: (secretPath: string, childEnvironment: NodeJS.ProcessEnv, executable: string) => string;
}

export function buildCredentialSubprocessEnvironment(environment: NodeJS.ProcessEnv, secretPath: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && CHILD_ENV_ALLOWLIST.has(key.toLowerCase())) child[key] = value;
  }
  child.CODEX_ROUTER_SECRET_PATH = secretPath;
  return child;
}

export function loadDeepSeekApiKey(environment: NodeJS.ProcessEnv = process.env, dependencies: CredentialLoaderDependencies = {}): string | undefined {
  const direct = normalizeCredential(environment.DEEPSEEK_API_KEY);
  if (direct) return direct;
  if ((dependencies.platform ?? process.platform) !== "win32" || !environment.LOCALAPPDATA) return undefined;
  const encrypted = path.win32.join(environment.LOCALAPPDATA, "CodexRouter", "deepseek-key.dpapi");
  if (!(dependencies.fileExists ?? existsSync)(encrypted)) return undefined;
  const childEnvironment = buildCredentialSubprocessEnvironment(environment, encrypted);
  const executable = resolveWindowsPowerShell(childEnvironment);
  try {
    const key = dependencies.decrypt
      ? dependencies.decrypt(encrypted, childEnvironment, executable)
      : decryptStoredCredential(executable, childEnvironment);
    return normalizeCredential(key);
  } catch {
    throw new Error("Unable to decrypt the stored DeepSeek API Key for the current Windows user");
  }
}

export function resolveWindowsPowerShell(environment: NodeJS.ProcessEnv): string {
  const windowsRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR ?? environment.Windir;
  if (!windowsRoot || !/^[A-Za-z]:\\/.test(windowsRoot) || /(^|\\)\.\.(\\|$)|["<>|?*]/.test(windowsRoot)) throw new Error("Windows system root is unavailable for credential decryption");
  return path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function decryptStoredCredential(executable: string, environment: NodeJS.ProcessEnv): string {
  const command = "$s=ConvertTo-SecureString ([IO.File]::ReadAllText($env:CODEX_ROUTER_SECRET_PATH).Trim());$c=[pscredential]::new('router',$s);[Console]::Out.Write($c.GetNetworkCredential().Password)";
  return execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", env: environment, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
}

function normalizeCredential(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 512) throw new Error("DeepSeek credential value is invalid");
  const trimmed = value.trim();
  return trimmed || undefined;
}
