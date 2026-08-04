"use client";

import { BookOpenCheck, Bot, Check, ChevronRight, CircleAlert, Database, ExternalLink, Eye, KeyRound, Laptop, Link2, LockKeyhole, Palette, PlugZap, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettings } from "@/lib/storage";

type Section = "general" | "learning" | "ai" | "privacy" | "about";
type AIProvider = "deepseek" | "openai-compatible";
type AIConfig = { provider: AIProvider; baseUrl: string; model: string; dailyLimit: number; timeoutSeconds: number; hasApiKey: boolean; updatedAt: string | null; secretStorage: "server-encrypted" };
type ConnectionCheck = { id: string; label: string; status: "passed" | "failed" | "unknown"; detail: string; latencyMs?: number };
type ConnectionTestResult = { ok: boolean; checkedAt?: string; latencyMs?: number; provider?: AIProvider; model?: string; endpointHost?: string; serviceStatusUrl?: string | null; checks?: ConnectionCheck[]; error?: { message?: string; code?: string; providerStatus?: number | null; networkReason?: string | null } | string };
const providerDefaults: Record<AIProvider, Pick<AIConfig, "baseUrl" | "model">> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
};
const defaultAIConfig: AIConfig = { provider: "deepseek", ...providerDefaults.deepseek, dailyLimit: 30, timeoutSeconds: 25, hasApiKey: false, updatedAt: null, secretStorage: "server-encrypted" };
const sections = [
  { id: "general" as const, label: "常规", icon: SlidersHorizontal }, { id: "learning" as const, label: "学习", icon: BookOpenCheck },
  { id: "ai" as const, label: "AI 接口", icon: Bot }, { id: "privacy" as const, label: "数据与安全", icon: ShieldCheck }, { id: "about" as const, label: "关于", icon: CircleAlert },
];
const apiHeaders = () => ({ "content-type": "application/json", "x-vocab-action": "settings" });

