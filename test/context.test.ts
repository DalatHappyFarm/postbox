import { describe, expect, it } from "vitest";
import { cleanElement, cleanLogs } from "../lib/context.ts";
import { setup } from "./helpers.ts";

describe("cleanLogs", () => {
  it("keeps valid entries (newest 20), drops bad ones, cuts strings and normalises fields", () => {
    const good = { kind: "request", message: "Internal Server Error", method: "post", url: "https://shop.test/api/cart", status: 500, seconds_before: 3.4 };
    expect(cleanLogs([good, { kind: "error", message: "x".repeat(400), source: "https://shop.test/app.js:1:2", seconds_before: 0 }])).toEqual([
      { kind: "request", message: "Internal Server Error", method: "POST", url: "https://shop.test/api/cart", status: 500, seconds_before: 3 },
      { kind: "error", message: "x".repeat(300), source: "https://shop.test/app.js:1:2", seconds_before: 0 },
    ]);
    const bad = [null, 7, "x", { kind: "nope", message: "m", seconds_before: 1 }, { kind: "error", seconds_before: 1 }, { kind: "error", message: "m", seconds_before: -1 },
      { kind: "error", message: "m" }, { kind: "error", message: "  ", seconds_before: 1 }];
    expect(cleanLogs(bad)).toBeNull();
    expect(cleanLogs({ kind: "error" })).toBeNull();
    expect(cleanLogs([{ kind: "request", message: "", method: "GET<script>", status: 1000, seconds_before: 1e9 }])).toEqual([{ kind: "request", message: "", seconds_before: 86400 }]);
    const many = Array.from({ length: 30 }, (_, n) => ({ kind: "console", message: `m${n}`, seconds_before: 30 - n }));
    expect(cleanLogs(many)!.map((e) => e.message)).toEqual(Array.from({ length: 20 }, (_, n) => `m${n + 10}`));
  });
});

describe("cleanElement", () => {
  it("needs a selector; keeps the opening tag and the text, cut", () => {
    expect(cleanElement({ selector: " #pay ", html: "<button id=\"pay\">", text: "Thanh toán", rect: { x: 1 } })).toEqual({ selector: "#pay", html: "<button id=\"pay\">", text: "Thanh toán" });
    expect(cleanElement({ selector: "a".repeat(600) })!.selector).toHaveLength(500);
    for (const v of [null, "#pay", [], {}, { selector: 7 }, { selector: " " }]) expect(cleanElement(v)).toBeNull();
  });
});

describe("page context on submit", () => {
  it("stores the cleaned logs and element, shows them on the letter, not in the list; a bad value never refuses the letter", async () => {
    const t = await setup();
    const logs = [{ kind: "error", message: "TypeError: cart is undefined", source: "https://shop.test/app.js:12:5", seconds_before: 8 }, { kind: "bogus" }];
    const r = await t.submitForm({ text: "pay button", platform: "web", logs, element: { selector: "#pay", html: "<button id=\"pay\">", text: "Pay" } });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: number };
    const one = (await (await t.admin(`/api/feedback/${id}`)).json()) as any;
    expect(one.logs).toEqual([logs[0]]);
    expect(one.element).toEqual({ selector: "#pay", html: "<button id=\"pay\">", text: "Pay" });
    const list = (await (await t.admin("/api/feedback")).json()) as any;
    expect(list.items[0]).not.toHaveProperty("logs");
    const plain = (await (await t.submitForm({ text: "app letter", logs: "nope", element: 5 })).json()) as { id: number };
    expect(await (await t.admin(`/api/feedback/${plain.id}`)).json()).toMatchObject({ logs: null, element: null });
  });
});
