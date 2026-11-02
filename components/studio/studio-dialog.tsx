"use client";

import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModal } from "@/hooks/use-modal";

export function StudioDialog({ title, onClose, children, footer, className = "" }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string;
}) {
  const titleId = useId();
  const { dialog, closing, requestClose, onCancel, onPointerDown, onClick } = useModal(onClose);
  return <dialog ref={dialog} className={`studio-dialog ${className}`} aria-labelledby={titleId} data-closing={closing}
    onCancel={onCancel} onPointerDown={onPointerDown} onClick={onClick}>
    <div className="studio-dialog-frame">
      <header className="studio-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={requestClose} aria-label={`关闭${title}`}><X size={20} aria-hidden="true" /></button></header>
      <div className="studio-dialog-body">{children}</div>
      {footer && <footer className="studio-dialog-footer">{footer}</footer>}
    </div>
  </dialog>;
}
