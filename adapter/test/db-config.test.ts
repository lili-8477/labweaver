import { describe, it, expect } from "vitest";
import { loadDbConfig } from "../src/db-config.js";

describe("loadDbConfig", () => {
  it("returns config when both PG_URL and USERNAME are set", () => {
    const cfg = loadDbConfig({ PG_URL: "postgres://u@h/d", USERNAME: "alice" });
    expect(cfg.pgUrl).toBe("postgres://u@h/d");
    expect(cfg.username).toBe("alice");
    expect(cfg.enabled).toBe(true);
  });

  it("returns enabled=false when PG_URL is missing", () => {
    const cfg = loadDbConfig({ USERNAME: "alice" });
    expect(cfg.enabled).toBe(false);
  });

  it("throws when PG_URL is set but USERNAME is missing", () => {
    expect(() => loadDbConfig({ PG_URL: "postgres://u@h/d" }))
      .toThrow(/USERNAME/);
  });

  it("rejects obviously-bogus usernames (path-traversal defense)", () => {
    expect(() => loadDbConfig({ PG_URL: "x", USERNAME: "../alice" }))
      .toThrow(/USERNAME/);
    expect(() => loadDbConfig({ PG_URL: "x", USERNAME: "" }))
      .toThrow(/USERNAME/);
  });
});
