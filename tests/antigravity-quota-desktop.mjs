import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {_electron} from '@playwright/test';
import electron from 'electron';
import {developmentRuntime} from '../scripts/development-runtime.mjs';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import {portableNode} from '../src/backend/portable-node-path.ts';
import {Store} from '../src/backend/store.ts';
import {DEFAULT_SETTINGS} from '../src/shared/defaults.ts';

const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());
delete env.ELECTRON_RUN_AS_NODE;env.AIROOM_NODE_EXE=portableNode(path.resolve('.airoom'))??process.execPath;
const id='acp-catalogantigravity',command=path.join(directory,'mock-agy.cjs'),state=path.join(directory,'quota-state.txt'),calls=path.join(directory,'usage-calls.jsonl');
await writeFile(state,'initial');
await writeFile(command,String.raw`
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('1.4.4');process.exit(0);}
if(args.includes('--help')){console.log('--input-format --output-format --conversation --sandbox --disable-slash-commands --print --print-timeout');process.exit(0);}
if(args[0]==='models'){console.log('gemini-test Gemini test');process.exit(0);}
if(!args.includes('/usage'))throw Error('Quota check must not start inference');
const state=fs.readFileSync(process.env.TEST_QUOTA_STATE,'utf8');
fs.appendFileSync(process.env.TEST_QUOTA_CALLS,JSON.stringify({args,state})+'\n');
if(state==='none'){console.error('authentication required');process.exit(1);}
const reset=new Date(Date.now()+7*24*60*60_000).toISOString();
console.log('Gemini Models\tWeekly Limit Remaining\t'+(state==='initial'?'92.5':'64')+'%\t'+reset);
if(state!=='recovered')console.log('Claude and GPT models\tFive Hour Limit Remaining\t0%\t'+reset);
if(state==='network')console.error('Failed to refresh quotas: network error');
`);
const store=new Store(env.AIROOM_DATA_DIR);
store.put('settings','main',{...DEFAULT_SETTINGS,nodeRuntime:'local'});
store.put('executors',id,{id,name:'Antigravity CLI',catalogId:'antigravity',adapter:'antigravity',command,args:[],env:{TEST_QUOTA_STATE:state,TEST_QUOTA_CALLS:calls},authentication:'google',permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:'2026-10-21'});
store.put('members','member-gemini',{id:'member-gemini',executor:id,name:'哈基米',templateId:'gemini',color:'#a35bdb',talkativeness:'quiet',createdAt:'2026-10-21'});
store.close();
let app;
const executablePath=await developmentRuntime(electron);
async function launch(){
  app=await _electron.launch({executablePath,args:[process.cwd()],env,timeout:60_000});
  const page=await app.firstWindow();
  await page.waitForFunction(async id=>{try{return (await window.airoom.invoke('snapshot')).quotas?.[id]?.queryStatus==='ready';}catch{return false;}},id,{timeout:60_000});
  await page.getByRole('button',{name:'用量与额度',exact:true}).click();
  return page;
}
const snapshot=page=>page.evaluate(()=>window.airoom.invoke('snapshot'));
try{
  let page=await launch(),card;
  const section=()=>page.getByRole('dialog',{name:'用量与额度',exact:true}).locator('section').filter({hasText:'哈基米'});
  card=section();
  async function refresh(next){
    const before=(await snapshot(page)).quotas[id].checkedAt;
    await writeFile(state,next);await card.getByRole('button',{name:'刷新额度',exact:true}).click();
    await page.waitForFunction(async ({id,before})=>(await window.airoom.invoke('snapshot')).quotas?.[id]?.checkedAt!==before,{id,before},{timeout:30_000});
    await card.getByRole('button',{name:'刷新额度',exact:true}).waitFor({state:'visible'});
  }
  await card.getByText('Gemini Models · 每周',{exact:true}).waitFor();
  await card.getByText('Claude and GPT models · 5 小时',{exact:true}).waitFor();
  await card.getByText('剩 92.5%',{exact:true}).waitFor();await card.getByText('剩 0%',{exact:true}).waitFor();
  assert.equal(await card.getByText('5 小时',{exact:true}).count(),0);assert.equal(await card.getByText('每周',{exact:true}).count(),0);
  assert.ok(await card.getByText(/恢复/).count());assert.equal(await card.getByText(/自动发言已暂停/).count(),0);
  await mkdir('tests/results',{recursive:true});await page.screenshot({path:'tests/results/antigravity-quota-desktop.png',fullPage:true});
  await refresh('updated');
  await card.getByText('剩 64%',{exact:true}).waitFor();
  await refresh('network');
  await card.getByText(/暂未提供可验证的额度数据/).waitFor();
  assert.equal((await snapshot(page)).quotas[id].windows.length,0);assert.equal(await card.getByText('剩 64%',{exact:true}).count(),0);
  await refresh('none');
  await page.waitForFunction(async id=>(await window.airoom.invoke('snapshot')).providers.find(x=>x.id===id)?.auth==='none',id);
  assert.equal((await snapshot(page)).quotas[id].queryStatus,'unavailable');
  await refresh('recovered');
  await card.getByText('剩 64%',{exact:true}).waitFor();assert.equal((await snapshot(page)).quotas[id].windows.length,1);
  // An old exhausted group cannot linger after a successful full-account refresh.
  assert.equal(await card.getByText('Claude and GPT models · 5 小时',{exact:true}).count(),0);
  await app.close();app=undefined;page=await launch();card=section();
  await card.getByText('剩 64%',{exact:true}).waitFor();
  const invocations=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(['initial','updated','network','none','recovered'].every(state=>invocations.some(call=>call.state===state)),JSON.stringify(invocations));
  assert.ok(invocations.every(({args})=>JSON.stringify(args)===JSON.stringify(['--print','/usage','--output-format','text','--print-timeout','20s'])));
  const report={passed:true,scope:'real Electron and backend using a simulated native CLI; fixture percentages, no real account',checks:['probe publishes native model-group quotas','actual labels, remaining percent and reset times rendered without fabricated core windows','manual refresh updates values','failed refresh discards cached quota rows even on exit zero','sign-out invalidates connection and quota','full-account refresh replaces removed model groups','quota refresh remains available after restart','no inference command invoked'],profile:directory,screenshot:path.resolve('tests/results/antigravity-quota-desktop.png')};
  await writeFile('tests/results/antigravity-quota-desktop.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await app?.close();}
