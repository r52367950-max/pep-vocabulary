"use client";
import { BookOpen, Bookmark, Layers3, Search, ShieldCheck, Volume2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { speakSystem, type LexiconDetail, type LexiconIndexEntry, type Scope } from "@/lib/lexicon";
import type { ReviewEvent, SkillName, StoredCard } from "@/lib/storage";

const scopeLabels: Record<Scope,string>={"middle-core":"初中核心","high-required":"高中必修","high-selective":"选择性必修","curriculum-not-textbook":"课标差集","gaokao-supplement":"高考补充","common-supplement":"常用课外"};
const books=[["HS-R1","必修一"],["HS-R2","必修二"],["HS-R3","必修三"],["HS-S1","选必一"],["HS-S2","选必二"],["HS-S3","选必三"],["HS-S4","选必四"],["JH-7A","七上"],["JH-7B","七下"],["JH-8A","八上"],["JH-8B","八下"],["JH-9","九年级"]] as const;
const skillLabels:Record<SkillName,string>={meaning:"识义",listening:"听辨",spelling:"拼写",context:"语境",collocation:"搭配",output:"输出"};
const statusLabel=(status?:StoredCard["status"])=>({unseen:"未学",learning:"学习中",weak:"薄弱",mastered:"已掌握",paused:"暂停"} as const)[status||"unseen"];
function sourceLine(entry:LexiconIndexEntry){const source=entry.sources[0];return source?`${source.volume} · ${source.unit}${source.printedPage?` · p.${source.printedPage}`:""}`:"来源待核"}
function due(card?:StoredCard){if(!card?.lastReviewed)return "—";const delta=new Date(card.due).getTime()-Date.now();if(delta<=0){const n=Math.floor(Math.abs(delta)/86400000);return n?`逾期 ${n} 天`:"今天"}const hours=Math.round(delta/3600000);if(hours<24)return `${Math.max(1,hours)} 小时后`;const days=Math.round(delta/86400000);return days<30?`+${days} 天`:`+${Math.round(days/30)} 个月`}
function retention(card?:StoredCard){const s=Number(card?.fsrs.stability||0);return s/Math.max(1,s+2)}

export type ConsoleLexiconProps={entries:LexiconIndexEntry[];total:number;selected:LexiconIndexEntry|null;detail:LexiconDetail|null;visibleDetails:Map<string,LexiconDetail>;cards:Map<string,StoredCard>;events:ReviewEvent[];allEntries:LexiconIndexEntry[];query:string;setQuery:(v:string)=>void;scopeFilters:Scope[];setScopeFilters:(v:Scope[])=>void;bookFilter:string;setBookFilter:(v:string)=>void;unitFilter:string;setUnitFilter:(v:string)=>void;statusFilters:string[];setStatusFilters:(v:string[])=>void;availableUnits:string[];onSelect:(e:LexiconIndexEntry)=>void;onFavorite:(e:LexiconIndexEntry)=>void;onNote:(e:LexiconIndexEntry,n:string)=>void;onStudy:(e:LexiconIndexEntry)=>void};

export default function ConsoleLexicon(p:ConsoleLexiconProps){
 const{entries,total,selected,detail,visibleDetails,cards,events,allEntries,query,setQuery,scopeFilters,setScopeFilters,bookFilter,setBookFilter,unitFilter,setUnitFilter,statusFilters,setStatusFilters,availableUnits,onSelect,onFavorite,onNote,onStudy}=p;
 const[mobileDetailOpen,setMobileDetailOpen]=useState(false);
 const byId=useMemo(()=>new Map(allEntries.map(e=>[e.id,e])),[allEntries]);
 const card=selected?cards.get(selected.id):undefined;
 const history=useMemo(()=>selected?[...events].filter(e=>e.cardId===selected.id).sort((a,b)=>b.timestampUtc.localeCompare(a.timestampUtc)):[],[events,selected]);
 const relations=(ids?:string[])=>(ids||[]).map(id=>byId.get(id)).filter(Boolean) as LexiconIndexEntry[];
 const family=relations(detail?.relations.family),phrases=relations(detail?.relations.phrases),confusables=relations(detail?.relations.confusables);
 const active=scopeFilters.length+statusFilters.length+Number(bookFilter!=="all")+Number(unitFilter!=="all");
 const scopeOrder:Scope[]=["high-required","high-selective","middle-core","curriculum-not-textbook","gaokao-supplement","common-supplement"];
 const toggleScope=(s:Scope)=>setScopeFilters(scopeFilters.includes(s)?scopeFilters.filter(v=>v!==s):[...scopeFilters,s]);
 const toggleStatus=(s:string)=>setStatusFilters(statusFilters.includes(s)?statusFilters.filter(v=>v!==s):[...statusFilters,s]);
 const select=(e:LexiconIndexEntry)=>{onSelect(e);setMobileDetailOpen(true)};
 const statusCount=(s:string)=>s==="unseen"?allEntries.filter(e=>!cards.has(e.id)||cards.get(e.id)?.status==="unseen").length:[...cards.values()].filter(c=>c.status===s).length;
 return <div className="console-lexicon">
  <header className="lexicon-console-head"><label><Search size={18}/><input id="lexicon-search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="英文、中文、词根或模糊拼写" aria-label="搜索词库"/><kbd>/</kbd></label><div><strong>{entries.length.toLocaleString()}</strong><span>/ {total.toLocaleString()} 条</span></div></header>
  <section className="filter-console" aria-label="词库组合筛选">
   <div className="filter-line"><span><Layers3 size={14}/>范围</span><div className="chip-scroll">{scopeOrder.map(s=><button key={s} className={scopeFilters.includes(s)?"active":""} onClick={()=>toggleScope(s)}>{scopeLabels[s]} <em>{allEntries.filter(e=>e.scopes.includes(s)).length}</em></button>)}</div></div>
   <div className="filter-line"><span><BookOpen size={14}/>教材</span><select value={bookFilter} onChange={e=>setBookFilter(e.target.value)} aria-label="筛选册次"><option value="all">全部册次</option>{books.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><select value={unitFilter} onChange={e=>setUnitFilter(e.target.value)} aria-label="筛选单元"><option value="all">全部单元</option>{availableUnits.map(u=><option key={u}>{u}</option>)}</select><div className="chip-scroll status-chips">{[["weak","薄弱"],["unseen","未学"],["learning","学习中"],["mastered","已掌握"],["favorite","收藏"]].map(([id,label])=><button key={id} className={statusFilters.includes(id)?"active":""} onClick={()=>toggleStatus(id)}>{label} <em>{id==="favorite"?[...cards.values()].filter(c=>c.favorite).length:statusCount(id)}</em></button>)}</div></div>
   <div className="filter-summary"><span>已选 {active} 个条件 · 一行一个词 · 按字母序</span>{active>0&&<button onClick={()=>{setScopeFilters([]);setStatusFilters([]);setBookFilter("all");setUnitFilter("all")}}>清空筛选</button>}</div>
  </section>
  <div className="lexicon-console-body">
   <section className="console-word-list" aria-label="词条结果"><div className="console-list-head"><span>词头 / IPA</span><span>词性 / 核心义</span><span>开放简义</span><span>教材位置</span><span>状态 / 下次</span></div>
    {entries.slice(0,90).map(e=>{const c=cards.get(e.id),d=visibleDetails.get(e.id);return <button key={e.id} className={selected?.id===e.id?"console-word-row selected":"console-word-row"} onClick={()=>select(e)}><span className="word-cell"><strong>{e.headword}</strong><small>{e.britishIpa?`/${e.britishIpa}/`:"IPA 待核"}</small></span><span className="meaning-cell"><em>{e.partsOfSpeech.join(" / ")||"—"}</em><strong>{e.chineseCore}</strong></span><span className="english-cell">{d?.englishCore||"开放简义待补"}</span><span className="source-cell">{sourceLine(e)}</span><span className="state-cell"><em data-status={c?.status||"unseen"}>{statusLabel(c?.status)}</em><strong>{due(c)}</strong></span></button>})}
    {entries.length>90&&<p className="list-limit">当前显示前 90 条；继续输入关键词可以缩小范围。</p>}{!entries.length&&<div className="console-empty"><strong>没有符合条件的词条</strong><p>移除一个筛选条件，或换用更短的搜索词。</p></div>}
   </section>
   <aside className={`console-detail-pane ${mobileDetailOpen?"mobile-open":""}`} aria-label="词条详情">{selected?<>
    <div className="detail-console-actions"><span>{selected.tier} 层 · {statusLabel(card?.status)}</span><button className={card?.favorite?"square-icon active":"square-icon"} onClick={()=>onFavorite(selected)} aria-label="收藏词条"><Bookmark size={17} fill={card?.favorite?"currentColor":"none"}/></button><button className="square-icon detail-mobile-close" onClick={()=>setMobileDetailOpen(false)} aria-label="关闭词条详情"><X size={18}/></button></div>
    <h2>{selected.headword}</h2><button className="console-pronunciation" onClick={()=>speakSystem(selected.headword)}><Volume2 size={17}/><span>BrE /{selected.britishIpa||"—"}/</span><small>系统语音</small></button>{selected.americanIpa&&selected.americanIpa!==selected.britishIpa&&<p className="us-ipa">NAmE /{selected.americanIpa}/</p>}
    <div className="pos-line">{selected.partsOfSpeech.length?selected.partsOfSpeech.map(pos=><span key={pos}>{pos}.</span>):<span>词性待字段级核验</span>}</div><div className="meaning-block"><span>核心义</span><p>{selected.chineseCore}</p>{detail?.englishCore&&<small>{detail.englishCore}</small>}</div>{detail?.openExample&&<div className="example-block"><span>开放语料例句</span><p>{detail.openExample}</p><small>开放词典字段 · 许可见词条记录</small></div>}
    {(family.length>0||phrases.length>0||confusables.length>0)&&<div className="relation-console"><span>词族与关联</span>{family.length>0&&<div><em>词族</em>{family.map(e=><button key={e.id} onClick={()=>select(e)}>{e.headword}</button>)}</div>}{phrases.length>0&&<div><em>短语</em>{phrases.slice(0,6).map(e=><button key={e.id} onClick={()=>select(e)}>{e.headword}</button>)}</div>}{confusables.length>0&&<div><em>易混</em>{confusables.map(e=><button key={e.id} onClick={()=>select(e)}>{e.headword}</button>)}</div>}</div>}
    <div className="source-block"><span>来源位置</span>{selected.sources.slice(0,5).map((s,i)=><p key={`${s.bookId}-${s.unit}-${i}`}><ShieldCheck size={14}/>{s.volume} · {s.unit}{s.printedPage?` · p.${s.printedPage}`:""}<small>{s.status||"verified-primary"}</small></p>)}</div>
    {detail?.grammar&&(detail.grammar.countability||detail.grammar.transitivity)&&<div className="grammar-line">{detail.grammar.countability&&<span>{detail.grammar.countability}</span>}{detail.grammar.transitivity&&<span>{detail.grammar.transitivity}</span>}</div>}
    <div className="fsrs-console"><span>FSRS 主状态</span><div><div><small>复习</small><strong>{history.length}</strong></div><div><small>稳定度</small><strong>{Number(card?.fsrs.stability||0).toFixed(1)}</strong></div><div><small>难度</small><strong>{Number(card?.fsrs.difficulty||0).toFixed(1)}</strong></div><div><small>估计保持</small><strong>{Math.round(retention(card)*100)}%</strong></div></div><p>下次：{due(card)} · 一个词跨词书只保留一个状态</p></div>
    {card&&<div className="detail-skills"><span>六项能力</span>{(Object.keys(skillLabels) as SkillName[]).map(s=><div key={s}><em>{skillLabels[s]}</em><i><b style={{width:`${card.skills[s]*100}%`}}/></i><strong>{Math.round(card.skills[s]*100)}</strong></div>)}</div>}
    {history.length>0&&<div className="history-console"><span>最近复习记录</span>{history.slice(0,5).map(e=><div key={e.eventId}><time>{new Date(e.timestampUtc).toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"})}</time><strong>{skillLabels[e.skill]}</strong><em className={e.correct?"correct":"incorrect"}>{e.correct?"正确":"未命中"}</em><small>{e.answerGiven?`作答：${e.answerGiven}`:`评分 ${e.rating}`}</small></div>)}</div>}
    <label className="note-field"><span>我的注释</span><textarea key={selected.id} defaultValue={card?.note||""} onBlur={e=>onNote(selected,e.target.value)} placeholder="记录易错点或自己的例句；离开输入框即保存"/></label><button className="console-primary full" onClick={()=>onStudy(selected)}>从这个词开始练习</button><p className="rights-note">未公开复制教材整段；详情只保留词表事实、页码定位和许可明确的开放字段。</p>
   </>:<div className="console-empty"><strong>选择一个词条</strong><p>右侧会显示音标、来源、核心义和学习状态。</p></div>}</aside>
  </div>
 </div>
}
