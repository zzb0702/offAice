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
const id='acp-catalogantigravity',command=path.join(directory,'mock-agy.cjs'),state=path.join(directory,'auth-state.txt'),calls=path.join(directory,'usage-calls.jsonl');
await writeFile(state,'account');
await writeFile(command,String.raw`
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('1.4.4');process.exit(0);}
if(args.includes('--help')){console.log('--input-format --output-format --conversation --sandbox --disable-slash-commands --print --print-timeout');process.exit(0);}
if(args[0]==='models'){console.log('gemini-test Gemini test');process.exit(0);}
if(!args.includes('/usage'))throw Error('Desktop auth check must not start inference');
fs.appendFileSync(process.env.TEST_AUTH_CALLS,JSON.stringify(args)+'\n');
const state=fs.readFileSync(process.env.TEST_AUTH_STATE,'utf8');
if(state==='none'){console.error('authentication required');process.exit(1);}
if(state==='unknown'){console.error('network unavailable');process.exit(1);}
console.log('Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-24T07:23:28Z');
`);
const store=new Store(env.AIROOM_DATA_DIR);
store.put('settings','main',{...DEFAULT_SETTINGS,nodeRuntime:'local'});
store.put('executors',id,{id,name:'Antigravity CLI',catalogId:'antigravity',adapter:'antigravity',command,args:[],env:{TEST_AUTH_STATE:state,TEST_AUTH_CALLS:calls},authentication:'google',permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:'2026-10-21'});
store.close();
let app;
try{
  app=await _electron.launch({executablePath:await developmentRuntime(electron),args:[process.cwd()],env,timeout:60_000});
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();await page.getByRole('button',{name:'连接与版本',exact:true}).click();
  const region=page.getByRole('region',{name:'Antigravity CLI 的连接',exact:true});
  await region.getByText('已连接 · 1.4.4',{exact:true}).waitFor({timeout:60_000});
  let snapshot=await page.evaluate(()=>window.airoom.invoke('snapshot'));
  assert.equal(snapshot.providers.find(x=>x.id===id).auth,'account');assert.equal(snapshot.providers.find(x=>x.id===id).available,true);
  await mkdir('tests/results',{recursive:true});await region.scrollIntoViewIfNeeded();await page.screenshot({path:'tests/results/antigravity-auth-desktop.png',fullPage:true});
  for(const auth of ['none','unknown']){
    await writeFile(state,auth);
    await page.evaluate(id=>window.airoom.invoke('provider.probe',{provider:id}),id);
    snapshot=await page.evaluate(()=>window.airoom.invoke('snapshot'));
    const info=snapshot.providers.find(x=>x.id===id);assert.equal(info.auth,auth);assert.equal(info.available,false);
    await region.getByText((auth==='none'?'需要登录':'未就绪')+' · 1.4.4',{exact:true}).waitFor({timeout:15_000});
  }
  const invocations=(await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(invocations.length>=3);assert.ok(invocations.every(args=>JSON.stringify(args)===JSON.stringify(['--print','/usage','--output-format','text','--print-timeout','20s'])));
  const report={passed:true,scope:'real Electron and backend using a simulated native CLI; no real account',checks:['native quota authentication makes connection runnable and displays connected','signed out displays login required','network failure stays unknown instead of claiming signed out','only built-in usage command invoked, no inference input'],profile:directory,screenshot:path.resolve('tests/results/antigravity-auth-desktop.png')};
  await writeFile('tests/results/antigravity-auth-desktop.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await app?.close();}
