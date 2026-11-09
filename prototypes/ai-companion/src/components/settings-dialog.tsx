import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpenCheck, ChevronLeft, ChevronRight, Info, MessagesSquare, Palette, ShieldCheck, Sparkles, X } from "lucide-react";
import { SCOPE_LABEL } from "../practice";
import { MODEL_IDS, MODEL_NAME, MODEL_USE, type ModelChoice, type ServiceState } from "../routing";
import { useStore } from "../store";
import type { Settings, SettingsSection } from "../types";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Palette }[] = [
  { id: "general", label: "常规", icon: Palette },
  { id: "learning", label: "学习安排", icon: BookOpenCheck },
  { id: "chat", label: "对话", icon: MessagesSquare },
  { id: "model", label: "模型", icon: Sparkles },
  { id: "privacy", label: "数据与隐私", icon: ShieldCheck },
  { id: "about", label: "关于原型", icon: Info },
];

function Row({ title, detail, children, htmlFor }: { title: string; detail?: ReactNode; children: ReactNode; htmlFor?: string }) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className="setting-row">
      <Label className="setting-text" {...(htmlFor ? { htmlFor } : {})}><strong>{title}</strong>{detail && <small>{detail}</small>}</Label>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => <button key={String(option.value)} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  );
}

function Switch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <span className="switch-wrap">
      <input id={id} type="checkbox" role="switch" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true" />
    </span>
  );
}

const SERVICE_OPTIONS: { value: ServiceState; label: string }[] = [
  { value: "normal", label: "正常" },
  { value: "sol-unavailable", label: "Sol 暂不可用" },
  { value: "budget-low", label: "额度不足" },
  { value: "budget-exhausted", label: "今日额度已用完" },
  { value: "truncate-next", label: "下一条回答不完整" },
];

