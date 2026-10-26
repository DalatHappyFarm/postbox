import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_KEY, DEFAULT_LIMITS, buildParts, cleanup, clampFab, fabX, getDeviceId, getLimits, giveConsent, hasConsent, initialFab, isDrag, isShake,
  makeThumb, parseFab, pick, processImage, resetLimitsCache, resizeFor, send, sendTimeout, serializeFab, slotsLeft, snapFab, toInsets,
  type Img, type ImageDeps, type PickDeps, type Store,
} from "../src/core.js";

const mem = (): Store & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
};
const context = { platform: "ios", device_id: "abc", screen: "Home", app_version: "1.2", build: "7", device: "iPhone", os: "19", locale: "en-US" };

const img = (n: number, w = 100, h = 200): Img => ({ uri: `file:///t/${n}.jpg`, width: w, height: h, bytes: 1000 });
const jres = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

describe("limits", () => {
  beforeEach(resetLimitsCache);
  it("fetches once per endpoint and caches", async () => {
    const f = vi.fn(async () => jres({ max_attachments: 6, max_image_bytes: 1000, max_total_bytes: 5000, max_text: 100 }));
    const a = await getLimits("https://x.dev/", f as unknown as typeof fetch);
    const b = await getLimits("https://x.dev", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://x.dev/api/limits");
    expect(a).toEqual({ max_attachments: 6, max_image_bytes: 1000, max_total_bytes: 5000, max_text: 100 });
    expect(b).toBe(a);
  });
  it("falls back to defaults on error, http failure or junk, and retries next time", async () => {
    const bad = vi.fn(async () => { throw new Error("offline"); });
    expect(await getLimits("https://x.dev", bad as unknown as typeof fetch)).toEqual(DEFAULT_LIMITS);
    expect(await getLimits("https://x.dev", (async () => jres({}, 500)) as unknown as typeof fetch)).toEqual(DEFAULT_LIMITS);
    expect(await getLimits("https://x.dev", (async () => jres({ max_attachments: -1, max_image_bytes: "x" })) as unknown as typeof fetch)).toEqual(DEFAULT_LIMITS);
    resetLimitsCache();
    const ok = vi.fn(async () => jres({ max_attachments: 2 }));
    expect((await getLimits("https://x.dev", ok as unknown as typeof fetch)).max_attachments).toBe(2);
  });
});

describe("slots", () => {
  it("counts the screenshot only when included, max 4", () => {
    expect(slotsLeft(4, true, 0)).toBe(3);
    expect(slotsLeft(4, false, 0)).toBe(4);
    expect(slotsLeft(4, true, 3)).toBe(0);
    expect(slotsLeft(4, false, 4)).toBe(0);
    expect(slotsLeft(4, true, 9)).toBe(0);
  });
});

describe("resize", () => {
  it("caps the long edge at 1600 and never upscales", () => {
    expect(resizeFor(4000, 3000)).toEqual({ width: 1600 });
    expect(resizeFor(3000, 4000)).toEqual({ height: 1600 });
    expect(resizeFor(1600, 1600)).toBeNull();
    expect(resizeFor(800, 600)).toBeNull();
    expect(resizeFor(0, 0)).toBeNull();
    expect(resizeFor(4000, 3000, 320)).toEqual({ width: 320 });
  });
  const deps = (bytes: number): ImageDeps & { manipulate: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } => ({
    getSize: vi.fn(async () => ({ width: 3000, height: 4000 })),
    manipulate: vi.fn(async () => ({ uri: "file:///out.jpg", width: 1200, height: 1600 })),
    bytes: () => bytes,
    remove: vi.fn(),
  });
  it("processImage resizes at quality 0.7, deletes the source", async () => {
    const d = deps(1000);
    const r = await processImage(d, "file:///in.jpg", 5000);
    expect(d.manipulate).toHaveBeenCalledWith("file:///in.jpg", { height: 1600 }, 0.7);
    expect(r).toEqual({ uri: "file:///out.jpg", width: 1200, height: 1600, bytes: 1000 });
    expect(d.remove).toHaveBeenCalledWith("file:///in.jpg");
  });
  it("uses known size, skips resize for a small image", async () => {
    const d = deps(1000);
    await processImage(d, "file:///in.jpg", 5000, { width: 800, height: 600 });
    expect(d.getSize).not.toHaveBeenCalled();
    expect(d.manipulate).toHaveBeenCalledWith("file:///in.jpg", null, 0.7);
  });
  it("rejects over the cap and deletes both files", async () => {
    const d = deps(6000);
    await expect(processImage(d, "file:///in.jpg", 5000)).rejects.toThrow("too_large");
    expect(d.remove).toHaveBeenCalledWith("file:///out.jpg");
    expect(d.remove).toHaveBeenCalledWith("file:///in.jpg");
  });
  it("makeThumb is 320 px at quality 0.6", async () => {
    const d = deps(10);
    await makeThumb(d, img(1, 1200, 1600));
    expect(d.manipulate).toHaveBeenCalledWith("file:///t/1.jpg", { height: 320 }, 0.6);
  });
});

describe("pick", () => {
  const asset = { uri: "file:///p.jpg", width: 1, height: 1 };
  const deps = (granted: boolean): PickDeps & { camera: ReturnType<typeof vi.fn>; library: ReturnType<typeof vi.fn> } => ({
    library: vi.fn(async () => ({ canceled: false, assets: [asset, asset, asset] })),
    camera: vi.fn(async () => ({ canceled: false, assets: [asset] })),
    cameraPermission: vi.fn(async () => granted),
  });
  it("camera permission denied: no camera launch", async () => {
    const d = deps(false);
    expect(await pick(d, "camera", 2)).toEqual({ kind: "denied" });
    expect(d.camera).not.toHaveBeenCalled();
  });
  it("library never asks camera permission and obeys the slot limit", async () => {
    const d = deps(false);
    const r = await pick(d, "library", 2);
    expect(d.cameraPermission).not.toHaveBeenCalled();
    expect(d.library).toHaveBeenCalledWith(2);
    expect(r.kind === "ok" && r.assets.length).toBe(2);
  });
  it("camera granted, cancelled and no slots", async () => {
    expect((await pick(deps(true), "camera", 1)).kind).toBe("ok");
    const c = deps(true); c.camera.mockResolvedValueOnce({ canceled: true });
    expect(await pick(c, "camera", 1)).toEqual({ kind: "cancelled" });
    expect(await pick(deps(true), "library", 0)).toEqual({ kind: "cancelled" });
  });
});

describe("buildParts", () => {
  const meta = { ...context, kind: "bug" as const, text: "  hi " };
  it("orders meta, screenshot, photos, thumb with spec field names", () => {
    const parts = buildParts({ meta, screenshot: img(0), photos: [img(1), img(2)], thumb: img(9) });
    expect(parts.map(([k]) => k)).toEqual(["meta", "screenshot", "photo", "photo", "thumb"]);
    expect(JSON.parse(parts[0][1] as string)).toMatchObject({ ...context, kind: "bug", text: "hi" });
    expect(parts[2][1]).toEqual({ uri: "file:///t/1.jpg", name: "photo-1.jpg", type: "image/jpeg" });
  });
  it("omits absent parts and caps text", () => {
    const parts = buildParts({ meta: { ...meta, text: "a".repeat(5000) }, photos: [], maxText: 10 });
    expect(parts.map(([k]) => k)).toEqual(["meta"]);
    expect(JSON.parse(parts[0][1] as string).text).toHaveLength(10);
  });
});

describe("timeout and cleanup", () => {
  it("20 s plus 10 s per MB, capped at 90 s", () => {
    expect(sendTimeout(0)).toBe(20_000);
    expect(sendTimeout(1)).toBe(30_000);
    expect(sendTimeout(3 * 1024 * 1024)).toBe(50_000);
    expect(sendTimeout(100 * 1024 * 1024)).toBe(90_000);
  });
  it("cleanup removes every file and survives errors", () => {
    const rm = vi.fn((u: string) => { if (u === "b") throw new Error("gone"); });
    cleanup(["a", "b", "c"], rm);
    expect(rm.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
  });
});

describe("consent and device id", () => {
  it("stores consent once", async () => {
    const s = mem();
    expect(await hasConsent(s)).toBe(false);
    await giveConsent(s);
    expect(await hasConsent(s)).toBe(true);
    expect(s.m.get(CONSENT_KEY)).toBe("1");
  });
  it("creates the device id once", async () => {
    const s = mem();
    const a = await getDeviceId(s);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await getDeviceId(s, () => 0)).toBe(a);
  });
});

// A fake XMLHttpRequest. React Native's real one reads {uri, name, type} file parts natively and sends Content-Length; the
// global fetch of Expo SDK 53+ (expo/fetch) cannot serialise such a part and throws before any byte leaves the phone.
function fakeXhr(outcome: { status?: number; error?: boolean; hang?: boolean }) {
  const x = {
    headers: {} as Record<string, string>, body: undefined as unknown, opened: undefined as [string, string] | undefined,
    timeout: 0, status: 0,
    onload: null as null | (() => void), onerror: null as null | (() => void), ontimeout: null as null | (() => void), onabort: null as null | (() => void),
    open(m: string, u: string) { x.opened = [m, u]; },
    setRequestHeader(k: string, v: string) { x.headers[k] = v; },
    abort() { x.onabort?.(); },
    send(body: unknown) {
      x.body = body;
      if (outcome.hang) return;
      queueMicrotask(() => {
        if (outcome.error) return x.onerror?.();
        x.status = outcome.status ?? 201; x.onload?.();
      });
    },
  };
  return x;
}

describe("send", () => {
  const parts = [["meta", "{}"]] as Parameters<typeof send>[2];
  it("posts multipart to /api/submit with the key header and no content-type", async () => {
    const x = fakeXhr({ status: 201 });
    const r = await send("https://x.dev/", "k1", parts, 1000, () => x as never);
    expect(r).toEqual({ ok: true });
    expect(x.opened).toEqual(["POST", "https://x.dev/api/submit"]);
    expect(x.headers).toEqual({ "x-project-key": "k1" });
    expect(x.body).toBeInstanceOf(FormData);
    expect((x.body as FormData).get("meta")).toBe("{}");
    expect(x.timeout).toBe(1000);
  });
  it("never goes through the global fetch (expo/fetch cannot send {uri} file parts)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unsupported FormDataPart implementation"));
    try {
      expect(await send("https://x.dev", "k", parts, 1000, () => fakeXhr({ status: 201 }) as never)).toEqual({ ok: true });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it("fails on http error", async () => {
    expect(await send("https://x.dev", "k", parts, 1000, () => fakeXhr({ status: 429 }) as never)).toEqual({ ok: false, error: "http 429" });
  });
  it("fails on network error", async () => {
    expect(await send("https://x.dev", "k", parts, 1000, () => fakeXhr({ error: true }) as never)).toEqual({ ok: false, error: "network" });
  });
  it("times out", async () => {
    const x = fakeXhr({ hang: true });
    const p = send("https://x.dev", "k", parts, 10, () => x as never);
    await Promise.resolve();
    x.ontimeout?.();
    expect(await p).toEqual({ ok: false, error: "timeout" });
  });
});

describe("isShake", () => {
  it("ignores rest (1 g) and fires above the threshold", () => {
    expect(isShake({ x: 0, y: 0, z: 1 }, 10_000, 0)).toBe(false);
    expect(isShake({ x: 2, y: 1, z: 1 }, 10_000, 0)).toBe(true);
  });
  it("respects the cooldown", () => {
    expect(isShake({ x: 3, y: 0, z: 0 }, 1500, 0)).toBe(false);
    expect(isShake({ x: 3, y: 0, z: 0 }, 2000, 0)).toBe(true);
  });
});

describe("send headers", () => {
  it("sends X-Device-Id when a device id is known", async () => {
    const x = fakeXhr({ status: 201 });
    await send("https://x.dev", "k", [], 1000, () => x as never, "dev1");
    expect(x.headers["x-device-id"]).toBe("dev1");
    const y = fakeXhr({ status: 201 });
    await send("https://x.dev", "k", [], 1000, () => y as never);
    expect(y.headers["x-device-id"]).toBeUndefined();
  });
});

describe("floating button position", () => {
  // iPhone-like portrait window; touch box 44, gap 6, so y runs from 59 + 6 to 844 - 34 - 6 - 44.
  const win = { width: 390, height: 844 };
  const ins = toInsets({ top: 59, bottom: 34 });

  it("docks to the right edge and rests at 62% of the window height", () => {
    expect(initialFab(win, ins)).toEqual({ side: "right", y: 501 });
    expect(fabX("right", win, ins)).toBe(340);
    expect(fabX("left", win, ins)).toBe(6);
    expect(initialFab({ width: 360, height: 800 }, toInsets())).toEqual({ side: "right", y: 474 });
  });
  it("honours buttonPosition, then the deprecated buttonBottom, and clamps both", () => {
    expect(initialFab(win, ins, { buttonPosition: { side: "left", y: 300 }, buttonBottom: 96 })).toEqual({ side: "left", y: 300 });
    expect(initialFab(win, ins, { buttonBottom: 96 })).toEqual({ side: "right", y: 704 });
    expect(initialFab(win, ins, { buttonBottom: 0 })).toEqual({ side: "right", y: 760 });
    expect(initialFab(win, ins, { buttonPosition: { side: "left", y: Number.NaN } })).toEqual({ side: "left", y: 501 });
  });
  it("clamps y inside the safe area and respects side insets", () => {
    expect(clampFab({ side: "right", y: -50 }, win, ins)).toEqual({ side: "right", y: 65 });
    expect(clampFab({ side: "left", y: 9999 }, win, ins)).toEqual({ side: "left", y: 760 });
    expect(clampFab({ side: "left", y: 400.4 }, win, ins)).toEqual({ side: "left", y: 400 });
    expect(clampFab({ side: "left", y: 50 }, { width: 100, height: 100 }, ins)).toEqual({ side: "left", y: 65 }); // window smaller than the insets
    const land = { width: 844, height: 390 };
    const side = toInsets({ left: 47, right: 47, bottom: 21 });
    expect(fabX("left", land, side)).toBe(53);
    expect(fabX("right", land, side)).toBe(747);
    expect(clampFab({ side: "right", y: 999 }, land, side).y).toBe(319);
  });
  it("snaps to the nearest side from the release point; a tie goes right", () => {
    expect(snapFab(100, 400, win, ins)).toEqual({ side: "left", y: 400 });
    expect(snapFab(300, 400, win, ins)).toEqual({ side: "right", y: 400 });
    expect(snapFab(172, 400, win, ins).side).toBe("left");
    expect(snapFab(173, 400, win, ins).side).toBe("right");
    expect(snapFab(-80, 5000, win, ins)).toEqual({ side: "left", y: 760 });
    expect(snapFab(9999, -5, win, ins)).toEqual({ side: "right", y: 65 });
  });
  it("tells a tap from a drag by distance, not by axis", () => {
    expect(isDrag(0, 0)).toBe(false);
    expect(isDrag(0, 10)).toBe(false);
    expect(isDrag(6, 6)).toBe(false);
    expect(isDrag(0, -11)).toBe(true);
    expect(isDrag(8, 8)).toBe(true);
    expect(isDrag(3, 0, 2)).toBe(true);
  });
  it("round-trips a stored position and rejects anything else", () => {
    expect(parseFab(serializeFab({ side: "left", y: 123 }))).toEqual({ side: "left", y: 123 });
    for (const bad of [null, undefined, "", "x", "null", "[]", "{}", '{"side":"top","y":1}', '{"side":"left"}', '{"side":"left","y":"1"}', '{"side":"left","y":null}'])
      expect(parseFab(bad)).toBeNull();
    expect(parseFab('{"side":"right","y":-20,"extra":1}')).toEqual({ side: "right", y: -20 }); // clamped later, against the window
  });
  it("keeps a position that no longer fits when the window changes", () => {
    const stored = parseFab('{"side":"right","y":900}');
    expect(clampFab(stored!, win, ins).y).toBe(760);
    expect(clampFab(stored!, { width: 844, height: 390 }, toInsets({ bottom: 21 })).y).toBe(319);
  });
});
