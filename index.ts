/**
 * pi-simplify
 *
 * Mimics Claude Code's /simplify skill as a pi coding agent extension.
 * Runs a 3-agent parallel code review (reuse, quality, efficiency) then fixes issues.
 *
 * Usage: /simplify — queues the review, then send any message to start.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";

interface SimplifyState {
	queuedDiff: string | null;
}

const state: SimplifyState = {
	queuedDiff: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// Git diff helpers
// ═══════════════════════════════════════════════════════════════════════════

function getDiff(): string {
	try {
		// Prefer staged+unstaged diff from HEAD; fall back to unstaged only
		let diff = execSync("git diff HEAD", {
			encoding: "utf-8",
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		if (!diff) {
			diff = execSync("git diff", {
				encoding: "utf-8",
				cwd: process.cwd(),
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		}

		return diff;
	} catch {
		return "";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Simplify prompt
// ═══════════════════════════════════════════════════════════════════════════

const SIMPLIFY_INSTRUCTIONS = `\
# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

The git diff is provided above. Use it as the source of truth for what changed.
If there are no changes in the diff, review the most recently modified files.

## Phase 2: Launch Three Review Agents in Parallel

Use the Agent tool to launch all three agents concurrently in a single message.
Pass each agent the full diff so it has complete context.

### Agent 1: Code Reuse Review

For each change:

1. **Search for existing utilities and helpers** that could replace newly written code.
   Look for similar patterns in utility directories, shared modules, and adjacent files.
2. **Flag any new function that duplicates existing functionality.**
   Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string
   manipulation, manual path handling, custom environment checks, ad-hoc type guards.

### Agent 2: Code Quality Review

Review the same changes for hacky patterns:

1. **Redundant state**: duplicates existing state, cached values that could be derived,
   observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters instead of generalizing or restructuring
3. **Copy-paste with slight variation**: near-duplicate blocks that should share an abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated
5. **Stringly-typed code**: raw strings where constants, enums, or branded types already exist
6. **Unnecessary JSX nesting**: wrapper elements with no layout value
7. **Unnecessary comments**: comments explaining WHAT the code does — delete them;
   keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)

### Agent 3: Efficiency Review

Review the same changes for efficiency:

1. **Unnecessary work**: redundant computations, repeated reads, duplicate API calls, N+1
2. **Missed concurrency**: independent operations running sequentially
3. **Hot-path bloat**: new blocking work on startup or per-request/per-render paths
4. **Recurring no-op updates**: unconditional state updates inside polling loops or handlers
5. **Unnecessary existence checks**: pre-checking before operating (TOCTOU anti-pattern)
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only part is needed

## Phase 3: Fix Issues

Wait for all three agents to complete. Aggregate findings and fix each issue directly.
If a finding is a false positive or not worth addressing, note it and move on.

When done, briefly summarize what was fixed (or confirm the code was already clean).`;

function buildContent(diff: string): string {
	if (!diff) {
		return `<git-diff>\n(no changes detected)\n</git-diff>\n\n${SIMPLIFY_INSTRUCTIONS}`;
	}
	return `<git-diff>\n${diff}\n</git-diff>\n\n${SIMPLIFY_INSTRUCTIONS}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════

export default function simplifyExtension(pi: ExtensionAPI): void {
	// Render queued simplify-context messages in chat
	pi.registerMessageRenderer("simplify-context", (message, options, theme) => {
		const rawContent =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content
						.map((c: { type: string; text?: string }) =>
							c.type === "text" ? c.text ?? "" : ""
						)
						.join("")
					: "";

		const container = new Container();

		container.addChild(
			new Text(
				theme.fg("accent", "✨ ") +
				theme.fg("customMessageLabel", theme.bold("Simplify Review")) +
				theme.fg("dim", " — reviewing code changes"),
				1,
				0
			)
		);

		const lines = rawContent.split("\n");
		const PREVIEW = 8;
		const showLines = options.expanded ? lines : lines.slice(0, PREVIEW);

		for (const line of showLines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}

		if (!options.expanded && lines.length > PREVIEW) {
			container.addChild(
				new Text(
					theme.fg("muted", `... ${lines.length - PREVIEW} more lines (click to expand)`),
					1,
					0
				)
			);
		}

		return container;
	});

	// /simplify command: fetch diff and queue the review
	pi.registerCommand("simplify", {
		description: "Review changed code for reuse, quality, and efficiency, then fix issues",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const diff = getDiff();

			if (!diff) {
				ctx.ui.notify(
					"No git changes detected — make some edits first, then run /simplify again.",
					"warning"
				);
				return;
			}

			state.queuedDiff = diff;

			const lineCount = diff.split("\n").length;
			ctx.ui.setStatus("simplify", "✨ Simplify queued");
			ctx.ui.setWidget("simplify", [
				`\x1b[2m✨ Simplify: \x1b[0m\x1b[36m${lineCount} diff lines queued\x1b[0m\x1b[2m — send any message to start review\x1b[0m`,
			]);
			ctx.ui.notify(
				`Simplify review queued (${lineCount} diff lines) — send any message to begin`,
				"info"
			);
		},
	});

	// Inject the diff + instructions before the agent starts
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!state.queuedDiff) return {};

		const diff = state.queuedDiff;
		state.queuedDiff = null;

		ctx.ui?.setStatus("simplify", undefined);
		ctx.ui?.setWidget("simplify", undefined);

		return {
			message: {
				customType: "simplify-context",
				content: buildContent(diff),
				display: true,
			},
		};
	});
}
