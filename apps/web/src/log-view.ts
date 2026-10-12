// Redesign R3b (review #9): the Log tab's five views and the remembered last one. Pure; prefs.ts stores the string.

export const LOG_VIEWS = ['training', 'history', 'health', 'learning', 'reading'] as const;
export type LogView = (typeof LOG_VIEWS)[number];

/** The chip text for each view; `history` is the Progress view. */
export const LOG_VIEW_LABELS: Readonly<Record<LogView, string>> = {
  training: 'Training',
  history: 'Progress',
  health: 'Health',
  learning: 'Learning',
  reading: 'Reading',
};

export const DEFAULT_LOG_VIEW: LogView = 'training';

export function isLogView(value: string): value is LogView {
  return (LOG_VIEWS as readonly string[]).includes(value);
}

/** Where the Log tab reopens: the saved view, or Training when nothing (or something unknown) was saved. */
export function rememberedLogView(saved: string | null): LogView {
  return saved !== null && isLogView(saved) ? saved : DEFAULT_LOG_VIEW;
}
