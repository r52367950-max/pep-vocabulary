import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const runs=[];
try{
 for(const device of [{name:'desktop',width:1440,height:900,cpu:1},{name:'phone-cpu4',width:390,height:844,cpu:4}])for(let round=1;round<=3;round++){
  const context=await browser.newContext({viewport:{width:device.width,height:device.height},reducedMotion:'reduce',locale:'zh-CN'});
  await context.route('**/api/learning-memory**',route=>route.fulfill({json:{accountScope:'perf-owner',revision:0,enabled:true,notes:[],recentTopics:[],contextVersion:'qa',journalRevision:0}}));
  await context.addInitScript(()=>{
   const now=Date.now();
   localStorage.setItem('vocab-companion-history-v1:perf-owner',JSON.stringify({version:1,conversations:Array.from({length:50},(_,i)=>({id:`perf-${i}`,title:`学习会话 ${String(i).padStart(2,'0')}`,createdAt:now-i*3600000,updatedAt:now-i*3600000,temporary:false,messages:Array.from({length:40},(_,j)=>({id:`m-${i}-${j}`,role:'user',at:now-j*1000,text:'Practice vocabulary and explain this sentence. '.repeat(3),quotes:[],attachments:[],via:'text'}))}))}));
   window.qa={longTasks:[],lcp:0};
   new PerformanceObserver(list=>{for(const item of list.getEntries())window.qa.longTasks.push(item.duration);}).observe({type:'longtask',buffered:true});
   new PerformanceObserver(list=>{for(const item of list.getEntries())window.qa.lcp=item.startTime;}).observe({type:'largest-contentful-paint',buffered:true});
  });
  const page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:device.cpu});await cdp.send('Performance.enable');
  const started=performance.now();await page.goto(process.env.CIJI_QA_URL,{waitUntil:'domcontentloaded'});await page.locator('.daily-feature').waitFor();
  const startupMs=performance.now()-started;
  const chatStarted=performance.now();
  const nav=page.getByRole('navigation').getByRole('button',{name:'AI 对话',exact:true});
  if(await nav.count())await nav.click();else await page.getByRole('navigation').getByRole('button',{name:'AI',exact:true}).click();
  await page.locator('.ciji-companion .greeting').waitFor();
  const chatMs=performance.now()-chatStarted;
  const listStart=performance.now();await page.getByRole('button',{name:'展开对话列表',exact:true}).click();
  await page.getByRole('searchbox',{name:'搜索对话'}).waitFor();
  assert.equal(await page.locator('.conv-row[data-conv]').count(),50);
  const listMs=performance.now()-listStart,searchStart=performance.now();
  await page.getByRole('searchbox',{name:'搜索对话'}).fill('学习会话 49');
  await page.waitForFunction(()=>document.querySelectorAll('.conv-row[data-conv]').length===1);
  const searchMs=performance.now()-searchStart;
  await page.locator('.conv-panel').getByRole('button',{name:'收起对话列表',exact:true}).click();
  const input=page.locator('.ciji-companion .composer textarea');
  const typeStart=performance.now();await input.pressSequentially('Please help me practise the vocabulary from this week.');
  assert.match(await input.inputValue(),/this week/);
  const typingMs=performance.now()-typeStart;
  const measured=await page.evaluate(()=>({...window.qa,historyChars:localStorage.getItem('vocab-companion-history-v1:perf-owner').length,overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth)}));
  const metrics=await cdp.send('Performance.getMetrics');
  assert.equal(measured.overflow,0);assert.deepEqual(errors,[]);
  runs.push({device:device.name,round,startupMs,chatMs,listMs,searchMs,typingMs,...measured,heapBytes:metrics.metrics.find(m=>m.name==='JSHeapUsedSize')?.value,pageErrors:errors});
  if(round===3)await page.screenshot({path:new URL(`./browser-load-${device.name}.png`,import.meta.url).pathname});
  console.log(JSON.stringify(runs.at(-1)));await context.close();
 }
}finally{await browser.close();writeFileSync(new URL('./browser-performance.json',import.meta.url),JSON.stringify({method:'Fresh browser context each round, actual production UI and lexicon, 50 conversations / 2000 messages, synthetic metadata only; automation wall timings are not INP. CPU throttling is emulation, no mobile hardware or WAN claim.',runs},null,2));}
