import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpenCheck, ChevronLeft, ChevronRight, Info, MessagesSquare, Palette, ShieldCheck, Sparkles, X } from "lucide-react";
import { DATA_ORIGIN } from "../data";
import { SCOPE_LABEL } from "../practice";
import { AUDIO_ROUTE, MODEL_IDS, MODEL_NAME, MODEL_USE, PROGRAM_ROUTE, routeTable, TASK_LABEL, tierLabel, type ModelChoice, type ServiceState, type TaskKind } from "../routing";
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

const TASK_ORDER: TaskKind[] = ["chat", "status", "short-plan", "essay-feedback", "practice-feedback", "complex-plan", "translate", "define", "grammar"];
const SERVICE_OPTIONS: { value: ServiceState; label: string }[] = [
  { value: "normal", label: "正常" },
  { value: "sol-unavailable", label: "Sol 暂不可用" },
  { value: "budget-low", label: "额度只够较低档位" },
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
  const table = routeTable(settings.complexPlanTier);
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
                  <Row title="外观" detail="跟随设备，或固定浅色、深色。">
                    <Segmented label="外观" value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "system", label: "系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} />
                  </Row>
                  <Row title="动态效果" detail="减少后，对话布局切换、小窗展开和回答出现都不再做位移动画。">
                    <Segmented label="动态效果" value={settings.motion} onChange={(motion) => update({ motion })} options={[{ value: "system", label: "跟随系统" }, { value: "reduce", label: "减少" }]} />
                  </Row>
                </>
              )}
              {section === "learning" && (
                <>
                  <Row title="每天可用时间" detail="AI 安排今天的练习时，没说时间就按这个计算。" htmlFor="daily-minutes">
                    <span className="range-wrap">
                      <input id="daily-minutes" type="range" min={10} max={60} step={5} value={settings.dailyMinutes} onChange={(event) => update({ dailyMinutes: Number(event.target.value) })} />
                      <output htmlFor="daily-minutes">{settings.dailyMinutes} 分钟</output>
                    </span>
                  </Row>
                  <Row title="默认练习范围" detail="计划卡里没指定范围时的取词来源。" htmlFor="default-scope">
                    <span className="select-field">
                      <select id="default-scope" value={settings.defaultScope} onChange={(event) => update({ defaultScope: event.target.value as Settings["defaultScope"] })}>
                        {(["mistakes", "due", "unit4"] as const).map((scope) => <option key={scope} value={scope}>{SCOPE_LABEL[scope]}</option>)}
                      </select>
                    </span>
                  </Row>
                  <Row title="加入学习安排前确认" detail="长期计划需要你确认后才加入；查看计划和开始练习不需要确认。" htmlFor="confirm-schedule">
                    <Switch id="confirm-schedule" label="加入学习安排前确认" checked={settings.confirmBeforeSchedule} onChange={(confirmBeforeSchedule) => update({ confirmBeforeSchedule })} />
                  </Row>
                </>
              )}
              {section === "chat" && (
                <>
                  <Row title="发送方式" detail={settings.sendMode === "enter" ? "Enter 发送，Shift+Enter 换行。输入法选词时的 Enter 不会发送。" : "⌘/Ctrl+Enter 发送，Enter 换行。"}>
                    <Segmented label="发送方式" value={settings.sendMode} onChange={(sendMode) => update({ sendMode })} options={[{ value: "enter", label: "Enter" }, { value: "mod-enter", label: "⌘/Ctrl+Enter" }]} />
                  </Row>
                  <p className="settings-group">新对话默认附带</p>
                  <Row title="学习记录" detail="练习对错与错误类型（原型中是示例记录）。关闭后，计划不再按错词取词，也不判断学习状态。" htmlFor="default-records">
                    <Switch id="default-records" label="新对话默认附带学习记录" checked={settings.includeRecords} onChange={(includeRecords) => update({ includeRecords })} />
                  </Row>
                  <Row title="当前文章全文" detail="在阅读页提问时附带整篇文章。关闭后只发送你选中的引用，不会悄悄恢复整篇读取。" htmlFor="default-article">
                    <Switch id="default-article" label="新对话默认附带当前文章全文" checked={settings.includeArticle} onChange={(includeArticle) => update({ includeArticle })} />
                  </Row>
                  <p className="settings-note">这里只影响之后新建的对话；正在写的消息在输入框的「来源」里单独调整。</p>
                </>
              )}
              {section === "model" && (
                <>
                  <p className="settings-group">默认模型</p>
                  <div className="route-options settings-routes" role="radiogroup" aria-label="默认模型">
                    {(["auto", ...MODEL_IDS] as ModelChoice[]).map((choice) => (
                      <button key={choice} type="button" role="radio" aria-checked={settings.routePreference === choice} className="route-option" onClick={() => update({ routePreference: choice })}>
                        <span><strong>{choice === "auto" ? "自动（推荐）" : MODEL_NAME[choice]}</strong><small>{choice === "auto" ? "按任务选择模型" : `固定使用；适合${MODEL_USE[choice]}`}</small></span>
                      </button>
                    ))}
                  </div>
                  <p className="settings-note">新对话从这里的默认开始；在输入框里换模型只影响那一段对话。思考强度不需要选择，始终按任务自动决定（见下方规则）。</p>
                  <Row title="复杂规划的思考强度" detail="多约束、有步骤依赖的规划。「Soda High」暂按 Sol · 高 理解，尚未确认，可在这里改。">
                    <Segmented label="复杂规划档位" value={settings.complexPlanTier} onChange={(complexPlanTier) => update({ complexPlanTier })} options={[{ value: "sol-high", label: "Sol · 高" }, { value: "sol-medium", label: "Sol · 中" }]} />
                  </Row>
                  <p className="settings-group">自动模式的规则</p>
                  <table className="route-table">
                    <thead><tr><th scope="col">任务</th><th scope="col">模型 · 思考强度</th></tr></thead>
                    <tbody>
                      {TASK_ORDER.map((task) => <tr key={task}><th scope="row">{TASK_LABEL[task]}</th><td>{tierLabel(table[task])}{task === "complex-plan" ? "（候选）" : ""}</td></tr>)}
                      <tr><th scope="row">拼写核对、确定答案评分</th><td>{PROGRAM_ROUTE.label} · 不调用模型</td></tr>
                      <tr><th scope="row">语音会话</th><td>{AUDIO_ROUTE.label}；文字任务再按上表委派</td></tr>
                      <tr className="is-muted"><th scope="row">轻量查询（后续候选）</th><td>Luna（gpt-6-luna）· 未启用</td></tr>
                    </tbody>
                  </table>
                  <p className="settings-note">长文章、对话轮数或引用里的“请升级模型”不会单独触发升级；预算不足或模型不可用时不发送，也不自动换模型重试。正式 API 的可用组合、成本与延迟需要另行实测。</p>
                  <p className="settings-group">接口</p>
                  <p className="settings-note">原型没有连接模型接口。正式产品沿用现有「AI 接口」配置，密钥只在服务端加密保存。</p>
                  <div className="test-box">
                    <Row title="原型测试：服务状态" detail="用来查看额度不足、模型不可用和回答不完整时的处理。只在原型里生效。" htmlFor="service-state">
                      <span className="select-field">
                        <select id="service-state" value={settings.service} onChange={(event) => update({ service: event.target.value as ServiceState })}>
                          {SERVICE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </span>
                    </Row>
                  </div>
                </>
              )}
              {section === "privacy" && (
                <>
                  <Row title="普通对话" detail={`保存在这个浏览器里，现有 ${saved} 段。只保存文字、引用和附件的名称与读取状态，不保存附件内容。`}>
                    {confirmClear ? (
                      <span className="inline-confirm">
                        <button type="button" className="button button-danger small" onClick={() => { clearAll(); setConfirmClear(false); }}>清除 {saved} 段</button>
                        <button type="button" className="button button-quiet small" onClick={() => setConfirmClear(false)}>取消</button>
                      </span>
                    ) : <button type="button" className="button button-secondary small" disabled={!saved} onClick={() => setConfirmClear(true)}>清除全部</button>}
                  </Row>
                  <Row title="临时对话" detail="不进入对话列表，不写入浏览器存储；离开、刷新或关闭页面后清除，其中的引用和附件一起清除。"><span className="setting-value">不保存</span></Row>
                  <Row title="图片与文件" detail="只在当前页面的内存里处理。TXT/MD/CSV 在本机读取文字；图片、PDF、DOCX 只作附件，原型不识别其内容。刷新后无法再次查看。"><span className="setting-value">不上传</span></Row>
                  <Row title="学习记录" detail="原型用示例记录演示，不读取你的正式学习数据。"><span className="setting-value">示例</span></Row>
                </>
              )}
              {section === "about" && (
                <div className="about">
                  <p>这是词迹 AI 对话体验的独立候选原型，基于正式版 2.18.1 的产品结构，不改变正式产品的版本、数据或访问范围。</p>
                  <p className="settings-group">在本地真实运行</p>
                  <ul className="plain-list">
                    <li>听写判分：沿用正式产品的听写比对规则与错误分类。</li>
                    <li>词义：词迹词库 {DATA_ORIGIN.lexiconVersion} 的教材词条。</li>
                    <li>文章：{DATA_ORIGIN.reading.split("/").pop()}，保留来源与权利说明。</li>
                    <li>TXT/MD/CSV 读取、模型路由决策、计划拆分、草稿与引用。</li>
                  </ul>
                  <p className="settings-group">演示逻辑</p>
                  <ul className="plain-list">
                    <li>回答：本地规则与原型译注，未连接任何模型。</li>
                    <li>语音会话：流程演示，不使用麦克风，不调用音频模型。</li>
                    <li>学习记录：示例数据。</li>
                    <li>图片识别、PDF/DOCX 解析、云端上传：未接入。</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
