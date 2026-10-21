import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {_electron} from '@playwright/test';
import electron from 'electron';
import {developmentRuntime} from '../scripts/development-runtime.mjs';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import {portableNode} from '../src/backend/portable-node-path.ts';

const executablePath=await developmentRuntime(electron);
const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());
delete env.ELECTRON_RUN_AS_NODE;env.AIROOM_NODE_EXE=portableNode(path.resolve('.airoom'))??process.execPath;
const data=env.AIROOM_DATA_DIR,secretFile=path.join(data,'secrets','dsh-api.secret'),fixtureKey='desktop-relay-fixture-key';
let requests=0,app;
const server=createServer((_req,res)=>{requests++;res.writeHead(500);res.end('Unexpected model request in configuration test');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
async function launch(){
  app=await _electron.launch({executablePath,args:[process.cwd()],env,timeout:60_000});
  const page=await app.firstWindow();
  await page.waitForFunction(async()=>{try{return (await window.airoom.invoke('snapshot')).backendReady===true;}catch{return false;}},undefined,{timeout:60_000});
  return page;
}
async function snapshot(page){return page.evaluate(()=>window.airoom.invoke('snapshot'));}
try{
  let page=await launch();
  const initial=await snapshot(page);
  await page.evaluate(({settings,entry})=>window.airoom.invoke('settings.save',{settings:{...settings,nodeRuntime:'local',paths:{...settings.paths,dsh:entry}}}),{settings:initial.settings,entry:path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')});
  await page.getByRole('button',{name:'设置与连接',exact:true}).click();
  await page.getByRole('button',{name:'连接与版本',exact:true}).click();
  const connection=page.locator('[data-provider="dsh"]');
  await connection.getByRole('combobox',{name:'DSH 连接方式'}).selectOption('api');
  assert.equal(await connection.getByRole('combobox',{name:'DSH API 接口格式'}).inputValue(),'openai-completions');
  assert.equal(await connection.getByRole('button',{name:'登录',exact:true}).count(),0);
  await connection.getByRole('textbox',{name:'DSH API 服务地址'}).fill(baseUrl);
  await connection.getByRole('textbox',{name:'DSH API 模型'}).fill('relay-desktop-model');
  await connection.getByRole('combobox',{name:'DSH API 思考程度',exact:true}).selectOption('max');
  await connection.getByRole('combobox',{name:'DSH API 思考参数格式',exact:true}).selectOption('deepseek');
  await connection.locator('input[aria-label="DSH API Key"]').fill(fixtureKey);
  await connection.getByRole('button',{name:'加密保存 DSH API Key',exact:true}).click();
  await page.getByText('DSH API Key 已加密保存。',{exact:true}).waitFor({timeout:60_000});
  const saved=await snapshot(page);
  assert.equal(saved.settings.dshAuthMode,'api');assert.equal(saved.settings.dshApiBaseUrl,baseUrl);
  assert.equal(saved.settings.efforts.dsh,'max');assert.equal(saved.settings.dshApiThinkingFormat,'deepseek');
  assert.ok(!JSON.stringify(saved).includes(fixtureKey));
  assert.equal(await connection.locator('input[aria-label="DSH API Key"]').inputValue(),'');
  const encrypted=await readFile(secretFile);assert.ok(!encrypted.includes(Buffer.from(fixtureKey)));
  const checked=await page.evaluate(()=>window.airoom.invoke('provider.probe',{provider:'dsh'}));
  assert.ok(checked);
  const connected=(await snapshot(page)).providers.find(item=>item.id==='dsh');
  assert.equal(connected.available,true,connected.detail);assert.equal(connected.auth,'api');
  await mkdir('tests/results',{recursive:true});
  await page.screenshot({path:'tests/results/dsh-api-desktop.png',fullPage:true});
  await app.close();app=undefined;
  page=await launch();
  const restored=await snapshot(page);
  assert.equal(restored.dshApiKeyConfigured,true);assert.equal(restored.settings.dshApiProtocol,'openai-completions');
  assert.equal(restored.settings.models.dsh,'relay-desktop-model');
  assert.equal(restored.settings.efforts.dsh,'max');assert.equal(restored.settings.dshApiThinkingFormat,'deepseek');
  assert.ok(!JSON.stringify(restored).includes(fixtureKey));
  await page.evaluate(()=>window.airoom.invoke('dshApiKey.set',{value:''}));
  await page.waitForFunction(async()=>!(await window.airoom.invoke('snapshot')).dshApiKeyConfigured);
  assert.equal(existsSync(secretFile),false);assert.equal(requests,0);
  const report={passed:true,checks:['real desktop settings and default protocol','API max effort and DeepSeek thinking format saved and restored across restart','encrypted key outside settings/snapshot','real backend/native DSH API probe','restart restores encrypted credential','clear removes stored credential','no model requests'],profile:directory,screenshot:path.resolve('tests/results/dsh-api-desktop.png')};
  await writeFile('tests/results/dsh-api-desktop.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}finally{await app?.close();await new Promise(resolve=>server.close(resolve));}
