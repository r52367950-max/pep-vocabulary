import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { localWorker } from './local-worker.mjs';
import { PRIVATE_API_ROUTES } from '../worker/security.ts';
import { validBodies, actions, sameOriginGetPaths } from '../tests/private-api-fixtures.mjs';

const worker=await localWorker(), checks=[], failures=[];
try {
  for(const [path,methods] of Object.entries(PRIVATE_API_ROUTES)) for(const method of methods){
    for(const [label,headers,expected] of [
      ['missing identity',{},401],
      ['foreign origin',{origin:'https://evil.test','oai-authenticated-user-email':'runtime-origin@example.test'},403],
      ['opaque origin',{origin:'null','oai-authenticated-user-email':'runtime-origin@example.test'},403],
      ['cross-site fetch',{'sec-fetch-site':'cross-site','oai-authenticated-user-email':'runtime-origin@example.test'},403],
      ['untrusted ingress',{host:'untrusted.test','oai-authenticated-user-email':'forged@example.test'},401],
    ]) {
      if(method==='GET' && expected===403 && !sameOriginGetPaths.has(path)) continue;
      if(method!=='GET') assert.ok(Object.hasOwn(validBodies,path),`${path} needs an admission fixture`);
      const response=await worker.request(path,{method,headers:{...(actions[path]?{'x-vocab-action':actions[path]}:{}),...headers},isolated:true,...(method==='GET'?{}:{body:validBodies[path]})});
      assert.equal(response.status,expected,`${label} ${method} ${path}: ${response.status} ${response.text}`);
      assert.match(response.headers['cache-control'],/no-store/);
      assert.match(response.headers['content-type'],/application\/json/);
      assert.equal(response.headers['x-content-type-options'],'nosniff');
      assert.doesNotMatch(response.text,/\bat .*\.(?:ts|js):\d+|SQLITE|D1_ERROR|encrypted_api_key|key_iv/);
      checks.push({path,method,label,status:response.status});
    }
  }
  const email='runtime-control@example.test';
  for(const path of ['/api/learning-journal','/api/learning-memory','/api/voice/memory','/api/sync','/api/ai/config']){
    const response=await worker.request(path,{email});assert.equal(response.status,200,response.text);
    checks.push({path,method:'GET',label:'authenticated normal control',status:response.status});
  }
  for(const suffix of ['/','?test=1']) {
    const response=await worker.request(`/api/learning-journal${suffix}`,{email});
    assert.equal(response.status,200,response.text);assert.match(response.headers['cache-control'],/no-store/);
    checks.push({path:`/api/learning-journal${suffix}`,label:'private path variant',status:response.status});
  }
  const metadata=(await worker.request('/api/learning-journal',{email})).json();
  const mutation=await worker.request('/api/learning-journal',{email,method:'POST',body:{...validBodies['/api/learning-journal'],accountScope:metadata.accountScope,privacyRevision:metadata.privacyRevision}});
  assert.equal(mutation.status,200,mutation.text);
  assert.match(mutation.headers['cache-control'],/no-store/);
  checks.push({path:'/api/learning-journal',method:'POST',label:'normal JSON mutation control',status:mutation.status});
  const boundary='vocab-runtime-form';
  const form=field=>`--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\nruntime-only\r\n--${boundary}--\r\n`;
  const formHeaders={'content-type':`multipart/form-data; boundary=${boundary}`,origin:'http://localhost'};
  const transports=[
    ['unsupported ordinary form',{method:'POST',headers:formHeaders,rawBody:form('note')},415],
    ['unsupported malformed action form',{method:'POST',headers:formHeaders,rawBody:form('$ACTION_ID_runtime_unknown_action')},415],
    ['unsupported unknown action form',{method:'POST',headers:formHeaders,rawBody:form('$ACTION_ID_runtime_unknown_module#missing')},415],
    ['unsupported cross-site form',{method:'POST',headers:{...formHeaders,origin:'https://evil.test','sec-fetch-site':'cross-site'},rawBody:form('note')},415],
    ...['x-rsc-action','next-action'].map(header=>[`unsupported ${header}`,{method:'POST',headers:{[header]:'runtime_unknown_module#missing','content-type':'application/json'},rawBody:'{}'},404]),
  ];
  const controls=[
    ['normal HTML control','/',{},200,/^text\/html/],
    ['normal RSC control','/.rsc',{headers:{RSC:'1'}},200,/^text\/x-component/],
    ...['/','/.rsc','/api/sync'].flatMap(path=>transports.map(([label,init,expected])=>[label,path,init,expected,path.startsWith('/api')?/^application\/json/:/^text\/plain/])),
  ];
  for(const [label,path,init,expected,contentType] of controls) {
    const response=await worker.request(path,{email,isolated:true,...init});
    checks.push({path,method:init.method||'GET',label,status:response.status,expected});
    try {
      assert.equal(response.status,expected,`${label}: ${response.status} ${response.text.slice(0,300)}`);
      assert.match(response.headers['content-type'],contentType,label);
      assert.equal(response.headers['x-content-type-options'],'nosniff',label);
      if(expected>=400) {
        assert.match(response.headers['cache-control'],/no-store/);
        assert.doesNotMatch(response.text,/\bat .*\.(?:ts|js):\d+|SQLITE|D1_ERROR|encrypted_api_key|key_iv/);
        if(path.startsWith('/api')) assert.equal(response.json().code,expected===404?'not_found':'unsupported_media_type');
      }
    } catch(error) { failures.push(error); }
  }
  writeFileSync(process.argv[2]||'/tmp/pep-runtime-security.json',JSON.stringify({timestamp:new Date().toISOString(),routes:Object.keys(PRIVATE_API_ROUTES).length,checks,failures:failures.map(error=>error.message)},null,2)+'\n');
  if(failures.length) throw new AggregateError(failures,`${failures.length} runtime security checks failed`);
  console.log(`${checks.length} runtime checks passed across ${Object.keys(PRIVATE_API_ROUTES).length} private API routes`);
}finally{await worker.close();}
