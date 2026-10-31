export type StudyShortcut =
  | { action: "check" | "play" | "undo" }
  | { action: "rate"; rating: 1 | 2 | 3 | 4 };

/** Buttons retain native Space activation; other shortcuts work after focus moves to them. */
export function studyShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "repeat" | "isComposing" | "ctrlKey" | "metaKey" | "altKey"
  >,
  state: {
    revealed: boolean;
    correct: boolean | null;
    busy: boolean;
    editing: boolean;
    button: boolean;
  },
): StudyShortcut | null {
  if (
    event.repeat || event.isComposing || event.ctrlKey || event.metaKey ||
    event.altKey || state.busy || state.editing
  )
    return null;
  if (event.code === "Space")
    return state.button
      ? null
      : state.revealed
        ? { action: "rate", rating: state.correct === false ? 1 : 3 }
        : { action: "check" };
  if (state.revealed && /^[1-4]$/.test(event.key))
    return { action: "rate", rating: Number(event.key) as 1 | 2 | 3 | 4 };
  if (event.key.toLowerCase() === "r") return { action: "play" };
  if (event.key.toLowerCase() === "z") return { action: "undo" };
  return null;
}
