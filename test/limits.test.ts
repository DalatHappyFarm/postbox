import { describe, expect, it } from "vitest";
import { DEFAULTS, readLimits } from "../lib/limits.ts";
import { setup } from "./helpers.ts";

describe("readLimits", () => {
  it("uses the spec defaults when nothing is set", () => {
    expect(readLimits({})).toEqual(DEFAULTS);
    expect(DEFAULTS).toEqual({ MAX_ATTACHMENTS: 4, MAX_IMAGE_BYTES: 5242880, MAX_TOTAL_BYTES: 15728640, MAX_THUMB_BYTES: 65536, MAX_TEXT: 4000, RATE_PER_DEVICE_HOUR: 20, RATE_PER_PROJECT_HOUR: 200 });
  });
  it("reads numbers and digit strings", () => {
    expect(readLimits({ MAX_ATTACHMENTS: "6", MAX_TEXT: 500, RATE_PER_DEVICE_HOUR: " 7 " })).toMatchObject({ MAX_ATTACHMENTS: 6, MAX_TEXT: 500, RATE_PER_DEVICE_HOUR: 7 });
  });
  it("falls back to the default for anything that is not a positive integer, or is above a ceiling", () => {
    const bad = { MAX_ATTACHMENTS: "0", MAX_IMAGE_BYTES: "-5", MAX_TOTAL_BYTES: "1.5", MAX_THUMB_BYTES: "abc", MAX_TEXT: 10001, RATE_PER_DEVICE_HOUR: "", RATE_PER_PROJECT_HOUR: 1e30 };
    expect(readLimits(bad)).toEqual(DEFAULTS);
    expect(readLimits({ MAX_ATTACHMENTS: null, MAX_TEXT: {} })).toEqual(DEFAULTS);
  });
});

describe("GET /api/limits", () => {
  it("is public, cacheable and follows the variables", async () => {
    const t = await setup();
    const res = await t.call("/api/limits");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.json()).toEqual({ max_attachments: 4, max_image_bytes: 5242880, max_total_bytes: 15728640, max_text: 4000, image_types: ["image/jpeg", "image/png"] });
    const changed = await t.call("/api/limits", {}, { ...t.env, MAX_ATTACHMENTS: "2", MAX_TEXT: "100" });
    expect(await changed.json()).toMatchObject({ max_attachments: 2, max_text: 100 });
  });
});
