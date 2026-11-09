import { useState, type ReactNode } from "react";
import { AudioLines, BookOpen, Check, ChevronDown, Copy, FileText, Image as ImageIcon, Quote as QuoteIcon } from "lucide-react";
import { ARTICLE, dayLabel, lookupWord, SAMPLE_LABEL, SAMPLE_NOTE, sentenceSpans, sourceLabel, WEEKDAYS } from "../data";
import { MANGROVE_NOTES, NOTES_LABEL } from "../data/mangrove-notes";
import { sentenceIndexLabel } from "../engine";
import { englishTokens } from "../lexicon-match";
import { buildPlan, MISTAKE_TITLE, sampleStatus, SCOPE_LABEL, type MistakeKind, type PlanScope, type PlanSpec } from "../practice";
import { AUDIO_ROUTE, PROGRAM_ROUTE, requestLabel, TASK_LABEL } from "../routing";
import { paragraphLabel, sentencesInQuote, type Quote } from "../selection";
import { statusLabel } from "../sources";
import { useStore } from "../store";
import type { Action, AssistantMessage, Block, Message, ResultMessage, UserMessage, VoiceMessage } from "../types";
import { TraceGlyph } from "./icons";
import { Modal } from "./modal";
import { Thumb } from "./thumb";
import { QuotePreview } from "./composer";

type Place = "full" | "mini";

export function MessageList({ messages, conversationId, place }: { messages: Message[]; conversationId: string; place: Place }) {
  return (
    <ol className={`thread thread-${place}`} aria-label="对话内容">
      {messages.map((message) => (
        <li key={message.id} className={`message message-${message.role}`}>
          {message.role === "user" && <UserBubble message={message} />}
          {message.role === "assistant" && <AssistantReply message={message} conversationId={conversationId} place={place} />}
          {message.role === "result" && <ResultCard message={message} />}
          {message.role === "voice" && <VoiceTranscript message={message} />}
        </li>
      ))}
    </ol>
  );
}

function UserBubble({ message }: { message: UserMessage }) {
  const [preview, setPreview] = useState<Quote | null>(null);
  return (
    <div className="user-turn">
      {message.quotes.map((quote) => (
        <button key={quote.id} type="button" className="sent-quote" onClick={() => setPreview(quote)}>
          <QuoteIcon size={13} aria-hidden="true" />
          <span className="reading-text">{quote.text.replace(/\n+/g, " ")}</span>
          <span className="sent-quote-meta">{quote.title} · {paragraphLabel(quote)}</span>
        </button>
      ))}
      {message.attachments.length > 0 && (
        <ul className="sent-files" aria-label="附件">
          {message.attachments.map((attachment) => (
            <li key={attachment.id} className={`sent-file status-${attachment.status}`}>
              {attachment.previewUrl ? <Thumb src={attachment.previewUrl} alt="" className="chip-thumb" /> : attachment.kind === "image" ? <ImageIcon size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
              <span><strong>{attachment.name}</strong><small>{statusLabel(attachment)}{!attachment.previewUrl && attachment.kind === "image" ? " · 预览未保存" : ""}</small></span>
            </li>
          ))}
        </ul>
      )}
      {message.text && <p className="bubble">{message.via === "voice" && <AudioLines size={14} aria-label="语音" />}{message.text}</p>}
      <Modal open={preview !== null} onClose={() => setPreview(null)} title="引用">{preview && <QuotePreview quote={preview} />}</Modal>
    </div>
  );
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => {
        const lines = paragraph.split("\n");
        if (lines.every((line) => line.startsWith("· "))) return <ul key={index} className="plain-list">{lines.map((line, item) => <li key={item}>{line.slice(2)}</li>)}</ul>;
        return <p key={index}>{paragraph}</p>;
      })}
    </>
  );
}

