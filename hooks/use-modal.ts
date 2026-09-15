"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export function useModal(onClose: () => void) {
  const dialog = useRef<HTMLDialogElement>(null);
  const outside = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const node = dialog.current; if (!node) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const y = window.scrollY;
    const style = document.body.style;
    const original = { position: style.position, top: style.top, width: style.width, overflow: style.overflow, paddingRight: style.paddingRight };
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    style.paddingRight = `${gutter + parseFloat(getComputedStyle(document.body).paddingRight || "0")}px`;
    style.position = "fixed"; style.top = `-${y}px`; style.width = "100%"; style.overflow = "hidden";
    node.showModal();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...node.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
    };
    node.addEventListener("keydown", trap);
    return () => { if (timer.current) clearTimeout(timer.current); node.removeEventListener("keydown", trap); node.close(); Object.assign(style, original); window.scrollTo({ top: y, behavior: "instant" }); trigger?.focus({ preventScroll: true }); };
  }, []);
  const requestClose = useCallback(() => {
    if (timer.current) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { onClose(); return; }
    setClosing(true); timer.current = setTimeout(onClose, 160);
  }, [onClose]);
  return { dialog, closing, requestClose,
    onCancel: (event: React.SyntheticEvent) => { event.preventDefault(); requestClose(); },
    onPointerDown: (event: React.PointerEvent<HTMLDialogElement>) => { outside.current = event.target === event.currentTarget; },
    onClick: (event: React.MouseEvent<HTMLDialogElement>) => { if (outside.current && event.target === event.currentTarget) requestClose(); outside.current = false; },
  };
}
