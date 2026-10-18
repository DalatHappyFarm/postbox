// Fills a `demo` mailbox with 120 neutral letters through the admin API, so the dashboard can be judged at the scale it is built for.
// usage: node scripts/seed-demo.ts --yes [--url https://x.pages.dev] [--token ...]   (or POSTBOX_URL and POSTBOX_TOKEN)
// Deterministic (fixed seed). Never prints the token. Photos are generated here: PNG phone-like screens and blocky grayscale JPEGs.
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const COUNT = 120;
const SLUG = "demo";

// ---- images made in code ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const be32 = (n: number) => Uint8Array.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** RGB PNG; `px(x, y)` returns [r, g, b]. */
export function makePng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * (1 + w * 3) + 1 + x * 3);
  const chunk = (type: string, data: Uint8Array) => { const t = new TextEncoder().encode(type); return cat(be32(data.length), t, data, be32(crc32(cat(t, data)))); };
  return cat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", cat(be32(w), be32(h), Uint8Array.from([8, 2, 0, 0, 0]))), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()));
}

// Baseline grayscale JPEG whose 8x8 blocks are flat (DC only): standard luminance DC Huffman table, quantiser 8, EOB for every block.
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CODES = (() => { const out: [number, number][] = []; let code = 0, k = 0; DC_BITS.forEach((n, i) => { for (let j = 0; j < n; j++) out[DC_VALS[k++]] = [code++, i + 1]; code <<= 1; }); return out; })();

/** `shade(bx, by)` gives 0..255 per 8x8 block. */
export function makeJpeg(w: number, h: number, shade: (bx: number, by: number) => number): Uint8Array {
  const seg = (m: number, body: number[]) => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  const bw = Math.ceil(w / 8), bh = Math.ceil(h / 8);
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  let prev = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const dc = Math.max(0, Math.min(255, Math.round(shade(bx, by)))) - 128; // DC = 8 * (v - 128), divided by quantiser 8
    const diff = dc - prev; prev = dc;
    const cat = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
    put(...DC_CODES[cat]);
    if (cat) put(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
    put(0b1010, 4); // AC end of block (standard luminance AC table: EOB is 1010)
  }
  while (bits.length % 8) bits.push(1);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) { const b = parseInt(bits.slice(i, i + 8).join(""), 2); data.push(b); if (b === 0xff) data.push(0); }
  // The standard luminance AC table (its code for EOB, symbol 0x00, is 1010).
  const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
  const AC_VALS = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xdb, [0, ...new Array(64).fill(8)]),
    ...seg(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
    ...seg(0xc4, [0x00, ...DC_BITS, ...DC_VALS]),
    ...seg(0xc4, [0x10, ...AC_BITS, ...AC_VALS]),
    ...seg(0xda, [1, 1, 0x00, 0, 63, 0]),
    ...data,
    0xff, 0xd9,
  ]);
}

