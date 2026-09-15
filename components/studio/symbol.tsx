import type { CSSProperties } from "react";

export type SymbolName = "today" | "lexicon" | "reading" | "activity" | "settings" | "listen" | "review";

// Original interface glyphs, optically aligned on a 28-unit grid.
// These are not exported Apple SF Symbols or font glyphs.
export function StudioSymbol({ name, tile = false, size = 24 }: { name: SymbolName; tile?: boolean; size?: number }) {
  return (
    <span className={`studio-symbol symbol-${name}${tile ? " symbol-tile" : ""}`} style={{ "--symbol-size": `${size}px` } as CSSProperties} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        {name === "today" && <><circle className="symbol-tone" cx="14" cy="14" r="5.6" fill="currentColor" stroke="none" /><circle cx="14" cy="14" r="5.6" /><path d="M14 2.8v2M14 23.2v2M2.8 14h2M23.2 14h2M6.1 6.1l1.5 1.5m12.8 12.8 1.5 1.5M6.1 21.9l1.5-1.5M20.4 7.6l1.5-1.5" /></>}
        {name === "lexicon" && <><path className="symbol-tone" fill="currentColor" stroke="none" d="M8 6h14a2 2 0 0 1 2 2v15H8z" /><path d="M8 6h14a2 2 0 0 1 2 2v15H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h13M8 6v17M5 20h3" /><path d="m12 17 3.5-8 3.5 8m-5.7-2.7h4.4" /></>}
        {name === "reading" && <><path className="symbol-tone" fill="currentColor" stroke="none" d="M14 6c3.3-2 7-2.1 10-1v17c-3-1.1-6.7-1-10 1z" /><path d="M14 6c-3.3-2-7-2.1-10-1v17c3-1.1 6.7-1 10 1 3.3-2 7-2.1 10-1V5c-3-1.1-6.7-1-10 1Zm0 0v17M7.5 9.2c1.2-.1 2.2.1 3.2.5m-3.2 3.5c1.2-.1 2.2.1 3.2.5" /></>}
        {name === "activity" && <><rect className="symbol-tone" x="3.5" y="14" width="4.5" height="10" rx="1.5" fill="currentColor" stroke="none" /><rect x="3.5" y="14" width="4.5" height="10" rx="1.5" /><rect className="symbol-tone" x="11.7" y="9" width="4.5" height="15" rx="1.5" fill="currentColor" stroke="none" /><rect x="11.7" y="9" width="4.5" height="15" rx="1.5" /><rect x="20" y="3.5" width="4.5" height="20.5" rx="1.5" fill="currentColor" stroke="none" /></>}
        {name === "settings" && <><path className="symbol-tone" fill="currentColor" stroke="none" transform="translate(1.4 0) scale(.9)" d="m11.2 3-.6 3-2.1 1.2-2.9-.9-2.8 4.9 2.3 2.1v2.4l-2.3 2.1 2.8 4.9 2.9-.9 2.1 1.2.6 3h5.6l.6-3 2.1-1.2 2.9.9 2.8-4.9-2.3-2.1v-2.4l2.3-2.1-2.8-4.9-2.9.9L17.4 6l-.6-3z" /><path d="m11.2 3-.6 3-2.1 1.2-2.9-.9-2.8 4.9 2.3 2.1v2.4l-2.3 2.1 2.8 4.9 2.9-.9 2.1 1.2.6 3h5.6l.6-3 2.1-1.2 2.9.9 2.8-4.9-2.3-2.1v-2.4l2.3-2.1-2.8-4.9-2.9.9L17.4 6l-.6-3z" transform="translate(1.4 0) scale(.9)" /><circle cx="14" cy="13.5" r="4" /></>}
        {name === "listen" && <><path d="M5 17v-4a9 9 0 0 1 18 0v4" /><rect className="symbol-tone" x="3.5" y="14" width="5" height="9" rx="2.4" fill="currentColor" /><rect className="symbol-tone" x="19.5" y="14" width="5" height="9" rx="2.4" fill="currentColor" /><path d="M12 11v6m4-8v10" /></>}
        {name === "review" && <><path d="M5.3 11a9 9 0 1 1-.1 6M5 4v7h7" /><path className="symbol-tone" d="m10.5 14 2.5 2.5 5-5" strokeWidth="2.5" /></>}
      </svg>
    </span>
  );
}
