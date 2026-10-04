/**
 * GIT-123: applies the e2e store guard to every child process an e2e test
 * starts, whatever helper it uses to start it.
 */

import cp from "child_process";
import { syncBuiltinESMExports } from "module";
import { promisify } from "util";
import { assertSandboxedStore } from "../helpers/e2e-store-guard.js";

type AnyFn = (...a: any[]) => any;

/** Split spawn-style arguments into command, args, env. */
function parts(kind: "spawn" | "exec" | "fork", a: any[]): { command: string; args: string[]; env?: Record<string, string> } {
  const args = Array.isArray(a[1]) ? (a[1] as string[]) : [];
  const options = [a[1], a[2], a[3]].find((x) => x && typeof x === "object" && !Array.isArray(x));
  const env = options?.env;
  if (kind === "fork") return { command: process.execPath, args: [String(a[0]), ...args], env };
  if (kind === "exec") return { command: String(a[0]), args: [], env };
  return { command: String(a[0]), args, env };
}

function guarded(name: string, kind: "spawn" | "exec" | "fork"): void {
  const original = (cp as any)[name] as AnyFn;
  const check = (a: any[]) => {
    const { command, args, env } = parts(kind, a);
    // exec/execSync take one command string: match on the whole string.
    assertSandboxedStore(kind === "exec" ? "gitmem-shell" : command, kind === "exec" ? [command] : args, env);
  };
  const wrapped: AnyFn = (...a) => { check(a); return original(...a); };
  const custom = (original as any)[promisify.custom];
  if (custom) (wrapped as any)[promisify.custom] = (...a: any[]) => {
    try { check(a); } catch (e) { return Promise.reject(e); }
    return custom(...a);
  };
  (cp as any)[name] = wrapped;
}

for (const n of ["spawn", "spawnSync", "execFile", "execFileSync"]) guarded(n, "spawn");
for (const n of ["exec", "execSync"]) guarded(n, "exec");
guarded("fork", "fork");
syncBuiltinESMExports();
