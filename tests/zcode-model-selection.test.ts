import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import {managedCatalogEnvironment} from '../src/backend/executor-catalog';
import {zcodeApiEnvironment} from '../src/backend/adapters/zcode-api';
import {ZcodeModelSession,ZcodeTaskOutput,zcodeRunModelEnvironment} from '../src/backend/adapters/zcode-model';
import {collectCommand} from '../src/backend/adapters/common';
import {ZcodeAdapter} from '../src/backend/adapters/zcode';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {zcodeProviderConfig} from '../src/backend/zcode-provider-config';
import type {AcpExecutor,AdapterContext} from '../src/shared/types';

const entry=path.resolve('.airoom/members/zcode/3.14.5/resources/glm/zcode.cjs');

test('account config completion preserves existing provider rules and fails on incompatible formats',()=>{
  const selection={providerId:'account:bigmodel-individual-coding-plan',modelId:'GLM-5.3-Flash',options:{reasoningLevel:'max'}};
  const original={schemaVersion:1,config:{providerOrder:['custom'],providerConfigRules:{providerRules:[{providerId:'custom',config:{api:{baseUrl:'https://example.invalid/v1'}}}]},modelConfigRules:{providerModelRules:[{providerId:'custom',modelId:'fixture',config:{enabled:true}}],manualProviderModelRules:[]},defaultModelSelection:{providerId:'custom',modelId:'fixture'}}};
  const before=JSON.stringify(original),updated=zcodeProviderConfig(original,selection);
  assert.deepEqual(updated.config.providerConfigRules,original.config.providerConfigRules);assert.deepEqual(updated.config.modelConfigRules,original.config.modelConfigRules);assert.deepEqual(updated.config.providerOrder,['custom']);assert.equal(JSON.stringify(original),before);
  const fresh=zcodeProviderConfig({},selection);assert.deepEqual(fresh.config.providerConfigRules,{providerRules:[]});assert.deepEqual(fresh.config.modelConfigRules,{providerModelRules:[],manualProviderModelRules:[]});
  for(const value of [null,[],{schemaVersion:2,config:{}},{schemaVersion:1,config:null},{config:{providerConfigRules:null}},{config:{modelConfigRules:{providerModelRules:[]}}},{config:{unknownSetting:true}}])assert.throws(()=>zcodeProviderConfig(value,selection),/未发送任务/);
});