// ---- deterministic data ----
function rng(seed: number) { return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const SCREENS = ["Home", "Search", "Cart", "Checkout", "Profile", "Settings", "Onboarding", "Orders", "Notifications", "Help"];
const BUILDS = ["41", "42", "43"];
const LABELS = ["ui", "crash", "perf", "copy", "a11y", "login", "payments", "layout", "dark-mode"];
const BUGS = ["button does nothing when tapped", "text is cut off on small phones", "app freezes for a few seconds", "wrong date format shown", "keyboard hides the input field", "image does not load on slow network", "back gesture closes the app", "list jumps back to the top", "badge count is out of date", "spinner never stops"];
const IDEAS = ["add a way to undo the last action", "show a short tour the first time", "let me sort this list by date", "remember my last choice", "add a dark theme toggle here", "offer a share button", "show how much is left at a glance"];
const OTHER = ["this wording is confusing", "I could not find where to change this", "the colours feel too bright at night", "great flow, one small thing felt slow"];
const NOTES = ["Fix in the shared component, add a test, keep the layout unchanged.", "Reproduce on the smallest supported phone first; acceptance: nothing is clipped at 320 px.", "Root cause first; acceptance: no freeze above 200 ms in the profile.", "Copy change only; use the wording in the letter."];

type Plan = { kind: "bug" | "idea" | "other"; text: string; screen: string | null; build: string; platform: string; photos: number; priority: number | null; labels: string[]; status: string; note: string | null; dupOf: number | null };

export function plan(n = COUNT): Plan[] {
  const r = rng(20261017);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const out: Plan[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    const kind = x < 0.6 ? "bug" : x < 0.85 ? "idea" : "other";
    const screen = r() < 0.08 ? null : pick(SCREENS);
    const body = pick(kind === "bug" ? BUGS : kind === "idea" ? IDEAS : OTHER);
    const text = `${screen ? screen + ": " : ""}${body}${r() < 0.3 ? `.\nHappens ${pick(["every time", "after an update", "only on wifi", "now and then"])}.` : ""}`;
    const s = r();
    const status = s < 0.6 ? "new" : s < 0.75 ? "ready" : s < 0.83 ? "doing" : s < 0.93 ? "done" : "wont_fix";
    const labels = [...new Set(Array.from({ length: Math.floor(r() * 3) }, () => pick(LABELS)))];
    out.push({
      kind, text, screen, build: pick(BUILDS), platform: pick(["ios", "android"]), photos: r() < 0.5 ? 1 + Math.floor(r() * 3 * r()) : 0,
      priority: r() < 0.35 ? null : Math.floor(r() * r() * 4), labels, status,
      note: status === "ready" || status === "doing" || status === "done" ? pick(NOTES) : null, dupOf: null,
    });
  }
  // about 10 duplicates: copies of earlier letters (never of a duplicate), reworded a little, pointing at the original.
  for (let k = 0; k < Math.round(n / 12); k++) {
    const at = 20 + Math.floor((k * (n - 25)) / Math.round(n / 12));
    const orig = out.slice(0, at).map((p, i) => [p, i] as const).filter(([p]) => p.dupOf === null && p.kind === "bug" && p.status === "new");
    const [o, oi] = orig[Math.floor(r() * orig.length)];
    out[at] = { ...o, text: o.text.split("\n")[0] + " (same here, build " + pick(BUILDS) + ")", status: "duplicate", note: null, priority: null, labels: [], photos: r() < 0.5 ? 1 : 0, dupOf: oi };
  }
  return out;
}

function photo(i: number, n: number): { bytes: Uint8Array; name: string; type: string } {
  if ((i + n) % 2 === 0) {
    const hue = (i * 47 + n * 90) % 360;
    const col = (l: number): [number, number, number] => { const k = (v: number) => { const a = (hue / 60 + v) % 6; return Math.round(255 * l * (1 - Math.max(0, Math.min(a, 4 - a, 1)) * 0.6)); }; return [k(0), k(4), k(2)]; };
    // A phone screenshot at a real size (720 x 1560, a 3x screen at half scale): bar, cards, tab bar, so the viewer is judged on real proportions.
    const w = 720, h = 1560;
    return { bytes: makePng(w, h, (x, y) => (y < 112 ? col(0.45) : y > h - 136 ? [235, 235, 238] : (y - 112) % 320 < 248 && x > 40 && x < w - 40 ? [250, 250, 252] : col(0.95))), name: `s${i}-${n}.png`, type: "image/png" };
  }
  return { bytes: makeJpeg(1200, 800, (bx, by) => 60 + ((bx * 7 + by * 11 + i * 13 + n * 40) % 160)), name: `p${i}-${n}.jpg`, type: "image/jpeg" };
}

// ---- run ----
export type SeedOpts = { url: string; token: string; fetch?: typeof fetch; log?: (s: string) => void; count?: number };

export async function seed({ url, token, fetch: f = fetch, log = () => {}, count = COUNT }: SeedOpts) {
  const base = url.replace(/\/+$/, "");
  const call = async (path: string, init: RequestInit = {}, okStatus: number[] = [200, 201]) => {
    const res = await f(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}) } });
    if (!okStatus.includes(res.status)) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? ""}`);
    return res;
  };
  await call("/api/projects", { method: "POST", body: JSON.stringify({ slug: SLUG, name: "Demo App" }) }, [201, 409]);
  const plans = plan(count);
  const ids: number[] = [];
  const created = new Date().toISOString();
  for (const [i, p] of plans.entries()) {
    const form = new FormData();
    form.set("meta", JSON.stringify({ project: SLUG, kind: p.kind, text: p.text, screen: p.screen, build: p.build, app_version: `1.${p.build}.0`, platform: p.platform, device: p.platform === "ios" ? "iPhone 15" : "Pixel 8", os: p.platform === "ios" ? "iOS 19" : "Android 16", locale: "en-US" }));
    for (let n = 0; n < p.photos; n++) { const ph = photo(i, n); form.append("photo", new File([ph.bytes as BlobPart], ph.name, { type: ph.type })); }
    ids.push(((await (await call("/api/feedback", { method: "POST", body: form })).json()) as { id: number }).id);
    if ((i + 1) % 20 === 0) log(`added ${i + 1}/${count}`);
  }
  // decisions, 6 at a time
  const jobs = plans.map((p, i) => async () => {
    const patch = p.dupOf !== null ? { duplicate_of: ids[p.dupOf] } : { status: p.status, priority: p.priority, labels: p.labels, ...(p.note ? { note: p.note } : {}) };
    await call(`/api/feedback/${ids[i]}`, { method: "PATCH", body: JSON.stringify(patch) });
  });
  for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map((j) => j()));
  log(`done at ${created}`);
  return { count: ids.length, ids, withPhotos: plans.filter((p) => p.photos).length, duplicates: plans.filter((p) => p.dupOf !== null).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { url: { type: "string" }, token: { type: "string" }, yes: { type: "boolean" } } });
  const url = values.url ?? process.env.POSTBOX_URL;
  const token = values.token ?? process.env.POSTBOX_TOKEN;
  if (!url || !token) { console.error("set POSTBOX_URL and POSTBOX_TOKEN (or --url and --token)"); process.exit(1); }
  if (!values.yes) { console.error(`this adds ${COUNT} letters to the "${SLUG}" mailbox at ${new URL(url).origin}; run again with --yes to confirm`); process.exit(1); }
  const r = await seed({ url, token, log: (s) => console.log(s) });
  console.log(`seeded ${r.count} letters (${r.withPhotos} with photos, ${r.duplicates} duplicates) into "${SLUG}"`);
}
