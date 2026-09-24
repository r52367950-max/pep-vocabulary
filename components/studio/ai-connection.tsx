import { Check, CircleAlert, ExternalLink } from "lucide-react";

export type AIProvider = "deepseek" | "openai-compatible";
type ConnectionCheck = {
  id: string;
  label: string;
  status: "passed" | "failed" | "unknown";
  detail: string;
  latencyMs?: number;
};
export type ConnectionTestResult = {
  ok: boolean;
  checkedAt?: string;
  latencyMs?: number;
  provider?: AIProvider;
  model?: string;
  endpointHost?: string;
  serviceStatusUrl?: string | null;
  checks?: ConnectionCheck[];
  error?:
    | {
        message?: string;
        code?: string;
        providerStatus?: number | null;
        networkReason?: string | null;
      }
    | string;
};

const checkLabel = { passed: "通过", failed: "失败", unknown: "未检测" } as const;

/** The result of a real connection test, check by check. */
export function ConnectionDiagnostic({ result }: { result: ConnectionTestResult }) {
  const { error } = result;
  return (
    <div className={`connection-diagnostic ${result.ok ? "passed" : "failed"}`} role="status">
      <div className="connection-diagnostic-head">
        <div>
          {result.ok ? <Check size={17} aria-hidden="true" /> : <CircleAlert size={17} aria-hidden="true" />}
          <strong>{result.ok ? "连接与服务均正常" : "连接诊断未通过"}</strong>
        </div>
        <span>
          {result.endpointHost || "服务端点"}
          {result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ""}
        </span>
      </div>
      <div className="connection-check-list">
        {result.checks?.map((check) => (
          <div key={check.id} data-status={check.status}>
            <i>{check.status === "passed" ? <Check size={13} aria-hidden="true" /> : <CircleAlert size={13} aria-hidden="true" />}</i>
            <div>
              <strong>{check.label}</strong>
              <small>
                {check.detail}
                {check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ""}
              </small>
            </div>
            <em>{checkLabel[check.status]}</em>
          </div>
        ))}
      </div>
      {error && (
        <p className="connection-error">
          {typeof error === "string" ? error : error.message}
          {typeof error !== "string" && error.providerStatus ? `（服务商 HTTP ${error.providerStatus}）` : ""}
        </p>
      )}
      {result.serviceStatusUrl && (
        <a className="provider-status-link" href={result.serviceStatusUrl} target="_blank" rel="noreferrer">
          查看 DeepSeek 官方服务状态 <ExternalLink size={13} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
