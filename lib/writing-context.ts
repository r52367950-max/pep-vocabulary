import { learningContextStore } from "./learning-context-client";

export type WritingContext = { epoch: number; temporary: boolean; accountScope: string | null; revision: number | null };
export function captureWritingContext(): WritingContext {
  const state = learningContextStore.get();
  return { epoch: state.epoch, temporary: state.temporary, accountScope: state.memory?.accountScope ?? null, revision: state.memory?.revision ?? null };
}
export function writingContextCurrent(context: WritingContext) {
  const current = captureWritingContext();
  return Object.keys(context).every((key) => current[key as keyof WritingContext] === context[key as keyof WritingContext]);
}
export class WritingContextChangedError extends Error {
  constructor() { super("账户或学习模式已改变，本次批改已取消，未保存新的反馈。请重新开始。"); }
}
/** Check again when a queued write starts, not only when the keystroke/request was made. */
export async function writeWritingInContext(context: WritingContext, write: () => Promise<unknown>, signal?: AbortSignal) {
  if (signal?.aborted || !writingContextCurrent(context)) throw new WritingContextChangedError();
  if (context.temporary) return false;
  await write();
  return true;
}
