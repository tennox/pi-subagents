/**
 * subagent-list-tool.test.ts — the contract of the `subagents` list tool: the
 * live-registry read behind "is this subagent actually still running?".
 *
 * `formatAgentRow` and `classifyFailure` are deliberately NOT exported — every
 * assertion here drives the registered tool's `execute`, so what is pinned is
 * the exact row text the model sees, including the two silent-empty failure
 * modes: the `parentSessionId` default stamped at spawn (without it a
 * top-level record never matches the scope key) and the `session_start` scope
 * wiring (without it the filter key stays undefined and the list is empty).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** A run that never settles — keeps a spawned record `running`. */
const neverSettles = () => vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);

let hermetic: Hermetic;
let pi: any;
let tools: Map<string, any>;
let lifecycle: Map<string, any>;

/** Boot the real extension hermetically (temp cwd/HOME, settings read at boot). */
function boot() {
  hermetic = hermeticDir();
  const booted = makePi();
  pi = booted.pi;
  tools = booted.tools;
  lifecycle = booted.lifecycle;
  subagentsExtension(pi);
}

/** What a real session does before any tool call: sets the list's scope key. */
const bindSession = async () => {
  await lifecycle.get("session_start")?.({}, ctx());
};

const registry = () => (globalThis as any)[MANAGER_KEY];

/** The extension's own manager, reached the way nested tools do — via the nestedRuntime. */
const rawManager = () => vi.mocked(runAgent).mock.calls[0][3].nestedRuntime.manager;

const list = (params: Record<string, unknown> = {}) =>
  tools.get("subagents").execute("tc-list", params, undefined, undefined, ctx());

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  neverSettles();
});

afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  vi.useRealTimers();
  delete (globalThis as any)[MANAGER_KEY];
  registerAgents(new Map());
  hermetic?.restore();
});

describe("subagents list tool — top-level scope", () => {
  it("renders a top-level spawn as a row carrying id/type/status/spawned-at", async () => {
    boot();
    await bindSession();

    const id = registry().spawn(pi, ctx(), "general-purpose", "do the thing", {
      description: "list this one",
    });
    await flush();

    const out = textOf(await list());
    expect(out).toContain(`id=${id}`);
    expect(out).toContain("type=general-purpose");
    expect(out).toContain("status=running");
    expect(out).toContain("spawned-at=");
    expect(out).toContain("list this one");
  });

  it("scopes rows to the main session: top-level visible, nested child hidden", async () => {
    boot();

    // parentSessionId default: a top-level spawn with no explicit session stamp
    // must carry the caller's session id, or it can never match the scope key.
    const topId = registry().spawn(pi, ctx(), "general-purpose", "top", {
      description: "top-level",
    });
    await flush();

    // The nested child is spawned through the RAW manager the way the nested
    // Agent tool does — parentAgentId set, parentSessionId = the parent record id.
    const nestedId = rawManager().spawn(pi, ctx(), "general-purpose", "nested", {
      description: "nested child",
      isBackground: true,
      parentAgentId: topId,
      parentSessionId: topId,
      depth: 2,
      maxSubagentDepth: 2,
    });
    await flush();

    // BEFORE session_start the scope key is unset — the honest empty message,
    // never a silently-filtered wrong list. (The session_start wiring is the
    // other half of the silent-empty fix.)
    expect(textOf(await list())).toContain("No subagents currently running or queued.");

    await bindSession();

    const out = textOf(await list());
    expect(out).toContain(`id=${topId}`);
    expect(out).not.toContain(nestedId);

    // Settled rows included, the nested child still stays out of the main
    // session's view — the scope filter, not the running/queued filter, is
    // what hides it.
    const all = textOf(await list({ include_completed: true }));
    expect(all).toContain(`id=${topId}`);
    expect(all).not.toContain(nestedId);
  });

  it("says so honestly when no agents exist", async () => {
    boot();
    await bindSession();

    expect(textOf(await list())).toBe("No subagents currently running or queued.");
  });
});

describe("subagents list tool — stall detection", () => {
  it("flags a running row stalled past the default 10m, and honours stall_minutes", async () => {
    boot();
    await bindSession();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const id = registry().spawn(pi, ctx(), "general-purpose", "slowpoke", {
      description: "stalling agent",
    });
    await flush();
    // Primary stall signal: last tool start. Stamped at "now" so the row is
    // fresh at spawn and only ages because the clock moves.
    registry().getRecord(id).lastToolStartedAt = Date.now();

    vi.setSystemTime(new Date("2026-03-01T12:11:00.000Z")); // 11 minutes later

    const out = textOf(await list());
    expect(out).toContain(`id=${id}`);
    expect(out).toContain("stalled=yes (no tool start for 11m)");

    // Per-call override: 30 minutes of tolerance clears the 11-minute gap.
    const overridden = textOf(await list({ stall_minutes: 30 }));
    expect(overridden).toContain(`id=${id}`);
    expect(overridden).toContain("stalled=no");
  });
});

describe("subagents list tool — failure signatures", () => {
  it("classifies provider failures on settled rows", async () => {
    boot();
    await bindSession();

    // One distinct provider error per spawn, in call order.
    let spawnNo = 0;
    vi.mocked(runAgent).mockImplementation(() => Promise.reject(new Error(
      ++spawnNo === 1
        ? "429 Too Many Requests — slow down"
        : "content_filter: input blocked by provider",
    )) as any);
    const limited = registry().spawn(pi, ctx(), "general-purpose", "rate-limited", {
      description: "hit the rate limit",
    });
    const filtered = registry().spawn(pi, ctx(), "general-purpose", "filtered", {
      description: "content filter block",
    });
    const [recA, recB] = [registry().getRecord(limited), registry().getRecord(filtered)];
    await Promise.all([recA.promise.catch(() => {}), recB.promise.catch(() => {})]);
    await flush();
    expect(recA.status).toBe("error");
    expect(recB.status).toBe("error");

    // Error rows are settled — invisible until include_completed asks for them.
    const running = textOf(await list());
    expect(running).not.toContain(`id=${limited}`);

    const out = textOf(await list({ include_completed: true }));
    expect(out).toContain(`id=${limited}`);
    expect(out).toContain(`id=${filtered}`);
    expect(out).toContain("status=error");
    expect(out).toContain("failure=rate-limited (429)");
    expect(out).toContain("failure=content-filtered");
  });
});

describe("subagents list tool — nested variant", () => {
  it("lists only the children of the parent it was built for", async () => {
    boot();
    await bindSession();

    const parentId = registry().spawn(pi, ctx(), "general-purpose", "orchestrator", {
      description: "parent",
    });
    await flush();
    const manager = rawManager();

    const mine = manager.spawn(pi, ctx(), "general-purpose", "child of parent", {
      description: "mine",
      isBackground: true,
      parentAgentId: parentId,
      parentSessionId: parentId,
      depth: 2,
      maxSubagentDepth: 2,
    });
    const theirs = manager.spawn(pi, ctx(), "general-purpose", "child of someone else", {
      description: "theirs",
      isBackground: true,
      parentAgentId: "other-parent",
      parentSessionId: "other-parent",
      depth: 2,
      maxSubagentDepth: 2,
    });
    await flush();

    const nestedTool = createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: parentId,
      parentSessionId: parentId,
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: hermetic.dir,
    }).find((t) => t.name === "subagents");
    expect(nestedTool, "nested tool set must include the subagents list tool").toBeDefined();

    const out = textOf(await nestedTool.execute("tc-nested", {}, undefined, undefined, ctx()));
    expect(out).toContain(mine);
    expect(out).not.toContain(theirs);
  });
});