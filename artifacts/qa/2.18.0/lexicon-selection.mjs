import pkg from '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.js';
const {chromium}=pkg;
const b=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const p=await b.newPage({viewport:{width:1280,height:800}});
p.on('pageerror',e=>console.log('PAGEERROR',e.message));
await p.goto('http://127.0.0.1:4173/');
await p.getByRole('button',{name:'词库',exact:true}).first().click();
await p.getByRole('heading',{name:'词库'}).waitFor();
console.log('menu buttons',await p.locator('button').allTextContents().then(x=>x.slice(0,22)));
await p.getByRole('button',{name:'词库选项'}).click();
console.log('menu text', (await p.locator('body').innerText()).slice(0,350));
await p.getByRole('menuitem',{name:'选择词语'}).click();
for(let i=0;i<2;i++){
 const checks=p.locator('.word-list input[type="checkbox"]');
 await checks.first().waitFor();
 console.log('page',i+1,'count',await checks.count());
 for(let j=0;j<40;j++) await checks.nth(j).check();
 if(i===0) await p.getByRole('button',{name:'下一页'}).click();
}
console.log('after 80', (await p.locator('body').innerText()).slice(0,450));
await p.getByRole('searchbox',{name:'搜索单词或中文释义'}).fill('exchange');
await p.waitForTimeout(300);
console.log('after search', (await p.locator('body').innerText()).slice(0,650));
console.log('visible check',await p.locator('.word-list input[type="checkbox"]').count());
if(await p.locator('.word-list input[type="checkbox"]').count()){
 await p.locator('.word-list input[type="checkbox"]').first().click();
 console.log('after attempted 81', (await p.locator('body').innerText()).slice(0,650));
 await p.screenshot({path:'/tmp/pep-qa-hidden-selection-80.png'});
 await p.getByRole('searchbox',{name:'搜索单词或中文释义'}).fill('zzzzzz-nonexistent'); await p.waitForTimeout(200); console.log('after zero', (await p.locator('body').innerText()).slice(0,550)); await p.screenshot({path:'/tmp/pep-qa-hidden-selection-zero.png'}); await p.getByRole('button',{name:'取消选择'}).click(); console.log('after clear', (await p.locator('body').innerText()).slice(0,430));
}
await b.close();
