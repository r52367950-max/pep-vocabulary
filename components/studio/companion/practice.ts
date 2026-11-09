export type PracticeItem = { id: string; text: string; meaning?: string; source?: string };
export type MistakeKind = "near-miss" | "spelling" | "confusion" | "recall";
export type Score = { correct: boolean; explanation: string; kind?: MistakeKind };
export type PlanScope = "mistakes" | "due" | "unit4" | "file";
export type PlanSpec = { minutes: number; scope: PlanScope; fileName?: string; fileItems?: PracticeItem[] };
