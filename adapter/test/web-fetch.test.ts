import { describe, expect, it, vi } from "vitest";
import { fetchPage, isPublicAddress } from "../src/web-fetch.js";

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

describe("isPublicAddress", () => {
  it("refuses loopback, private, link-local and unique-local addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
      "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) expect(isPublicAddress(a), a).toBe(true);
  });
});

describe("fetchPage", () => {
  it("fetches a public page and names it by its content type", async () => {
    const fetchFn = vi.fn(async () => html("<html><title>Core</title></html>"));
    const page = await fetchPage("https://core.example.edu/services", { lookup: publicLookup, fetchFn });
    expect(page).toMatchObject({ url: "https://core.example.edu/services", ext: ".html" });
    expect(page.body.toString()).toContain("Core");
    expect((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses non-http schemes and hosts that resolve to internal addresses", async () => {
    await expect(fetchPage("file:///etc/passwd", { lookup: publicLookup, fetchFn: vi.fn() })).rejects.toThrow(/http/);
    const internal = vi.fn(async () => [{ address: "172.18.0.4", family: 4 }]);
    await expect(fetchPage("http://labweaver-dev-indexer:8400/memory/list", { lookup: internal, fetchFn: vi.fn() }))
      .rejects.toThrow(/internal address/);
  });

  it("checks every redirect hop, and stops after five", async () => {
    const lookup = vi.fn(async (host: string) =>
      [{ address: host === "evil.example.com" ? "127.0.0.1" : "93.184.216.34", family: 4 }]);
    const toInternal = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://evil.example.com/" } }));
    await expect(fetchPage("https://ok.example.com/", { lookup, fetchFn: toInternal })).rejects.toThrow(/internal address/);

    const loop = vi.fn(async () => new Response(null, { status: 301, headers: { location: "/again" } }));
    await expect(fetchPage("https://ok.example.com/", { lookup, fetchFn: loop })).rejects.toThrow(/redirects/);

    const once = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/final" } }))
      .mockResolvedValueOnce(html("done"));
    expect((await fetchPage("https://ok.example.com/start", { lookup, fetchFn: once })).url).toBe("https://ok.example.com/final");
  });

  it("refuses pages over the size cap and types it cannot read", async () => {
    const big = vi.fn(async () => html("x".repeat(2000)));
    await expect(fetchPage("https://ok.example.com/", { lookup: publicLookup, fetchFn: big, maxBytes: 1000 })).rejects.toThrow(/larger/);
    const image = vi.fn(async () => new Response("png", { headers: { "content-type": "image/png" } }));
    await expect(fetchPage("https://ok.example.com/a.png", { lookup: publicLookup, fetchFn: image })).rejects.toThrow(/image\/png/);
    const csv = vi.fn(async () => new Response("a,b\n1,2", { headers: { "content-type": "text/csv" } }));
    expect((await fetchPage("https://ok.example.com/x", { lookup: publicLookup, fetchFn: csv })).ext).toBe(".csv");
  });

  it("reports HTTP errors", async () => {
    const notFound = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(fetchPage("https://ok.example.com/", { lookup: publicLookup, fetchFn: notFound })).rejects.toThrow(/404/);
  });
});
