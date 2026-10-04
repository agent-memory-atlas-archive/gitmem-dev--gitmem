/**
 * Regression: session_close must hand ThreadObjects (with ids) to the Supabase thread sync
 * even when the session row's open_threads come back from Supabase as JSON strings.
 *
 * orchestra_sessions.open_threads is a text[] whose elements are JSON-encoded threads.
 * On a re-close with no new threads passed and no in-memory thread state (a second close,
 * or a close after a server restart), buildSessionRecord left those raw strings in
 * sessionData.open_threads and session_close cast them `as ThreadObject[]` without
 * normalizing. thread.id was undefined for every thread, so syncThreadsToSupabase built
 * the filter { thread_id: undefined } and threw "Cannot read properties of undefined
 * (reading 'includes')" for all of them (28 of 28 in the field).
 *
 * NOTE: vitest.config.ts has `restoreMocks: true`; re-establish spy implementations in beforeEach.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all dependencies before importing session-close ---
// Use plain functions (not vi.fn()) for mocks we don't need to spy on.
// restoreMocks: true in vitest config clears vi.fn() implementations between tests.

vi.mock("../../../src/services/agent-detection.js", () => ({
  detectAgent: () => ({ agent: "CLI", entrypoint: "cli", docker: true, hostname: "test" }),
}));

// These tests model nTEG's store (orchestra_ prefix), which has the
// production-only columns and tables. Customer-store behaviour (columns absent)
// is covered in tests/unit/services/store-columns.test.ts.
vi.mock("../../../src/services/store-columns.js", () => ({
  supportedColumns: async (_table: string, candidates: string[]) => new Set(candidates),
  storeHasTable: async () => true,
  resetStoreColumnCache: () => {},
}));

vi.mock("../../../src/services/supabase-client.js", () => ({
  listRecords: vi.fn(),
  getRecord: vi.fn(),
  directUpsert: vi.fn(),
  directPatch: vi.fn(),
}));

vi.mock("../../../src/services/embedding.js", () => ({
  embed: () => Promise.resolve(null),
  isEmbeddingAvailable: () => false,
}));

vi.mock("../../../src/services/tier.js", () => ({
  hasSupabase: vi.fn(),
  hasBatchOperations: () => true,
  hasTranscripts: () => false,
  hasCacheManagement: () => true,
  hasVariants: () => true,
  hasEmbeddings: () => true,
  hasMetrics: () => true,
  getTier: () => "pro",
  resetTier: () => {},
  hasProInsights: () => false,
  getTablePrefix: () => "orchestra_",
  getTableName: (base: string) => `orchestra_${base}`,
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
    get: () => Promise.resolve(null),
    upsert: () => Promise.resolve(undefined),
  }),
}));

vi.mock("../../../src/services/session-state.js", () => ({
  clearCurrentSession: () => {},
  getSurfacedScars: () => [],
  getConfirmations: () => [],
  getObservations: () => [],
  getChildren: () => [],
  getThreads: () => [],
  getSessionActivity: () => null,
  isRecallCalled: () => true,
}));

vi.mock("../../../src/services/thread-manager.js", async (importOriginal) => ({
  // Real normalizeThreads / migrateStringThread / mergeThreadStates: the bug lives in what
  // session_close hands to the sync, so stubbing normalization would hide it.
  ...(await importOriginal<typeof import("../../../src/services/thread-manager.js")>()),
  saveThreadsFile: () => {},
  loadThreadsFile: () => [],
}));

vi.mock("../../../src/services/thread-dedup.js", () => ({
  deduplicateThreadList: (threads: unknown[]) => threads,
}));

vi.mock("../../../src/services/thread-supabase.js", () => ({
  syncThreadsToSupabase: vi.fn(),
  loadOpenThreadEmbeddings: () => Promise.resolve([]),
}));

vi.mock("../../../src/services/compliance-validator.js", () => ({
  validateSessionClose: () => ({ valid: true, errors: [], warnings: [] }),
  buildCloseCompliance: (_params: unknown, _agent: string, _learningsCount: number) => ({
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
  recordMetrics: () => Promise.resolve(undefined),
  buildPerformanceData: (_name: string, latency: number, count: number) => ({
    latency_ms: latency,
    target_ms: 3000,
    meets_target: latency < 3000,
    result_count: count,
  }),
  updateRelevanceData: () => Promise.resolve(undefined),
}));

vi.mock("../../../src/tools/record-scar-usage-batch.js", () => ({
  recordScarUsageBatch: () => Promise.resolve({ success: true }),
}));

vi.mock("../../../src/services/effect-tracker.js", () => ({
  getEffectTracker: () => ({
    track: () => {},
    formatSummary: () => "No tracked effects this session.",
    getHealthReport: () => ({ overall: { attempted: 0, succeeded: 0, failed: 0, successRate: "N/A", paths_with_failures: [] }, byPath: {}, recentFailures: [] }),
  }),
}));

vi.mock("../../../src/tools/save-transcript.js", () => ({
  saveTranscript: () => Promise.resolve({ success: false }),
}));

vi.mock("../../../src/services/transcript-chunker.js", () => ({
  processTranscript: () => Promise.resolve({ success: false }),
}));

vi.mock("../../../src/services/gitmem-dir.js", () => ({
  getGitmemPath: (filename: string) => `/tmp/.gitmem/${filename}`,
  getGitmemDir: () => "/tmp/.gitmem",
  getSessionPath: (sid: string, filename: string) => `/tmp/.gitmem/sessions/${sid}/${filename}`,
  getSessionDir: (sid: string) => `/tmp/.gitmem/sessions/${sid}`,
}));

vi.mock("../../../src/services/active-sessions.js", () => ({
  unregisterSession: () => {},
  findSessionByHostPid: () => null,
  findSessionById: () => null, // GIT-86: session-close's registry fallback looks up by id
}));

vi.mock("../../../src/services/thread-suggestions.js", () => ({
  loadSuggestions: () => [],
  saveSuggestions: () => {},
  detectSuggestedThreads: () => [],
  loadRecentSessionEmbeddings: () => Promise.resolve(null),
}));

// --- Import after mocks ---
import { sessionClose } from "../../../src/tools/session-close.js";
import * as supabase from "../../../src/services/supabase-client.js";
import { hasSupabase } from "../../../src/services/tier.js";
import { syncThreadsToSupabase } from "../../../src/services/thread-supabase.js";

const SESSION_ID = "393adb34-a80c-4c3a-b71a-bc0053b7a7ea";

function thread(id: string, text: string) {
  return { id, text, status: "open", created_at: "2026-09-01T00:00:00.000Z", source_session: SESSION_ID };
}

function sessionRow(openThreads: unknown[]) {
  const now = new Date().toISOString();
  return {
    id: SESSION_ID, agent: "CLI", project: "test-project", session_title: "Interactive Session",
    session_date: now.split("T")[0], created_at: now, close_compliance: null,
    open_threads: openThreads, embedding: null,
  };
}

const okSync = (attempted: number) => ({
  attempted, synced: [], failed: [], skipped: false, all_synced: true,
  dedup_coverage: "complete" as const, dedup_candidates: 0,
});

describe("session_close re-close with stored (stringified) threads", () => {
  beforeEach(() => {
    vi.mocked(hasSupabase).mockReturnValue(true);
    vi.mocked(supabase.listRecords).mockResolvedValue([]);
    vi.mocked(supabase.directUpsert).mockResolvedValue(undefined);
    vi.mocked(supabase.directPatch).mockResolvedValue(undefined);
    vi.mocked(syncThreadsToSupabase).mockImplementation(async (threads) => okSync(threads.length));
  });

  it("passes ThreadObjects with ids to the sync when open_threads are stored as JSON strings", async () => {
    const stored = [JSON.stringify(thread("t-aaa111", "first thread")), JSON.stringify(thread("t-bbb222", "second thread"))];
    vi.mocked(supabase.getRecord).mockResolvedValue(sessionRow(stored));

    const result = await sessionClose({ session_id: SESSION_ID, close_type: "quick" });

    expect(result.success).toBe(true);
    expect(syncThreadsToSupabase).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(syncThreadsToSupabase).mock.calls[0][0];
    expect(sent.map((t) => t.id)).toEqual(["t-aaa111", "t-bbb222"]);
    expect(sent.every((t) => typeof t === "object" && typeof t.text === "string")).toBe(true);
  });

  it("gives plain-text legacy strings a generated id instead of undefined", async () => {
    vi.mocked(supabase.getRecord).mockResolvedValue(sessionRow(["legacy plain text thread"]));

    await sessionClose({ session_id: SESSION_ID, close_type: "quick" });

    const sent = vi.mocked(syncThreadsToSupabase).mock.calls[0][0];
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toMatch(/^t-/);
    expect(sent[0].text).toBe("legacy plain text thread");
  });

  it("still passes already-object threads through unchanged", async () => {
    vi.mocked(supabase.getRecord).mockResolvedValue(sessionRow([thread("t-ccc333", "object thread")]));

    await sessionClose({ session_id: SESSION_ID, close_type: "quick" });

    const sent = vi.mocked(syncThreadsToSupabase).mock.calls[0][0];
    expect(sent.map((t) => t.id)).toEqual(["t-ccc333"]);
  });
});
