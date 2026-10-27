/**
 * fleet-list.ts — the ONE persistent agent list, rendered above the editor.
 *
 * Merges what used to be two simultaneous listings of the same subagents: the
 * above-editor `AgentWidget` (spinner rows, tree lines, turn-aged finished
 * lines) and the below-editor FleetView (navigable rows with selection, an
 * overlay viewer and workflow runs). Every agent is rendered exactly once, in
 * one block:
 *
 *   - Idle (unfocused), the block is compact: one informative line per agent
 *     (type, description, mode tag, turns, tool uses, tokens with context%,
 *     agent rows above `MAX_AGENT_ROWS` collapse into a single `+N more`, and
 *     recently finished agents linger as settled rows for `FINISHED_LINGER_MS`.
 *   - Focused (the user pressed ↓/← at an empty prompt), every agent shows with
 *     no cap and no windowing, running agents gain a second `⎿ …` activity
 *     line, and ↑/↓/Enter/Esc navigate — Enter opens the selected agent's live
 *     conversation overlay, Esc returns to the prompt.
 *
 * `main` is the first row: activating the list lands on it, and Enter on it
 * returns to the prompt. Workflow runs render above the agents, each as one row.
 *
 * Mechanics (see plan): the block is an `aboveEditor` widget (render-only), and
 * ALL key handling goes through `onTerminalInput` — which fires before the
 * focused editor and can `consume` keys — gated on `getEditorText() === ""` so
 * normal typing is untouched.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  type AgentActivity,
  buildInvocationTags,
  describeActivity,
  ERROR_STATUSES,
  fgPreservingNestedStyles,
  formatCost,
  formatSessionTokens,
  formatTurns,
  getPromptModeLabel,
  SPINNER,
  type Theme,
} from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

/** Widget key for the above-editor agent block. */
const FLEET_KEY = "fleet";
/** Agent rows the block shows before the remainder collapses into a `+N more` line. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the block needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  /**
   * Optional: the block also captures the UI from paths without a terminal —
   * an Agent tool executed headless, or a UI stub that renders but never takes
   * keys. There the block stays render-only.
   */
  onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the agent list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

/**
 * The settled row's icon in the slot next to the bullet, carried over from the
 * retired separate widget's finished lines: ✓ succeeded, ✓ steered to its turn
 * limit, ■ stopped, ✗ errored or aborted.
 */
function settledIcon(record: AgentRecord, theme: Theme): string {
  switch (record.status) {
    case "completed": return theme.fg("success", "✓");
    case "steered": return theme.fg("warning", "✓");
    case "stopped": return theme.fg("dim", "■");
    default: return theme.fg("error", "✗");
  }
}

/**
 * A settled row's trailing annotation, after its stats — the same wording and
 * coloring the widget's finished lines had. `ERROR_STATUSES` is exactly the set
 * of statuses that carry one; a completed run says nothing.
 */
