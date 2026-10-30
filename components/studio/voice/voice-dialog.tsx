"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/** One native modal; its children stay mounted so drafts survive closing a panel. */
export function VoiceDialog({ open, title, onClose, children }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="voice-dialog"
      aria-labelledby="voice-dialog-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={() => { if (open) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <header className="voice-dialog-header">
        <h2 id="voice-dialog-title">{title}</h2>
        <button className="voice-icon-button" type="button" aria-label="关闭面板" title="关闭面板" autoFocus onClick={onClose}>
          <X size={21} />
        </button>
      </header>
      <div className="voice-dialog-content">{children}</div>
    </dialog>
  );
}
