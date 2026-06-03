/**
 * pi-simplify: Code Review & Cleanup Extension for pi
 *
 * /simplify — reviews changed code for reuse, quality, and efficiency
 * /code-smell — finds structural problems with programmatic checks and agent review
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCodeSmellWorkflow } from "./code-smell-workflow.js";
import { registerSimplifyWorkflow } from "./workflow.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function simplifyExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [path.join(__dirname, "skills")],
  }));

  registerSimplifyWorkflow(pi);
  registerCodeSmellWorkflow(pi);
}
