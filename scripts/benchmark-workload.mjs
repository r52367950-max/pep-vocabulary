import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cpus, totalmem } from 'node:os';
import { localWorker } from './local-worker.mjs';

const { values } = parseArgs({ options: { build: { type: 'string', default: 'dist' }, output: { type: 'string', default: '/tmp/pep-workload.json' }, 'soak-seconds': { type: 'string', default: '0' } } });
const soakSeconds = Number(values['soak-seconds']);
assert.ok(Number.isInteger(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 300);
const worker = await localWorker(values.build);
const scenarios = [], samples = [];
const percentile = (a, p) => a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)];
const summary = a => { const sorted = [...a].sort((a,b) => a-b); return { n: a.length, p50: percentile(sorted,.5), p95: percentile(sorted,.95), p99: percentile(sorted,.99) }; };
try {
  const accounts = [];
  for (let owner = 0; owner < 8; owner++) {
    const email = `load-${owner}@example.test`;
    const key = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))).toString('hex');
    const eventsPerDay = owner === 7 ? 1000 : 80;
    const statements = [];
    for (let day = 0; day < 30; day++) {
      const date = new Date(Date.now() - (day + 1) * 86400000).toISOString().slice(0, 10);
      statements.push(worker.db.prepare('INSERT INTO learning_journal_days (user_key,date,facts_summary,updated_at) VALUES (?,?,?,?)').bind(key, date, `owner-${owner}: vocabulary, reading and writing`, `${date}T22:00:00.000Z`));
      // Recursive SQL seeds synthetic historical facts efficiently, with the real quota triggers enabled.
      statements.push(worker.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i+1<?)
        INSERT INTO learning_journal_events(user_key,event_id,date,timezone,occurred_at,kind,title,summary,ref_ids,counts,content_hash)
        SELECT ?,?||i,?,'UTC',?||printf('%02d:%02d:00.000Z',i/60,i%60),'vocabulary',?, ?, '["word-one","reading-one"]','{"reviewed":20,"correct":16}','fixture' FROM n`)
        .bind(eventsPerDay,key,`load-${day}-`,date,`${date}T`, `owner-${owner}: complete review`, 'Practised vocabulary, reviewed mistakes, then read an article. '.repeat(5)));
    }
    await worker.db.batch(statements);
    const state = await worker.request('/api/learning-journal?metadata=1', { email });
    assert.equal(state.status, 200);
    accounts.push({ email, key, eventsPerDay, scope: state.json().accountScope });
  }
  // Five warm-up journeys; exclude these from measurements.
  for (let i=0;i<5;i++) await worker.request('/api/learning-journal', { email: accounts[0].email });
  let sequence = 0;
  for (let round=1;round<=3;round++) {
    for (const concurrency of [1,4,12]) {
      const latencies = [], byRoute = {}, errors = [];
      let bytes = 0;
      const started = performance.now();
      // Each user traverses 20 requests; no synthetic delay is included in service latency.
      await Promise.all(Array.from({length:concurrency},async(_, client) => {
        const account = accounts[client % accounts.length];
        for(let i=0;i<20;i++) {
          const slot = i % 10;
          const path = slot < 5 ? '/api/learning-journal' : slot < 7 ? '/api/learning-memory' : slot === 7 ? '/data/v1/index.json' : slot === 8 ? '/' : '/api/learning-journal';
          const init = { email: account.email };
          if (slot === 9) Object.assign(init, { method: 'POST', body: { accountScope: account.scope, privacyRevision: 0, eventId: `benchmark-${sequence++}`, kind:'vocabulary', title:'Complete 20-word review', summary:'16 correct, 4 to review.', refIds:['word-one'], counts:{reviewed:20,correct:16}, occurredAt:new Date().toISOString(),timezone:'UTC' } });
          const label = `${init.method || 'GET'} ${path}`, before = performance.now();
          const response = await worker.request(path,init);
          const ms = performance.now()-before;
          latencies.push(ms); (byRoute[label]??=[]).push(ms); bytes += response.bytes;
          if(response.status!==200) errors.push({label,status:response.status,body:response.text.slice(0,200)});
          if(path==='/api/learning-journal'&&response.status===200) {
            const data = response.json();
            assert.equal(data.accountScope, account.scope);
            assert.ok(data.days.length<=30);
            for (const day of data.days) {
              assert.ok(day.events.length<=20);
              assert.ok(!day.summary.includes('owner-') || day.summary.includes(`owner-${client % accounts.length}:`));
            }
          }
        }
      }));
      const elapsedMs=performance.now()-started;
      const result = {round,concurrency,...summary(latencies),elapsedMs,requestsPerSecond:latencies.length*1000/elapsedMs,bytes,errors,routes:Object.fromEntries(Object.entries(byRoute).map(([k,a])=>[k,summary(a)]))};
      scenarios.push(result); samples.push({round,concurrency,latencies,byRoute});
      console.log(JSON.stringify(result));
    }
  }
  const soak = [];
  if(soakSeconds){
    const started=performance.now();
    await Promise.all(Array.from({length:12},async(_,client)=>{
      let i=0;
      while(performance.now()-started<soakSeconds*1000){
        const path=['/api/learning-journal','/api/learning-journal','/api/learning-journal','/api/learning-memory','/data/v1/index.json','/'][i++%6];
        const at=performance.now()-started,before=performance.now();
        const response=await worker.request(path,{email:accounts[client%8].email});
        soak.push({at,ms:performance.now()-before,status:response.status,path});
      }
    }));
    console.log(JSON.stringify({soakSeconds,requests:soak.length,...summary(soak.map(x=>x.ms)),errors:soak.filter(x=>x.status!==200).length}));
  }
  const result={timestamp:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),build:values.build,seed:{accounts:8,days:30,regularEventsPerDay:80,denseEventsPerDay:1000,totalEvents:46800},method:'Local production HTTP/workerd/D1; closed-loop concurrency; synthetic learning histories; no paid provider; full body consumed; warm-up excluded; 3 rounds. Optional soak: 12 concurrent readers, full journal/memory/index/shell requests.',scenarios,samples,soakSeconds,soak};
  writeFileSync(values.output,JSON.stringify(result,null,2)+'\n');
  assert.equal(scenarios.reduce((sum,s)=>sum+s.errors.length,0),0);
  assert.ok(soak.every(x=>x.status===200));
} finally { await worker.close(); }