function settledStatusText(record: AgentRecord, theme: Theme): string {
  if (!ERROR_STATUSES.has(record.status)) return "";
  if (record.status === "steered") return theme.fg("warning", " (turn limit)");
  if (record.status === "stopped") return theme.fg("dim", " stopped");
  const errMsg = record.error ? `: ${record.error.slice(0, 60)}` : "";
  return theme.fg("error", ` error${errMsg}`);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** One-shot: fires `update()` once when the next lingering row is due to expire. */
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;

  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;
  /** Spinner frame for running rows; advances with the stat tick. */
  private spinnerFrame = 0;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render/keyboard time. Both settings gates in one place: the
     * list shows only while `fleetView` is on AND `widgetMode` is not `off`.
     * Read live, not captured, so a settings toggle applies without a rebuild.
     */
    private visible: () => boolean = () => true,
    /**
     * Read live at render time. Whether each row shows the tracked per-call
     * cost after its token count. Defaults to off — the extension supplies the
     * user's `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * Read live at render time. Whether running rows name the model driving
     * them and the thinking level it is running at, before their stats.
     * Defaults to off — the extension supplies the user's `showModel` setting.
     */
    private showModel: () => boolean = () => false,
    /**
     * The user's `viewerMarkdown` setting, for a conversation overlay opened
     * from here. Read live rather than captured, because the viewer's `m` key
     * changes it while the overlay is up. Omitted → the viewer's own default.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m` in that overlay, so the key means the same
     * thing here as it does from `/agents` — one setting, not one per entry
     * point. Omitted → `m` still cycles, viewer-locally.
     */
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
  ) {}

  // ---- Lifecycle ----

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
    // Headless UIs (pi -p, tool-execute mocks) carry no input hook; the block
    // is render-only there and keys simply never reach it.
    this.inputUnsub = ui.onTerminalInput?.(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) {
      // The tick animates the spinner frames; update() alone does not advance
      // them, so a render stays byte-stable however often the callers refresh.
      this.timer = setInterval(() => { this.spinnerFrame++; this.update(); }, TICK_MS);
    }
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.lingerTimer) { clearTimeout(this.lingerTimer); this.lingerTimer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, undefined);
      this.ui.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    this.lastStatusText = undefined;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the above-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;

    // The status bar is independent of the block's two visibility settings: run
    // agents are worth announcing in whatever surface the user has left.
    const agents = topLevelAgents(this.manager);
    const runningCount = agents.filter(a => a.status === "running").length;
    const queuedCount = agents.filter(a => a.status === "queued").length;
    let newStatusText: string | undefined;
    const total = runningCount + queuedCount;
    if (total > 0) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.ui.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before. A top-level agent without a
    // session counts as content too: it is either queued behind the pool (the
    // summary line below is its own row) or still establishing one — an RPC,
    // scheduler or mention spawn enters through the manager, whose onStart
    // refresh lands BEFORE runAgent has created the session. Counting both is
    // what makes the block appear at spawn time; the starting one's row
    // follows on the next tick, once the session exists.
    const starting = agents.some(a => !a.session && (a.status === "running" || a.status === "queued"));
    const hasVisible = this.visible() && (this.roster().length > 1 || starting);

    if (!hasVisible) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      if (this.lingerTimer) { clearTimeout(this.lingerTimer); this.lingerTimer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();

    // The repeating timer earns its keep only while something is actually
    // progressing (elapsed/tokens/spinner to tick) — a row full of finished/
    // paused/viewed entries has nothing to animate but would still force a full
    // unmemoized re-layout at 5fps forever (#leak). When nothing is live, fall
    // back to a single timer that fires once the earliest linger expires, so a
    // finished row still drops out on schedule.
    if (this.hasLiveRows()) {
      this.ensureTimer(); // keep stats ticking whenever live rows are shown (e.g. after a re-enable)
      if (this.lingerTimer) { clearTimeout(this.lingerTimer); this.lingerTimer = undefined; }
    } else {
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.scheduleLingerExpiry();
    }

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  /** Whether anything in the list is actually progressing (worth ticking stats for). */
  private hasLiveRows(): boolean {
    return this.visible() && (
      this.agentRecords().some(a => a.status === "running" || a.status === "queued")
      // Still establishing its session (spawn → runAgent window): live, and
      // this tick is what notices the session arriving — nothing else fires
      // for a manager-entered spawn.
      || topLevelAgents(this.manager).some(a => !a.session && a.status === "running")
      || this.workflows().some(w => w.status === "running")
    );
  }

  /**
   * Arm the one-shot that clears the next expired linger, unless one is
   * already pending — `update()` may re-enter this path on every re-render
   * while nothing is live, and re-arming each time would leak timers.
   */
  private scheduleLingerExpiry(): void {
    if (this.lingerTimer) return;
    const delay = this.nextLingerExpiryDelay();
    if (delay == null) return; // only pinned/paused rows left — nothing will expire on its own
    this.lingerTimer = setTimeout(() => { this.lingerTimer = undefined; this.update(); }, delay);
  }

  /**
   * Ms until the soonest row still in the roster because it's within
   * `FINISHED_LINGER_MS`, not because it's pinned (viewed agent, paused
   * run) — those persist independent of time, so a pin doesn't count here.
   */
  private nextLingerExpiryDelay(): number | undefined {
    const now = Date.now();
    const expiries: number[] = [];
    for (const a of this.agentRecords()) {
      if (a.completedAt != null && a.id !== this.viewingAgentId) expiries.push(a.completedAt + FINISHED_LINGER_MS);
    }
    for (const w of this.workflows()) {
      if (w.completedAt != null) expiries.push(w.completedAt + FINISHED_LINGER_MS);
    }
    return expiries.length ? Math.max(0, Math.min(...expiries) - now) : undefined;
  }

  // ---- Roster ----

  /**
   * Queued top-level agents with no session yet — pending starts parked behind
   * the concurrency limit. They are not rows (there is nothing to open), they
   * are the block's `◦ N queued` summary, the retired separate widget's count
   * line.
   */
  private pendingQueued(): AgentRecord[] {
    return topLevelAgents(this.manager).filter(a => !a.session && a.status === "queued");
  }

  /**
   * Agents shown in the list, ordered earliest-launched first so the ones you
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Pending agents with no session yet are hidden until they start.
   * (`listAgents()` is newest-first, so we re-sort.)
   */
  private agentRecords(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a) && a.session && (
        a.status === "running" || a.status === "queued"
        || a.id === this.viewingAgentId
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.visible() || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingWorkflowId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      // Gated on the roster, not the agents: a session whose only row is a
      // workflow run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      void Promise.resolve(this.openWorkflow?.(entry.workflow.id)).then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
          this.viewerMarkdown,
          this.onViewerMarkdown,
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId ?? this.viewingWorkflowId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed
        : e.kind === "workflow" ? e.workflow.id === viewed
        : false,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = [
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
    const pendingCount = this.pendingQueued().length;
    if (rows.length === 0 && pendingCount === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, rows.length);

    const live = this.hasLiveRows();
    const headingColor = live ? "accent" : "dim";
    const headingIcon = live ? "●" : "○";

    const lines: string[] = [
      truncateToWidth(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"), width),
      truncateToWidth("  " + theme.fg("dim", this.hint()), width),
      "",
      truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width),
    ];

    // Focused, every row shows — the selection is always on screen, so the old
    // fleet's windowing indicators have nothing to do. Idle, the block is
    // capped and the remainder collapses into one `+N more` line: agents come
    // after the workflow rows, so agent rows are the ones that collapse.
    const maxRows = this.active ? rows.length : Math.min(MAX_AGENT_ROWS, rows.length);
    const hidden = rows.length - maxRows;
    for (let i = 0; i < maxRows; i++) {
      const row = rows[i];
      lines.push(
        row.kind === "workflow" ?
          this.renderWorkflowRow(i + 1, sel, row.workflow, width, theme)
        : this.renderAgentRow(i + 1, sel, row.record, width, theme),
      );
      // A focused running agent's second line — what it is doing right now,
      // under its stats, exactly as the retired separate widget showed it.
      if (this.active && row.kind === "agent" && row.record.status === "running") {
        const activity = this.agentActivity.get(row.record.id);
        lines.push(truncateToWidth(theme.fg("dim", `  ⎿  ${describeActivity(activity?.activeTools ?? new Map(), activity?.responseText)}`), width));
      }
    }

    if (pendingCount > 0) {
      lines.push(truncateToWidth(`  ${theme.fg("muted", "◦")} ${theme.fg("dim", `${pendingCount} queued`)}`, width));
    }
    if (hidden > 0) {
      lines.push(rightAlign("", theme.fg("dim", `+${hidden} more`), width));
    }

    return lines;
  }

  private hint(): string {
    return this.active ? "↑↓ select · enter view · esc back" : "esc to interrupt · ← for agents · ↓ to manage";
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme): string {
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
   * — so the two read as one list, with the agent count where an agent has its
   * description and the same elapsed/token tail.
   */
  private renderWorkflowRow(
    rosterIndex: number,
    sel: number,
    workflow: FleetWorkflow,
    width: number,
    theme: Theme,
  ): string {
    const selected = rosterIndex === sel;
    const kind = theme.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? theme.fg("text", workflow.name) : workflow.name;
    const left = `  ${this.bullet(rosterIndex, sel, theme)} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }

  private renderAgentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number, theme: Theme): string {
    const selected = rosterIndex === sel;
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const name = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const modeTag = getPromptModeLabel(record.type);
    const description = selected ? theme.fg("text", record.description) : record.description;
    // The slot after the bullet carries the live state: the animated spinner
    // frame while running (kept from the retired separate widget, animated by
    // the stat tick), the settled icon once the agent is done.
    const glyph = record.status === "running"
      ? ` ${theme.fg("accent", SPINNER[this.spinnerFrame % SPINNER.length])}`
      : record.status === "queued" ? ""
      : ` ${settledIcon(record, theme)}`;
    const left = `  ${this.bullet(rosterIndex, sel, theme)}${glyph} ${name}${modeTag ? ` ${theme.fg("dim", `(${modeTag})`)}` : ""}  ${description}`;

    // Spend and tokens read from the record, never from the activity tracker:
    // the record is the one that survives the agent finishing, and the one
    // nested-tools folds a hidden child's spend into. Reading the tracker while
    // an agent runs and the record once it stops made the figure jump at
    // completion. The tracker still lends the live turn count.
    const activity = this.agentActivity.get(record.id);
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const tokenText = tokens > 0 ? formatSessionTokens(tokens, getSessionContextPercent(record.session), theme, record.compactionCount) : "";
    const costText = this.showCost() ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished

    // Model and thinking first, paired, read through buildInvocationTags so the
    // "(asked X)" disclosure survives — the old widget's running-row head.
    const parts: string[] = [];
    if (this.showModel()) {
      const { modelName, tags } = buildInvocationTags(record.invocation);
      if (modelName) parts.push(modelName);
      const thinkingTag = tags.find(tag => tag.startsWith("thinking: "));
      if (thinkingTag) parts.push(thinkingTag);
    }
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (record.toolUses > 0) parts.push(`${record.toolUses} tool use${record.toolUses === 1 ? "" : "s"}`);
    if (tokenText) parts.push(tokenText);
    if (costText) parts.push(costText);
    parts.push(formatFleetElapsed(elapsedMs));
    const stats = parts.join(" · ") + settledStatusText(record, theme);
    // Nesting-safe: percent/compaction and the settled annotation carry their
    // own colors inside the outer one, restored after every nested reset.
    const right = fgPreservingNestedStyles(theme, selected ? "text" : "dim", stats);
    return rightAlign(left, right, width);
  }
}

/** Top-level agents only — the nested ones report through their parents. */
function topLevelAgents(manager: AgentManager): AgentRecord[] {
  return manager.listAgents().filter(isTopLevelAgent);
}