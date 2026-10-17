// Every limit comes from Pages variables ([vars] in wrangler.toml); a missing or invalid value falls back to the default.
export const DEFAULTS = {
  MAX_ATTACHMENTS: 4,
  MAX_IMAGE_BYTES: 5_242_880,
  MAX_TOTAL_BYTES: 15_728_640,
  MAX_THUMB_BYTES: 65_536,
  MAX_TEXT: 4000,
  RATE_PER_DEVICE_HOUR: 20,
  RATE_PER_PROJECT_HOUR: 200,
} as const;

export type Limits = { -readonly [K in keyof typeof DEFAULTS]: number };

// MAX_TEXT is bounded by the database check (0002) and by the 64 KB body slack of the Content-Length guard.
const CEILING: Partial<Limits> = { MAX_TEXT: 10_000 };

/** Positive integers only (number or digit string); anything else, or above the ceiling, means the default. */
export function readLimits(env: Record<string, unknown>): Limits {
  const out = { ...DEFAULTS } as Limits;
  for (const k of Object.keys(DEFAULTS) as (keyof Limits)[]) {
    const raw = env[k];
    if (typeof raw !== "number" && !(typeof raw === "string" && /^\d{1,15}$/.test(raw.trim()))) continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0 && n <= (CEILING[k] ?? Infinity)) out[k] = n;
  }
  return out;
}
