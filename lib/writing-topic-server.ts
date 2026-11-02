import { env } from 'cloudflare:workers';
import { authenticatedUserKey } from './server-user';
import { consumeRateLimit,privateJson } from './http';
import { assistantErrorResponse,assertSameOrigin,authenticatedRuntime,complete,readJsonRequest } from './assistant/server';
import { AssistantInputError,AssistantUpstreamError,usesOpenAIResponses } from './assistant/core';
import { resolveLearningContext,contextMetadata,learningContextData } from './learning-memory/context';
import { operationId } from './voice/dictation-planner';
import { WRITING_TOPIC_RULES } from './writing-topic-rules';
import { WRITING_TOPICS,validWritingTopic,type WritingTopic } from './writing-topics';
export async function generateWritingTopic(request:Request) {
 try {
  assertSameOrigin(request);const user=await authenticatedUserKey();if(!user)throw new AssistantInputError('authentication_required','请先登录。',401);
  const body=await readJsonRequest(request) as Record<string,unknown>,id=operationId(body.operationId);
  if(!['free','practical','continuation'].includes(String(body.kind))||(body.theme!==undefined&&(typeof body.theme!=='string'||body.theme.length>500)))throw new AssistantInputError('invalid_request','写作题型或主题无效。');
  const config=await authenticatedRuntime(request),context=await resolveLearningContext(user,body);
  if(!usesOpenAIResponses(config.baseUrl))throw new AssistantInputError('unsupported_provider','AI出题需要官方 OpenAI 配置。',400);
  if(!env.DB)throw new AssistantInputError('unavailable','用量服务暂不可用。',503);
  const now=Date.now(),minute=Math.floor(now/60000);
  if(await consumeRateLimit(env.DB,`writing-topic:${user}:${minute}`,(minute+1)*60000,4)!==null)throw new AssistantInputError('rate_limited','请稍后再试。',429);
  const claimed=await env.DB.prepare('INSERT INTO ai_rate_limits (bucket_key, request_count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket_key) DO NOTHING RETURNING request_count').bind(`writing-topic-operation:${user}:${id}`,now+86400000).first();
  if(!claimed)throw new AssistantInputError('operation_already_started','这次出题已提交，请勿重复请求。',409);
  const examples=WRITING_TOPICS.filter(t=>t.kind===body.kind).filter((_,i)=>i%5===0).slice(0,3).map(({readingText,...t})=>({...t,readingText:readingText?.slice(0,300)}));
  const {completion}=await complete({...config,model:'gpt-6.1-terra'},request,{model:'gpt-6.1-terra',stream:false,max_tokens:3000,response_format:{type:'json_object'},messages:[{role:'system',content:WRITING_TOPIC_RULES},{role:'user',content:JSON.stringify({kind:body.kind,theme:body.theme||'',context:learningContextData(context.memory),examples})}]});
  if(completion.finishReason==='length') throw new AssistantUpstreamError('invalid_writing_topic','题目生成不完整，请重新出题。',502,true);
  let topic:WritingTopic;try { const raw=JSON.parse(completion.content);if(raw.kind!==body.kind)throw new Error();topic={id:`ai-${id}`,kind:raw.kind,title:raw.title,prompt:raw.prompt,readingText:raw.readingText,paragraphStarters:raw.paragraphStarters,cefr:raw.cefr,wordMin:raw.wordMin,wordMax:raw.wordMax,themes:raw.themes,skills:raw.skills,sourceIds:[],provenance:'ai-original'};if(!validWritingTopic(topic))throw new Error(); }catch {throw new AssistantUpstreamError('invalid_writing_topic','AI未返回完整有效的题目，请重新出题。',502,true);}
  await resolveLearningContext(user,body);if(request.signal.aborted)throw new AssistantInputError('request_aborted','已取消出题。',499);
  return privateJson({operationId:id,topic,...contextMetadata(context)});
 }catch(error){return assistantErrorResponse(error);}
}
