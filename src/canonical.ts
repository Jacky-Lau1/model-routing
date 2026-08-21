import { createHash, timingSafeEqual } from "node:crypto";

export type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

/**
 * RFC 8785-inspired JSON serialization for contract hashes.
 * Object keys use locale-independent UTF-16 code-unit order, arrays retain their order, and
 * unsupported/non-finite values fail closed instead of being omitted.
 */
export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Reflect.ownKeys(value).some(key => typeof key === "symbol")) throw new Error("Canonical JSON rejects sparse arrays and array properties");
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Canonical JSON accepts plain objects only");
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key === "symbol") || ownKeys.length !== Object.keys(value).length) throw new Error("Canonical JSON rejects symbol and non-enumerable fields");
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => {
        if (entry === undefined) throw new Error(`Canonical JSON rejects undefined field: ${key}`);
        return `${JSON.stringify(key)}:${canonicalSerialize(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical JSON rejects ${typeof value} values`);
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}

export function hashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
