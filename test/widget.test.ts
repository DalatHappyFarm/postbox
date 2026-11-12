import { describe as group, expect, it } from "vitest";
import { buildMeta, cleanUrl, cssPath, DEFAULT_LIMITS, describe, errorKey, errText, logsForSend, openingTag, pushLog, shortName, FAB_REST, initialFab, isDrag, isStagingHost, normalizeScreen, pickLang, readLimits, resizeDims, sendTimeout, showButton, slotsLeft, snapFab, STRINGS, testerFlag } from "../public/widget/lib.js";

const UA = {
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  zalo: "Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36 Zalo android/12345 ZaloTheme/light",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  coccoc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) coc_coc_browser/130.0.0 Chrome/124.0.0.0 CocCoc/130.0.0 Safari/537.36",
};

group("web widget helpers", () => {
  it("shows the button on development, preview and staging hosts, or in tester mode", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "shop.localhost", "site.test", "mac.local", "192.168.1.20", "10.0.0.5", "172.20.1.1",
      "abc123.my-site.pages.dev", "my-site.vercel.app", "x.netlify.app", "api.me.workers.dev", "staging.example.com", "dev.example.com", "preview-42.example.com", "qa.shop.vn"])
      expect(isStagingHost(h), h).toBe(true);
    for (const h of ["example.com", "www.shop.vn", "developer.example.com", "testimonials.example.com", "172.32.0.1", "8.8.8.8", ""])
      expect(isStagingHost(h), h).toBe(false);
    expect(showButton("auto", "example.com", null)).toBe(false);
    expect(showButton("auto", "example.com", true)).toBe(true);
    expect(showButton(undefined, "localhost", null)).toBe(true);
    expect(showButton("never", "localhost", true)).toBe(false);
    expect(showButton("always", "example.com", false)).toBe(true);
  });

  it("hides the button for a tester who switched it off, on staging hosts too", () => {
    expect(showButton("auto", "localhost", false)).toBe(false);
    expect(showButton("auto", "staging.example.com", false)).toBe(false);
    expect(showButton(undefined, "localhost", undefined)).toBe(true);
  });

  it("turns tester mode on and off from ?feedback and keeps the stored value otherwise", () => {
    expect([testerFlag("?feedback", false), testerFlag("?a=1&feedback=1", false), testerFlag("?feedback=on", false)]).toEqual([true, true, true]);
    expect([testerFlag("?feedback=0", true), testerFlag("?feedback=off", true), testerFlag("?feedback=FALSE", true)]).toEqual([false, false, false]);
    expect([testerFlag("", true), testerFlag("?x=1", false), testerFlag(undefined, true)]).toEqual([true, false, true]);
    expect([testerFlag("", null), testerFlag("?x=1", undefined), testerFlag("?feedback=off", null)]).toEqual([null, null, false]);
  });

  it("tells a click from a drag and docks a dropped button to the nearest side at the same height", () => {
    expect([isDrag(0, 0), isDrag(6, 7), isDrag(8, 7), isDrag(0, -11)]).toEqual([false, false, true, true]);
    expect(snapFab(100, 300, 1000, 800)).toEqual({ side: "left", y: 0.375 });
    expect(snapFab(501, 300, 1000, 800)).toEqual({ side: "right", y: 0.375 });
    expect(snapFab(900, -40, 1000, 800)).toEqual({ side: "right", y: 0 });
    expect(snapFab(900, 900, 1000, 800)).toEqual({ side: "right", y: 1 });
    expect(snapFab(10, 123, 390, 844)).toEqual({ side: "left", y: 0.146 });
    expect(snapFab(10, 10, 390, 0)).toEqual({ side: "left", y: FAB_REST });
  });

  it("starts where the tester left the button, else on the data-position side at the default height", () => {
    expect(initialFab('{"side":"left","y":0.3}', undefined)).toEqual({ side: "left", y: 0.3 });
    expect(initialFab('{"side":"right","y":0.9}', "left")).toEqual({ side: "right", y: 0.9 });
    expect(initialFab(null, undefined)).toEqual({ side: "right", y: FAB_REST });
    expect(initialFab(null, "left")).toEqual({ side: "left", y: FAB_REST });
    for (const bad of ["", "nope", "null", "[]", '{"side":"top","y":0.5}', '{"side":"left","y":2}', '{"side":"left","y":"0.5"}', '{"side":"left"}'])
      expect(initialFab(bad, "left"), bad).toEqual({ side: "left", y: FAB_REST });
  });

  it("cleans the address: no credentials, secrets redacted, fragment only for #/ routes, no feedback switch", () => {
    expect(cleanUrl("https://user:pw@example.com/checkout?step=2&token=abc&utm_source=zalo#section")).toBe("https://example.com/checkout?step=2&token=redacted&utm_source=zalo");
    expect(cleanUrl("https://shop.vn/reset?email=a%40b.c&reset_code=9&apiKey=a&accessToken=b&X-Amz-Signature=s&promocode=SALE&keyword=ao")).toBe("https://shop.vn/reset?email=redacted&reset_code=redacted&apiKey=redacted&accessToken=redacted&X-Amz-Signature=redacted&promocode=SALE&keyword=ao");
    expect(cleanUrl("https://app.vn/?feedback&q=ao+dai")).toBe("https://app.vn/?q=ao+dai");
    expect(cleanUrl("https://app.vn/#/orders/12?access_token=x&tab=items")).toBe("https://app.vn/#/orders/12?access_token=redacted&tab=items");
    expect(cleanUrl("https://app.vn/#!/home")).toBe("https://app.vn/#!/home");
    expect(cleanUrl("https://app.vn/cb#access_token=secret&state=1")).toBe("https://app.vn/cb");
    expect(cleanUrl("not a url")).toBeNull();
    expect(cleanUrl("https://a.vn/" + "x".repeat(3000))!.length).toBe(2000);
  });

  it("names the screen after the path with ids folded, so letters group by page", () => {
    expect(normalizeScreen("/")).toBe("/");
    expect(normalizeScreen("/orders/12345/")).toBe("/orders/:id");
    expect(normalizeScreen("/u/3f2b8c1e-9d4a-4b7e-8c2d-1a2b3c4d5e6f/settings")).toBe("/u/:id/settings");
    expect(normalizeScreen("/p/65a1f0c2e4b0a1b2c3d4e5f6")).toBe("/p/:id");
    expect(normalizeScreen("/r/01HZX3J5K8M9N2P4Q6R7S8T9V0")).toBe("/r/:id");
    expect(normalizeScreen("/doc/aB3dE5fG7hJ9kL1mN3pQ")).toBe("/doc/:id");
    expect(normalizeScreen("/blog/top-10-homestay-da-lat-2024")).toBe("/blog/top-10-homestay-da-lat-2024");
    expect(normalizeScreen("/blog/deadline")).toBe("/blog/deadline");
    expect(normalizeScreen("/s%E1%BA%A3n-ph%E1%BA%A9m/ca-phe")).toBe("/sản-phẩm/ca-phe");
    expect(normalizeScreen("/bad%E0%A4%A")).toBe("/bad%E0%A4%A");
    expect(normalizeScreen("/app/", "#/orders/9?tab=1")).toBe("/app/orders/:id");
    expect(normalizeScreen("/", "#!/cart")).toBe("/cart");
    expect(normalizeScreen("/", "#reviews")).toBe("/");
    expect(normalizeScreen("/" + "a".repeat(300)).length).toBe(200);
  });

  it("describes the browser, viewport and OS from the user agent", () => {
    expect(describe(UA.macChrome, { w: 1440, h: 900, dpr: 2 })).toEqual({ device: "Chrome 130 · 1440x900 @2x", os: "macOS" });
    expect(describe(UA.macSafari, { w: 1280, h: 720, dpr: 1 })).toEqual({ device: "Safari 18.1 · 1280x720", os: "macOS" });
    expect(describe(UA.macSafari, { w: 1024, h: 1366, dpr: 2, touch: 5 }).os).toBe("iPadOS");
    expect(describe(UA.iphone, { w: 393, h: 852, dpr: 3 })).toEqual({ device: "Safari 18.1 · 393x852 @3x", os: "iOS 18.1" });
    expect(describe(UA.iphoneChrome, { w: 390, h: 844, dpr: 3 }).device).toBe("Chrome 130 · 390x844 @3x");
    expect(describe(UA.android, { w: 412, h: 915, dpr: 2.625 })).toEqual({ device: "Chrome 130 · 412x915 @2.63x", os: "Android 14" });
    expect(describe(UA.zalo, { w: 360, h: 780, dpr: 3 }).device).toBe("Chrome 129 (Zalo in-app) · 360x780 @3x");
    expect(describe(UA.edge, {})).toEqual({ device: "Edge 130", os: "Windows" });
    expect(describe(UA.firefox, {}).device).toBe("Firefox 132");
    expect(describe(UA.coccoc, {}).device).toBe("Coc Coc 130");
    expect(describe("curl/8", {})).toEqual({ device: "Browser", os: null });
  });

  it("builds a meta field that always fits the server limits", () => {
    const m = buildMeta({ kind: "bug", text: "  Nút Thanh toán không bấm được  ", screen: "/checkout", url: "https://shop.vn/checkout", device: "Chrome 130", os: "macOS", locale: "vi-VN", build: " ", app_version: undefined, device_id: "abc" });
    expect(m).toEqual({ kind: "bug", text: "Nút Thanh toán không bấm được", platform: "web", screen: "/checkout", url: "https://shop.vn/checkout", device: "Chrome 130", os: "macOS", locale: "vi-VN", device_id: "abc" });
    const long = buildMeta({ kind: "idea", text: "x".repeat(5000), screen: "s".repeat(500), build: "b".repeat(300) }, 4000);
    expect([long.text.length, long.screen.length, long.build.length]).toEqual([4000, 200, 200]);
  });

  it("maps failed sends to a message", () => {
    expect([errorKey(0, ""), errorKey(429, "rate limit exceeded"), errorKey(401, "invalid project key"), errorKey(403, "origin not allowed"), errorKey(413, "images too large together"), errorKey(413, "text too long"), errorKey(415, "invalid jpeg"), errorKey(400, "text is required"), errorKey(500, "x"), errorKey(400, "invalid kind")])
      .toEqual(["offline", "rate", "setup", "setup", "tooLarge", "textLong", "badImage", "empty", "server", "server"]);
    for (const lang of ["en", "vi"] as const) expect(STRINGS[lang].sentRef).toContain("#{id}");
    for (const lang of ["en", "vi"] as const) for (const k of ["offline", "rate", "setup", "tooLarge", "textLong", "badImage", "empty", "server"]) expect(STRINGS[lang].errors[k as keyof typeof STRINGS.en.errors], `${lang}.${k}`).toBeTruthy();
  });

  it("keeps both languages complete and picks one from data-lang, the page or the browser", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k]));
    expect(keys(STRINGS.vi).sort()).toEqual(keys(STRINGS.en).sort());
    expect([pickLang("vi", "en"), pickLang(undefined, "vi-VN"), pickLang("", "", ["vi", "en"]), pickLang(undefined, "en", ["vi"]), pickLang(undefined, undefined, [])]).toEqual(["vi", "vi", "vi", "en", "en"]);
  });

  it("follows the server limits, slots and send timeout like the React Native kit", () => {
    expect(readLimits({ max_attachments: 6, max_text: 0, max_image_bytes: "9" })).toEqual({ ...DEFAULT_LIMITS, max_attachments: 6 });
    expect(readLimits(null)).toEqual(DEFAULT_LIMITS);
    expect([slotsLeft(4, true, 0), slotsLeft(4, false, 0), slotsLeft(4, true, 3), slotsLeft(4, true, 5)]).toEqual([3, 4, 0, 0]);
    expect([sendTimeout(0), sendTimeout(1), sendTimeout(3 * 1024 * 1024), sendTimeout(100 * 1024 * 1024)]).toEqual([20_000, 30_000, 50_000, 90_000]);
    expect([resizeDims(3200, 1800), resizeDims(800, 600), resizeDims(1000, 4000, 320)]).toEqual([{ w: 1600, h: 900 }, { w: 800, h: 600 }, { w: 80, h: 320 }]);
  });

  it("records page errors as short lines, newest 20, with seconds before sending", () => {
    expect(errText(new TypeError("cart is undefined"))).toBe("TypeError: cart is undefined");
    expect(errText({ code: 7 })).toBe('{"code":7}');
    expect(errText("x".repeat(400))).toHaveLength(300);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(errText(cyclic)).toBe("[object Object]");
    const list: { at: number; n: number }[] = [];
    for (let n = 0; n < 25; n++) pushLog(list, { at: 1000 + n * 1000, n });
    expect(list.map((e) => e.n)).toEqual(Array.from({ length: 20 }, (_, n) => n + 5));
    expect(logsForSend([{ at: 1000, kind: "error", message: "m" }], 13_600)).toEqual([{ kind: "error", message: "m", seconds_before: 13 }]);
  });

  it("builds the shortest unique selector from tags, :nth-of-type and hand-written ids", () => {
    type N = { tagName: string; id?: string; parentElement: N | null; children: N[] };
    const node = (tagName: string, parent: N | null, id = ""): N => { const n: N = { tagName, id, parentElement: parent, children: [] }; parent?.children.push(n); return n; };
    const html = node("HTML", null), body = node("BODY", html), main = node("MAIN", body, "app");
    const sec1 = node("SECTION", main), sec2 = node("SECTION", main);
    node("BUTTON", sec1); const pay = node("BUTTON", sec2); const pay2 = node("BUTTON", sec2);
    const gen = node("DIV", body, ":r1:"), inGen = node("SPAN", gen);
    const counts: Record<string, number> = { button: 3, "button:nth-of-type(1)": 2, "section:nth-of-type(2) > button:nth-of-type(1)": 1, "button:nth-of-type(2)": 1, span: 1 };
    const count = (s: string) => counts[s] ?? 0;
    expect(cssPath(pay, count)).toBe("section:nth-of-type(2) > button:nth-of-type(1)");
    expect(cssPath(pay2, count)).toBe("button:nth-of-type(2)");
    expect(cssPath(inGen, count)).toBe("span");
    expect(cssPath(pay, () => 2)).toBe("body > #app > section:nth-of-type(2) > button:nth-of-type(1)"); // never unique: the whole path
    expect(cssPath(inGen, () => 2)).toBe("body > div > span"); // a generated id (:r1:) is not used
  });

  it("describes the element with safe attributes only, never a value", () => {
    expect(openingTag("BUTTON", [["class", "btn  primary"], ["value", "4111 1111"], ["type", "submit"], ["onclick", "pay()"], ["data-testid", "pay"], ["aria-label", 'say "hi"']]))
      .toBe('<button class="btn primary" type="submit" data-testid="pay" aria-label="say &quot;hi&quot;">');
    expect(openingTag("INPUT", [["name", "email"], ["value", "a@b.c"], ["type", "email"]])).toBe('<input name="email" type="email">');
    expect(shortName("BUTTON", "", ["btn", "primary", "big"])).toBe("button.btn.primary");
    expect(shortName("DIV", "cart", ["x"])).toBe("#cart");
    expect(shortName("DIV", ":r2:", ["hover:bg-red", "card"])).toBe("div.card");
  });
});
