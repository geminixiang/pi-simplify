/**
 * pi-simplify: Code Cleanup Extension for pi
 *
 * Removes leftover code after feature implementation:
 * - Dead code (unused exports, orphaned files)
 * - Debug remnants (console.log, debugger, temp flags)
 * - Commented-out code
 * - Over-engineering ("might use later" abstractions)
 * - Duplicate logic
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, type SelectItem } from "@mariozechner/pi-tui";

type SimplifyResult = {
  file: string;
  lines: string;
  reason: string;
  risk: "safe" | "confirm" | "review";
};

const SIMPLIFY_PROMPT = `# Simplify: Clean Up Leftover Code

You are a code cleanup assistant. Your job is to identify and remove unnecessary code left over after feature implementation.

## What to Find

### 1. Dead Code (Safe to Delete)
- **Unused exports**: Functions/classes defined but never imported elsewhere
- **Orphan files**: Files created but never referenced
- **Zombie variables**: Variables assigned but never used
- **Empty blocks**: try/catch/if blocks with no logic

### 2. Debug Remnants (Safe to Delete)
- console.log, console.warn, console.error statements
- debugger statements
- Temporary feature flags (e.g., \`ENABLE_DEBUG\`, \`DEBUG_MODE\`)
- Temporary todo comments that are now implemented

### 3. Commented-out Code (Review Before Deleting)
- Old logic left in comments
- Disabled features (commented out rather than deleted)
- Copy-pasted templates never customized

### 4. Over-engineering (Confirm Before Deleting)
- Abstractions created "for future use" but never used
- Helper functions with single call sites (could be inlined)
- Layers of indirection that add no value

### 5. Duplicate Logic (Confirm Before Deleting)
- Repeated if-else blocks doing the same thing
- Copy-paste code with minor variations
- Duplicate utility functions

## How to Analyze

1. Run \`git diff\` to see what changed
2. For each change, determine if it's:
   - **Essential**: Required for the feature to work
   - **Residual**: Left over from development/debugging
   - **Legacy**: Old code not touched by this change

3. For each residual item:
   - Identify exact file and line(s)
   - Assess risk level
   - Provide clear reason for removal

## Risk Levels

- **safe**: Definitely can be deleted (unused, debug code)
- **confirm**: Delete after user confirms (over-engineered, duplicates)
- **review**: User should review before action (commented code, ambiguous)

## Rules

1. When in doubt, mark as "confirm" or "review" - don't delete without consent
2. For inline candidates, show the alternative
3. Don't flag necessary code just because it's simple
4. Respect existing abstraction boundaries
5. Be especially careful with:
   - Error handling code
   - Security-related logic
   - Code that looks "unused" but is called via reflection/eval
   - Database migration files

## Output Format (REQUIRED)

You may write prose analysis first, but you MUST end your response with a single fenced JSON block containing ALL candidates. This JSON is parsed programmatically — it must be valid JSON and use this exact shape:

\`\`\`json
{
  "candidates": [
    {
      "risk": "safe",
      "file": "path/to/file.ext",
      "lines": "12-15",
      "reason": "Why this should be removed",
      "action": "delete"
    }
  ]
}
\`\`\`

Field notes:
- \`risk\` — one of: "safe", "confirm", "review"
- \`file\` — repository-relative path, no backticks, no markdown
- \`lines\` — line number or range ("42" or "42-57"); empty string if unknown
- \`reason\` — single plain-text sentence
- \`action\` — one of: "delete", "inline", "confirm" (appended to reason)

If there are no candidates, output \`{"candidates": []}\`. Do NOT output anything after the closing \`\`\` fence.
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

  const RISK_VALUES = new Set(["safe", "confirm", "review"]);

  function normalizeRisk(value: unknown): "safe" | "confirm" | "review" {
    const v = String(value ?? "")
      .toLowerCase()
      .trim();
    return RISK_VALUES.has(v) ? (v as "safe" | "confirm" | "review") : "review";
  }

  function stripMarkdown(text: string): string {
    return text.replace(/[`*_]/g, "").trim();
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
        const out: SimplifyResult[] = [];
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const file = stripMarkdown(String(item.file ?? item.location ?? ""));
          // Validate path is within repo (no path traversal)
          if (!file || file.includes("..") || file.startsWith("/")) continue;
          const reason = stripMarkdown(String(item.reason ?? item.description ?? ""));
          const action = item.action ? ` [${stripMarkdown(String(item.action))}]` : "";
          out.push({
            file,
            lines: stripMarkdown(String(item.lines ?? "")),
            reason: reason ? reason + action : action.trim() || "(no reason provided)",
            risk: normalizeRisk(item.risk),
          });
        }
        // A valid candidates array (even empty) is a successful parse
        return out;
      } catch {
        // try next block
      }
    }
    return null;
  }

  /**
   * Show selection dialog for candidates with proper multi-select support
   */
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
      safe: { label: "Safe to delete", description: "Will be deleted", selected: true },
      confirm: { label: "Needs confirmation", description: "Select to delete", selected: false },
      review: { label: "Needs review", description: "Review before deleting", selected: false },
    } as const;

    const sections = [
      { key: "safe" as const, items: safeCandidates },
      { key: "confirm" as const, items: confirmCandidates },
      { key: "review" as const, items: reviewCandidates },
    ]
      .map(({ key, items }) => ({ key, items, config: RISK_CONFIG[key], total: items.length }))
      .filter((s) => s.total > 0);

    const displayItems: SelectItem[] = [];
    const selectableItems: { index: number; candidate: SimplifyResult }[] = [];
    let globalIndex = 0;

    for (const section of sections) {
      displayItems.push({
        value: `__section__${section.key}__`,
        label: `── ${section.config.label} (${section.total}) ──`,
        description: "",
      });
      globalIndex++;
      for (const c of section.items) {
        displayItems.push({
          value: JSON.stringify(c),
          label: `${c.file} - ${c.reason}`,
          description: section.config.description,
        });
        selectableItems.push({ index: globalIndex++, candidate: c });
      }
    }

    // Pre-select all safe items
    const selectedSet = new Set<number>(
      safeCandidates.length > 0 ? Array.from({ length: safeCandidates.length }, (_, i) => i) : [],
    );

    const maxVisible = 12;
    let scrollOffset = 0;
    let cursorPos = 0;

    const result = await ctx.ui.custom<SimplifyResult[]>((tui, theme, _keybindings, done) => {
      // Render the multi-select list manually
      const renderList = (width: number): string[] => {
        const lines: string[] = [];

        // Calculate which items are visible
        const visibleItems: { selectableIdx: number | null; item: SelectItem }[] = [];
        for (let i = 0; i < displayItems.length; i++) {
          const item = displayItems[i];
          if (item.value.startsWith("__section__")) {
            visibleItems.push({ selectableIdx: null, item });
          } else {
            const selectableIdx = selectableItems.findIndex((si) => si.index === i);
            if (selectableIdx >= 0) {
              visibleItems.push({ selectableIdx, item: displayItems[i] });
            }
          }
        }

        // Show visible range with scroll
        const startIdx = Math.max(0, scrollOffset);
        const endIdx = Math.min(visibleItems.length, startIdx + maxVisible);

        for (let vIdx = startIdx; vIdx < endIdx; vIdx++) {
          const { selectableIdx, item } = visibleItems[vIdx];

          if (item.value.startsWith("__section__")) {
            // Section header
            lines.push(theme.fg("accent", item.label));
          } else {
            // Selectable item
            const isCursor = selectableIdx === cursorPos;
            const isSelected = selectableIdx !== null && selectedSet.has(selectableIdx);
            const prefix = isCursor ? theme.fg("accent", "> ") : "  ";
            const checkbox = isSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
            const truncatedLabel = truncateToWidth(item.label, width - 6);
            const line = `${prefix}${checkbox} ${truncatedLabel}`;
            lines.push(isCursor ? theme.fg("accent", line) : line);
          }
        }

        // Scroll indicator
        if (visibleItems.length > maxVisible) {
          const scrollInfo = `  (${startIdx + 1}-${endIdx}/${visibleItems.length})`;
          lines.push(theme.fg("dim", scrollInfo));
        }

        return lines;
      };

      return {
        render(width: number) {
          const lines: string[] = [];
          lines.push(theme.bold("Simplify: Select items to remove"));
          lines.push(
            theme.fg(
              "muted",
              `Found ${candidates.length} candidates (${safeCandidates.length} safe, ${confirmCandidates.length} confirm, ${reviewCandidates.length} review)`,
            ),
          );
          lines.push("");
          lines.push(...renderList(width));
          lines.push("");
          lines.push(
            theme.fg(
              "muted",
              `Selected: ${selectedSet.size} • ↑↓ navigate • space toggle • a select all • enter confirm • esc cancel`,
            ),
          );
          return lines;
        },
        invalidate() {},
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
            // Toggle current selection
            if (selectedSet.has(cursorPos)) {
              selectedSet.delete(cursorPos);
            } else {
              selectedSet.add(cursorPos);
            }
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "a")) {
            // Select/deselect all
            if (selectedSet.size === selectableItems.length) {
              selectedSet.clear();
            } else {
              for (let i = 0; i < selectableItems.length; i++) {
                selectedSet.add(i);
              }
            }
            tui.requestRender();
            return;
          }

          // Navigation
          if (matchesKey(data, Key.down)) {
            cursorPos = Math.min(selectableItems.length - 1, cursorPos + 1);
            // Ensure cursor is within visible window
            const displayIdx = selectableItems[cursorPos].index;
            if (displayIdx >= scrollOffset + maxVisible) {
              scrollOffset = displayIdx - maxVisible + 1;
            }
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.up)) {
            cursorPos = Math.max(0, cursorPos - 1);
            // Ensure cursor is within visible window
            const displayIdx = selectableItems[cursorPos].index;
            if (displayIdx < scrollOffset) {
              // Scroll up to show the item, and include section header if it's just above
              scrollOffset = Math.max(0, displayIdx - 1);
            }
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.home)) {
            cursorPos = 0;
            scrollOffset = 0;
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.end)) {
            cursorPos = selectableItems.length - 1;
            const lastDisplayIdx = selectableItems[cursorPos].index;
            scrollOffset = Math.max(0, lastDisplayIdx - maxVisible + 1);
            tui.requestRender();
            return;
          }
        },
      };
    });

    return result ?? [];
  }

  /**
   * Execute the cleanup by sending deletion commands
   */
  async function executeCleanup(
    ctx: ExtensionCommandContext,
    selected: SimplifyResult[],
  ): Promise<void> {
    if (selected.length === 0) {
      ctx.ui.notify("No items selected for cleanup", "info");
      return;
    }

    const safeItems = selected.filter((c) => c.risk === "safe");
    const confirmItems = selected.filter((c) => c.risk === "confirm");

    // Build cleanup prompt with verification step
    const cleanupPrompt = `# Cleanup Instructions

Delete the following code:

${selected.map((c) => `- ${c.file}: ${c.reason}`).join("\n")}

For each item:
1. Read the file to find the exact location
2. Remove only the specified code (not surrounding code unless instructed)
3. If the removal affects other code, stop and report the issue
4. After all deletions, verify the code still works by running any existing tests

IMPORTANT: After completing deletions:
- Run \`npm test\` or equivalent test command
- If tests fail, report which tests failed and whether it's related to the cleanup
- If there are no tests, at least verify the files parse correctly (e.g., \`node --check\`)

Report:
- What was deleted
- Test results (pass/fail)
- Any issues encountered
- Files that may need further attention`;

    ctx.ui.notify(
      `Starting cleanup of ${selected.length} items (${safeItems.length} safe, ${confirmItems.length} confirmed)`,
      "info",
    );

    pi.sendUserMessage(cleanupPrompt);
  }

  /**
   * Main command handler
   */
  pi.registerCommand("simplify", {
    description: "Clean up leftover code (dead code, debug remnants, over-engineering)",
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

      ctx.ui.notify("Analyzing code for cleanup candidates...", "info");

      // Build prompt with optional focus
      let fullPrompt = SIMPLIFY_PROMPT;
      if (args.trim()) {
        fullPrompt += `\n\n## Additional Focus\n\n${args.trim()}`;
      }

      // Reset capture buffer, then send prompt and wait.
      // message_end events append to assistantTextBuffer during the turn.
      //
      // Wait for the queued analysis turn to actually begin before waiting for
      // idle; otherwise waitForIdle() can return immediately while the agent is
      // still idle and the queued prompt has not started yet.
      assistantTextBuffer = "";
      const turnStarted = new Promise<void>((r) => {
        resolvePendingTurnStart = r;
      });

      pi.sendUserMessage(fullPrompt);

      const started = await Promise.race<boolean>([
        turnStarted.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 10000)),
      ]);
      if (!started) {
        resolvePendingTurnStart = null;
        ctx.ui.notify("Analysis did not start within 10 seconds. Please try again.", "warning");
        return;
      }

      await ctx.waitForIdle();
      const analysisText = assistantTextBuffer;

      if (!analysisText) {
        ctx.ui.notify("Could not read analysis — no response captured.", "error");
        return;
      }

      const candidates = parseCandidatesJSON(analysisText);

      if (candidates === null) {
        ctx.ui.notify(
          "Could not parse cleanup candidates — the model did not return the expected JSON block.",
          "warning",
        );
        return;
      }

      if (candidates.length === 0) {
        ctx.ui.notify("No cleanup candidates found!", "info");
        return;
      }

      ctx.ui.notify(`Found ${candidates.length} candidates. Select items to remove...`, "info");

      // Show selector
      const selected = await showCandidateSelector(ctx, candidates);

      if (!selected || selected.length === 0) {
        ctx.ui.notify("Cleanup cancelled", "info");
        return;
      }

      // Execute cleanup
      await executeCleanup(ctx, selected);
    },
  });

  /**
   * Quick simplify - auto-clean safe items only
   */
  pi.registerCommand("simplify-quick", {
    description: "Quick cleanup of obviously safe items (debug code, unused exports)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Simplify requires interactive mode", "error");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Try again after current task.", "warning");
        return;
      }

      const quickPrompt = `# Quick Cleanup

Find and delete ONLY the most obviously safe cleanup items:

1. \`console.log\`, \`console.warn\`, \`console.error\` statements
2. \`debugger\` statements
3. Unused \`import\` statements (imported but never used)
4. Empty \`catch\` blocks (just \`catch (e) {}\`)
5. Unused \`const\`/\`let\`/\`var\` declarations

DO NOT delete:
- Commented-out code
- Over-engineered abstractions
- Duplicate logic
- Anything that might be needed

For each item found:
1. Confirm it's truly unused by searching for references
2. Delete only the specific lines
3. Report what was deleted

Return a summary of what was deleted.`;

      ctx.ui.notify("Running quick cleanup...", "info");
      pi.sendUserMessage(quickPrompt, { deliverAs: "followUp" });
    },
  });

  /**
   * Status indicator on startup
   */
  /**pi.on("session_start", async (_event, ctx) => {
    const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
    if (code === 0) {
      ctx.ui.setStatus(
        "simplify",
        `${ctx.ui.theme.fg("accent", "simplify")} ${ctx.ui.theme.fg("muted", "ready (try /simplify)")}`,
      );
    }
  });
  */
}
