import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";

/**
 * A small anchored layer: opens from its trigger, closes on Escape or an outside press and
 * returns focus to the trigger. It does not trap focus, so the page behind stays usable.
 */
export function Popover({ label, trigger, children, placement = "top", align = "start", className = "", triggerClass = "", triggerLabel }: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
  triggerClass?: string;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [closedByChoice, setClosedByChoice] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useDismiss(open, wrap, () => setOpen(false), button);
  // A choice made inside the layer closes it and returns focus to the trigger.
  useEffect(() => { if (closedByChoice) button.current?.focus(); }, [closedByChoice]);
  const close = () => { setOpen(false); setClosedByChoice((count) => count + 1); };
  return (
    <div className={`popover-wrap ${className}`} ref={wrap}>
      <button ref={button} type="button" className={triggerClass} aria-expanded={open} aria-controls={id} aria-label={triggerLabel} onClick={() => setOpen((value) => !value)}>
        {trigger}
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={label} className={`popover popover-${placement} popover-${align}`}>
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function useDismiss(open: boolean, area: RefObject<HTMLElement | null>, close: () => void, returnTo?: RefObject<HTMLElement | null>) {
  const latest = useRef(close);
  useEffect(() => { latest.current = close; });
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (area.current && !area.current.contains(event.target as Node)) latest.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (area.current?.contains(document.activeElement) || document.activeElement === document.body) {
        event.stopPropagation();
        latest.current();
        returnTo?.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [open, area, returnTo]);
}
