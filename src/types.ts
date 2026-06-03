// ── /simplify ─────────────────────────────────────────────────────────────────

export type Category = "reuse" | "quality" | "efficiency";
export type Risk = "safe" | "confirm" | "review";
export type Action = "delete" | "inline" | "refactor" | "parallelize";

export type SimplifyResult = {
  category: Category;
  file: string;
  lines: string;
  /** The underlying problem with the current code. */
  rootIssue: string;
  /** What this problem leads to if left unchanged. */
  consequence: string;
  /** The concrete advantage gained after applying the fix. */
  benefit: string;
  risk: Risk;
  action: Action;
};

// ── /code-smell ───────────────────────────────────────────────────────────────

export type SmellCategory =
  | "complexity"
  | "duplication"
  | "coupling"
  | "state"
  | "errors"
  | "performance"
  | "maintainability";

export type SmellSeverity = "low" | "medium" | "high";
export type SmellConfidence = "low" | "medium" | "high";
export type SmellAction = "inspect" | "delete" | "inline" | "extract" | "refactor" | "guard";

export type CodeSmellFinding = {
  category: SmellCategory;
  severity: SmellSeverity;
  confidence: SmellConfidence;
  file: string;
  lines: string;
  smell: string;
  evidence: string;
  impact: string;
  recommendation: string;
  action: SmellAction;
};

export type ProgrammaticCheck = {
  id: string;
  title: string;
  category: SmellCategory;
  severity: SmellSeverity;
  file: string;
  lines: string;
  evidence: string;
  recommendation: string;
};
