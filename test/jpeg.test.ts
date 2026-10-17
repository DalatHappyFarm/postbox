import { describe, expect, it } from "vitest";
import { stripJpeg } from "../lib/jpeg.ts";
import { exifSegment, jpeg } from "./helpers.ts";

const has = (b: Uint8Array, m: number) => b.some((x, i) => x === 0xff && b[i + 1] === m);

describe("stripJpeg", () => {
  it("drops APP1-APP15 and COM, keeps JFIF and all image segments", () => {
    const app13 = Uint8Array.from([0xff, 0xed, 0, 4, 1, 2]);
    const app15 = Uint8Array.from([0xff, 0xef, 0, 3, 9]);
    const com = Uint8Array.from([0xff, 0xfe, 0, 5, 0x68, 0x69, 0x21]);
    const clean = jpeg();
    const dirty = jpeg([exifSegment(), app13, com, app15]);
    expect(dirty.length).toBeGreaterThan(clean.length);
    const out = stripJpeg(dirty);
    expect(out).toEqual(clean);
    for (const m of [0xe1, 0xed, 0xef, 0xfe]) expect(has(out, m)).toBe(false);
    for (const m of [0xd8, 0xe0, 0xc0, 0xda, 0xd9]) expect(has(out, m)).toBe(true);
    expect([...out].join(",")).toContain("18,255,0,52"); // entropy data with the stuffed FF00 intact
  });
  it("drops anything after EOI", () => {
    expect(stripJpeg(jpeg([], [1, 2, 3, 0xff, 0xe1]))).toEqual(jpeg());
  });
  it("keeps segments that follow a scan (progressive files) and drops metadata between scans", () => {
    const base = jpeg();
    const eoi = base.length - 2;
    const second = [0xff, 0xe1, 0, 4, 5, 5, 0xff, 0xda, 0, 4, 0, 0, 0x77, 0xff, 0xd9];
    const dirty = Uint8Array.from([...base.subarray(0, eoi), ...second]);
    const out = stripJpeg(dirty);
    expect(has(out, 0xe1)).toBe(false);
    expect(out.length).toBe(dirty.length - 6);
  });
  it("rejects malformed input", () => {
    expect(() => stripJpeg(Uint8Array.from([1, 2, 3, 4]))).toThrow("invalid jpeg");
    expect(() => stripJpeg(jpeg().subarray(0, 20))).toThrow("invalid jpeg"); // truncated
    expect(() => stripJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toThrow("invalid jpeg"); // length past the end
    expect(() => stripJpeg(jpeg().subarray(0, jpeg().length - 2))).toThrow("invalid jpeg"); // no EOI
  });
});
