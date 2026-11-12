// Allowed origins per mailbox: which websites may send letters with its public key.
// A browser always sends Origin on a cross-site POST and a page cannot change it, so a list stops other websites
// from using a key copied out of a page's HTML. Native apps and scripts send no Origin (or any they like), so the
// rate limits stay the protection against those; a request without Origin is accepted.

/** `scheme://host[:port]`: the host may start with `*.` (any subdomain, not the domain itself) and the port may be `*`. */
const PATTERN = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}|\*))?$/;
export const MAX_ORIGINS = 20;

/** The pattern lowercased, without a trailing slash or a default port; null when it is not a valid origin pattern. */
export function normalizeOrigin(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/\/$/, "");
  const m = PATTERN.exec(v);
  if (!m) return null;
  const [, scheme, star = "", host, port] = m;
  if (star && !host.includes(".")) return null; // "*.com" would allow every site under a top-level domain
  if (port && port !== "*" && (Number(port) < 1 || Number(port) > 65535)) return null;
  const isDefault = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  return `${scheme}://${star}${host}${port && !isDefault ? `:${port}` : ""}`;
}

/** True when the list is empty (any origin), the request has no Origin header, or the origin matches a pattern. */
export function originAllowed(origin: string | null, patterns: readonly string[]): boolean {
  if (!patterns.length || origin === null) return true;
  const o = /^(https?):\/\/([a-z0-9.-]+)(?::(\d+))?$/.exec(origin.toLowerCase());
  if (!o) return false; // "null" from sandboxed frames and file: pages
  const [, scheme, host, port = ""] = o;
  return patterns.some((p) => {
    const m = PATTERN.exec(p);
    if (!m || m[1] !== scheme) return false;
    if (m[4] !== "*" && (m[4] ?? "") !== port) return false;
    return m[2] ? host.endsWith(`.${m[3]}`) : host === m[3];
  });
}
