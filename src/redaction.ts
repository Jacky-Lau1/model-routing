const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*([^\s,;"']+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+/gi;
const KEY_SHAPED = /\b(?:sk|ds|pk)-(?:live-|test-)?[A-Za-z0-9_-]{8,}\b/gi;
const WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\r\n"'<>|]+/g;
const USER_PATH = /\/(?:Users|home)\/[^\s"']+/g;

export function redactText(value: string, maxLength = 2_000): string {
  const redacted = value
    .replace(SECRET_ASSIGNMENT, "[REDACTED_SECRET]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(KEY_SHAPED, "[REDACTED]")
    .replace(WINDOWS_PATH, "[PATH]")
    .replace(USER_PATH, "[PATH]");
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}[TRUNCATED]`;
}

export function redactError(error: unknown): string {
  if (error instanceof Error) return redactText(`${error.name}: ${error.message}`);
  return redactText(String(error));
}

export function sanitizeForPersistence<T>(value: T): T {
  return sanitize(value) as T;
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = sanitize(entry);
    return result;
  }
  throw new Error(`Unsupported persistence value: ${typeof value}`);
}
