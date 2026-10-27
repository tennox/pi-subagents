/**
 * fleet-wiring.test.ts — end-to-end wiring of the agent block through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the block the live UI (so it captures input), that spawning a background
 * agent actually registers the ONE `aboveEditor` widget once the agent has a
 * session, that `session_shutdown` tears it down, and that the block's two
 * settings gates (fleetView, widgetMode) actually hide it at the real seam.
 * runAgent is mocked (no LLM); the manager, settings load, completion routing,
 * and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

type BootedPi2 = ReturnType<typeof import("./helpers/boot-extension.js").makePi>;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces the widget + fleet touch; setWidget is spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>) {
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("Agent block wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  /**
   * Hermetic cwd + agent dir, with the given subagents.json settings. Settings
   * load at extension activation, so this runs BEFORE subagentsExtension(pi).
   * async join routes completions straight to sendIndividualNudge (no batch
   * debounce), so fleet.onAgentFinished fires synchronously on the result.
   */
  function setup(settings: Record<string, unknown> = {}): BootedPi2 {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    prevCwd = process.cwd();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify(
      { schedulingEnabled: false, defaultJoinMode: "async", ...settings },
    ));
    process.chdir(tmpDir);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
    vi.restoreAllMocks();
  });

  it("captures terminal input on tool_execution_start (the block hooked into the UI)", async () => {
    const { lifecycle } = setup();
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("registers the aboveEditor block once a spawned agent has a session, then clears it on shutdown", async () => {
    const { tools, lifecycle } = setup();

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // block captures THIS ui

    const spawn = await spawnBackgroundAgent(tools, ui);
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush(); // completion → fleet.onAgentFinished → update → block registers

    const blockRegs = ui.setWidget.mock.calls.filter(c => c[0] === "fleet" && typeof c[1] === "function");
    expect(blockRegs.length, "the block should register with a render factory").toBeGreaterThan(0);
    expect(
      blockRegs.every(c => c[2]?.placement === "aboveEditor"),
      "the ONE block registers above the editor",
    ).toBe(true);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined); // dispose cleared it
  });

  it("shows every top-level agent under the default widgetMode (the old foreground filter is gone)", async () => {
    const { tools, lifecycle } = setup();

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    await spawnBackgroundAgent(tools, ui);
    await flush();

    expect(
      ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function"),
      "registers by default",
    ).toBe(true);
  });

  it("hides the block when fleetView is off", async () => {
    const { tools, lifecycle } = setup({ fleetView: false });

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    await spawnBackgroundAgent(tools, ui);
    await flush();

    expect(
      ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function"),
      "never registers a content factory",
    ).toBe(false);
  });

  it("hides the block when widgetMode is off", async () => {
    const { tools, lifecycle } = setup({ widgetMode: "off" });

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    await spawnBackgroundAgent(tools, ui);
    await flush();

    expect(
      ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function"),
      "never registers a content factory",
    ).toBe(false);
  });

  it("reads a stored legacy widgetMode: background as all", async () => {
    const { tools, lifecycle } = setup({ widgetMode: "background" });

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));

    await spawnBackgroundAgent(tools, ui);
    await flush();

    expect(
      ui.setWidget.mock.calls.some(c => c[0] === "fleet" && typeof c[1] === "function"),
      "the retired spelling still shows the block",
    ).toBe(true);
  });

  /**
   * Spawn one background agent through the real Agent tool; runAgent is mocked.
   * The tool is handed the SAME ui the lifecycle handler saw: real pi gives
   * every tool call the session's one ctx.ui, and the merged block captures
   * whatever UI it is handed — a second object here would point the block (and
   * its assertions) at the wrong ui.
   */
  function spawnBackgroundAgent(tools: Map<string, any>, ui: ReturnType<typeof uiCtx>) {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    return tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctxWith(ui),
    );
  }
});