test('real ZCode fresh invocation receives a selected model different from its saved default',{skip:!existsSync(entry),timeout:150_000},async()=>{
  const {directory,env:base}=isolatedTestEnvironment(process.env,process.cwd());base.AIROOM_NODE_EXE=process.execPath;base.AIROOM_NODE_SOURCE='local';
  const home=path.join(directory,'zcode'),cwd=path.join(directory,'workspace');await mkdir(home,{recursive:true});await mkdir(cwd);
  const requests:{model:string;effort?:string}[]=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;const body=JSON.parse(text);requests.push({model:body.model,effort:body.reasoning_effort});
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:'Local fixture reply'},null],[{},'stop']])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const executor:AcpExecutor={id:'acp-model-test',catalogId:'zcode',name:'Model fixture',command:entry,args:[],authentication:'custom-api',env:{AIROOM_ZCODE_MODEL:'GLM-5.3',AIROOM_ZCODE_BASE_URL:`http://127.0.0.1:${(server.address() as any).port}/v1`,AIROOM_ZCODE_API_KEY:'local-fixture-key'},permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:'2026-10-21'};
  const env={...managedCatalogEnvironment(executor,base,home),ZCODE_DATA_BASE_DIR:home,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:path.join(path.dirname(entry),'provider','zcode-builtin.json')};
  const temporary=await zcodeApiEnvironment(executor,env),file=temporary.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!;
  const config=JSON.parse(await readFile(file,'utf8'));config.config.providerConfigRules.providerRules[0].config.personalModelIds=['GLM-5.3','GLM-5.3-Flash'];await writeFile(file,JSON.stringify(config));
  const before=await readFile(file,'utf8'),command={command:process.execPath,prefix:[entry],path:entry};
  let control:ZcodeModelSession|undefined;
  try{
    control=await ZcodeModelSession.open(command,temporary.env,cwd,'airoom-custom-api',undefined,false);
    let state=await control.load(undefined,true);assert.equal(state.current?.modelId,'GLM-5.3');
    const selection=await control.select(state,'GLM-5.3-Flash','max',false);await control.close();control=undefined;
    let id:string|undefined;
    assert.equal(requests.length,0,'model preparation does not call a model');
    const run=async()=>{
      const task=await zcodeRunModelEnvironment(temporary.env,selection);
      try{
        const response=await collectCommand(command,['-p','Reply once.',...(id?['--resume',id]:[]),'--mode','plan','--output-format','stream-json','--disallowed-tools','Bash,Write,Edit,Agent,Task,WebFetch,WebSearch'],task.env,cwd,45_000);
        assert.equal(response.code,0,'local native prompt completed');const output=new ZcodeTaskOutput();output.feed(response.stdout);output.finish();assert.equal(output.invalid,false);if(id)assert.equal(output.result.sessionId,id);else id=output.result.sessionId;return output;
      }finally{await task.cleanup();}
    };
    const first=await run();assert.equal(requests.at(-1)?.model,'GLM-5.3-Flash');assert.equal(requests.at(-1)?.effort,'max');
    assert.ok(first.models.length);assert.ok(first.models.every(item=>item.modelId==='GLM-5.3-Flash'));
    control=await ZcodeModelSession.open(command,temporary.env,cwd,'airoom-custom-api',undefined,false);state=await control.load(id);
    assert.equal(state.current?.modelId,'GLM-5.3-Flash');Object.assign(selection,await control.select(state,'GLM-5.3','high',true));await control.close();control=undefined;
    await run();assert.equal(requests.length,2);assert.equal(requests.at(-1)?.model,'GLM-5.3');assert.equal(requests.at(-1)?.effort,'high');
    assert.equal(await readFile(file,'utf8'),before,'model switching never edits the invocation default');
    await mkdir('tests/results',{recursive:true});await writeFile('tests/results/zcode-model-selection-native.json',JSON.stringify({passed:true,scope:'real installed CLI against a local mock API; isolated empty account profile',checks:['both GLM models available; default GLM-5.3','prepare Flash/max without model request','fresh CLI prompt requests Flash/max','nonempty persisted session cold-reads GLM-5.3/high after an explicit switch','shared defaults remain byte-identical'],modelRequests:requests},null,2)+'\n');
  }finally{await control?.close();await temporary.cleanup();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('official account runtime cold-reads Flash from an older incomplete AIROOM login config',{skip:!existsSync(entry),timeout:90_000},async()=>{
  const {directory,env:base}=isolatedTestEnvironment(process.env,process.cwd());base.AIROOM_NODE_EXE=process.execPath;base.AIROOM_NODE_SOURCE='local';
  const home=path.join(directory,'zcode'),cwd=path.join(directory,'workspace'),provider='account:bigmodel-individual-coding-plan';
  const configDirectory=path.join(home,'.zcode','v2');await mkdir(configDirectory,{recursive:true});await mkdir(cwd);
  const personal=path.join(configDirectory,'provider_config.json');
  const before=JSON.stringify({schemaVersion:1,config:{defaultModelSelection:{providerId:provider,modelId:'GLM-5.3'}}});await writeFile(personal,before);
  const env={...base,HOME:home,USERPROFILE:home,ZCODE_DATA_BASE_DIR:home,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:path.join(path.dirname(entry),'provider','zcode-builtin.json'),ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personal};
  const command={command:process.execPath,prefix:[entry],path:entry};let control:ZcodeModelSession|undefined;
  try{
    control=await ZcodeModelSession.open(command,env,cwd,provider);const state=await control.load(undefined,true);
    const selection=await control.select(state,'GLM-5.3-Flash','max',false);await control.close();control=undefined;
    const task=await zcodeRunModelEnvironment(env,selection);
    try{
      // A different unmodified native process must accept the invocation default without another setter.
      control=await ZcodeModelSession.open(command,task.env,cwd,provider);const cold=await control.load(undefined,true);
      assert.equal(cold.current?.providerId,provider);assert.equal(cold.current?.modelId,'GLM-5.3-Flash');assert.equal(cold.current?.options?.reasoningLevel,'max');
      await control.close();control=undefined;
    }finally{await task.cleanup();}
    assert.equal(await readFile(personal,'utf8'),before,'old profile remains unchanged; only the private launch config is repaired');
    await mkdir('tests/results',{recursive:true});await writeFile('tests/results/zcode-account-model-native.json',JSON.stringify({passed:true,scope:'real installed ZCode app-server; isolated signed-out profile with protocol entitlement overlay; model control only, no model requests',checks:['older incomplete official login config reproduced','both native account GLM models available','different native process reads Flash/max as its initial selection without a setter','original profile unchanged']},null,2)+'\n');
  }finally{await control?.close();}
});

test('adapter passes a valid private model default and rejects genuine request mismatch',async()=>{
  const {directory,env}=isolatedTestEnvironment(process.env,process.cwd()),command=path.join(directory,'fake-zcode.cjs'),state=path.join(directory,'state.json'),calls=path.join(directory,'calls.jsonl'),provider='airoom-custom-api',nativeId='sess_prepared';
  const fake=String.raw`
const fs=require('fs'),readline=require('readline'),args=process.argv.slice(2),state=process.env.MODEL_STATE,calls=process.env.MODEL_CALLS;
const read=()=>JSON.parse(fs.readFileSync(state,'utf8'));
if(args[0]==='app-server')readline.createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);let current=read();fs.appendFileSync(calls,JSON.stringify({method:p.method,params:p.params})+'\n');
 if(p.method==='session/setModel'){current=p.params.model;fs.writeFileSync(state,JSON.stringify(current));}
 const option=model=>({ref:{providerId:'airoom-custom-api',modelId:model},reasoning:{levels:[{value:'max'}],defaultLevel:'max'}});
 const result={protocol:{name:'ZCode Protocol',version:1},session:{sessionId:'sess_prepared'},settings:{model:{current,available:[option('GLM-5.3'),option('GLM-5.3-Flash')]}}};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result})+'\n');
});
else {
 fs.appendFileSync(calls,JSON.stringify({args})+'\n');
 const config=JSON.parse(fs.readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,'utf8')).config;
 const resumed=args.includes('--resume')?args[args.indexOf('--resume')+1]:'sess_prepared';
 const model=process.env.FORCE_MISMATCH==='1'||!config.providerConfigRules||!config.modelConfigRules?'GLM-5.3':config.defaultModelSelection.modelId;
 console.log(JSON.stringify({type:'session.updated',sessionId:resumed,turnId:'turn',payload:{providerId:'airoom-custom-api',modelId:model,messageCount:0}}));
 console.log(JSON.stringify({type:'result',sessionId:resumed,turnId:'turn',response:'fixture reply',projection:{status:'completed'}}));
}
`;
  await writeFile(command,fake);await writeFile(state,JSON.stringify({providerId:provider,modelId:'GLM-5.3'}));
  const executor:AcpExecutor={id:'acp-zcode-test',catalogId:'zcode',name:'ZCode',command,args:[],authentication:'custom-api',env:{MODEL_STATE:state,MODEL_CALLS:calls,AIROOM_ZCODE_MODEL:'GLM-5.3-Flash',AIROOM_ZCODE_BASE_URL:'http://127.0.0.1:1/v1',AIROOM_ZCODE_API_KEY:'fixture-key'},model:'GLM-5.3-Flash',permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:'2026-10-21'};
  await mkdir(path.join(directory,'provider'));await writeFile(path.join(directory,'provider','zcode-builtin.json'),JSON.stringify({revision:1}));
  const home=path.join(directory,'home'),personal=path.join(home,'provider.json');await mkdir(home);await writeFile(personal,JSON.stringify({schemaVersion:1,config:{defaultModelSelection:{providerId:provider,modelId:'GLM-5.3'}}}));
  const settings={...DEFAULT_SETTINGS,models:{[executor.id]:'GLM-5.3-Flash'},efforts:{[executor.id]:'max'},permissions:{...DEFAULT_SETTINGS.permissions,[executor.id]:executor.permissions}};
  const context={run:{id:'run',provider:executor.id},session:{id:'session',writeMode:false},cwd:directory,env,settings,emit:()=>{},markDelivery:()=>{},persistNativeSession:()=>{},registerProcess:()=>{},recordConfig:()=>{}} as unknown as AdapterContext;
  // Reuse the real task path, replacing only account preparation in this protocol fixture.
  const adapter=new ZcodeAdapter(executor) as any;
  adapter.environment=()=>({...env,...executor.env,ZCODE_DATA_BASE_DIR:home,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:path.join(directory,'provider','zcode-builtin.json'),ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:personal});
  adapter.modelEnvironment=(value:unknown)=>value;adapter.state=()=>({ready:true,provider,model:'GLM-5.3-Flash'});
  try{
    const result=await adapter.startPrepared(context,'fixture');assert.equal(result.failure,undefined);assert.equal(result.unknown,undefined);
    const packets=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(packets.find(item=>item.method==='session/create').params.persistence,'deferred');
    const args=packets.find(item=>item.args).args;assert.equal(args.includes('--resume'),false,'fresh sessions are created by the task CLI');
    executor.env.FORCE_MISMATCH='1';
    const rejected=await adapter.startPrepared(context,'fixture mismatch');assert.equal(rejected.failure?.kind,'failed');
    assert.match(rejected.failure.message,/GLM-5.3-Flash/);assert.match(rejected.failure.message,/实际：airoom-custom-api\/GLM-5.3/);
    const after=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(after.filter(item=>item.args).length,2,'one explicit task produces one CLI execution; a mismatch is never retried');
  }finally{await adapter.stop();}
});
