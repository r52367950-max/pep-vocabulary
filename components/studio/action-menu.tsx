"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; separator?: boolean; danger?: boolean };

/** A native popover stays above clipping containers and dismisses on an outside tap. */
export function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = (restore = false) => {
    menu.current?.hidePopover();
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  const show = (last = false) => {
    const node = menu.current, button = trigger.current;
    if (!node || !button) return;
    node.showPopover();
    const rect = button.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.right - box.width, window.innerWidth - box.width - 12));
    const top = rect.bottom + box.height + 8 <= window.innerHeight - 12 ? rect.bottom + 8 : Math.max(12, rect.top - box.height - 8);
    node.style.left = `${left}px`; node.style.top = `${top}px`;
    const controls = node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    ((last ? controls[controls.length - 1] : controls[0]) || node).focus({ preventScroll: true });
  };
  useEffect(() => {
    const resize = () => menu.current?.hidePopover();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return <span className="action-menu">
    <button ref={trigger} type="button" className="action-menu-trigger" aria-haspopup="menu" aria-controls={id} aria-expanded={open}
      onClick={() => { if (menu.current?.matches(":popover-open")) close(true); else show(); }}
      onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(event.key === "ArrowUp"); } }}>
      <MoreHorizontal size={18} aria-hidden="true" /><span>{label}</span>
    </button>
    <div ref={menu} id={id} className="action-menu-panel" popover="auto" role="menu" tabIndex={-1} aria-label={label}
      onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === "open")}
      onKeyDown={event => {
        const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const at = controls.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } close(true); return; }
        const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : event.key === "ArrowDown" ? (at + 1) % controls.length : event.key === "ArrowUp" ? (at + controls.length - 1) % controls.length : -1;
        if (next >= 0) { event.preventDefault(); controls[next]?.focus(); }
      }}>
      {items.map((item, index) => <button key={`${index}-${item.label}`} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
        className={`${item.separator ? "menu-separator " : ""}${item.danger ? "menu-danger" : ""}`}
        onClick={() => { close(true); item.onSelect(); }}>
        {item.icon && <span className="action-menu-icon">{item.icon}</span>}<span>{item.label}</span>
      </button>)}
    </div>
  </span>;
}
