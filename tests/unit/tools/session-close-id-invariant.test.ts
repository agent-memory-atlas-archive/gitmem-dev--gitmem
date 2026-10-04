/**
 * GIT-122: an explicit session_id is either the session that gets closed, or
 * the call is refused. A close never lands on a different session's row, never
 * silently overwrites an already-closed session, and never merges another
 * session's closing-payload.json.
 *
 * Incident 2026-10-04: Brain closed 279cb65a through a process bound to CLI's
 * already-closed ed6b400e. COMPLETE was reported, ed6b400e's close_compliance was
 * overwritten, and 279cb65a stayed open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = vi.hoisted(() => ({ dir: "" }));
const live = vi.hoisted(() => ({ list: (..._a: unknown[]): unknown[] => [] }));
const store = vi.hoisted(() => ({ rows: {} as Record<string, Record<string, unknown>>, upserts: [] as Record<string, unknown>[] }));
const bound = vi.hoisted(() => ({ id: null as string | null }));

// Mock dependencies before importing session-close
vi.mock("../../../src/services/agent-detection.js", () => ({
  detectAgent: () => ({ agent: "CLI", entrypoint: "cli", docker: true, hostname: "test" }),
}));

vi.mock("../../../src/services/supabase-client.js", () => ({
  listRecords: vi.fn().mockResolvedValue([]),
  getRecord: vi.fn().mockImplementation(async (_t: string, id: string) => store.rows[id] ?? null),
  directUpsert: vi.fn().mockImplementation(async (_t: string, row: Record<string, unknown>) => { store.upserts.push(row); }),
  directPatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/services/embedding.js", () => ({
  embed: vi.fn().mockResolvedValue(null),
  isEmbeddingAvailable: () => false,
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: () => true,
  hasBatchOperations: () => false,
  hasTranscripts: () => false,
  hasCacheManagement: () => false,
  getTableName: (base: string) => `orchestra_${base}`,
  hasProInsights: () => false,
}));

vi.mock("../../../src/services/analytics.js", () => ({
  queryScarUsageByDateRange: vi.fn().mockResolvedValue([]),
  enrichScarUsageTitles: vi.fn().mockResolvedValue([]),
  formatBlindspotSnippet: vi.fn().mockReturnValue(null),
  querySessionsByDateRange: vi.fn().mockResolvedValue([]),
  computeLightweightSummary: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../src/services/storage.js", () => ({
  getStorage: () => ({
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../src/services/session-state.js", () => ({
  clearCurrentSession: vi.fn(),
  getSurfacedScars: () => [],
  getObservations: () => [],
  getChildren: () => [],
  getThreads: () => [],
  getSessionActivity: () => null,
  isRecallCalled: () => true,
  getConfirmations: () => [],
  resolveCurrentSession: () => (bound.id ? { sessionId: bound.id, surfacedScars: [], recallCalled: true } : null),
}));

vi.mock("../../../src/services/thread-manager.js", () => ({
  normalizeThreads: vi.fn().mockReturnValue([]),
  mergeThreadStates: vi.fn().mockReturnValue([]),
  migrateStringThread: vi.fn().mockReturnValue({ id: "t-test", text: "test", status: "open", created_at: new Date().toISOString() }),
  saveThreadsFile: vi.fn(),
}));

vi.mock("../../../src/services/thread-dedup.js", () => ({
  deduplicateThreadList: vi.fn().mockImplementation((threads) => threads),
}));

vi.mock("../../../src/services/thread-supabase.js", () => ({
  syncThreadsToSupabase: vi.fn().mockResolvedValue(undefined),
  loadOpenThreadEmbeddings: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/services/compliance-validator.js", () => ({
  validateSessionClose: () => ({ valid: true, errors: [], warnings: [] }),
  buildCloseCompliance: vi.fn().mockReturnValue({
    close_type: "quick",
    agent: "CLI",
    checklist_displayed: true,
    questions_answered_by_agent: false,
    human_asked_for_corrections: false,
    learnings_stored: 0,
    scars_applied: 0,
  }),
}));

vi.mock("../../../src/services/metrics.js", () => ({
  Timer: class { stop() { return 100; } },
  recordMetrics: vi.fn().mockResolvedValue(undefined),
  buildPerformanceData: (name: string, latency: number, count: number) => ({
    latency_ms: latency,
    target_ms: 3000,
    meets_target: latency < 3000,
    result_count: count,
  }),
  updateRelevanceData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/tools/record-scar-usage-batch.js", () => ({
  recordScarUsageBatch: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: () => ({
    track: vi.fn(),
    formatSummary: () => "No tracked effects this session.",
    getHealthReport: () => ({ overall: { attempted: 0, succeeded: 0, failed: 0, successRate: "N/A", paths_with_failures: [] }, byPath: {}, recentFailures: [] }),
  }),
}));

vi.mock("../../../src/tools/save-transcript.js", () => ({
  saveTranscript: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("../../../src/services/transcript-chunker.js", () => ({
  processTranscript: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemPath: (filename: string) => `${root.dir}/${filename}`,
  getGitmemDir: () => root.dir,
  getSessionPath: (sid: string, filename: string) => `${root.dir}/sessions/${sid}/${filename}`,
  getSessionDir: (sid: string) => `${root.dir}/sessions/${sid}`,
}));

vi.mock("../../../src/services/active-sessions.js", () => ({
  unregisterSession: vi.fn(),
  findSessionByHostPid: vi.fn().mockReturnValue(null),
  findSessionById: vi.fn().mockReturnValue(null), // GIT-86: session-close's registry fallback looks up by id
  listActiveSessions: (...a: unknown[]) => live.list(...a),
}));

vi.mock("../../../src/services/thread-suggestions.js", () => ({
  loadSuggestions: vi.fn().mockReturnValue([]),
  saveSuggestions: vi.fn(),
  detectSuggestedThreads: vi.fn().mockReturnValue([]),
  loadRecentSessionEmbeddings: vi.fn().mockResolvedValue(null),
}));

import { sessionClose } from "../../../src/tools/session-close.js";

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const REFLECTION = { what_broke: "x", what_took_longer: "x", do_differently: "x", what_worked: "y", wrong_assumption: "x", scars_applied: [] };
const reflection = (tag: string) => ({ ...REFLECTION, what_worked: tag });
const sessionDir = (id: string) => path.join(root.dir, "sessions", id);
const writePayload = (file: string, body: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
};
const open = (id: string) => ({ id, agent: "cli", project: "gitmem", session_date: "2026-10-04" });
const closed = (id: string) => ({ ...open(id), close_compliance: { close_type: "standard", agent: "cli" } });
const written = () => store.upserts.map((r) => r.id);

beforeEach(() => {
  vi.clearAllMocks();
  root.dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitmem-git122-"));
  store.rows = {};
  store.upserts = [];
  bound.id = null;
  live.list = () => [];
});

afterEach(() => {
  fs.rmSync(root.dir, { recursive: true, force: true });
});

describe("session_close identity invariant (GIT-122)", () => {
  it("explicit id A + payload file carrying B's identity: refused, nothing written", async () => {
    store.rows[A] = open(A);
    store.rows[B] = open(B);
    bound.id = B;
    writePayload(path.join(root.dir, "closing-payload.json"), { session_id: B, closing_reflection: reflection("B-reflection") });

    const result = await sessionClose({ session_id: A, close_type: "standard" });

    expect(result.success).toBe(false);
    expect(result.validation_errors!.join(" ")).toContain(A.slice(0, 8));
    expect(result.validation_errors!.join(" ")).toContain(B.slice(0, 8));
    expect(written()).toEqual([]);
  });

  it("per-session payload carrying another session's id: refused, nothing written", async () => {
    store.rows[A] = open(A);
    writePayload(path.join(sessionDir(A), "closing-payload.json"), { session_id: B, closing_reflection: reflection("B-reflection") });

    const result = await sessionClose({ session_id: A, close_type: "standard", closing_reflection: reflection("A-inline") });

    expect(result.success).toBe(false);
    expect(written()).toEqual([]);
  });

  it("explicit id of an already-closed session: refused, row untouched", async () => {
    store.rows[A] = closed(A);

    const result = await sessionClose({ session_id: A, close_type: "quick" });

    expect(result.success).toBe(false);
    expect(result.validation_errors!.join(" ")).toMatch(/already closed/i);
    expect(result.validation_errors!.join(" ")).toContain("reclose");
    expect(written()).toEqual([]);
  });

  it("reclose: true is the explicit way to close it again, and lands on that row", async () => {
    store.rows[A] = closed(A);

    const result = await sessionClose({ session_id: A, close_type: "quick", reclose: true });

    expect(written()).toEqual([A]);
    expect(result.session_id).toBe(A);
  });

  it("a partial-persist close can be retried without reclose", async () => {
    store.rows[A] = { ...open(A), close_compliance: { close_type: "standard", agent: "cli", partial_persist: true } };

    await sessionClose({ session_id: A, close_type: "quick" });

    expect(written()).toEqual([A]);
  });

  it("no id with two live sessions: refused, names both, writes nothing", async () => {
    store.rows[A] = open(A);
    store.rows[B] = open(B);
    bound.id = B;
    live.list = () => [{ session_id: A }, { session_id: B }];

    const result = await sessionClose({ close_type: "quick" });

    expect(result.success).toBe(false);
    expect(result.validation_errors!.join(" ")).toContain(A.slice(0, 8));
    expect(result.validation_errors!.join(" ")).toContain(B.slice(0, 8));
    expect(written()).toEqual([]);
  });

  it("no id with exactly one live session still recovers it", async () => {
    store.rows[B] = open(B);
    bound.id = B;
    live.list = () => [{ session_id: B }];

    await sessionClose({ close_type: "quick" });

    expect(written()).toEqual([B]);
  });

  it("explicit id A closes A even when the process is bound to B", async () => {
    store.rows[A] = open(A);
    store.rows[B] = open(B);
    bound.id = B;

    const result = await sessionClose({ session_id: A, close_type: "quick" });

    expect(written()).toEqual([A]);
    expect(result.session_id).toBe(A);
  });

  it("result and display show the full id actually written", async () => {
    store.rows[A] = open(A);

    const result = await sessionClose({ session_id: A, close_type: "quick" });

    expect(result.session_id).toBe(A);
    expect(result.display).toContain(A);
  });

  it("logs the raw incoming session_id to stderr on entry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    store.rows[A] = open(A);

    await sessionClose({ session_id: A, close_type: "quick" });

    expect(err.mock.calls.map((c) => String(c[0]))).toContain(`[session_close] incoming session_id=${A}`);
    err.mockRestore();
  });
});

describe("closing payload is scoped per session (GIT-122)", () => {
  it("reads <sessions>/<id>/closing-payload.json", async () => {
    store.rows[A] = open(A);
    writePayload(path.join(sessionDir(A), "closing-payload.json"), { closing_reflection: reflection("A-reflection") });

    await sessionClose({ session_id: A, close_type: "standard" });

    expect(written()).toEqual([A]);
    expect(JSON.stringify(store.upserts[0])).toContain("A-reflection");
  });

  it("B's payload is untouched and B stays open when A closes", async () => {
    store.rows[A] = open(A);
    store.rows[B] = open(B);
    writePayload(path.join(sessionDir(A), "closing-payload.json"), { closing_reflection: reflection("A-reflection") });
    writePayload(path.join(sessionDir(B), "closing-payload.json"), { closing_reflection: reflection("B-reflection") });

    await sessionClose({ session_id: A, close_type: "standard" });

    expect(written()).toEqual([A]);
    expect(JSON.stringify(store.upserts[0])).not.toContain("B-reflection");
    expect(fs.existsSync(path.join(sessionDir(B), "closing-payload.json"))).toBe(true);
  });

  it("falls back to the legacy root file when exactly one session is live", async () => {
    store.rows[A] = open(A);
    live.list = () => [{ session_id: A }];
    writePayload(path.join(root.dir, "closing-payload.json"), { closing_reflection: reflection("legacy-reflection") });

    await sessionClose({ session_id: A, close_type: "standard" });

    expect(JSON.stringify(store.upserts[0])).toContain("legacy-reflection");
  });

  it("ignores the legacy root file when several sessions are live", async () => {
    store.rows[A] = open(A);
    live.list = () => [{ session_id: A }, { session_id: B }];
    writePayload(path.join(root.dir, "closing-payload.json"), { closing_reflection: reflection("legacy-reflection") });

    const result = await sessionClose({ session_id: A, close_type: "standard" });

    expect(result.success).toBe(false);
    expect(written()).toEqual([]);
    expect(fs.existsSync(path.join(root.dir, "closing-payload.json"))).toBe(true);
  });
});

describe("gitmem_session_id alias (GIT-122)", () => {
  // The remote-devices bridge drops a parameter named `session_id`; the alias carries the same id.
  it("alias alone closes that session, even when the process is bound to another", async () => {
    store.rows[A] = open(A);
    store.rows[B] = open(B);
    bound.id = B;
    live.list = () => [{ session_id: B }];

    const result = await sessionClose({ gitmem_session_id: A, close_type: "quick" });

    expect(written()).toEqual([A]);
    expect(result.session_id).toBe(A);
  });

  it("both given and equal: closes it", async () => {
    store.rows[A] = open(A);
    await sessionClose({ session_id: A, gitmem_session_id: A, close_type: "quick" });
    expect(written()).toEqual([A]);
  });

  it("both given and different: refused, nothing written, both ids named", async () => {
    store.rows[A] = open(A);
    store.rows[B] = open(B);

    const result = await sessionClose({ session_id: A, gitmem_session_id: B, close_type: "quick" });

    expect(result.success).toBe(false);
    expect(result.validation_errors!.join(" ")).toContain(A.slice(0, 8));
    expect(result.validation_errors!.join(" ")).toContain(B.slice(0, 8));
    expect(written()).toEqual([]);
  });

  it("alias is subject to the same checks: a closed session is refused", async () => {
    store.rows[A] = closed(A);
    const result = await sessionClose({ gitmem_session_id: A, close_type: "quick" });
    expect(result.success).toBe(false);
    expect(written()).toEqual([]);
  });

  it("a malformed alias is rejected, not ignored", async () => {
    store.rows[B] = open(B);
    bound.id = B;
    const result = await sessionClose({ gitmem_session_id: "../../etc/passwd", close_type: "quick" });
    expect(result.success).toBe(false);
    expect(written()).toEqual([]);
  });

  it("the alias id is logged on entry", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    store.rows[A] = open(A);
    await sessionClose({ gitmem_session_id: A, close_type: "quick" });
    expect(err.mock.calls.map((c) => String(c[0]))).toContain(`[session_close] incoming session_id=${A}`);
    err.mockRestore();
  });
});
