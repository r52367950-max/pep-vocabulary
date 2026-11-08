import pkg from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';
const {chromium}=pkg;const b=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
for(const width of [320,375,768,1024]){
 const p=await b.newPage({viewport:{width,height:768},hasTouch:true}); p.on('pageerror',e=>console.log('PAGEERROR',width,e.message));
 await p.goto('http://127.0.0.1:4173/');await p.getByRole('button',{name:'开始学习',exact:true}).waitFor();
 const state=async tag=>{await p.waitForTimeout(150); console.log(width,tag,await p.evaluate(()=>({doc:document.documentElement.scrollWidth,view:innerWidth,heading:document.querySelector('h1')?.textContent})));await p.screenshot({path:`/tmp/pep-qa-vp-${width}-${tag}.png`})};
 await state('today');
 for(const name of ['词库','阅读']){const nav=p.getByRole('button',{name,exact:true}).filter({visible:true}); await nav.first().click();await p.getByRole('heading',{name,exact:true}).waitFor();await state(name==='词库'?'lexicon':'reading')}
 await p.close();
}
await b.close();
