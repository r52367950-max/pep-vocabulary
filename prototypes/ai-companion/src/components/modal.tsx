import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Native modal dialog: the browser supplies the inert background, focus containment and Escape.
 * Focus returns to whatever opened it.
 */
export function Modal({ open, onClose, title, children, className = "" }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onClosed = () => {
      onClose();
      const target = opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    };
    element.addEventListener("close", onClosed);
    return () => element.removeEventListener("close", onClosed);
  }, [onClose]);
  return (
    <dialog ref={dialog} className={`modal ${className}`} aria-label={title}
      onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      {open && (
        <div className="modal-frame">
          <header className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="icon-button" aria-label={`关闭${title}`} onClick={() => dialog.current?.close()}><X size={18} aria-hidden="true" /></button>
          </header>
          <div className="modal-body">{children}</div>
        </div>
      )}
    </dialog>
  );
}
