import { describe, expect, it } from "vitest";
import { withUser } from "../src/chpc-bridge-rpc.js";

const template = `# CHPC bridge — uncomment the Host stanza and fill in your UNID,
#
# Host chpc-login
#     HostName notchpeak.chpc.utah.edu
#     User <YOUR-UNID>
`;

describe("withUser", () => {
  it("adds a live stanza under the commented-out template", () => {
    const out = withUser(template, "u1234567");
    expect(out.startsWith(template)).toBe(true);
    expect(out).toMatch(/^Host chpc-login\n {4}HostName notchpeak\.chpc\.utah\.edu\n {4}User u1234567$/m);
    expect(out).toContain("ControlPersist 8h");
  });

  it("changes the User of an existing stanza and leaves other hosts alone", () => {
    const raw = "Host other\n    User keep\n\nHost chpc-login\n    HostName notchpeak.chpc.utah.edu\n    User u0000001\n";
    expect(withUser(raw, "u7654321")).toBe(raw.replace("u0000001", "u7654321"));
  });

  it("writes a stanza into an empty config", () => {
    expect(withUser("", "u1234567")).toMatch(/^Host chpc-login\n/);
  });
});
