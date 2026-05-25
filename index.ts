/**
 * pi-simplify: Code Review & Cleanup Extension for pi
 *
 * Reviews changed code for reuse, quality, and efficiency:
 * - Reuse: replace newly-written code with existing utilities
 * - Quality: dead code, debug remnants, commented-out code, over-engineering, duplicate logic
 * - Efficiency: redundant work, missed concurrency, hot-path bloat, memory leaks
 */

import {
  defineTool,
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Key,
  SelectList,
  wrapTextWithAnsi,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Category = "reuse" | "quality" | "efficiency";
type Risk = "safe" | "confirm" | "review";
type Action = "delete" | "inline" | "refactor" | "parallelize";

type SimplifyResult = {
  category: Category;
  file: string;
  lines: string;
  reason: string;
  risk: Risk;
  action: Action;
};

const SIMPLIFY_PROMPT = `# Simplify: Review Changed Code for Reuse, Quality, and Efficiency

You are a code review assistant. Review the changed code along three axes — **Reuse**, **Quality**, and **Efficiency** — and surface concrete fixes.

Match the user's language for candidate reasons and summaries; if the user's request is in Chinese, write the candidate \`reason\` fields in Chinese.

## What to Find

### A. Reuse (Confirm Before Replacing)

Before flagging, **search the codebase** (utility directories, shared modules, files adjacent to the change) for existing helpers. Quote the existing symbol you'd use.

- **Duplicates an existing function**: a newly written helper does what an existing one already does
- **Inline logic that has a utility**: hand-rolled string manipulation, manual path handling, custom env checks, ad-hoc type guards
- **Reinvented framework primitive**: re-implementing something the language/stdlib/framework already provides

### B. Quality

#### B1. Dead Code (Safe to Delete)
- Unused exports, orphan files, zombie variables, empty try/catch/if blocks

#### B2. Debug Remnants (Safe to Delete)
- \`console.log\` / \`console.warn\` / \`console.error\`, \`debugger\`, temporary feature flags, stale TODO comments

#### B3. Commented-out Code (Review)
- Old logic left in comments, disabled features, uncustomized templates

#### B4. Over-engineering (Confirm)
- Abstractions created "for future use" but unused, single-call-site helpers that should be inlined, useless indirection

#### B5. Hacky Patterns (Confirm)
- **Redundant state**: state that duplicates other state, cached values that could be derived, observers that could be direct calls
- **Parameter sprawl**: piling new parameters onto a function instead of restructuring
- **Copy-paste with variation**: near-duplicate blocks that should share an abstraction
- **Leaky abstractions**: exposing internals or breaking existing boundaries
- **Stringly-typed code**: raw strings where an existing constant/enum/union exists
- **Unnecessary wrapper elements**: JSX/DOM wrappers that add no layout value
- **Nested conditionals**: ternary chains or if/else nested 3+ levels deep — flatten with early returns or a lookup table
- **Useless comments**: comments restating WHAT the code does, narrating the change, or referencing the task/caller — keep only non-obvious WHY

### C. Efficiency (Confirm)

- **Unnecessary work**: redundant computations, repeated file reads, duplicate API calls, N+1 patterns
- **Missed concurrency**: independent operations run sequentially when they could run in parallel
- **Hot-path bloat**: blocking work added to startup or per-request/per-render hot paths
- **Recurring no-op updates**: state writes inside loops/intervals/handlers that fire unconditionally — add a change-detection guard
- **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU) — operate directly and handle the error
- **Memory**: unbounded data structures, missing cleanup, event listener leaks
- **Overly broad operations**: reading whole files when a slice would do, loading all items when filtering for one

## How to Analyze

1. Run \`git diff\` to see what changed.
2. For each change, classify as **Essential** / **Residual** / **Legacy** (don't flag legacy code unless the diff touches it).
3. For each finding:
   - Identify exact file and line(s)
   - Assign **category** (reuse / quality / efficiency) and **risk**
   - State the concrete fix (which existing utility to call, which lines to delete, how to parallelize, etc.)

## Risk Levels

- **safe**: Definitely apply (dead code, debug remnants)
- **confirm**: Apply after user confirms (reuse swaps, over-engineering, hacky patterns, efficiency fixes)
- **review**: User should look first (commented-out code, ambiguous cases)

## Rules

1. When in doubt, mark as "confirm" or "review" — don't change without consent.
2. For reuse findings, name the existing symbol/file you'd swap to.
3. For efficiency findings, briefly justify the win (e.g., "N+1 → single query", "sequential awaits → Promise.all").
4. Don't flag necessary code just because it's simple.
5. Respect existing abstraction boundaries.
6. Be especially careful with:
   - Error handling code
   - Security-related logic
   - Code that looks "unused" but is called via reflection/eval
   - Database migration files

## Output Format (REQUIRED)

When analysis is complete, call the \`simplify_candidates\` tool exactly once as your final action. Put ALL candidates in that tool call.

Field notes:
- \`category\` — one of: "reuse", "quality", "efficiency"
- \`risk\` — one of: "safe", "confirm", "review"
- \`file\` — repository-relative path, no backticks, no markdown
- \`lines\` — line number or range ("42" or "42-57"); empty string if unknown
- \`reason\` — single plain-text sentence stating the concrete fix
- \`action\` — one of: "delete", "inline", "refactor", "parallelize"

If there are no candidates, call \`simplify_candidates\` with an empty \`candidates\` array.
Do NOT write a prose-only final answer; the extension relies on the tool result.
`;

export default function simplifyExtension(pi: ExtensionAPI) {
  // Accumulate assistant text across the whole turn (multiple messages when
  // the AI makes tool calls). Overwriting would drop the JSON block if it
  // appears in an earlier message and a later one adds a short confirmation.
  let assistantTextBuffer = "";
  let resolvePendingTurnStart: (() => void) | null = null;

  pi.on("turn_start", () => {
    if (!resolvePendingTurnStart) return;
    const resolve = resolvePendingTurnStart;
    resolvePendingTurnStart = null;
    resolve();
  });

  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
    const text = (msg.content as { type: string; text?: string }[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
    if (text) assistantTextBuffer += (assistantTextBuffer ? "\n" : "") + text;
  });

  const CATEGORY_VALUES = new Set<Category>(["reuse", "quality", "efficiency"]);
  const RISK_VALUES = new Set<Risk>(["safe", "confirm", "review"]);
  const ACTION_VALUES = new Set<Action>(["delete", "inline", "refactor", "parallelize"]);

  function normalizeCategory(value: unknown): Category {
    const v = String(value ?? "")
      .toLowerCase()
      .trim();
    return CATEGORY_VALUES.has(v as Category) ? (v as Category) : "quality";
  }

  function normalizeRisk(value: unknown): Risk {
    const v = String(value ?? "")
      .toLowerCase()
      .trim();
    return RISK_VALUES.has(v as Risk) ? (v as Risk) : "review";
  }

  function normalizeAction(value: unknown): Action | null {
    const v = String(value ?? "")
      .toLowerCase()
      .trim();
    return ACTION_VALUES.has(v as Action) ? (v as Action) : null;
  }

  function normalizeCandidates(list: unknown): SimplifyResult[] {
    if (!Array.isArray(list)) return [];

    const out: SimplifyResult[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const file = stripMarkdown(String(raw.file ?? raw.location ?? ""));
      if (!file || file.includes("..") || file.startsWith("/")) continue;
      const action = normalizeAction(raw.action);
      if (!action) continue;
      const reason = stripMarkdown(String(raw.reason ?? raw.description ?? ""));
      out.push({
        category: normalizeCategory(raw.category),
        file,
        lines: stripMarkdown(String(raw.lines ?? "")),
        reason: reason || "(no reason provided)",
        risk: normalizeRisk(raw.risk),
        action,
      });
    }
    return out;
  }

  let resolvePendingCandidatesTool: ((candidates: SimplifyResult[]) => void) | null = null;
  let latestToolCandidates: SimplifyResult[] | null = null;

  const simplifyCandidatesParameters = Type.Object({
    candidates: Type.Array(
      Type.Object({
        category: Type.String({ description: "reuse, quality, or efficiency" }),
        risk: Type.String({ description: "safe, confirm, or review" }),
        file: Type.String({ description: "Repository-relative path" }),
        lines: Type.Optional(Type.String({ description: "Line number or range" })),
        reason: Type.String({ description: "Concrete fix in one sentence" }),
        action: Type.String({ description: "delete, inline, refactor, or parallelize" }),
      }),
    ),
  });

  const simplifyCandidatesTool = defineTool({
    name: "simplify_candidates",
    label: "Simplify Candidates",
    description:
      "Return the complete candidate list for /simplify. Use as the final action after analyzing changed code.",
    promptSnippet: "Return structured cleanup candidates for /simplify as a terminating result",
    promptGuidelines: [
      "Use simplify_candidates exactly once as the final action when the /simplify command asks for cleanup candidates.",
    ],
    parameters: simplifyCandidatesParameters,
    async execute(_toolCallId, params) {
      const resolve = resolvePendingCandidatesTool;
      if (!resolve) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Ignored simplify candidates because no /simplify analysis is pending.",
            },
          ],
          details: {
            ignored: true,
            candidates: [],
            byRisk: { safe: 0, confirm: 0, review: 0 },
          },
          terminate: true,
        };
      }

      const candidates = normalizeCandidates(params.candidates);
      latestToolCandidates = candidates;
      resolvePendingCandidatesTool = null;
      resolve(candidates);

      const byRisk = {
        safe: candidates.filter((c) => c.risk === "safe").length,
        confirm: candidates.filter((c) => c.risk === "confirm").length,
        review: candidates.filter((c) => c.risk === "review").length,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: `Captured ${candidates.length} simplify candidates (${byRisk.safe} safe, ${byRisk.confirm} confirm, ${byRisk.review} review).`,
          },
        ],
        details: { ignored: false, candidates, byRisk },
        terminate: true,
      };
    },
  });

  pi.registerTool(simplifyCandidatesTool);

  function stripMarkdown(text: string): string {
    return text.replace(/[`*]/g, "").trim();
  }

  /**
   * Try to parse a JSON candidates block. The prompt requires this format,
   * but we tolerate the AI wrapping it in ```json ... ``` or ``` ... ```,
   * and also handle the case where it embeds the JSON inline without fences.
   * Returns null only when no valid JSON with a `candidates` array is found —
   * a valid empty list returns [] (which means "the AI found nothing").
   */
  function parseCandidatesJSON(response: string): SimplifyResult[] | null {
    const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/gi;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(response)) !== null) blocks.push(m[1]);

    const bareMatch = response.match(/\{[\s\S]*"candidates"[\s\S]*\}/);
    if (bareMatch) blocks.push(bareMatch[0]);

    // Walk newest-first: the contract puts the JSON at the end of the response.
    for (let i = blocks.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(blocks[i]);
        const list = parsed?.candidates;
        if (!Array.isArray(list)) continue;
        // A valid candidates array (even empty) is a successful parse
        return normalizeCandidates(list);
      } catch {
        // try next block
      }
    }
    return null;
  }

  async function showCandidateSelector(
    ctx: ExtensionCommandContext,
    candidates: SimplifyResult[],
  ): Promise<SimplifyResult[]> {
    if (candidates.length === 0) {
      return [];
    }

    // Categorize by risk level for display
    const safeCandidates = candidates.filter((c) => c.risk === "safe");
    const confirmCandidates = candidates.filter((c) => c.risk === "confirm");
    const reviewCandidates = candidates.filter((c) => c.risk === "review");

    const RISK_CONFIG = {
      safe: { label: "Safe to apply" },
      confirm: { label: "Needs confirmation" },
      review: { label: "Needs review" },
    } as const;
    const ACTION_LABEL: Record<Action, string> = {
      delete: "Delete code",
      inline: "Inline code",
      refactor: "Refactor code",
      parallelize: "Run work in parallel",
    };

    const sections = [
      { key: "safe" as const, items: safeCandidates },
      { key: "confirm" as const, items: confirmCandidates },
      { key: "review" as const, items: reviewCandidates },
    ]
      .map(({ key, items }) => ({ key, items, config: RISK_CONFIG[key], total: items.length }))
      .filter((s) => s.total > 0);

    const selectableItems = sections.flatMap((section) =>
      section.items.map((candidate) => ({ section, candidate })),
    );

    const listItems: SelectItem[] = selectableItems.map(({ section, candidate }, index) => ({
      value: String(index),
      label: "",
      description: `${section.config.label} · ${ACTION_LABEL[candidate.action]}`,
    }));

    // Pre-select all safe items.
    const selectedSet = new Set<number>();
    selectableItems.forEach(({ candidate }, index) => {
      if (candidate.risk === "safe") selectedSet.add(index);
    });

    const maxVisible = 8;
    let cursorPos = 0;

    const getSelectListStartIndex = (selectedIndex: number) =>
      Math.max(
        0,
        Math.min(selectedIndex - Math.floor(maxVisible / 2), selectableItems.length - maxVisible),
      );

    const result = await ctx.ui.custom<SimplifyResult[]>((tui, theme, _keybindings, done) => {
      const updateListLabel = (index: number) => {
        const item = listItems[index];
        const { candidate } = selectableItems[index];
        const checkbox = selectedSet.has(index) ? "[x]" : "[ ]";
        const location = candidate.lines ? `${candidate.file}:${candidate.lines}` : candidate.file;
        item.label = `${checkbox} ${location}`;
      };
      const updateAllListLabels = () => listItems.forEach((_item, index) => updateListLabel(index));

      updateAllListLabels();

      const selectList = new SelectList(listItems, maxVisible, getSelectListTheme());
      selectList.onSelectionChange = (item) => {
        cursorPos = Number(item.value);
      };
      selectList.onCancel = () => done([]);

      return {
        render(width: number) {
          selectList.setSelectedIndex(cursorPos);

          const lines: string[] = [];
          lines.push(theme.bold("Simplify: Select findings to apply"));
          lines.push(
            theme.fg(
              "muted",
              `Found ${candidates.length} candidates (${safeCandidates.length} safe, ${confirmCandidates.length} confirm, ${reviewCandidates.length} review)`,
            ),
          );
          lines.push("");

          const listLines = selectList.render(width);
          const selectedLineIndex = cursorPos - getSelectListStartIndex(cursorPos);
          const current = selectableItems[cursorPos]?.candidate;
          for (const [lineIndex, line] of listLines.entries()) {
            lines.push(line);
            if (lineIndex !== selectedLineIndex || !current) continue;

            const detailIndent = "    ";
            const detailPrefix = `${detailIndent}│ `;
            const location = current.lines ? `${current.file}:${current.lines}` : current.file;
            lines.push(theme.fg("borderMuted", `${detailIndent}┌─ recommendation`));
            lines.push(
              ...wrapTextWithAnsi(current.reason, Math.max(1, width - detailPrefix.length)).map(
                (wrappedLine) => theme.fg("muted", `${detailPrefix}${wrappedLine}`),
              ),
            );
            lines.push(theme.fg("muted", `${detailPrefix}`));
            lines.push(theme.fg("muted", `${detailPrefix}File: ${location}`));
            lines.push(
              theme.fg("muted", `${detailPrefix}Review: ${RISK_CONFIG[current.risk].label}`),
            );
            lines.push(theme.fg("muted", `${detailPrefix}Kind: ${current.category}`));
            lines.push(theme.fg("muted", `${detailPrefix}Fix: ${ACTION_LABEL[current.action]}`));
            lines.push(theme.fg("borderMuted", `${detailIndent}└─ space selects this fix`));
          }

          lines.push("");
          lines.push(
            theme.fg(
              "muted",
              `Selected: ${selectedSet.size} • ↑↓ navigate • space toggle • a select all • enter confirm • esc cancel`,
            ),
          );
          return lines;
        },
        invalidate() {
          selectList.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.enter)) {
            const results = Array.from(selectedSet).map((i) => selectableItems[i].candidate);
            done(results);
            return;
          }
          if (matchesKey(data, Key.escape)) {
            done([]);
            return;
          }
          if (matchesKey(data, Key.space)) {
            if (selectedSet.has(cursorPos)) {
              selectedSet.delete(cursorPos);
            } else {
              selectedSet.add(cursorPos);
            }
            updateListLabel(cursorPos);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "a")) {
            if (selectedSet.size === selectableItems.length) {
              selectedSet.clear();
            } else {
              for (let i = 0; i < selectableItems.length; i++) selectedSet.add(i);
            }
            updateAllListLabels();
            tui.requestRender();
            return;
          }

          const previousCursorPos = cursorPos;
          selectList.handleInput(data);
          if (cursorPos !== previousCursorPos) tui.requestRender();
        },
      };
    });

    return result ?? [];
  }

  async function applyFindings(
    ctx: ExtensionCommandContext,
    selected: SimplifyResult[],
  ): Promise<void> {
    if (selected.length === 0) {
      ctx.ui.notify("No findings selected to apply", "info");
      return;
    }

    const safeItems = selected.filter((c) => c.risk === "safe");
    const confirmItems = selected.filter((c) => c.risk === "confirm");

    const cleanupPrompt = `# Apply Review Findings

Apply the following findings. Each item includes a bracketed action (e.g. \`[delete]\`, \`[refactor]\`, \`[parallelize]\`, \`[inline]\`) — follow that action, not a blanket delete.

${selected.map((c) => `- ${c.file} (${c.lines || "?"}): ${c.reason} [${c.action}]`).join("\n")}

For each item:
1. Read the file to find the exact location
2. Apply only the specified change (not surrounding code unless instructed)
3. For refactor/inline/parallelize: preserve behavior; if the change has visible side effects, stop and report
4. If the change affects other code, stop and report the issue

After applying all changes:
- Run \`npm test\` or equivalent; if there are no tests, verify the files parse/type-check
- Report what changed, test results, and any items skipped with reasons`;

    ctx.ui.notify(
      `Applying ${selected.length} findings (${safeItems.length} safe, ${confirmItems.length} confirmed)`,
      "info",
    );

    pi.sendUserMessage(cleanupPrompt);
  }

  pi.registerCommand("simplify", {
    description: "Review changed code for reuse, quality, and efficiency, then apply fixes",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Simplify requires interactive mode", "error");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Cannot run simplify while agent is busy. Wait for current task to complete.",
          "warning",
        );
        return;
      }

      // Check if in git repo
      const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
      if (code !== 0) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      // Check if there are changes
      const { stdout: gitStatus } = await pi.exec("git", ["status", "--porcelain"]);
      if (!gitStatus.trim()) {
        ctx.ui.notify("No git changes found. Simplify reviews uncommitted changes.", "info");
        return;
      }

      ctx.ui.notify("Analyzing code for review findings...", "info");

      // Build prompt with optional focus
      let fullPrompt = SIMPLIFY_PROMPT;
      if (args.trim()) {
        fullPrompt += `\n\n## Additional Focus\n\n${args.trim()}`;
      }

      // Reset capture state, then send prompt and wait.
      // The preferred path is the structured simplify_candidates tool result.
      // message_end text capture remains as a compatibility fallback for older
      // sessions/models that still return a fenced JSON block.
      assistantTextBuffer = "";
      latestToolCandidates = null;
      const turnStarted = new Promise<void>((r) => {
        resolvePendingTurnStart = r;
      });
      const toolResult = new Promise<SimplifyResult[]>((r) => {
        resolvePendingCandidatesTool = r;
      });

      pi.sendUserMessage(fullPrompt);

      const started = await Promise.race<boolean>([
        turnStarted.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 10000)),
      ]);
      if (!started) {
        resolvePendingTurnStart = null;
        resolvePendingCandidatesTool = null;
        ctx.ui.notify("Analysis did not start within 10 seconds. Please try again.", "warning");
        return;
      }

      await ctx.waitForIdle();

      const candidates =
        latestToolCandidates ??
        (await Promise.race<SimplifyResult[] | null>([
          toolResult,
          new Promise<null>((r) => setTimeout(() => r(null), 100)),
        ])) ??
        parseCandidatesJSON(assistantTextBuffer);
      resolvePendingCandidatesTool = null;

      if (candidates === null) {
        ctx.ui.notify(
          "Could not read review findings — the model did not call simplify_candidates or return fallback JSON.",
          "warning",
        );
        return;
      }

      if (candidates.length === 0) {
        ctx.ui.notify("No review findings found!", "info");
        return;
      }

      ctx.ui.notify(`Found ${candidates.length} findings. Select findings to apply...`, "info");

      // Show selector
      const selected = await showCandidateSelector(ctx, candidates);

      if (!selected || selected.length === 0) {
        ctx.ui.notify("Apply findings cancelled", "info");
        return;
      }

      // Apply selected findings
      await applyFindings(ctx, selected);
    },
  });
}
