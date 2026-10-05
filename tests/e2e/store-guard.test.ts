/** GIT-123: through the installed child_process guard, an unsandboxed gitmem call fails before it spawns. */
import { describe, it, expect } from "vitest";
import { execFile as execFileCb, execFileSync, spawn } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { join } from "path";

const BIN = join(__dirname, "../../bin/gitmem.js");

describe("e2e child-process store guard (GIT-123)", () => {
  it("execFileSync with the real HOME throws, and runs nothing", () => {
    expect(() => execFileSync("node", [BIN, "--version"], { env: { ...process.env, HOME: homedir(), GITMEM_DIR: "", GITMEM_HOME: "" } })).toThrow(/e2e store guard/);
  });

  it("promisified execFile with the real HOME rejects", async () => {
    await expect(promisify(execFileCb)("node", [BIN, "--version"], { env: { ...process.env, HOME: homedir(), GITMEM_DIR: "", GITMEM_HOME: "" } })).rejects.toThrow(/e2e store guard/);
  });

  it("spawn of the server with the real HOME throws", () => {
    expect(() => spawn("node", [join(__dirname, "../../dist/index.js")], { env: { ...process.env, HOME: homedir(), GITMEM_DIR: "" } })).toThrow(/e2e store guard/);
  });
});
