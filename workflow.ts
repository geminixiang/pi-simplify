import {
  defineTool,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SIMPLIFY_PROMPT } from "./prompt.js";
import { showCandidateSelector } from "./selector.js";
import type { SimplifyResult } from "./types.js";

const categorySchema = Type.Union([
  Type.Literal("reuse"),
  Type.Literal("quality"),
  Type.Literal("efficiency"),
]);
const riskSchema = Type.Union([
  Type.Literal("safe"),
  Type.Literal("confirm"),
  Type.Literal("review"),
]);
const actionSchema = Type.Union([
  Type.Literal("delete"),
  Type.Literal("inline"),
  Type.Literal("refactor"),
  Type.Literal("parallelize"),
]);

function registerSimplifyCandidatesTool(
  pi: ExtensionAPI,
  state: {
    getResolver: () => ((candidates: SimplifyResult[]) => void) | null;
    clearResolver: () => void;
    setLatestCandidates: (candidates: SimplifyResult[]) => void;
  },
) {
  const parameters = Type.Object({
    candidates: Type.Array(
      Type.Object({
        category: categorySchema,
        risk: riskSchema,
        file: Type.String({
          description: "Repository-relative path",
          minLength: 1,
          pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
        }),
        lines: Type.String({ description: "Line number or range, or empty string if unknown" }),
        reason: Type.String({ description: "Concrete fix in one sentence" }),
        action: actionSchema,
      }),
    ),
  });

  pi.registerTool(
    defineTool({
      name: "simplify_candidates",
      label: "Simplify Candidates",
      description:
        "Return the complete candidate list for /simplify. Use as the final action after analyzing changed code.",
      promptSnippet: "Return structured cleanup candidates for /simplify as a terminating result",
      promptGuidelines: [
        "Use simplify_candidates exactly once as the final action when the /simplify command asks for cleanup candidates.",
      ],
      parameters,
      async execute(_toolCallId, params) {
        const candidates: SimplifyResult[] = params.candidates;
        const resolve = state.getResolver();
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

        state.setLatestCandidates(candidates);
        state.clearResolver();
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
    }),
  );
}

async function applyFindings(
  ctx: ExtensionCommandContext,
  selected: SimplifyResult[],
  pi: ExtensionAPI,
) {
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

export function registerSimplifyWorkflow(pi: ExtensionAPI) {
  let resolvePendingTurnStart: (() => void) | null = null;
  let resolvePendingCandidatesTool: ((candidates: SimplifyResult[]) => void) | null = null;
  let latestToolCandidates: SimplifyResult[] | null = null;

  pi.on("turn_start", () => {
    if (!resolvePendingTurnStart) return;
    const resolve = resolvePendingTurnStart;
    resolvePendingTurnStart = null;
    resolve();
  });

  registerSimplifyCandidatesTool(pi, {
    getResolver: () => resolvePendingCandidatesTool,
    clearResolver: () => {
      resolvePendingCandidatesTool = null;
    },
    setLatestCandidates: (candidates) => {
      latestToolCandidates = candidates;
    },
  });

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

      const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
      if (code !== 0) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      const { stdout: gitStatus } = await pi.exec("git", ["status", "--porcelain"]);
      if (!gitStatus.trim()) {
        ctx.ui.notify("No git changes found. Simplify reviews uncommitted changes.", "info");
        return;
      }

      ctx.ui.notify("Analyzing code for review findings...", "info");

      let fullPrompt = SIMPLIFY_PROMPT;
      if (args.trim()) fullPrompt += `\n\n## Additional Focus\n\n${args.trim()}`;

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
        ]));
      resolvePendingCandidatesTool = null;

      if (candidates === null) {
        ctx.ui.notify(
          "Could not read review findings — the model did not call simplify_candidates.",
          "warning",
        );
        return;
      }

      if (candidates.length === 0) {
        ctx.ui.notify("No review findings found!", "info");
        return;
      }

      ctx.ui.notify(`Found ${candidates.length} findings. Select findings to apply...`, "info");

      const selected = await showCandidateSelector(ctx, candidates);
      if (!selected || selected.length === 0) {
        ctx.ui.notify("Apply findings cancelled", "info");
        return;
      }

      await applyFindings(ctx, selected, pi);
    },
  });
}
