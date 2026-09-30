// WebIDL argument conversions used by the timer API.

/**
 * WebIDL `long` (no [EnforceRange]/[Clamp]): ToNumber, NaN/±Infinity -> 0,
 * truncate, wrap modulo 2^32 into the signed 32-bit range. `x | 0` is exactly
 * ECMAScript ToInt32 and throws TypeError for Symbol/BigInt like WebIDL does.
 *
 * Consequences (same as Chrome): 2**31 -> -2147483648 (treated as 0 by the
 * timer steps), 2**32 + 5 -> 5, "100" -> 100, undefined/null/NaN -> 0.
 */
export function toLong(v: unknown): number {
  return (v as number) | 0;
}

/**
 * `(Function or TrustedScript or DOMString)`: callables stay as-is, anything
 * else is converted with ToString (template literal = ToString with the
 * "string" hint; throws for Symbols like WebIDL).
 */
export function toTimerHandler(v: unknown): unknown {
  return typeof v === "function" ? v : `${v as string}`;
}
