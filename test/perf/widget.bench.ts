/**
 * widget.bench.ts — the one persistent agent surface: the merged, always-on
 * agent block (`FleetList` above the editor).
 *
 * It caches nothing about the agent list: one `update()` reaches `agentRecords()`
 * twice (the roster and the session-less queued summary), both sorted, and every
 * TUI frame re-renders the rows — the block sits beside the editor, so a
 * keystroke in the main session redraws it too.
 *
 * `render` and `update` are measured apart because they run at different rates
 * (per frame vs. a 200 ms timer plus ~10 call sites in index.ts) and a
 * regression in one says nothing about the other.
 *
 * Cleanup is in `afterAll`, NOT in tinybench's per-task `teardown`: that hook
 * fires between the warmup and sampling phases, and `dispose()` unregisters the
 * widget by calling `setWidget(key, undefined)`. The first version of this file
 * disposed in `teardown` and reported 33 million renders per second — it was
 * measuring an unregistered widget returning an empty array.
 */
import { afterAll, bench, describe } from "vitest";
import { FleetList } from "../../src/ui/fleet-list.js";
import { makeFleet, mountFleet } from "../helpers/perf-fixtures.js";

/** Fleet sizes: one agent, a normal fan-out, and a pathological one. */
const SIZES = [1, 10, 100];

/** Everything mounted here, torn down once at the end (the block holds a timer). */
const mounted: { dispose: () => void }[] = [];
function track<T extends { dispose: () => void }>(m: T): T {
  mounted.push(m);
  return m;
}
afterAll(() => {
  for (const m of mounted) m.dispose();
});

describe("The block — render (per TUI frame)", () => {
  for (const n of SIZES) {
    const w = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.render(120);
    });
  }
});

describe("The block — update (200ms timer + ~10 call sites)", () => {
  for (const n of SIZES) {
    const w = track(mountFleet(FleetList, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.update();
    });
  }
});

describe("The block — the block's real mix", () => {
  // What a fan-out actually looks like on screen: a few running, a queue behind
  // them, and finished rows still lingering. The idle cap has to resolve this
  // shape, which the flat "n running" cases never reach.
  const off = track(mountFleet(FleetList, makeFleet({ running: 3, queued: 7, finished: 3 })));
  bench("3 running / 7 queued / 3 finished", () => {
    off.render(120);
  });
});
