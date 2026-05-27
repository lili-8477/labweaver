import { describe, it, expect } from "vitest";
import { extractDescription } from "../src/frontmatter.js";

describe("extractDescription", () => {
  it("returns the description from a leading YAML frontmatter block", () => {
    const manifest = "---\nname: foo\ndescription: A short summary\n---\n\nBody";
    expect(extractDescription(manifest)).toBe("A short summary");
  });

  it("strips surrounding single or double quotes", () => {
    const manifest = `---\ndescription: "Quoted text"\n---\n`;
    expect(extractDescription(manifest)).toBe("Quoted text");
  });

  it("returns empty string when there is no frontmatter", () => {
    expect(extractDescription("Just a body.\n")).toBe("");
  });

  it("returns empty string when the frontmatter lacks a description field", () => {
    expect(extractDescription("---\nname: foo\n---\n")).toBe("");
  });
});
