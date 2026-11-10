export function CompanionGlyph({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 16.5c2.2 0 3-5.5 5.4-5.5 2 0 2.2 3.4 4.3 3.4 1.7 0 2.4-2.6 3.6-4.4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="18.6" cy="8.2" r="2.1" fill="var(--blue)" />
  </svg>;
}
