import type { Difficulty, ReadingCategory } from "./reading-library";

export function parseClassification(input: string): { category: ReadingCategory; difficulty: Difficulty } {
  const clean = input.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const value: unknown = JSON.parse(clean);
  if (!value || typeof value !== "object") throw new Error("分类结果格式无效。");
  const a = value as { category: ReadingCategory; difficulty: Difficulty };
  if (!["essay", "fiction", "science"].includes(a.category) || !["A2", "B1", "B2", "C1"].includes(a.difficulty)) throw new Error("分类结果超出支持范围。");
  return { category: a.category, difficulty: a.difficulty };
}
