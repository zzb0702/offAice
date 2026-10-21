import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
import {createServer} from '../../scripts/ui-test-server.mjs';
import {Engine} from '../../src/backend/engine.ts';
import {nativeTokenUsage} from '../../src/shared/token-usage.ts';

if(!process.env.AIROOM_TEST_PROFILE)throw Error('Use the isolated test bootstrap.');
const root=process.env.AIROOM_TEST_PROFILE;
let page,browser;
const engine=new Engine(path.join(root,'token-ui'),event=>{if(page)void page.evaluate(e=>window.__listeners?.forEach(fn=>fn(e)),event).catch(()=>{});},()=>{},undefined,{maintenanceOnly:true});
const store=engine.store,at=new Date().toISOString(),thread=store.currentRoomThread(),project={id:'token-lounge',name:'测试茶歇室',kind:'lounge',directory:root,createdAt:at,updatedAt:at};
store.put('projects',project.id,project);
const samples=[
  {id:'codex-test',name:'codex',provider:'codex',source:'codex',templateId:'codex',nativeId:'codex-thread',data:{tokenUsage:{total:{inputTokens:12500,cachedInputTokens:10000,outputTokens:800}}}},
  {id:'ds-test',name:'DS',provider:'dsh',source:'dsh',templateId:'dsh',data:{inputTokens:5000,cacheReadTokens:15000,outputTokens:1000,totalTokens:21000}},
  {id:'glm-test',name:'GLM',provider:'acp-token-glm',source:'zcode',templateId:'claude',data:{inputTokens:1200000,cacheReadTokens:900000,outputTokens:32000}},
  {id:'qwen-test',name:'Qwen',provider:'acp-token-qwen',templateId:'gemini'},
  {id:'gemini-test',name:'哈基米',provider:'acp-token-gemini',source:'antigravity',templateId:'gemini',nativeId:'old-conversation',legacy:true,data:{input_tokens:30000,cache_read_tokens:20000,output_tokens:350}},
];
const contexts=[];
store.put('room_messages','user',{id:'user',threadId:thread.id,author:'user',text:'请大家汇报一下进展。',at,status:'done'});
for(const [index,sample] of samples.entries()){
  store.put('members',sample.id,{id:sample.id,name:sample.name,executor:sample.provider,templateId:sample.templateId,talkativeness:'quiet',createdAt:at});
  if(sample.provider.startsWith('acp-'))store.put('executors',sample.provider,{id:sample.provider,name:sample.name,command:process.execPath,args:[],env:{},createdAt:at});
  const session={id:'session-'+sample.id,projectId:project.id,provider:sample.provider,memberId:sample.id,title:sample.name,roomId:'global',roomThreadId:thread.id,createdAt:at,updatedAt:at,revision:0,writeMode:false,...(sample.legacy?{nativeId:sample.nativeId}:{})};
  const run={id:'run-'+sample.id,sessionId:session.id,projectId:project.id,provider:sample.provider,revision:0,status:'running',input:'A test prompt',createdAt:at,updatedAt:at,bootId:'test',delivery:'confirmed'};
  store.put('sessions',session.id,session);store.put('runs',run.id,run);
  store.put('room_messages',sample.id,{id:sample.id,threadId:thread.id,runId:run.id,author:sample.id,text:`${sample.name} 的测试回复。这里只展示模拟用量，不会调用真实模型。`,at:new Date(Date.parse(at)+index*1000+1).toISOString(),status:'done'});
  const ctx=engine.context(run,session);engine.active.set(run.id,{ctx,children:[]});contexts.push({ctx,run,sample});
  if(sample.nativeId)ctx.persistNativeSession(sample.nativeId);
  if(sample.source)ctx.recordTokenUsage(nativeTokenUsage(sample.source,sample.data),sample.nativeId);
  store.put('runs',run.id,{...store.get('runs',run.id),status:'ended',completedAt:at});
}
const server=await createServer({root:process.cwd(),server:{host:'127.0.0.1',port:0},logLevel:'error'});
try{
  await server.listen();browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1365,height:1000}});
  await page.exposeFunction('__invoke',(method,params)=>engine.invoke(method,params));
  await page.addInitScript(()=>{localStorage.setItem('airoom.theme','dark');window.__listeners=[];window.airoom={invoke:(method,params)=>window.__invoke(method,params),onEvent:fn=>{window.__listeners.push(fn);return()=>window.__listeners=window.__listeners.filter(item=>item!==fn);}};});
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole('button',{name:/^茶歇室/}).click();
  const room=page.getByRole('log',{name:'茶歇室消息',exact:true});await room.waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.room-token-usage').length===5);
  const footer=id=>page.locator(`[data-message-id="${id}"] .room-token-usage`);
  assert.match(await footer('codex-test').innerText(),/输入：12.5K.*输出：0.8K.*缓存率：80.0%/s);
  assert.match(await footer('glm-test').innerText(),/输入：1.2M.*输出：32.0K/s);
  assert.match(await footer('qwen-test').innerText(),/缓存率：未提供/);
  assert.match(await footer('gemini-test').innerText(),/会话累计/);
  assert.equal(await page.locator('[data-message-id="user"] .room-token-usage').count(),0);
  const current=contexts[0];current.ctx.recordTokenUsage(nativeTokenUsage('codex',{tokenUsage:{total:{inputTokens:20000,cachedInputTokens:15000,outputTokens:1000}}}),current.sample.nativeId);
  await page.waitForFunction(()=>document.querySelector('[data-message-id="codex-test"] .room-token-usage')?.textContent.includes('75.0%'));
  // History must retain the receipt even when its run is outside the snapshot window.
  store.delete('runs','run-glm-test');engine.broadcast();
  await page.reload();await page.getByRole('button',{name:/^茶歇室/}).click();await page.waitForFunction(()=>document.querySelector('[data-message-id="glm-test"] .room-token-usage')?.textContent.includes('1.2M'));
  await mkdir('tests/ui/results',{recursive:true});await page.screenshot({path:'tests/ui/results/token-usage-desktop.png',fullPage:true,animations:'disabled'});
  await room.screenshot({path:'tests/ui/results/token-usage-chat.png',animations:'disabled'});
  await page.setViewportSize({width:700,height:900});
  for(const id of samples.map(item=>item.id)){
    const result=await footer(id).evaluate(node=>{const box=node.getBoundingClientRect();return {right:box.right,width:window.innerWidth};});
    assert.ok(result.right<=result.width+1,'usage footer stays within narrow window');
  }
  await page.screenshot({path:'tests/ui/results/token-usage-narrow.png',fullPage:true,animations:'disabled'});
  await writeFile('tests/ui/results/token-usage-verification.json',JSON.stringify({passed:true,scope:'real Engine and React UI; synthetic native usage, no account or model requests',checks:['footer under each agent reply, absent under user message','K/M formatting','missing Qoder fields do not become zero','cumulative label when no baseline','live native usage update','history survives missing run snapshot and reload','narrow window wrapping'],screenshots:['token-usage-desktop.png','token-usage-narrow.png']},null,2)+'\n');
  console.log('Token usage UI smoke passed: five reply footers, K/M, cache rates, missing fields, session scope, live updates, history and narrow layout; no real account/model calls.');
}catch(error){await mkdir('tests/ui/results',{recursive:true});if(page){await page.screenshot({path:'tests/ui/results/token-usage-error.png',fullPage:true});console.error((await page.locator('body').innerText()).slice(-1800));}throw error;
}finally{engine.active.clear();await browser?.close();await server.close();await engine.close();}
