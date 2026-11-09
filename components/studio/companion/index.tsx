"use client";

import { useEffect, useRef, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { CompanionProvider, useStore } from "./store";
import { ChatView } from "./components/chat-view";
import { Launcher, MiniPanel } from "./components/mini-panel";
import "./styles.css";

export type CompanionHostProps = Omit<ComponentProps<typeof CompanionProvider>, "children"> & {
  target: HTMLElement | null;
  visible: boolean;
  openRequest: number;
  onReady: () => void;
  onMiniChange: (open: boolean) => void;
};

export default function CompanionHost({ target, visible, openRequest, onReady, onMiniChange, ...provider }: CompanionHostProps) {
  return <CompanionProvider {...provider}>
    <CompanionSurfaces target={target} visible={visible} openRequest={openRequest} onReady={onReady} onMiniChange={onMiniChange} />
  </CompanionProvider>;
}

function CompanionSurfaces({ target, visible, openRequest, onReady, onMiniChange }: Pick<CompanionHostProps, "target" | "visible" | "openRequest" | "onReady" | "onMiniChange">) {
  const { state, dispatch } = useStore();
  const seen = useRef(0);
  const chat = state.view === "chat";
  useEffect(() => { onReady(); }, [onReady]);
  useEffect(() => { onMiniChange(!chat && state.miniOpen && visible); }, [chat, onMiniChange, state.miniOpen, visible]);
  useEffect(() => {
    if (openRequest <= seen.current) return;
    seen.current = openRequest;
    dispatch({ type: "mini", open: true });
    dispatch({ type: "focus-composer" });
  }, [dispatch, openRequest]);
  return <>
    {visible && chat && target && createPortal(<div className="ciji-companion companion-full"><ChatView /></div>, target)}
    <div className={`ciji-companion companion-floating${state.miniOpen ? " has-mini" : ""}`}>
      {visible && !chat && state.miniOpen && <MiniPanel />}
      {visible && !chat && <Launcher />}
      <span className="visually-hidden" role="status" aria-live="polite">{state.announcement}</span>
    </div>
  </>;
}
