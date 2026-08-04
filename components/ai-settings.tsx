"use client";

import { KeyRound, LoaderCircle, ServerCog, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Provider = "deepseek" | "openai-compatible";

type SafeConfig = {
  configured: boolean;
  source: "database" | "environment" | "unconfigured";
  provider: Provider;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  canManage: boolean;
  updatedAt: string | null;
};

type ApiResult = {
  ok?: boolean;
  config?: SafeConfig;
  error?: { code?: string; message?: string };
};

const providerDefaults: Record<Provider, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
};

function sourceLabel(source: SafeConfig["source"]) {
  if (source === "database") return "服务端加密配置";
  if (source === "environment") return "Sites 环境变量";
  return "尚未配置";
}

export default function AiSettingsPanel() {
  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [provider, setProvider] = useState<Provider>("deepseek");
  const [baseUrl, setBaseUrl] = useState(providerDefaults.deepseek.baseUrl);
  const [model, setModel] = useState(providerDefaults.deepseek.model);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyConfig = useCallback((next: SafeConfig) => {
    setConfig(next);
    setProvider(next.provider);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/assistant/config", { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (response) => {
        const result = await response.json() as ApiResult;
        if (!response.ok || !result.config) throw new Error(result.error?.message || "服务端配置状态暂时无法读取。");
        if (active) applyConfig(result.config);
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : "服务端配置状态暂时无法读取。"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [applyConfig]);

  const chooseProvider = (next: Provider) => {
    setProvider(next);
    setBaseUrl(providerDefaults[next].baseUrl);
    setModel(providerDefaults[next].model);
    setMessage(null);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    const transientApiKey = apiKey.trim();
    setApiKey("");
    try {
      const response = await fetch("/api/assistant/config", {
        method: "PUT",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          provider,
          baseUrl,
          model,
          ...(transientApiKey ? { apiKey: transientApiKey } : {}),
        }),
      });
      const result = await response.json() as ApiResult;
      if (!response.ok || !result.config) throw new Error(result.error?.message || "服务端配置保存失败。");
      applyConfig(result.config);
      setMessage("服务端配置已保存；密钥只保留在服务端加密存储中。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "服务端配置保存失败。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="data-panel ai-settings-panel span-two" aria-labelledby="ai-settings-title">
      <Sparkles size={22} aria-hidden="true" />
      <div className="ai-settings-heading">
        <div><span className="section-kicker">SERVER-SIDE AI</span><h2 id="ai-settings-title">模型接口</h2><p>支持 DeepSeek 与 OpenAI-compatible Chat Completions。Base URL、模型名和密钥都由服务端配置。</p></div>
        <span className={`config-status ${config?.configured ? "ready" : ""}`}>{loading ? "读取中" : error ? "暂不可用" : sourceLabel(config?.source || "unconfigured")}</span>
      </div>

      <div className="ai-config-grid" aria-busy={loading || saving}>
        <label><span>接口类型</span><select value={provider} disabled={loading || saving || !config?.canManage} onChange={(event) => chooseProvider(event.target.value as Provider)}><option value="deepseek">DeepSeek</option><option value="openai-compatible">OpenAI-compatible</option></select></label>
        <label><span>Base URL</span><input type="url" inputMode="url" value={baseUrl} disabled={loading || saving || !config?.canManage} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label><span>模型名</span><input value={model} disabled={loading || saving || !config?.canManage} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-chat" spellCheck={false} /></label>
        <label><span>服务端 API key</span><div className="secret-field"><KeyRound size={16} aria-hidden="true" /><input type="password" name="server-ai-api-key" value={apiKey} disabled={loading || saving || !config?.canManage} onChange={(event) => setApiKey(event.target.value)} placeholder={config?.hasApiKey ? "已配置；留空可保留" : "首次保存时必填"} autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} /></div></label>
      </div>

      <div className="ai-settings-actions">
        <button className="primary-button" type="button" disabled={loading || saving || !config?.canManage} onClick={save}>{saving ? <LoaderCircle className="spin" size={17} /> : <ServerCog size={17} />}{saving ? "正在保存" : "保存服务端配置"}</button>
        <span><ShieldCheck size={15} aria-hidden="true" />密钥不会回显，也不会进入 IndexedDB、同步备份、客户端包或应用日志。</span>
      </div>
      {config?.canManage === false && <p className="inline-warning"><ShieldCheck size={15} />当前账号只能查看状态。部署者需在 Sites 中配置 <code>AI_CONFIG_ADMIN_EMAILS</code>。</p>}
      {message && <p className="config-message success" role="status">{message}</p>}
      {error && <p className="config-message error" role="alert">{error}</p>}
    </section>
  );
}
