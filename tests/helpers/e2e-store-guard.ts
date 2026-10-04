/**
 * GIT-123: no e2e test may run a gitmem process whose store is the developer's.
 *
 * `uninstall --all` deletes the store, and the server and `init` write to it, at
 * GITMEM_DIR, else (GITMEM_HOME || HOME)/.gitmem (bin/gitmem-root.js,
 * src/services/gitmem-dir.ts). A test that spawns one of them without
 * overriding those variables acts on the real ~/.gitmem. On 2026-10-04 that
 * deleted a developer's store. CI runners are ephemeral, which is why it only
 * showed on a real machine.
 *
 * The guard resolves the store root a child would see and refuses unless it is
 * under os.tmpdir(). It is installed for every e2e worker by
 * tests/e2e/setup-store-guard.ts, and createMcpClient calls it directly.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Env = Record<string, string | undefined>;

/** The store root a gitmem process started with this env would use. */
export function effectiveStoreRoot(env: Env): string | null {
  if (env.GITMEM_DIR) return env.GITMEM_DIR;
  const base = env.GITMEM_HOME || env.HOME;
  return base ? path.join(base, ".gitmem") : null;
}

/** realpath of the deepest existing ancestor, so /var/folders and /private/var compare equal. */
function resolveReal(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

export function isUnderTmpdir(p: string): boolean {
  const tmp = resolveReal(os.tmpdir());
  const target = resolveReal(p);
  return target === tmp || target.startsWith(tmp + path.sep);
}

const GITMEM_ARG = /(^|[\\/])bin[\\/]gitmem\.js$|(^|[\\/])dist[\\/]index\.js$|gitmem-mcp/;

/** Is this command a gitmem CLI or server (as opposed to git, bash, ...)? */
export function isGitmemInvocation(command: string, args: readonly string[]): boolean {
  return GITMEM_ARG.test(command) || /(^|[\\/])gitmem$/.test(command) || args.some((a) => GITMEM_ARG.test(a));
}

/** Throws unless the store this gitmem process would use is under os.tmpdir(). */
export function assertSandboxedStore(command: string, args: readonly string[], env: Env | undefined): void {
  if (!isGitmemInvocation(command, args)) return;
  const root = effectiveStoreRoot(env ?? process.env);
  if (root && isUnderTmpdir(root)) return;
  throw new Error(
    `[e2e store guard] refusing to run "${path.basename(command)} ${args.map((a) => path.basename(String(a))).join(" ")}": ` +
      `its store would be ${root ?? "(no HOME, GITMEM_HOME or GITMEM_DIR)"}, which is not under ${os.tmpdir()}. ` +
      `Pass a sandbox HOME, GITMEM_HOME and GITMEM_DIR in the env (GIT-123).`
  );
}
