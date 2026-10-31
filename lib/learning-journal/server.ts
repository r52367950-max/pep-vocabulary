import { authenticatedUserKey } from "@/lib/server-user";
import { consumeRateLimit, privateJson } from "@/lib/http";
import { AssistantInputError } from "@/lib/assistant/core";
import { assistantErrorResponse, assertSameOrigin, readJsonRequest } from "@/lib/assistant/server";
import { memoryDatabase } from "@/lib/learning-memory/store";
import { accountScope } from "@/lib/learning-memory/context";
import { appendJournalEvent, journalDays, journalMetadata, mutateJournal } from "./store";
import { dateInZone, object, timezone } from "./input";
async function identity(request:Request) { assertSameOrigin(request); const key=await authenticatedUserKey(); if(!key) throw new AssistantInputError("authentication_required","请先登录站点。",401); return key; }
async function view(key:string,zone:string,metadataOnly=false,temporary=false) { const meta=await journalMetadata(key); return {accountScope:await accountScope(key),...meta,...(temporary?{enabled:false}:{}),timezone:zone,today:dateInZone(new Date().toISOString(),zone),days:metadataOnly||temporary?[]:await journalDays(key)}; }
export async function getJournal(request:Request) {
  try { const key=await identity(request),params=new URL(request.url).searchParams,zone=timezone(params.get("timezone")??"UTC"); return privateJson(await view(key,zone,params.get("metadata")==="1",params.get("temporary")==="1")); }
  catch(error){return assistantErrorResponse(error);}
}
export async function writeJournal(request:Request,method:"POST"|"PUT"|"DELETE") {
  try {
    const key=await identity(request),body=object(await readJsonRequest(request));
    if(body.accountScope!==await accountScope(key)) throw new AssistantInputError("learning_account_changed","登录账号已变化，请重新读取学习记录。",409);
    if(body.temporary!==undefined&&typeof body.temporary!=="boolean") throw new AssistantInputError("invalid_request","临时会话参数无效。");
    if(body.temporary===true) throw new AssistantInputError("temporary_memory_write","临时会话不保存学习记录。",409);
    const start=Math.floor(Date.now()/60000)*60000;
    if(await consumeRateLimit(memoryDatabase(),`learning-journal:${key}:${start}`,start+60000,120)!==null) throw new AssistantInputError("journal_rate_limited","学习记录更新较频繁，请稍后重试。",429);
    const zone=timezone(body.timezone??"UTC");
    const result=method==="POST"?await appendJournalEvent(key,body):(await mutateJournal(key,body,method),{});
    return privateJson({...await view(key,zone),...result});
  }catch(error){return assistantErrorResponse(error);}
}
