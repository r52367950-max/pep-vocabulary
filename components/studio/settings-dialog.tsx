"use client";

import { lazy, Suspense, useState } from "react";
import { X } from "lucide-react";
import type { Vocabulary } from "@/hooks/use-vocabulary";
import { useModal } from "@/hooks/use-modal";
import ConsoleSettings from "../console-settings";

const DataTools = lazy(() => import("./data-tools"));

export default function SettingsDialog({ data, onClose, onClear, onReplaced }: {
  data: Vocabulary; onClose: () => void; onClear: () => void; onReplaced: () => void;
}) {
  const [showData, setShowData] = useState(false);
  const { dialog: dialogRef, closing, requestClose, onCancel, onPointerDown, onClick } = useModal(onClose);
  return <dialog ref={dialogRef} className="settings-dialog" aria-labelledby="settings-dialog-title" data-closing={closing}
    onCancel={onCancel} onPointerDown={onPointerDown} onClick={onClick}>
    <div className="settings-dialog-frame">
      <header className="settings-dialog-header"><h2 id="settings-dialog-title">设置</h2><button className="icon-button" aria-label="关闭设置" onClick={requestClose}><X size={20} aria-hidden="true" /></button></header>
      {showData ? <div className="settings-data-panel"><Suspense fallback={<p role="status">正在载入备份工具…</p>}><DataTools data={data} onBack={() => setShowData(false)} onReplaced={onReplaced} /></Suspense></div> :
        <ConsoleSettings settings={data.settings} onUpdate={data.updateSettings} onOpenData={() => setShowData(true)} onClear={onClear} />}
    </div>
  </dialog>;
}
