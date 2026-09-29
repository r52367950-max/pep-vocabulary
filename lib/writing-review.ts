/** Saved reviews are untrusted backup/cache data, even after an earlier model validation. */
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown, check: (value: unknown) => boolean) => value == null || check(value);
const list = (value: unknown, check: (value: unknown) => boolean) => Array.isArray(value) && value.length <= 100 && value.every(check);
const fields = (value: unknown, names: string[], nullable: string[] = []) => record(value) &&
  names.every((name) => text(value[name])) && nullable.every((name) => optional(value[name], text));
const issueTypes = ["grammar", "spelling", "word-choice", "collocation", "coherence", "punctuation", "style"];

/** Newer blocks stay optional so earlier, valid 1.2.0 writing backups still import. */
export function validWritingReview(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  return ["kind", "origin", "overall", "revised"].every((key) => optional(value[key], text)) &&
    ["estimatedScore", "outOf"].every((key) => optional(value[key], number)) &&
    optional(value.scores, (scores) => record(scores) && Object.values(scores).every(number)) &&
    optional(value.issues, (rows) => list(rows, (row) => fields(row, ["quote", "type", "suggestion", "reason"]) && issueTypes.includes(String((row as Record<string, unknown>).type)))) &&
    optional(value.targetWords, (rows) => list(rows, (row) => fields(row, ["wordId", "status", "note"]))) &&
    optional(value.upgrades, (rows) => list(rows, (row) => fields(row, ["original", "better", "note"]))) &&
    ["nextSteps", "limitations", "evidenceIds"].every((key) => optional(value[key], (rows) => list(rows, text))) &&
    optional(value.band, (band) => record(band) && number(band.level) && Number.isInteger(band.level) &&
      Number(band.level) >= 1 && Number(band.level) <= 5 && Array.isArray(band.range) && band.range.length === 2 && band.range.every(number) && optional(band.reason, text)) &&
    optional(value.structure, (shape) => record(shape) && list(shape.outline, (row) => fields(row, ["part", "comment"])) && list(shape.cohesion, text) && optional(shape.comment, text)) &&
    optional(value.sentences, (shape) => record(shape) && list(shape.strong, (row) => fields(row, ["quote", "pattern"], ["comment"])) &&
      list(shape.rewrites, (row) => fields(row, ["original", "better", "pattern"], ["note"])) && optional(shape.comment, text)) &&
    optional(value.continuation, (shape) => fields(shape, [], ["linkage", "plot"]));
}