export function SettingsDialog() {
  const { state, dispatch, clearAll } = useStore();
  const section = state.settingsOpen;
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // On a phone the dialog is a list that opens one section at a time. Opening from the main
  // navigation shows the list; opening from a specific place (e.g. the route menu) shows that section.
  const [listForced, setListForced] = useState(false);
  const [picked, setPicked] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const settings = state.settings;
  const update = (patch: Partial<Settings>) => dispatch({ type: "settings", patch });

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (section && !element.open) { opener.current = document.activeElement; element.showModal(); }
    if (!section && element.open) element.close();
  }, [section]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onClose = () => {
      dispatch({ type: "settings-open", section: null });
      setConfirmClear(false);
      setListForced(false);
      setPicked(false);
      const target = opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    };
    element.addEventListener("close", onClose);
    return () => element.removeEventListener("close", onClose);
  }, [dispatch]);

  const go = (id: SettingsSection) => {
    dispatch({ type: "settings-open", section: id });
    setListForced(false);
    setPicked(true);
    setConfirmClear(false);
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  };
  const saved = state.conversations.filter((conversation) => !conversation.temporary && conversation.messages.length).length;
  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];

  return (
    <dialog ref={dialog} className="settings" aria-labelledby="settings-title" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      {section && (
        <div className={`settings-frame${!listForced && (section !== "general" || picked) ? " show-detail" : ""}`}>
          <header className="settings-head">
            <button type="button" className="icon-button settings-back" aria-label="返回设置列表" onClick={() => setListForced(true)}><ChevronLeft size={20} aria-hidden="true" /></button>
            <h2 id="settings-title">设置</h2>
            <button type="button" className="icon-button" aria-label="关闭设置" onClick={() => dialog.current?.close()}><X size={19} aria-hidden="true" /></button>
          </header>
          <div className="settings-body">
            <nav className="settings-nav" aria-label="设置分类">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <button key={id} type="button" aria-current={section === id ? "page" : undefined} onClick={() => go(id)}>
                  <Icon size={18} aria-hidden="true" /><span>{label}</span><ChevronRight size={16} aria-hidden="true" className="nav-chevron" />
                </button>
              ))}
            </nav>
            <div className="settings-content">
              <h3 ref={heading} tabIndex={-1} className="settings-section-title">{current.label}</h3>
              {section === "general" && (
                <>
                  <Row title="外观">
                    <Segmented label="外观" value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "system", label: "系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} />
                  </Row>
                  <Row title="动态效果">
                    <Segmented label="动态效果" value={settings.motion} onChange={(motion) => update({ motion })} options={[{ value: "system", label: "跟随系统" }, { value: "reduce", label: "减少" }]} />
                  </Row>
                </>
              )}
              {section === "learning" && (
                <>
                  <Row title="每天可用时间" htmlFor="daily-minutes">
                    <span className="range-wrap">
                      <input id="daily-minutes" type="range" min={10} max={60} step={5} value={settings.dailyMinutes} onChange={(event) => update({ dailyMinutes: Number(event.target.value) })} />
                      <output htmlFor="daily-minutes">{settings.dailyMinutes} 分钟</output>
                    </span>
                  </Row>
                  <Row title="默认练习范围" htmlFor="default-scope">
                    <span className="select-field">
                      <select id="default-scope" value={settings.defaultScope} onChange={(event) => update({ defaultScope: event.target.value as Settings["defaultScope"] })}>
                        {(["mistakes", "due", "unit4"] as const).map((scope) => <option key={scope} value={scope}>{SCOPE_LABEL[scope]}</option>)}
                      </select>
                    </span>
                  </Row>
                  <Row title="加入学习安排前确认" htmlFor="confirm-schedule">
                    <Switch id="confirm-schedule" label="加入学习安排前确认" checked={settings.confirmBeforeSchedule} onChange={(confirmBeforeSchedule) => update({ confirmBeforeSchedule })} />
                  </Row>
                </>
              )}
              {section === "chat" && (
                <>
                  <Row title="发送方式">
                    <Segmented label="发送方式" value={settings.sendMode} onChange={(sendMode) => update({ sendMode })} options={[{ value: "enter", label: "Enter" }, { value: "mod-enter", label: "⌘/Ctrl+Enter" }]} />
                  </Row>
                  <p className="settings-group">新对话默认附带</p>
                  <Row title="学习记录" htmlFor="default-records">
                    <Switch id="default-records" label="新对话默认附带学习记录" checked={settings.includeRecords} onChange={(includeRecords) => update({ includeRecords })} />
                  </Row>
                  <Row title="当前文章全文" htmlFor="default-article">
                    <Switch id="default-article" label="新对话默认附带当前文章全文" checked={settings.includeArticle} onChange={(includeArticle) => update({ includeArticle })} />
                  </Row>
                </>
              )}
              {section === "model" && (
                <div className="route-options settings-routes" role="radiogroup" aria-label="新对话的默认模型">
                  {(["auto", ...MODEL_IDS] as ModelChoice[]).map((choice) => (
                    <button key={choice} type="button" role="radio" aria-checked={settings.routePreference === choice} className="route-option" onClick={() => update({ routePreference: choice })}>
                      <span><strong>{choice === "auto" ? "自动" : MODEL_NAME[choice]}</strong><small>{choice === "auto" ? "按问题选择" : MODEL_USE[choice]}</small></span>
                    </button>
                  ))}
                </div>
              )}
              {section === "privacy" && (
                <>
                  <Row title={`已保存的对话 · ${saved} 段`}>
                    {confirmClear ? (
                      <span className="inline-confirm">
                        <button type="button" className="button button-danger small" onClick={() => { clearAll(); setConfirmClear(false); }}>清除 {saved} 段</button>
                        <button type="button" className="button button-quiet small" onClick={() => setConfirmClear(false)}>取消</button>
                      </span>
                    ) : <button type="button" className="button button-secondary small" disabled={!saved} onClick={() => setConfirmClear(true)}>清除全部</button>}
                  </Row>
                  <Row title="临时对话"><span className="setting-value">不保存</span></Row>
                  <Row title="图片与文件"><span className="setting-value">不上传</span></Row>
                  <Row title="学习记录"><span className="setting-value">示例</span></Row>
                </>
              )}
              {section === "about" && (
                <div className="about">
                  <p>词迹 AI 对话的候选原型。回答由本地规则生成，语音不使用麦克风，学习记录为示例数据，图片和 PDF/DOCX 只作附件。</p>
                  <div className="test-box">
                    <Row title="模拟服务状态" htmlFor="service-state">
                      <span className="select-field">
                        <select id="service-state" value={settings.service} onChange={(event) => update({ service: event.target.value as ServiceState })}>
                          {SERVICE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </span>
                    </Row>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
