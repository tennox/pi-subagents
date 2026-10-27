/**
 * agent-widget.test.ts — the shared formatting helpers every agent surface
 * renders rows from (src/ui/agent-widget.ts). The LIST their rows assemble into
 * is tested in fleet-list.test.ts; the cost figures' contract has its own
 * cost-display.test.ts.
 */
import { describe, expect, it } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import { fgPreservingNestedStyles, formatCost, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});
describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    // Rounding to cents would print the same figure for a run that cost four
    // times another — the band most single subagent runs fall in.
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.0123)).toBe("$0.0123");
    expect(formatCost(1.239)).toBe("$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("$0.05");    // not $0.0500
    expect(formatCost(0.4)).toBe("$0.40");     // not $0.4
    expect(formatCost(12)).toBe("$12.00");
  });

  it("presents the figure as what pi recorded, not an estimate", () => {
    // The number is summed from pi's per-call cost records — the provider's
    // own accounting of each call — so the old tilde disclaimer is gone.
    expect(formatCost(0.5)).toBe("$0.50");
    expect(formatCost(0.5)).not.toContain("~");
  });

  it("renders the no-cost marker, never $0.00", () => {
    // pi zero-fills the per-call cost object, so a run whose total is 0 has no
    // measured figure at all — "$—" must say that, not claim a measurement of
    // 0, and not vanish (which would read as the display forgetting a field).
    expect(formatCost(0)).toBe("$—");
    expect(formatCost(Number.NaN)).toBe("$—");
    expect(formatCost(-1)).toBe("$—");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    // The distinction the whole helper turns on: "measured, below what four
    // decimals can show" must not render the same as "never measured".
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("$—");
  });
});