export default function ConsoleSettings({ settings, onUpdate, onOpenData, onClear }: { settings: AppSettings; onUpdate: (patch: Partial<AppSettings>) => void; onOpenData: () => void; onClear: () => void }) {
  const [section, setSection] = useState<Section>("general");
  const [aiConfig, setAIConfig] = useState<AIConfig>(defaultAIConfig);
  const [apiKey, setApiKey] = useState("");
  const [loadingConfig, setLoadingConfig] = useState(true), [saving, setSaving] = useState(false), [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [connectionResult, setConnectionResult] = useState<ConnectionTestResult | null>(null);

  useEffect(() => { let active = true; fetch("/api/ai/config", { cache: "no-store" }).then(async (response) => { const result = await response.json() as AIConfig & { error?: string }; if (!response.ok) throw new Error(result.error || "无法读取 API 配置"); if (active) setAIConfig(result); }).catch((error) => active && setMessage({ kind: "error", text: error instanceof Error ? error.message : "无法读取 API 配置" })).finally(() => active && setLoadingConfig(false)); return () => { active = false; }; }, []);

  const chooseProvider = (provider: AIProvider) => {
    setAIConfig((current) => ({ ...current, provider, ...providerDefaults[provider] }));
    setMessage(null);
    setConnectionResult(null);
  };

  const saveAIConfig = async () => {
    setSaving(true); setMessage(null); setConnectionResult(null);
    const transientApiKey = apiKey.trim(); setApiKey("");
    try {
      const response = await fetch("/api/ai/config", { method: "POST", headers: apiHeaders(), body: JSON.stringify({ provider: aiConfig.provider, baseUrl: aiConfig.baseUrl, model: aiConfig.model, dailyLimit: aiConfig.dailyLimit, timeoutSeconds: aiConfig.timeoutSeconds, ...(transientApiKey ? { apiKey: transientApiKey } : {}) }) });
      const result = await response.json() as AIConfig & { error?: string }; if (!response.ok) throw new Error(result.error || "保存失败");
      setAIConfig(result); if (!settings.aiEnabled) onUpdate({ aiEnabled: true }); setMessage({ kind: "success", text: "API 配置已保存，密钥不会返回浏览器。" });
    } catch (error) { setMessage({ kind: "error", text: error instanceof Error ? error.message : "保存失败" }); } finally { setSaving(false); }
  };
  const testAIConfig = async () => {
    setTesting(true); setMessage(null); setConnectionResult(null);
    try {
      const response = await fetch("/api/ai/test", { method: "POST", headers: apiHeaders(), body: "{}", cache: "no-store" });
      const result = await response.json() as ConnectionTestResult;
      setConnectionResult(result);
      if (!response.ok && !result.checks?.length) {
        setMessage({ kind: "error", text: typeof result.error === "string" ? result.error : result.error?.message || "连接测试失败" });
      }
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "连接测试失败" });
    } finally { setTesting(false); }
  };
  const removeAIConfig = async () => {
    if (!window.confirm("移除服务端保存的 API Key 和接口设置？本地词库与学习记录不会受影响。")) return;
    setSaving(true); setMessage(null); setConnectionResult(null);
    try { const response = await fetch("/api/ai/config", { method: "DELETE", headers: apiHeaders() }); const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || "移除失败"); setAIConfig(defaultAIConfig); setApiKey(""); onUpdate({ aiEnabled: false }); setMessage({ kind: "success", text: "API 配置已移除。" }); }
    catch (error) { setMessage({ kind: "error", text: error instanceof Error ? error.message : "移除失败" }); } finally { setSaving(false); }
  };

  return <div className="settings-console">
    <header className="settings-titlebar"><div><span className="console-kicker">PREFERENCES</span><h1>设置</h1><p>学习习惯、外观、接口与数据边界集中在这里。</p></div><div className={aiConfig.hasApiKey ? "settings-status ready" : "settings-status"}><i/>{aiConfig.hasApiKey ? "AI 接口已配置" : "AI 接口未配置"}</div></header>
    <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">{sections.map((item) => <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => { setSection(item.id); setMessage(null); }}><item.icon size={17}/><span>{item.label}</span><ChevronRight size={14}/></button>)}</nav>
      <main className="settings-content">
        {section === "general" && <><section className="settings-card"><header><Palette size={20}/><div><h2>外观</h2><p>只改变本机显示，不影响学习记录。</p></div></header><div className="settings-row"><div><strong>配色方案</strong><small>可跟随当前设备的浅色或深色设置</small></div><div className="segmented-control" role="group" aria-label="配色方案">{(["system", "light", "dark"] as const).map((theme) => <button key={theme} className={settings.theme === theme ? "active" : ""} onClick={() => onUpdate({ theme })}>{theme === "system" ? "系统" : theme === "light" ? "浅色" : "深色"}</button>)}</div></div></section><section className="settings-card"><header><Sparkles size={20}/><div><h2>增强功能</h2><p>AI 可做检索重排、精讲、背诵线索、分析与规划；FSRS 排程始终在本地完成。</p></div></header><label className="settings-row toggle-row"><div><strong>启用 AI 增强</strong><small>{aiConfig.hasApiKey ? "接口已就绪；关闭后不会发起模型请求" : "需要先在“AI 接口”中保存密钥"}</small></div><input type="checkbox" checked={settings.aiEnabled} onChange={(event) => onUpdate({ aiEnabled: event.target.checked })}/><span className="switch"/></label></section></>}
        {section === "learning" && <><section className="settings-card"><header><BookOpenCheck size={20}/><div><h2>每日学习</h2><p>这些设置会直接影响今日队列和未来负担。</p></div></header><label className="settings-slider"><div><strong>每日时间预算</strong><span>{settings.dailyMinutes} 分钟</span></div><input type="range" min="10" max="60" step="5" value={settings.dailyMinutes} onChange={(event) => onUpdate({ dailyMinutes: Number(event.target.value) })}/><small>积压较多时，系统会先减少新词。</small></label><label className="settings-slider"><div><strong>目标保持率</strong><span>{Math.round(settings.desiredRetention * 100)}%</span></div><input type="range" min="0.8" max="0.97" step="0.01" value={settings.desiredRetention} onChange={(event) => onUpdate({ desiredRetention: Number(event.target.value) })}/><small>保持率越高，每日复习量通常越大。</small></label></section><section className="settings-card"><header><SlidersHorizontal size={20}/><div><h2>学习模式</h2><p>临时切换即可，历史事件不会被改写。</p></div></header><label className="settings-row"><div><strong>当前模式</strong><small>考试前可暂时切换到考前强化</small></div><select value={settings.mode} onChange={(event) => onUpdate({ mode: event.target.value as AppSettings["mode"] })}><option value="normal">普通学习</option><option value="unit">单元同步</option><option value="review-only">只复习</option><option value="exam">考前强化</option><option value="browse">自由浏览</option></select></label></section></>}
        {section === "ai" && <>
          <section className="settings-card api-overview">
            <header><PlugZap size={20}/><div><h2>模型 API</h2><p>支持 DeepSeek 与 OpenAI-compatible Chat Completions；请求只从站点服务端发出。</p></div><span className={aiConfig.hasApiKey ? "api-badge ready" : "api-badge"}>{loadingConfig ? "读取中" : aiConfig.hasApiKey ? "已部署" : "待配置"}</span></header>
            <div className="security-callout"><LockKeyhole size={18}/><div><strong>服务端加密保存</strong><p>API Key 经 HTTPS 送达服务端后用 AES-GCM 加密；页面、浏览器存储、备份和日志均不保存明文。</p></div></div>
          </section>
          <section className="settings-card api-form">
            <header><Link2 size={20}/><div><h2>接口参数</h2><p>Base URL 必须使用 HTTPS，且不能指向本机、私网或特殊用途地址。</p></div></header>
            <div className="form-grid">
              <label><span>服务商</span><select value={aiConfig.provider} onChange={(event) => chooseProvider(event.target.value as AIProvider)}><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI-compatible</option></select></label>
              <label><span>Base URL</span><input type="url" inputMode="url" value={aiConfig.baseUrl} onChange={(event) => { setAIConfig((current) => ({ ...current, baseUrl: event.target.value })); setConnectionResult(null); }} placeholder="https://api.example.com/v1" spellCheck={false}/></label>
              <label><span>模型名</span><input list={aiConfig.provider === "deepseek" ? "deepseek-models" : undefined} value={aiConfig.model} onChange={(event) => { setAIConfig((current) => ({ ...current, model: event.target.value })); setConnectionResult(null); }} placeholder={aiConfig.provider === "deepseek" ? "deepseek-v4-flash" : "provider-model-id"} spellCheck={false}/><datalist id="deepseek-models"><option value="deepseek-v4-flash"/><option value="deepseek-v4-pro"/></datalist><small>填写服务商当前开放的模型 ID。</small></label>
              <label><span>API Key</span><div className="secret-input"><KeyRound size={15}/><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={aiConfig.hasApiKey ? "已保存；留空表示不更换" : "输入服务端 API Key"} autoComplete="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true"/></div><small>{aiConfig.hasApiKey ? "密钥已存在，服务器不会把它回传到此处。" : "首次保存时必填。"}</small></label>
              <label><span>每日调用上限</span><input type="number" min="5" max="200" value={aiConfig.dailyLimit} onChange={(event) => setAIConfig((current) => ({ ...current, dailyLimit: Number(event.target.value) }))}/><small>到达上限后自动回退到本地功能。</small></label>
              <label><span>请求超时</span><div className="suffix-input"><input type="number" min="10" max="60" value={aiConfig.timeoutSeconds} onChange={(event) => setAIConfig((current) => ({ ...current, timeoutSeconds: Number(event.target.value) }))}/><span>秒</span></div><small>建议 20–30 秒。</small></label>
            </div>
            <div className="api-actions"><button className="console-primary" onClick={saveAIConfig} disabled={saving || loadingConfig}><Save size={16}/>{saving ? "保存中…" : aiConfig.hasApiKey ? "保存更改" : "安全保存"}</button><button className="console-secondary" onClick={testAIConfig} disabled={testing || !aiConfig.hasApiKey}><PlugZap size={16}/>{testing ? "正在执行真实测试…" : "测试连接与服务"}</button>{aiConfig.hasApiKey && <button className="api-remove" onClick={removeAIConfig} disabled={saving}><Trash2 size={15}/>移除密钥</button>}</div>
            <p className="connection-test-note">测试先进行一次不携带密钥、不会计费的 HTTPS 探测，再发送两次极小的真实请求检查基础生成与 JSON 输出；会产生少量服务商用量。</p>
            {message && <p className={`settings-message ${message.kind}`} role="status">{message.kind === "success" ? <Check size={16}/> : <CircleAlert size={16}/>} {message.text}</p>}
            {connectionResult?.checks?.length ? <div className={`connection-diagnostic ${connectionResult.ok ? "passed" : "failed"}`} role="status">
              <div className="connection-diagnostic-head"><div>{connectionResult.ok ? <Check size={17}/> : <CircleAlert size={17}/>}<strong>{connectionResult.ok ? "连接与服务均正常" : "连接诊断未通过"}</strong></div><span>{connectionResult.endpointHost || "服务端点"}{connectionResult.latencyMs !== undefined ? ` · ${connectionResult.latencyMs} ms` : ""}</span></div>
              <div className="connection-check-list">{connectionResult.checks.map((check) => <div key={check.id} data-status={check.status}><i>{check.status === "passed" ? <Check size={13}/> : <CircleAlert size={13}/>}</i><div><strong>{check.label}</strong><small>{check.detail}{check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ""}</small></div><em>{check.status === "passed" ? "通过" : check.status === "failed" ? "失败" : "未检测"}</em></div>)}</div>
              {connectionResult.error && <p className="connection-error">{typeof connectionResult.error === "string" ? connectionResult.error : connectionResult.error.message}{typeof connectionResult.error !== "string" && connectionResult.error.providerStatus ? `（服务商 HTTP ${connectionResult.error.providerStatus}）` : ""}</p>}
              {connectionResult.serviceStatusUrl && <a className="provider-status-link" href={connectionResult.serviceStatusUrl} target="_blank" rel="noreferrer">查看 DeepSeek 官方服务状态 <ExternalLink size={13}/></a>}
            </div> : aiConfig.provider === "deepseek" ? <a className="provider-status-link standalone" href="https://status.deepseek.com/" target="_blank" rel="noreferrer">查看 DeepSeek 官方服务状态 <ExternalLink size={13}/></a> : null}
          </section>
          <section className="settings-card compact-card"><header><Eye size={19}/><div><h2>发送范围与 token 预算</h2><p>搜索先在本机召回最多 12 个词；分析与规划只发送匿名聚合；背诵只发送正式词条 ID。八类任务各有独立输出上限，DeepSeek Flash 使用固定前缀以提高上下文缓存命中。</p></div></header></section>
        </>}
        {section === "privacy" && <><section className="settings-card"><header><Database size={20}/><div><h2>本地数据</h2><p>卡片状态、复习事件、词单和注释默认保存在本机。</p></div></header><button className="settings-link-row" onClick={onOpenData}><div><strong>备份、恢复与私有同步</strong><small>前往数据页管理 JSON、CSV 与同步状态</small></div><ChevronRight size={16}/></button></section><section className="settings-card danger-card"><header><RotateCcw size={20}/><div><h2>重置本机数据</h2><p>不会删除服务端 API 密钥；如需移除密钥，请在 AI 接口页单独操作。</p></div></header><button className="danger-button" onClick={onClear}><Trash2 size={16}/>清空本机个人数据</button></section></>}
        {section === "about" && <section className="settings-card about-card"><header><Laptop size={20}/><div><h2>词迹</h2><p>人教版初高中英语词汇学习 · 本地优先</p></div></header><dl><div><dt>应用版本</dt><dd>1.4.0</dd></div><div><dt>用户数据 schema</dt><dd>1.1.0</dd></div><div><dt>词库发布状态</dt><dd>带已声明缺口的发布候选</dd></div><div><dt>AI 密钥边界</dt><dd>服务端加密，不随备份导出</dd></div></dl></section>}
      </main>
    </div>
  </div>;
}
