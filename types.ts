export type Category = "reuse" | "quality" | "efficiency";
export type Risk = "safe" | "confirm" | "review";
export type Action = "delete" | "inline" | "refactor" | "parallelize";

export type SimplifyResult = {
  category: Category;
  file: string;
  lines: string;
  reason: string;
  risk: Risk;
  action: Action;
};
