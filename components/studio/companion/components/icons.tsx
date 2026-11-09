/** The product mark (components/studio/shared.tsx): a forgetting curve lifted at each review. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <path d="M14 26C19 44 24 52 33 55V33C39 46 45 50 55 52V38C62 46 70 48 82 48" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 78H86" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="82" cy="48" r="7" fill="var(--accent)" />
    </svg>
  );
}

/**
 * The AI glyph: the brand's review curve drawn as one rising stroke that ends in a dot,
 * read as "the trace of what you learned leads to a question". Used on the launcher and as
 * the assistant's mark, so the entry and the answer share one sign.
 */
export function TraceGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="trace-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 16.5c2.2 0 3-5.5 5.4-5.5 2 0 2.2 3.4 4.3 3.4 1.7 0 2.4-2.6 3.6-4.4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18.6" cy="8.2" r="2.1" fill="var(--accent)" />
    </svg>
  );
}

/** Temporary conversation: a speech outline drawn in dashes, so it reads as "not kept". */
export function TemporaryIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 4.2c4.4 0 7.8 2.9 7.8 6.6S16.4 17.4 12 17.4c-.9 0-1.8-.1-2.6-.3L5.3 19.3l1-3.4C4.9 14.6 4.2 12.8 4.2 10.8 4.2 7.1 7.6 4.2 12 4.2Z" strokeDasharray="2.6 2.7" />
    </svg>
  );
}
