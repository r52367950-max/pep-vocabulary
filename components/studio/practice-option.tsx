import { ChevronRight, Mic } from "lucide-react";
import { StudioSymbol, type SymbolName } from "./symbol";

type PracticeOptionProps = {
  symbol: SymbolName | "mic";
  title: string;
  detail: string;
  onClick: () => void;
  onPrepare?: () => void;
};

export function PracticeOption({ symbol, title, detail, onClick, onPrepare }: PracticeOptionProps) {
  return (
    <button type="button" className="practice-option" onClick={onClick} onPointerEnter={onPrepare} onFocus={onPrepare}>
      <span className="practice-entry-symbol" data-symbol={symbol} aria-hidden="true">
        {symbol === "mic" ? <Mic size={23} /> : <StudioSymbol name={symbol} size={23} />}
      </span>
      <span className="practice-description"><strong>{title}</strong><small>{detail}</small></span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}
