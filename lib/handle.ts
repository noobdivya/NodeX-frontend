// NodeX handles ("Rahul#7K3M9X") — parsing and case-insensitive comparison.
// Kept free of crypto dependencies so any screen can use it cheaply.
//
// Handles are case-insensitive. Every comparison, lookup and validation uses
// the canonical form (handleKey): lowercase, with tag look-alikes fixed —
// "Rahul#7K3M9X", "rahul#7k3m9x" and "RAHUL#7K3M9X" are all "rahul#7k3m9x".

export const TAG_LENGTH = 6;
/** Crockford base32: no I, L, O or U, so tags are easy to read aloud and type. */
export const TAG_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const DISPLAY_NAME_RE = /^[A-Za-z0-9_]{2,20}$/;
const HANDLE_RE = new RegExp(`^([A-Za-z0-9_]{2,20})#([0-9A-Za-z]{${TAG_LENGTH}})$`);

/** Splits a handle into its parts plus canonical `key`. Null if malformed. */
export function parseHandle(input: string): { name: string; tag: string; key: string } | null {
  const m = HANDLE_RE.exec(input.trim());
  if (!m) return null;
  // Crockford decoding: accept common look-alikes.
  const tag = m[2].toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  if ([...tag].some((c) => !TAG_ALPHABET.includes(c))) return null;
  return { name: m[1], tag, key: `${m[1]}#${tag}`.toLowerCase() };
}

/** Canonical form of a handle for comparison, or null if malformed. */
export function normalizeHandle(input: string): string | null {
  return parseHandle(input)?.key ?? null;
}

/** Case-insensitive handle equality: "Rahul#Z7NJR2" equals "rahul#z7njr2". */
export function handlesEqual(a: string, b: string): boolean {
  const ka = normalizeHandle(a);
  return ka !== null && ka === normalizeHandle(b);
}
