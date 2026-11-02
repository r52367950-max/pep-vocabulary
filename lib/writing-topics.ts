import { WRITING_TOPIC_DATA, WRITING_TOPIC_SOURCES } from './writing-topic-data';
import type { WritingGenre } from './backup';
export type WritingTopic = { id:string;kind:WritingGenre;title:string;prompt:string;readingText?:string;paragraphStarters?:string[];cefr:'A2'|'B1'|'B2'|'C1';wordMin:number;wordMax:number;themes:string[];skills:string[];sourceIds:string[];provenance:'original'|'adapted-pattern'|'ai-original';prerequisites?:string[];unitKeywords?:string[] };
export const WRITING_TOPICS = WRITING_TOPIC_DATA as WritingTopic[];
export { WRITING_TOPIC_SOURCES };
export const getWritingTopic = (id:string) => WRITING_TOPICS.find(topic=>topic.id===id);
export function topicPrompt(topic:WritingTopic) {
  return [topic.prompt,topic.readingText && `Reading passage:\n${topic.readingText}`,topic.paragraphStarters?.length && `Begin the two paragraphs with:\n1. ${topic.paragraphStarters[0]}\n2. ${topic.paragraphStarters[1]}`].filter(Boolean).join('\n\n');
}
export type WritingTopicContext={wordIds?:string[];bookIds?:string[];units?:string[];recentTitles?:string[];themes?:string[];cefr?:WritingTopic['cefr'];recentTopicIds?:string[]};
export function recommendWritingTopic(kind:WritingGenre,context:WritingTopicContext={}) {
  const terms=[...context.wordIds||[],...context.bookIds||[],...context.units||[],...context.themes||[]].join(' ').toLowerCase().match(/[a-z]+(?:[-'][a-z]+)*|[\u4e00-\u9fff]{2,}/g)||[];
  const level=context.cefr||'B1';const levels=['A2','B1','B2','C1'];
  return WRITING_TOPICS.filter(t=>t.kind===kind).map((topic,index)=>({topic,index,score:terms.reduce((n,term)=>n+[...topic.themes,...topic.skills,...topic.unitKeywords||[],...topic.prerequisites||[],topic.title].filter(Boolean).reduce((s,field)=>s+(field.toLowerCase().includes(term)?2:0),0),0)-Math.abs(levels.indexOf(topic.cefr)-levels.indexOf(level))*3-(context.recentTopicIds?.includes(topic.id)||context.recentTitles?.includes(topic.title)?20:0)})).sort((a,b)=>b.score-a.score||a.index-b.index)[0]?.topic ?? WRITING_TOPICS[0];
}
export function randomWritingTopic(kind:WritingGenre,excludeId?:string) { const choices=WRITING_TOPICS.filter(t=>t.kind===kind&&t.id!==excludeId);return choices[Math.floor(Math.random()*choices.length)]||WRITING_TOPICS.find(t=>t.kind===kind)!; }
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const strings=(v:unknown,max:number)=>Array.isArray(v)&&v.length<=max&&v.every(s=>typeof s==='string'&&s.length<=150&&s.trim().length>0);
export function validWritingTopic(v:unknown):v is WritingTopic {
  if(!obj(v)||!['free','practical','continuation'].includes(String(v.kind))||!['A2','B1','B2','C1'].includes(String(v.cefr)))return false;
  if(typeof v.id!=='string'||!v.id||v.id.length>120||typeof v.title!=='string'||!v.title.trim()||v.title.length>200||typeof v.prompt!=='string'||!v.prompt.trim()||v.prompt.length>2000)return false;
  if(!Number.isInteger(v.wordMin)||!Number.isInteger(v.wordMax)||Number(v.wordMin)<30||Number(v.wordMax)<Number(v.wordMin)||Number(v.wordMax)>500)return false;
  if(!strings(v.themes,12)||(v.themes as string[]).length===0||!strings(v.skills,12)||(v.skills as string[]).length===0||!strings(v.sourceIds,12)||!['original','adapted-pattern','ai-original'].includes(String(v.provenance)))return false;
  if(v.kind==='continuation'&&(typeof v.readingText!=='string'||v.readingText.length<400||v.readingText.length>2600||!strings(v.paragraphStarters,2)||(v.paragraphStarters as string[]).length!==2))return false;
  if(v.readingText!==undefined&&(typeof v.readingText!=='string'||v.readingText.length>2600))return false;
  return topicPrompt(v as WritingTopic).length<=4000;
}
