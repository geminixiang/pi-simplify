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
import {
  Container,
  Box,
  Spacer,
  Text,
  SelectList,
  matchesKey,
  Key,
  truncateToWidth,
  type SelectItem,
} from "@mariozechner/pi-tui";

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

## Output Format

For each candidate, output in this format:

\`\`\`
## [risk-level] file:line - Brief Description
- Type: (dead-code|debug|commented|over-eng|duplicate)
- Location: \`path/to/file.ext:123-456\`
- Reason: Why this should be removed
- Action: (delete|inline|confirm)
\`\`\`

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

## Result

Start your response with one of:
- "## Candidates Found: N" (followed by your analysis)
- "## No Candidates" (if everything looks necessary)
- "## Error" (if you couldn't complete the analysis)

After listing candidates, end with:
"## Ready for cleanup" if you found anything, or "## Code is clean" if not.
`;

export default function simplifyExtension(pi: ExtensionAPI) {
  /**
   * Parse the AI's response to extract cleanup candidates
   */
  function parseCandidates(response: string): SimplifyResult[] {
    const candidates: SimplifyResult[] = [];
    const lines = response.split("\n");
    let currentCandidate: Partial<SimplifyResult> | null = null;
    let currentReason = "";

    for (const line of lines) {
      // Look for risk level markers: [safe], [confirm], [review]
      const riskMatch = line.match(/^\s*##\s*\[(safe|confirm|review)\]\s*(.+?)\s*-\s*(.+)$/);
      if (riskMatch) {
        // Save previous candidate
        if (currentCandidate && currentCandidate.file && currentReason) {
          candidates.push({
            file: currentCandidate.file,
            lines: currentCandidate.lines || "",
            reason: currentReason.trim(),
            risk: currentCandidate.risk || "review",
          });
        }

        const [, risk, location, description] = riskMatch;
        currentCandidate = {
          risk: risk as "safe" | "confirm" | "review",
          file: location,
          lines: description,
        };
        currentReason = "";
        continue;
      }

      // Collect reason lines
      if (currentCandidate) {
        const typeMatch = line.match(/^\s*-\s*Type:\s*(.+)$/);
        const locationMatch = line.match(/^\s*-\s*Location:\s*`(.+)`/);
        const reasonMatch = line.match(/^\s*-\s*Reason:\s*(.+)$/);
        const actionMatch = line.match(/^\s*-\s*Action:\s*(.+)$/);

        if (typeMatch) {
          currentCandidate.lines = typeMatch[1];
        }
        if (locationMatch) {
          currentCandidate.lines = locationMatch[1];
        }
        if (reasonMatch) {
          currentReason = reasonMatch[1];
        }
        if (actionMatch) {
          currentReason += ` [${actionMatch[1]}]`;
        }
      }
    }

    // Don't forget the last candidate
    if (currentCandidate && currentCandidate.file && currentReason) {
      candidates.push({
        file: currentCandidate.file,
        lines: currentCandidate.lines || "",
        reason: currentReason.trim(),
        risk: currentCandidate.risk || "review",
      });
    }

    return candidates;
  }

  /**
   * Show selection dialog for candidates
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

    // Build items with checkbox-style labels
    const items: SelectItem[] = [];
    const indexToCandidate = new Map<number, SimplifyResult>();

    if (safeCandidates.length > 0) {
      items.push({
        value: "__section__safe__",
        label: `── Safe to delete (${safeCandidates.length}) ──`,
        description: "",
      });
      for (const c of safeCandidates) {
        const idx = items.length;
        items.push({
          value: JSON.stringify(c),
          label: `  [x] ${c.file} - ${truncateToWidth(c.reason, 40)}`,
          description: "Will be deleted",
        });
        indexToCandidate.set(idx, c);
      }
    }

    if (confirmCandidates.length > 0) {
      items.push({
        value: "__section__confirm__",
        label: `── Needs confirmation (${confirmCandidates.length}) ──`,
        description: "",
      });
      for (const c of confirmCandidates) {
        const idx = items.length;
        items.push({
          value: JSON.stringify(c),
          label: `  [ ] ${c.file} - ${truncateToWidth(c.reason, 40)}`,
          description: "Select to delete",
        });
        indexToCandidate.set(idx, c);
      }
    }

    if (reviewCandidates.length > 0) {
      items.push({
        value: "__section__review__",
        label: `── Needs review (${reviewCandidates.length}) ──`,
        description: "",
      });
      for (const c of reviewCandidates) {
        const idx = items.length;
        items.push({
          value: JSON.stringify(c),
          label: `  [ ] ${c.file} - ${truncateToWidth(c.reason, 40)}`,
          description: "Review before deleting",
        });
        indexToCandidate.set(idx, c);
      }
    }

    // Track selected items
    const selectedIndices = new Set<number>();
    const safeStartIdx = safeCandidates.length > 0 ? 1 : 0;
    const safeEndIdx = safeStartIdx + safeCandidates.length;

    // Pre-select all safe items
    for (let i = safeStartIdx; i < safeEndIdx; i++) {
      selectedIndices.add(i);
    }

    const result = await ctx.ui.custom<SimplifyResult[]>((tui, theme, _keybindings, done) => {
      const container = new Container();

      // Header box
      const header = new Box(1, 0);
      header.addChild(new Text(theme.fg("accent", theme.bold("Simplify: Select items to remove"))));
      container.addChild(header);

      // Summary line
      const summary = `Found ${candidates.length} candidates (${safeCandidates.length} safe, ${confirmCandidates.length} confirm, ${reviewCandidates.length} review)`;
      container.addChild(new Text(theme.fg("muted", summary)));
      container.addChild(new Spacer(1));

      // Use SelectList for navigation, toggle with space
      const selectList = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (_text) => theme.fg("accent", "> "),
        selectedText: (text) => {
          // Check if this item is selected based on text matching
          for (const [idx, candidate] of indexToCandidate) {
            const checkMark = selectedIndices.has(idx)
              ? theme.fg("success", "[x]")
              : theme.fg("dim", "[ ]");
            if (text.includes(candidate.file)) {
              return text.replace(/\[.?\]/, checkMark);
            }
          }
          return text;
        },
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });

      // Scroll to show safe items first
      selectList.setSelectedIndex(safeStartIdx);

      container.addChild(selectList);
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          theme.fg(
            "muted",
            `Selected: ${selectedIndices.size} • space toggle • enter confirm • esc cancel`,
          ),
        ),
      );

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.enter)) {
            // Return selected candidates
            const results: SimplifyResult[] = [];
            for (const idx of selectedIndices) {
              const candidate = indexToCandidate.get(idx);
              if (candidate) {
                results.push(candidate);
              }
            }
            done(results);
            return;
          }
          if (matchesKey(data, Key.escape)) {
            done([]);
            return;
          }
          if (matchesKey(data, Key.space)) {
            // Toggle current selection
            const currentItem = selectList.getSelectedItem();
            if (currentItem && !currentItem.value.startsWith("__section__")) {
              const currentIdx = items.findIndex((i) => i.value === currentItem.value);
              if (selectedIndices.has(currentIdx)) {
                selectedIndices.delete(currentIdx);
              } else {
                selectedIndices.add(currentIdx);
              }
              // Move to next item
              selectList.setSelectedIndex(currentIdx + 1);
            }
            tui.requestRender();
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
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

    // Build cleanup prompt
    const cleanupPrompt = `# Cleanup Instructions

Delete the following code:

${selected.map((c) => `- ${c.file}: ${c.reason}`).join("\n")}

For each item:
1. Read the file to find the exact location
2. Remove only the specified code (not surrounding code unless instructed)
3. If the removal affects other code, stop and report the issue
4. After all deletions, verify the code still works by running any existing tests

Report:
- What was deleted
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

      // Send to agent for analysis
      pi.sendUserMessage(fullPrompt);

      // Wait for analysis to complete
      await ctx.waitForIdle();

      // Get the analysis from session
      const entries = ctx.sessionManager.getEntries();
      let analysisText = "";

      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                if (block.text.includes("## ")) {
                  analysisText = block.text;
                  break;
                }
              }
            }
          }
          if (analysisText) break;
        }
      }

      if (!analysisText || analysisText.includes("No Candidates")) {
        ctx.ui.notify("No cleanup candidates found!", "info");
        return;
      }

      if (analysisText.includes("## Error")) {
        ctx.ui.notify("Analysis failed. Check the conversation for details.", "error");
        return;
      }

      // Parse candidates from analysis
      const candidates = parseCandidates(analysisText);

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
  pi.on("session_start", async (_event, ctx) => {
    const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
    if (code === 0) {
      ctx.ui.setStatus(
        "simplify",
        `${ctx.ui.theme.fg("accent", "simplify")} ${ctx.ui.theme.fg("muted", "ready (try /simplify)")}`,
      );
    }
  });
}
