import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises';
import {_electron} from '@playwright/test';
import electron from 'electron';
import {developmentRuntime} from '../scripts/development-runtime.mjs';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import {portableNode} from '../src/backend/portable-node-path.ts';
import {Store} from '../src/backend/store.ts';
import {DEFAULT_SETTINGS} from '../src/shared/defaults.ts';
const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());
delete env.ELECTRON_RUN_AS_NODE;env.AIROOM_NODE_EXE=portableNode(path.resolve('.airoom'))??process.execPath;
const id='acp-catalogqodercn',home=path.join(env.AIROOM_ACP_HOME,id),auth=path.join(home,'qoder-cn','.auth','user'),command=path.join(directory,'qoder-fixture.cjs'),state=path.join(directory,'state.txt'),calls=path.join(directory,'calls.jsonl');
await mkdir(path.dirname(auth),{recursive:true});await writeFile(auth,'fixture-account');await writeFile(state,'initial');await copyFile('tests/fixtures/qoder-quota.cjs',command);
const store=new Store(env.AIROOM_DATA_DIR);
store.put('settings','main',{...DEFAULT_SETTINGS,nodeRuntime:'local'});
store.put('executors',id,{id,name:'Qoder CN CLI',catalogId:'qodercn',command,args:['--acp'],env:{TEST_QUOTA_STATE:state,TEST_QUOTA_CALLS:calls},authentication:'qodercn',permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:'2026-10-21'});
store.put('members','member-qwen',{id:'member-qwen',executor:id,name:'Qwen',templateId:'gemini',color:'#a35bdb',talkativeness:'quiet',createdAt:'2026-10-21'});store.close();
let app;
const executablePath=await developmentRuntime(electron),snapshot=page=>page.evaluate(()=>window.airoom.invoke('snapshot'));
async function launch(){
  app=await _electron.launch({executablePath,args:[process.cwd()],env,timeout:60_000});
  const page=await app.firstWindow();
  await page.waitForFunction(async id=>{try{return (await window.airoom.invoke('snapshot')).quotas?.[id]?.queryStatus==='ready';}catch{return false;}},id,{timeout:60_000});
  await page.getByRole('button',{name:'用量与额度',exact:true}).click();return page;
}
try{
  let page=await launch(),card;
  const section=()=>page.getByRole('dialog',{name:'用量与额度',exact:true}).locator('section').filter({hasText:'Qwen'});card=section();
  await card.getByText('套餐 Credits',{exact:true}).waitFor();await card.getByText('附加 Credits',{exact:true}).waitFor();await card.getByText('组织资源包',{exact:true}).waitFor();
  await card.getByText('剩 0 Credits',{exact:true}).waitFor();await card.getByText('剩 45 Credits',{exact:true}).waitFor();await card.getByText('剩 180 Credits',{exact:true}).waitFor();
  assert.equal(await card.getByText('5 小时',{exact:true}).count(),0);assert.equal(await card.getByText('每周',{exact:true}).count(),0);assert.equal(await card.getByText(/自动发言已暂停/).count(),0);
  assert.ok(await card.getByText(/套餐到期/).count());
  const initial=await snapshot(page);assert.equal(initial.quotas[id].kind,'credits');assert.ok(!JSON.stringify(initial).includes('fixture-private-user'));assert.ok(!JSON.stringify(initial).includes('private.example'));
  await mkdir('tests/results',{recursive:true});await page.screenshot({path:'tests/results/qoder-quota-desktop.png',fullPage:true});
  async function refresh(next){
    const before=(await snapshot(page)).quotas?.[id]?.checkedAt;await writeFile(state,next);
    await card.getByRole('button',{name:'刷新额度',exact:true}).click();
    await page.waitForFunction(async ({id,before})=>(await window.airoom.invoke('snapshot')).quotas?.[id]?.checkedAt!==before,{id,before},{timeout:30_000});
  }
  await refresh('updated');await card.getByText('剩 20 Credits',{exact:true}).waitFor();
  await refresh('session-only');await card.getByText(/还没有可验证的 Credits 额度/).waitFor();assert.equal((await snapshot(page)).quotas[id].credits.status,'unavailable');
  await refresh('unsupported');assert.equal((await snapshot(page)).quotas[id].credits.status,'unavailable');assert.equal((await snapshot(page)).providers.find(p=>p.id===id).available,true);
  await writeFile(auth,'fixture-new-account');assert.equal((await snapshot(page)).quotas[id],undefined);
  await refresh('narrow');await card.getByText('剩 45 Credits',{exact:true}).waitFor();assert.equal(await card.getByText('组织资源包',{exact:true}).count(),0);
  await refresh('exhausted');await card.getByText(/官方账号已报告总额度耗尽/).waitFor();
  await refresh('updated');await card.getByText('剩 20 Credits',{exact:true}).waitFor();assert.equal(await card.getByText(/官方账号已报告总额度耗尽/).count(),0);
  await app.close();app=undefined;page=await launch();card=section();await card.getByText('剩 20 Credits',{exact:true}).waitFor();
  const records=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse),inputs=records.filter(r=>r.kind==='input').map(r=>r.message);
  assert.ok(inputs.length);assert.ok(inputs.every(msg=>msg.type==='control_request'?['initialize','get_usage_info'].includes(msg.request?.type):['initialize','session/new'].includes(msg.method)));
  const report={passed:true,scope:'real Electron and backend with a simulated Qoder CN CLI and fake Credits; no real account',checks:['probe fetches account quota through native SDK controls','plan, add-on and organization pools rendered with actual count fields','one exhausted plan pool does not pause the account','expiry is separate from refill and no rolling windows are fabricated','manual refresh updates Credits','session-only/unsupported responses clear old account data without disconnecting','native auth changes invalidate cached account data','missing resource pool disappears after full refresh','native total exhaustion and recovery update UI','restart remains usable','no model prompt or agent turn sent'],profile:directory,screenshot:path.resolve('tests/results/qoder-quota-desktop.png')};
  await writeFile('tests/results/qoder-quota-desktop.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await app?.close();}
