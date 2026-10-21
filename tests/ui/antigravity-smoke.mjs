import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';

if(!process.env.AIROOM_TEST_PROFILE)throw new Error('Run with the isolated test bootstrap.');
const directory=process.env.AIROOM_TEST_PROFILE,command=path.join(directory,'mock-agy.cjs');
await writeFile(command,`const a=process.argv.slice(2);if(a.includes('--version'))console.log('Antigravity CLI 1.4.3');else if(a.includes('--help'))console.log('--print --print-timeout --input-format --output-format --conversation --sandbox --disable-slash-commands');else if(a[0]==='models')console.log('gemini-test Gemini test model');else if(a.includes('/usage')){console.error('Authentication required');process.exitCode=1;}else {console.error('Unexpected model invocation in UI smoke');process.exitCode=2;}`);
let page;
const engine=new Engine(path.join(directory,'ui-data'),event=>{if(page)void page.evaluate(e=>window.__airoomListeners?.forEach(listener=>listener(e)),event).catch(()=>{});},()=>{},undefined,{maintenanceOnly:true},async(_data,member,version)=>{assert.equal(member,'antigravity');return {version,entry:command};});
const server=await createServer({root:process.cwd(),server:{host:'127.0.0.1',port:0},logLevel:'error'});
let browser;
try{
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1365,height:900}});
  await page.exposeFunction('__airoomInvoke',(method,params)=>engine.invoke(method,params));
  await page.addInitScript(()=>{window.__airoomListeners=[];window.airoom={invoke:(method,params)=>window.__airoomInvoke(method,params),onEvent:listener=>{window.__airoomListeners.push(listener);return()=>{window.__airoomListeners=window.__airoomListeners.filter(item=>item!==listener);};}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'手动添加',exact:true}).count(),0);
  if(!await page.getByRole('group',{name:'官方执行端清单',exact:true}).isVisible())await page.getByRole('button',{name:'从清单添加',exact:true}).click();
  await page.getByRole('group',{name:'官方执行端清单',exact:true}).getByRole('button',{name:/^Antigravity CLI/}).click();
  assert.equal(await page.getByRole('button',{name:'选择本机 agy',exact:true}).count(),0);
  await page.getByRole('checkbox',{name:'我已了解并同意该厂商条款',exact:true}).check();
  await mkdir('tests/ui/results',{recursive:true});
  await page.screenshot({path:'tests/ui/results/antigravity-catalog.png',fullPage:true});
  await page.getByRole('button',{name:'下载并自动配置',exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent?.includes('程序已配置。'));
  const snapshot=engine.snapshot(),executor=snapshot.executors.find(item=>item.catalogId==='antigravity');
  assert.equal(executor?.adapter,'antigravity');assert.deepEqual(executor.args,[]);
  const catalog=await engine.invoke('catalog.list');assert.equal(catalog.items.find(item=>item.entry.id==='antigravity').configured,true);
  await page.getByRole('button',{name:'打开登录终端',exact:true}).first().waitFor();
  // Full engine factory + real mock subprocess, with no injected adapter and no model prompt.
  await engine.invoke('provider.probe',{provider:executor.id});
  const info=engine.snapshot().providers.find(item=>item.id===executor.id);
  assert.equal(info.available,false);assert.equal(info.runtimeReady,true);assert.equal(info.auth,'none');
  await page.getByText('尚未登录或登录已失效',{exact:false}).first().waitFor();
  await page.screenshot({path:'tests/ui/results/antigravity-connection.png',fullPage:true});
  console.log('Antigravity UI smoke passed: catalog card, standard download action, persisted native connection, engine factory and mock CLI probe; no manual/local selection entry. No account or model calls.');
}catch(error){await mkdir('tests/ui/results',{recursive:true});if(page){await page.screenshot({path:'tests/ui/results/antigravity-smoke-error.png',fullPage:true});console.error((await page.locator('body').innerText()).slice(-1600));}throw error;
}finally{await browser?.close();await server.close();await engine.close();}
