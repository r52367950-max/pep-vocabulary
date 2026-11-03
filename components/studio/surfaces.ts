import { memo } from "react";
import { preloadable } from "./preloadable";

// Code-split surfaces of the app. Each one renders without a loading step once preloaded:
// the shell warms the likely next steps in idle time, and pointer or focus intent warms the rest.

// A surface counts as loaded only together with its stylesheet, so it never paints unstyled.
const styled = <T,>(load: () => Promise<T>) => () => Promise.all([load(), import("./surface-styles")]).then(([module]) => module);

// Rendered as soon as their parent opens, so the parent counts as ready only with them.
export const WordAi = preloadable(styled(() => import("./ai/word-ai")));
export const SentenceOutput = preloadable(styled(() => import("./ai/sentence-output")));

// Memoized: once visited, these stay mounted behind <Activity> and skip unrelated shell renders.
export const Lexicon = preloadable(styled(() => import("./lexicon").then((m) => ({ default: memo(m.default) }))));
export const Reading = preloadable(styled(() => import("./reading").then((m) => ({ default: memo(m.default) }))));
export const ActivityView = preloadable(styled(() => import("./activity").then((m) => ({ default: memo(m.default) }))));

export const VocabularyPractice = preloadable(styled(() => import("./vocabulary-practice")));
export const SettingsDialog = preloadable(styled(() => import("./settings-dialog")));
export const StudySession = preloadable(styled(() => Promise.all([import("./study-session"), SentenceOutput.preload()]).then(([m]) => m)));
export const WordDetail = preloadable(styled(() => Promise.all([import("./word-detail"), WordAi.preload()]).then(([m]) => m)));
// The three memorisation modes open from one picker, so they load together with their screen.
export const Flashcards = preloadable(styled(() => import("./learn/flashcards")));
export const Match = preloadable(styled(() => import("./learn/match")));
export const Quiz = preloadable(styled(() => import("./learn/quiz")));
export const LearnActivity = preloadable(styled(() => Promise.all([import("./learn/learn-activity"), Flashcards.preload(), Match.preload(), Quiz.preload()]).then(([m]) => m)));
export const WritingWorkspace = preloadable(styled(() => import("./writing/writing-workspace")));
export const VoiceWorkspace = preloadable(styled(() => import("./voice-workspace")));
