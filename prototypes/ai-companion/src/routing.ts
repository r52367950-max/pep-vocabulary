/**
 * Task-level model routing. The route decides the request: `buildRequest` copies the route's
 * model and effort into the payload, and every label is read back from that payload, so the
 * label shown can never differ from what would be sent.
 */
export type ModelId = "gpt-6.1-sol" | "gpt-6.1-terra";
export type Effort = "low" | "medium" | "high";
export type TierId = "sol-medium" | "sol-high" | "terra-low" | "terra-medium";

export const MODEL_NAME: Record<ModelId, string> = { "gpt-6.1-sol": "Sol", "gpt-6.1-terra": "Terra" };
export const EFFORT_NAME: Record<Effort, string> = { low: "低", medium: "中", high: "高" };

export const TIERS: Record<TierId, { model: ModelId; effort: Effort; use: string }> = {
  "sol-medium": { model: "gpt-6.1-sol", effort: "medium", use: "常规对话、状态总结、短计划、作文反馈" },
  "sol-high": { model: "gpt-6.1-sol", effort: "high", use: "多约束、步骤相互依赖的规划（候选）" },
  "terra-low": { model: "gpt-6.1-terra", effort: "low", use: "阅读中的简单翻译、选词释义" },
  "terra-medium": { model: "gpt-6.1-terra", effort: "medium", use: "选文语法、语境辨析" },
};
export const TIER_ORDER: TierId[] = ["sol-medium", "sol-high", "terra-low", "terra-medium"];

export function tierLabel(tier: TierId) {
  return requestLabel(TIERS[tier].model, TIERS[tier].effort);
}
export function requestLabel(model: ModelId, effort: Effort) {
  return `${MODEL_NAME[model]} · ${EFFORT_NAME[effort]}`;
}

export type TaskKind =
  | "chat" | "status" | "short-plan" | "essay-feedback" | "practice-feedback"
  | "complex-plan" | "translate" | "define" | "grammar";

export const TASK_LABEL: Record<TaskKind, string> = {
  chat: "常规学习对话",
  status: "学习状态总结",
  "short-plan": "普通短计划",
  "essay-feedback": "作文反馈",
  "practice-feedback": "练习结果反馈",
  "complex-plan": "多约束规划",
  translate: "选文翻译",
  define: "选词释义",
  grammar: "选文语法与语境",
};

export type RouteTable = Record<TaskKind, TierId>;
export const DEFAULT_ROUTE_TABLE: RouteTable = {
  chat: "sol-medium",
  status: "sol-medium",
  "short-plan": "sol-medium",
  "essay-feedback": "sol-medium",
  "practice-feedback": "sol-medium",
  "complex-plan": "sol-high",
  translate: "terra-low",
  define: "terra-low",
  grammar: "terra-medium",
};

/** "Soda High" from the request is read as Sol · 高 until confirmed; the tier stays a setting. */
export type ComplexPlanTier = "sol-high" | "sol-medium";
export function routeTable(complexPlanTier: ComplexPlanTier): RouteTable {
  return { ...DEFAULT_ROUTE_TABLE, "complex-plan": complexPlanTier };
}

/** Work that never goes to a text model. */
export const PROGRAM_ROUTE = { label: "程序判分", detail: "拼写核对与确定答案由本地程序完成，不调用模型" } as const;
export const AUDIO_ROUTE = { model: "gpt-live-1", label: "GPT-Live 1", detail: "语音会话使用专门的音频模型；其中的文字任务再按学习路由委派" } as const;

export type SelectionAction = "translate" | "define" | "grammar";
export type ClassifyInput = {
  /** Only the learner's own words. Quotes, files and earlier turns are deliberately not inspected. */
  text: string;
  action?: SelectionAction;
  hasQuote: boolean;
  practiceResult?: boolean;
};
export type Classification = { task: TaskKind; signals: string[] };

const PLAN_WORDS = /计划|安排|规划|日程|备考|冲刺/;
const TIME_BUDGET = /\d+\s*(分钟|min)|半小时|一小时|只有.{0,4}(分钟|时间)/;
const PRACTICE_WORDS = /听写|复习|练习|背单词|错词/;
const MULTI_DAY = /(\d+|[一二两三四五六七八九十]+)\s*(天|周|个星期|星期|个月)|下周|月考|期中|期末|考试前|这学期/;
const WEEKDAY = /周[一二三四五六日天末]|星期[一二三四五六日天]/;
const DEPENDENCY = /先.{0,16}(再|然后|之后|后)|之前要|在.{0,10}之后|前提|依次|循序/;
const DAILY = /每天\s*\d+|每天.{0,4}(分钟|小时)/;
const SCOPES = ["听写", "阅读", "写作", "口语", "错词", "新词", "复习", "单元", "词汇"];
const STATUS = /状态|进度|这周|本周|最近学|学习记录|掌握|学得怎么样|薄弱|错得最多|哪些词/;
const ESSAY = /作文|写作|批改|润色/;
const GRAMMAR = /语法|结构|从句|句型|成分|主干|时态|语态|为什么用|为何用|辨析|区别|语境|搭配|用法|指代|修饰/;
const TRANSLATE = /翻译|译成|中文意思|什么意思|意思是/;
const DEFINE = /词义|释义|这个词|单词.{0,4}意思|怎么读|音标/;