function AssistantReply({ message, conversationId, place }: { message: AssistantMessage; conversationId: string; place: Place }) {
  const { state, continueReply } = useStore();
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const streaming = message.status === "streaming";
  const lead = message.blocks[0];
  const shown = streaming && lead?.type === "text" ? [{ ...lead, text: lead.text.slice(0, message.revealed) }] : message.blocks;
  const label = requestLabel(message.request.model, message.request.reasoning.effort);
  const copy = async () => {
    const text = message.blocks.filter((block): block is Extract<Block, { type: "text" }> => block.type === "text").map((block) => block.text).join("\n\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
  };
  const context = message.request.context;
  return (
    <div className="ai-turn" aria-busy={streaming}>
      <span className="ai-mark" aria-hidden="true"><TraceGlyph size={18} /></span>
      <div className="ai-body">
        {shown.map((block, index) => <BlockView key={index} block={block} index={index} message={message} conversationId={conversationId} place={place} />)}
        {message.status === "stopped" && <p className="status-note">已停止。已显示的内容保留；可以修改问题后再发送。</p>}
        {message.status === "incomplete" && (
          <div className="inline-notice tone-warn">
            <p>回答在中途结束（模拟输出上限）。已收到的内容保留，没有自动重试。</p>
            {message.remainder && (
              <button type="button" className="button button-quiet" disabled={state.conversations.find((item) => item.id === conversationId)?.messages.some((item) => item.role === "assistant" && item.status === "streaming")}
                onClick={() => continueReply(conversationId, message.id)}>继续回答（另发一次 {label} 请求）</button>
            )}
          </div>
        )}
        {!streaming && (
          <div className="msg-meta">
            <button type="button" className="meta-route" aria-expanded={details} onClick={() => setDetails((value) => !value)}>
              <span className="meta-model">{label}</span>
              <span className="meta-reason">{message.routeReason}</span>
              <ChevronDown size={14} aria-hidden="true" className={details ? "is-open" : ""} />
            </button>
            <button type="button" className="icon-button small" aria-label={copied ? "已复制" : "复制回答文字"} onClick={() => void copy()}>
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </button>
          </div>
        )}
        {details && !streaming && (
          <dl className="request-detail">
            <div><dt>任务</dt><dd>{TASK_LABEL[message.request.metadata.task]}</dd></div>
            <div><dt>请求</dt><dd><code>model: {message.request.model}</code> <code>reasoning.effort: {message.request.reasoning.effort}</code></dd></div>
            <div><dt>来源</dt><dd>{message.request.metadata.routeSource === "auto" ? "自动选择" : message.request.metadata.routeSource === "next-only" ? "仅这一条的手动选择" : "你设定的后续偏好"}</dd></div>
            <div><dt>附带</dt><dd>
              学习记录{context.records ? "（示例）" : "：未附带"}；文章全文：{context.article === "full" ? "已附带" : context.article === "off" ? "已关闭" : "无"}；
              引用 {context.quotes} 段{context.quotes ? `（${context.quoteChars} 字符）` : ""}
              {context.readFiles.map((file) => `；已读取「${file.name}」${file.chars} 字`).join("")}
              {context.attachmentsOnly.map((file) => `；「${file.name}」仅附件`).join("")}
            </dd></div>
            <div><dt>说明</dt><dd>演示中这份请求没有发出；回答由本地规则生成。正式接入时，按这里的 model 与 effort 原样发送。</dd></div>
          </dl>
        )}
      </div>
    </div>
  );
}

function BlockView({ block, index, message, conversationId, place }: { block: Block; index: number; message: AssistantMessage; conversationId: string; place: Place }) {
  switch (block.type) {
    case "text": return <div className="ai-text"><RichText text={block.text} /></div>;
    case "quote-answer": return <QuoteAnswer quote={block.quote} mode={block.mode} focus={block.focus} />;
    case "plan": return <PlanCard spec={block.spec} index={index} message={message} conversationId={conversationId} place={place} />;
    case "long-plan": return <LongPlan block={block} index={index} message={message} conversationId={conversationId} />;
    case "status": return <StatusCard />;
    case "sources": return <SourcesCard block={block} />;
    case "actions": return <ActionRow actions={block.actions} place={place} />;
    case "notice": return <div className={`inline-notice tone-${block.tone}`}><p>{block.text}</p></div>;
  }
}

function SentenceText({ quote, paragraph, sentence }: { quote: Quote; paragraph: number; sentence: number }) {
  const span = sentenceSpans(ARTICLE.paragraphs[paragraph])[sentence];
  const from = paragraph === quote.start.paragraph ? quote.start.offset : 0;
  const to = paragraph === quote.end.paragraph ? quote.end.offset : ARTICLE.paragraphs[paragraph].text.length;
  const a = Math.max(from, span.start) - span.start;
  const b = Math.min(to, span.end) - span.start;
  if (a <= 0 && b >= span.text.length) return <span>{span.text}</span>;
  return <span>{span.text.slice(0, a)}<mark>{span.text.slice(a, b)}</mark>{span.text.slice(b)}</span>;
}

const STOP = new Set("the a an and or of to in on at by for with from as is are be been was were it its that this which there their all can so only just more about where during near than into out up".split(" "));

function QuoteAnswer({ quote, mode, focus }: { quote: Quote; mode: "translate" | "define" | "grammar" | "context"; focus?: string }) {
  const sentences = sentencesInQuote(ARTICLE, quote);
  const source = <p className="answer-source"><BookOpen size={13} aria-hidden="true" />{quote.title} · {quote.author} · {paragraphLabel(quote)}</p>;
  if (mode === "define") {
    const tokens = englishTokens(quote.text);
    const seen = new Set<string>();
    const found: { token: string; word: NonNullable<ReturnType<typeof lookupWord>> }[] = [];
    const missing: { token: string; gloss?: string }[] = [];
    for (const token of tokens) {
      const key = token.toLowerCase();
      if (seen.has(key) || (tokens.length > 1 && (STOP.has(key) || key.length < 3))) continue;
      seen.add(key);
      const word = lookupWord(token);
      if (word) { if (!found.some((item) => item.word.id === word.id)) found.push({ token, word }); continue; }
      const paragraphText = ARTICLE.paragraphs.slice(quote.start.paragraph, quote.end.paragraph + 1).map((item) => item.text).join(" ");
      const paren = new RegExp(`\\b${token}\\s*\\(([^)]+)\\)`, "i").exec(paragraphText)?.[1];
      const alias = new RegExp(`([A-Za-z ]+),\\s*or\\s+${token}\\b`, "i").exec(paragraphText)?.[1];
      missing.push({ token, gloss: paren ? `原文括注：${paren}` : alias ? `原文说明：即 ${alias.trim()}` : undefined });
    }
    return (
      <section className="answer-card" aria-label="词义">
        {source}
        {found.length > 0 && (
          <ul className="word-list">
            {found.slice(0, 10).map(({ token, word }) => (
              <li key={word.id}>
                <span className="word-head"><strong>{word.headword}</strong>{token.toLowerCase() !== word.headword.toLowerCase() && <small>原文 {token}</small>}{word.ipa && <span className="ipa">/{word.ipa}/</span>}</span>
                <span className="word-zh">{word.chineseCore}</span>
                <span className="word-src">{sourceLabel(word)}</span>
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 && (
          <div className="word-missing">
            <p className="label">词迹词库未收录</p>
            <ul>{missing.slice(0, 6).map((item) => <li key={item.token}><strong>{item.token}</strong>{item.gloss ? ` · ${item.gloss}` : " · 可继续追问，正式接入后由 Terra 结合语境解释"}</li>)}</ul>
          </div>
        )}
        <p className="answer-foot">释义来自词迹词库（教材与课程标准来源，含稳定词条 ID）。</p>
      </section>
    );
  }
  return (
    <section className="answer-card" aria-label={mode === "translate" ? "译文" : mode === "grammar" ? "语法分析" : "原文要点"}>
      {source}
      <ol className="sentence-list">
        {sentences.map((item) => {
          const note = MANGROVE_NOTES[`${item.paragraph}-${item.sentence}`];
          const points = note ? (focus ? [...note.points].sort((a, b) => Number(b.includes(focus)) - Number(a.includes(focus))) : note.points) : [];
          return (
            <li key={`${item.paragraph}-${item.sentence}`}>
              <p className="sentence-label">{sentenceIndexLabel(item.paragraph, item.sentence)}{item.partial ? " · 选区是这句的一部分" : ""}</p>
              <p className="reading-text"><SentenceText quote={quote} paragraph={item.paragraph} sentence={item.sentence} /></p>
              {note && (mode === "translate" || mode === "context") && <p className="zh">{note.zh}</p>}
              {note && (mode === "grammar" || mode === "context") && <p className="grammar-core">{note.core}</p>}
              {note && mode === "grammar" && (
                <ul className="grammar-points">{points.map((point) => <li key={point} className={focus && point.includes(focus) ? "is-focus" : ""}>{point}</li>)}</ul>
              )}
            </li>
          );
        })}
      </ol>
      <p className="answer-foot">{NOTES_LABEL}</p>
    </section>
  );
}

const MINUTE_CHOICES = [10, 15, 20, 30];

function PlanCard({ spec, index, message, conversationId, place }: { spec: PlanSpec; index: number; message: AssistantMessage; conversationId: string; place: Place }) {
  const { dispatch, startPractice, setView, state } = useStore();
  const steps = buildPlan(spec);
  const total = steps.reduce((sum, step) => sum + step.minutes, 0);
  const update = (patch: Partial<PlanSpec>) => dispatch({ type: "block", id: conversationId, messageId: message.id, index, block: { type: "plan", spec: { ...spec, ...patch } } });
  const scopes: PlanScope[] = spec.fileItems?.length ? ["file", "mistakes", "due", "unit4"] : ["mistakes", "due", "unit4"];
  const recordsOff = message.request.context.records === false;
  const dictation = steps[0];
  const longPlan = message.blocks.some((block) => block.type === "long-plan");
  return (
    <section className={`plan-card${longPlan ? " is-first-step" : ""}`} aria-label={longPlan ? "今天第一步" : "今天的练习安排"}>
      <header className="plan-head">
        <div>
          <p className="plan-kicker">{longPlan ? "今天第一步" : "今天的安排"}</p>
          <h3>{total} 分钟 · {steps.length} 步</h3>
        </div>
        <div className="plan-controls">
          <div className="segmented small" role="radiogroup" aria-label="可用时间">
            {[...new Set([...MINUTE_CHOICES, spec.minutes])].sort((a, b) => a - b).map((minutes) => (
              <button key={minutes} type="button" role="radio" aria-checked={spec.minutes === minutes} onClick={() => update({ minutes })}>{minutes}<span className="unit">分</span></button>
            ))}
          </div>
          <label className="select-field">
            <span className="visually-hidden">练习范围</span>
            <select value={spec.scope} onChange={(event) => update({ scope: event.target.value as PlanScope })}>
              {scopes.map((scope) => <option key={scope} value={scope} disabled={recordsOff && (scope === "mistakes" || scope === "due")}>{SCOPE_LABEL[scope]}{recordsOff && (scope === "mistakes" || scope === "due") ? "（学习记录未附带）" : ""}</option>)}
            </select>
            <ChevronDown size={15} aria-hidden="true" />
          </label>
        </div>
      </header>
      <ol className="plan-steps">
        {steps.map((step, position) => (
          <li key={step.id} className={`plan-step step-${step.kind}`}>
            <span className="step-index" aria-hidden="true">{position + 1}</span>
            <div className="step-body">
              <p className="step-title">{step.title}<span className="step-time">约 {step.minutes} 分钟</span></p>
              <p className="step-detail">{step.detail}</p>
              {step.items && step.items.length > 0 && <p className="step-words">{step.items.map((item) => item.text).join(" · ")}</p>}
            </div>
            {step.kind === "dictation" && (
              <button type="button" className="button button-primary" disabled={!step.items?.length}
                onClick={() => startPractice(step.items ?? [], `${state.conversations.find((item) => item.id === conversationId)?.temporary ? "临时 · " : ""}${step.items?.length ?? 0} 词听写`, step.detail, place)}>开始听写</button>
            )}
            {step.kind === "reading" && <button type="button" className="button button-secondary" onClick={() => setView("reading")}>打开阅读</button>}
          </li>
        ))}
      </ol>
      <p className="plan-foot">由本地规则按时间拆分；听写词来自{SCOPE_LABEL[spec.scope]}{dictation.items?.length ? `，共 ${dictation.items.length} 词` : ""}。</p>
    </section>
  );
}

function LongPlan({ block, index, message, conversationId }: { block: Extract<Block, { type: "long-plan" }>; index: number; message: AssistantMessage; conversationId: string }) {
  const { state, dispatch } = useStore();
  const set = (added: "pending" | "added" | undefined) => dispatch({ type: "block", id: conversationId, messageId: message.id, index, block: { ...block, added } });
  const studyDays = Array.from({ length: block.days }, (_, offset) => {
    const date = new Date(block.startedAt);
    date.setDate(date.getDate() + offset);
    return { offset, date, rest: block.restWeekdays.includes(date.getDay()) };
  });
  const active = studyDays.filter((day) => !day.rest);
  const phaseOf = (position: number) => {
    if (position >= active.length - 2) return { key: "test", label: "自测" };
    const reviewFirst = block.order === "review-first";
    const early = position < Math.max(1, Math.round(active.length * 0.35));
    return early === reviewFirst ? { key: "review", label: "复习" } : { key: "new", label: "新词" };
  };
  return (
    <section className="long-plan" aria-label="整段安排">
      <header className="plan-head">
        <div>
          <p className="plan-kicker">整段安排 · 草稿</p>
          <h3>{block.days} 天 · 每天 {block.minutes} 分钟</h3>
        </div>
        <p className="long-plan-sub">{active.length} 个学习日{block.restWeekdays.length ? ` · 周${block.restWeekdays.map((day) => WEEKDAYS[day]).join("、")}休息` : ""}</p>
      </header>
      <ol className="day-grid">
        {studyDays.map((day) => {
          const phase = day.rest ? { key: "rest", label: "休息" } : phaseOf(active.indexOf(day));
          return (
            <li key={day.offset} className={`day phase-${phase.key}${day.offset === 0 ? " is-today" : ""}`}>
              <span className="day-date">{day.date.getMonth() + 1}/{day.date.getDate()}</span>
              <span className="day-week">周{WEEKDAYS[day.date.getDay()]}</span>
              <span className="day-phase">{day.offset === 0 ? "今天" : phase.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="plan-foot">整段安排只定节奏；每天的词在当天按练习表现重新挑选。</p>
      <div className="schedule-row" aria-live="polite">
        {block.added === "added" ? (
          <>
            <p className="ok-text"><Check size={15} aria-hidden="true" />已加入学习安排。原型只记在这段对话里，不写入正式的今日学习。</p>
            <button type="button" className="button button-quiet" onClick={() => set(undefined)}>撤销</button>
          </>
        ) : block.added === "pending" ? (
          <>
            <p>加入后，接下来 {block.days} 天的今日学习会按这份节奏安排。确认加入吗？</p>
            <button type="button" className="button button-primary" onClick={() => set("added")}>确认加入</button>
            <button type="button" className="button button-quiet" onClick={() => set(undefined)}>取消</button>
          </>
        ) : (
          <button type="button" className="button button-secondary" onClick={() => set(state.settings.confirmBeforeSchedule ? "pending" : "added")}>加入学习安排</button>
        )}
      </div>
    </section>
  );
}

function StatusCard() {
  const status = sampleStatus();
  const kinds = Object.entries(status.kinds) as [MistakeKind, number][];
  const max = Math.max(1, ...kinds.map(([, count]) => count));
  return (
    <section className="status-card" aria-label="这周的练习表现">
      <p className="sample-tag">{SAMPLE_LABEL} · {SAMPLE_NOTE}</p>
      <dl className="stat-grid">
        <div><dt>有练习的天数</dt><dd>{status.practiceDays}<small> / 7 天</small></dd></div>
        <div><dt>听写正确</dt><dd>{status.dictationCorrect}<small> / {status.dictationTotal} 词</small></dd></div>
        <div><dt>复习正确</dt><dd>{status.reviewCorrect}<small> / {status.reviewTotal} 词</small></dd></div>
        <div><dt>到期复习</dt><dd>{status.due}<small> 词</small></dd></div>
      </dl>
      <p className="label">错误类型</p>
      <ul className="kind-bars">
        {kinds.map(([kind, count]) => (
          <li key={kind}><span>{MISTAKE_TITLE[kind]}</span><span className="bar" aria-hidden="true"><span style={{ width: `${(count / max) * 100}%` }} /></span><span className="num">{count}</span></li>
        ))}
      </ul>
      <p className="label">本周写错的词</p>
      <ul className="word-pills">{status.frequent.map((row) => <li key={row.word.id}>{row.word.headword}<small>错 {row.count} 次</small></li>)}</ul>
    </section>
  );
}

function SourcesCard({ block }: { block: Extract<Block, { type: "sources" }> }) {
  return (
    <section className="sources-card" aria-label="这条消息用到的来源">
      <p className="label">这条消息的来源</p>
      <ul>
        {block.read.map((item) => <li key={item.name}><FileText size={14} aria-hidden="true" /><span><strong>{item.name}</strong> · 已读取{item.truncated ? "前 20,000 字" : ` ${item.chars} 字`}<small>开头：{item.excerpt}{item.excerpt.length >= 80 ? "…" : ""}</small></span></li>)}
        {block.attached.map((item) => <li key={item.name} className="is-attached"><ImageIcon size={14} aria-hidden="true" /><span><strong>{item.name}</strong> · 仅附件（{item.kind}内容没有被读取）</span></li>)}
        {block.quotes > 0 && <li><QuoteIcon size={14} aria-hidden="true" /><span>你的引用 {block.quotes} 段</span></li>}
        <li className={block.records ? "" : "is-off"}><span>学习记录：{block.records ? "已附带（示例）" : "未附带"}</span></li>
        <li className={block.article === "full" ? "" : "is-off"}><span>文章全文：{block.article === "full" ? "已附带" : block.article === "off" ? "已关闭" : "当前没有文章"}</span></li>
      </ul>
    </section>
  );
}

function ActionRow({ actions, place }: { actions: Action[]; place: Place }) {
  const { send, active, setView, startPractice, dispatch } = useStore();
  return (
    <div className="action-row">
      {actions.map((action) => (
        <button key={action.id} type="button" className="button button-secondary" onClick={() => {
          if (action.intent === "send") send(active.id, { text: action.text, keepDraft: true });
          else if (action.intent === "open-reading") setView("reading");
          else if (action.intent === "start-dictation") startPractice(action.items, action.title, "对话中的建议", place);
          else dispatch({ type: "settings-open", section: action.section });
        }}>{action.label}</button>
      ))}
    </div>
  );
}

function ResultCard({ message }: { message: ResultMessage }) {
  const { rounds } = message.result;
  return (
    <section className="result-card" aria-label="练习结果">
      <header>
        <p className="plan-kicker">练习结果 · {PROGRAM_ROUTE.label}</p>
        <h3>{message.result.title}</h3>
      </header>
      <ul className="round-list">
        {rounds.map((round, position) => {
          const correct = round.filter((answer) => answer.score.correct).length;
          return (
            <li key={position}>
              <p className="round-head">{position === 0 ? "第一轮" : `重练第 ${position} 轮`}<span className="num">{correct} / {round.length}</span></p>
              <ul className="answer-list">
                {round.filter((answer) => !answer.score.correct).map((answer) => (
                  <li key={answer.item.id}><span className="wrong">{answer.answer || "（空）"}</span><span aria-hidden="true">→</span><strong>{answer.item.text}</strong><small>{answer.score.kind ? MISTAKE_TITLE[answer.score.kind] : ""}</small></li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      <p className="plan-foot">{PROGRAM_ROUTE.detail}。</p>
    </section>
  );
}

function VoiceTranscript({ message }: { message: VoiceMessage }) {
  const [open, setOpen] = useState(message.captions.length <= 4);
  const minutes = Math.floor(message.seconds / 60);
  return (
    <section className="voice-card" aria-label="语音会话记录">
      <button type="button" className="voice-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <AudioLines size={15} aria-hidden="true" />
        <span>语音会话 · 演示 · {message.captions.length} 句 · {minutes}:{String(message.seconds % 60).padStart(2, "0")}</span>
        <ChevronDown size={14} aria-hidden="true" className={open ? "is-open" : ""} />
      </button>
      {open && (
        <ol className="caption-list">
          {message.captions.map((caption, index) => <li key={index} className={`caption caption-${caption.speaker}`}><span className="who">{caption.speaker === "user" ? "你" : "AI"}</span>{caption.text}</li>)}
        </ol>
      )}
      <p className="plan-foot">{AUDIO_ROUTE.label}（演示中未调用）；字幕是你输入的文字与本地回答。</p>
    </section>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) { return <p className="empty-note">{children}</p>; }
export { dayLabel };
