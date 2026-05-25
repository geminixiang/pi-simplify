/**
 * pi-simplify: Code Review & Cleanup Extension for pi
 *
 * Reviews changed code for reuse, quality, and efficiency:
 * - Reuse: replace newly-written code with existing utilities
 * - Quality: dead code, debug remnants, commented-out code, over-engineering, duplicate logic
 * - Efficiency: redundant work, missed concurrency, hot-path bloat, memory leaks
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSimplifyWorkflow } from "./workflow.js";

export default function simplifyExtension(pi: ExtensionAPI) {
  registerSimplifyWorkflow(pi);
}