export function classifyTask(input: ClassifyInput): Classification {
  if (input.action) return { task: input.action, signals: ["阅读工具栏动作"] };
  if (input.practiceResult) return { task: "practice-feedback", signals: ["练习结果"] };
  const text = input.text;
  if (input.hasQuote) {
    if (GRAMMAR.test(text)) return { task: "grammar", signals: ["引用 + 语法或语境问题"] };
    if (DEFINE.test(text)) return { task: "define", signals: ["引用 + 词义问题"] };
    if (TRANSLATE.test(text)) return { task: "translate", signals: ["引用 + 翻译问题"] };
  }
  const planLike = PLAN_WORDS.test(text) || TIME_BUDGET.test(text) || (PRACTICE_WORDS.test(text) && /安排|帮我|给我|今天|用/.test(text));
  if (planLike) {
    const signals: string[] = [];
    if (MULTI_DAY.test(text)) signals.push("跨多日");
    if (DAILY.test(text)) signals.push("每日时长");
    if (WEEKDAY.test(text)) signals.push("日期限制");
    if (DEPENDENCY.test(text)) signals.push("先后顺序");
    if (SCOPES.filter((scope) => text.includes(scope)).length >= 2) signals.push("多个练习范围");
    if (signals.length >= 3 && (signals.includes("跨多日") || signals.includes("先后顺序"))) return { task: "complex-plan", signals };
    return { task: "short-plan", signals: signals.length ? signals : ["时间或安排请求"] };
  }
  if (STATUS.test(text)) return { task: "status", signals: ["询问学习状态"] };
  if (ESSAY.test(text)) return { task: "essay-feedback", signals: ["作文相关"] };
  return { task: "chat", signals: [] };
}

/** The learner picks a model or leaves it automatic; thinking strength always follows the task. */
export type ModelChoice = "auto" | ModelId;
export const MODEL_IDS: ModelId[] = ["gpt-6.1-sol", "gpt-6.1-terra"];
export const MODEL_USE: Record<ModelId, string> = {
  "gpt-6.1-sol": "对话、学习计划、状态总结和作文反馈",
  "gpt-6.1-terra": "阅读中的翻译、词义和语法",
};
export function isModelChoice(value: unknown): value is ModelChoice {
  return value === "auto" || MODEL_IDS.includes(value as ModelId);
}
export type RouteSource = "auto" | "next-only" | "preference";
export type Route = { model: ModelId; effort: Effort; task: TaskKind; source: RouteSource; reason: string; automatic: { model: ModelId; effort: Effort } };

export function resolveRoute(classification: Classification, choice: { nextOnly: ModelId | null; preference: ModelChoice }, table: RouteTable): Route {
  const automatic = TIERS[table[classification.task]];
  const chosen = choice.nextOnly ?? (choice.preference === "auto" ? null : choice.preference);
  const source: RouteSource = choice.nextOnly ? "next-only" : chosen ? "preference" : "auto";
  const why = classification.signals.length ? `（${classification.signals.join("、")}）` : "";
  const autoLabel = requestLabel(automatic.model, automatic.effort);
  const reason = source === "auto"
    ? `自动：${TASK_LABEL[classification.task]}${why}`
    : `${source === "next-only" ? "仅本条指定" : "你指定的默认模型"} ${MODEL_NAME[chosen!]}，思考强度按任务；自动会用 ${autoLabel}`;
  return { model: chosen ?? automatic.model, effort: automatic.effort, task: classification.task, source, reason, automatic: { model: automatic.model, effort: automatic.effort } };
}

/** A one-message fallback offered after a refusal; the learner has to choose it. */
export type Fallback = { model: ModelId; effort?: Effort; label: string };
export function applyFallback(route: Route, fallback: Fallback): Route {
  const model = fallback.model, effort = fallback.effort ?? route.effort;
  return { ...route, model, effort, source: "next-only", reason: `仅本条：${fallback.label}；自动会用 ${requestLabel(route.automatic.model, route.automatic.effort)}` };
}

export type ContextSummary = {
  records: boolean; article: "full" | "off" | "none"; quotes: number; quoteChars: number;
  readFiles: { name: string; chars: number }[]; attachmentsOnly: { name: string; kind: string }[];
};
export type RequestPayload = {
  model: ModelId;
  reasoning: { effort: Effort };
  metadata: { task: TaskKind; routeSource: RouteSource };
  context: ContextSummary;
};

export function buildRequest(route: Route, context: ContextSummary): RequestPayload {
  return { model: route.model, reasoning: { effort: route.effort }, metadata: { task: route.task, routeSource: route.source }, context };
}

/** Simulated service state for the prototype's error paths. */
export type ServiceState = "normal" | "sol-unavailable" | "budget-low" | "budget-exhausted" | "truncate-next";
export type SendCheck =
  | { ok: true }
  | { ok: false; problem: "unavailable" | "budget"; message: string; alternatives: Fallback[] };

export function checkSendable(route: Route, service: ServiceState): SendCheck {
  if (service === "budget-exhausted") {
    return { ok: false, problem: "budget", message: "今日 AI 额度已用完（模拟）。这条消息没有发出，草稿已保留；听写判分等本地功能不受影响。", alternatives: [] };
  }
  if (service === "budget-low" && route.effort === "high") {
    return { ok: false, problem: "budget", message: `剩余额度不够完成 ${requestLabel(route.model, route.effort)} 的预计用量（模拟）。可以只把这条降为中等思考发送。`, alternatives: [{ model: route.model, effort: "medium", label: "只把这条降为中等思考发送" }] };
  }
  if (service === "sol-unavailable" && route.model === "gpt-6.1-sol") {
    return { ok: false, problem: "unavailable", message: `${MODEL_NAME[route.model]} 暂时不可用（模拟）。这条消息没有发出，也不会自动换模型重试。`, alternatives: [{ model: "gpt-6.1-terra", label: "只把这条改用 Terra 发送" }] };
  }
  return { ok: true };
}
