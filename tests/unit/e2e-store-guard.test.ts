/** GIT-123: the e2e store guard refuses any gitmem process whose store is not under os.tmpdir(). */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assertSandboxedStore, effectiveStoreRoot, isGitmemInvocation } from "../helpers/e2e-store-guard.js";

const BIN = "/repo/bin/gitmem.js";
const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-guard-"));

describe("e2e store guard (GIT-123)", () => {
  it("refuses the CLI when HOME is the developer's", () => {
    expect(() => assertSandboxedStore("node", [BIN, "uninstall", "--all"], { HOME: os.homedir() })).toThrow(/not under/);
  });

  it("refuses when GITMEM_HOME points outside tmp", () => {
    expect(() => assertSandboxedStore("node", [BIN], { HOME: sandbox(), GITMEM_HOME: os.homedir() })).toThrow(/e2e store guard/);
  });

  it("refuses when GITMEM_DIR points outside tmp, even with a sandbox HOME", () => {
    expect(() => assertSandboxedStore("node", [BIN], { HOME: sandbox(), GITMEM_DIR: path.join(os.homedir(), ".gitmem") })).toThrow();
  });

  it("refuses the server (dist/index.js) the same way", () => {
    expect(() => assertSandboxedStore("node", ["/repo/dist/index.js"], { HOME: os.homedir() })).toThrow();
  });

  it("refuses when no store root can be derived", () => {
    expect(() => assertSandboxedStore("node", [BIN], {})).toThrow(/no HOME/);
  });

  it("allows a sandbox HOME under tmpdir, including one that does not exist yet", () => {
    const home = sandbox();
    expect(() => assertSandboxedStore("node", [BIN], { HOME: home })).not.toThrow();
    expect(() => assertSandboxedStore("node", [BIN], { HOME: path.join(home, "not", "yet") })).not.toThrow();
  });

  it("allows an explicit GITMEM_DIR under tmpdir; GITMEM_DIR wins over HOME", () => {
    const dir = sandbox();
    expect(effectiveStoreRoot({ GITMEM_DIR: dir, HOME: os.homedir() })).toBe(dir);
    expect(() => assertSandboxedStore("node", [BIN], { GITMEM_DIR: dir, HOME: os.homedir() })).not.toThrow();
  });

  it("an empty GITMEM_DIR/GITMEM_HOME falls through to HOME, as the CLI does", () => {
    expect(effectiveStoreRoot({ GITMEM_DIR: "", GITMEM_HOME: "", HOME: "/h" })).toBe(path.join("/h", ".gitmem"));
  });

  it("does not touch commands that are not gitmem", () => {
    expect(isGitmemInvocation("git", ["init"])).toBe(false);
    expect(() => assertSandboxedStore("git", ["init"], { HOME: os.homedir() })).not.toThrow();
  });
});
