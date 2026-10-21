import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { dshApiConnection, dshApiReasoning, switchDshMode } from '../src/shared/dsh-connection';
import { buildDshEnvironment, buildDshPatch, DshAdapter, dshModelSelection, setDshApiKey } from '../src/backend/adapters/dsh';
import { redact } from '../src/backend/security';
import type { AdapterContext, Settings } from '../src/shared/types';
import { isolatedTestEnvironment } from '../scripts/test-environment.mjs';

const apiSettings = (baseURL='http://127.0.0.1:1/v1'): Settings => ({...DEFAULT_SETTINGS,
  dshAuthMode:'api',dshApiBaseUrl:baseURL,models:{dsh:'relay-test-model'},efforts:{},
  permissions:{...DEFAULT_SETTINGS.permissions,dsh:{commands:'deny',fileScope:'workspace',network:false}},
});

test('API roots and protocols validate without restricting legitimate relay paths',()=>{
  assert.deepEqual(dshApiConnection({dshApiBaseUrl:'https://relay.example/proxy/v1/'}),{api:'openai-completions',baseURL:'https://relay.example/proxy/v1'});
  for(const value of ['not-a-url','file:///tmp/a','https://key:secret@relay.example/v1','https://relay.example/v1?key=secret','https://relay.example/v1#x','https://relay.example/v1/chat/completions'])
    assert.throws(()=>dshApiConnection({dshApiBaseUrl:value}));
  assert.throws(()=>dshApiConnection({dshApiBaseUrl:'https://relay.example',dshApiProtocol:'invalid' as any}));
});

test('account and API routes remain separate, and no key is serialized into the patch',()=>{
  const account:any[]=buildDshPatch({...DEFAULT_SETTINGS},process.cwd(),false,path.resolve('guard.mjs'));
  assert.equal(account.find(item=>item.id==='acp')?.config?.provider,'deepseek-account');
  assert.throws(()=>buildDshPatch({...DEFAULT_SETTINGS,deepseekBaseUrl:'https://relay.example'},process.cwd(),false,path.resolve('guard.mjs')));
  const api:any[]=buildDshPatch(apiSettings(),process.cwd(),false,path.resolve('guard.mjs'));
  const route=(api.find(item=>item.id==='llm-pi-ai')?.config as any).providers['airoom-api'];
  assert.equal(route.api,'openai-completions');assert.equal(route.apiKeyEnv,'AIROOM_DSH_API_KEY');
  assert.equal(api.find(item=>item.id==='deepseek-account')?.disabled,true);
  assert.equal(api.find(item=>item.id==='llm-deepseek-account')?.disabled,true);
  assert.equal(api.find(item=>item.id==='acp')?.config?.provider,'airoom-api');
  assert.equal(dshModelSelection('relay-test-model','airoom-api').option,'["airoom-api","relay-test-model"]');
  assert.throws(()=>dshModelSelection('["deepseek-account","deepseek-flash"]','airoom-api'));
  assert.throws(()=>dshModelSelection(undefined,'airoom-api'));
});

test('only an explicitly supplied API credential enters the isolated child environment',()=>{
  const base={DSH_HOME:'other',DSH_PROFILE:'other',DEEPSEEK_API_KEY:'wrong-deepseek',DEEPSEEK_BASE_URL:'https://wrong.example',AIROOM_DSH_API_KEY:'wrong-inherited'};
  const account=buildDshEnvironment(base,process.cwd(),false);
  assert.equal(account.AIROOM_DSH_API_KEY,undefined);assert.equal(account.DEEPSEEK_API_KEY,undefined);
  const api=buildDshEnvironment(base,process.cwd(),false,'relay-fixture-key');
  assert.equal(api.AIROOM_DSH_API_KEY,'relay-fixture-key');assert.equal(api.DSH_PROFILE,undefined);
  setDshApiKey('relay-fixture-key');assert.equal(redact('echo relay-fixture-key'),'echo [credential redacted]');setDshApiKey();
});

test('switching connection modes restores the matching model and account effort',()=>{
  const account={...DEFAULT_SETTINGS,models:{dsh:'deepseek-flash'},efforts:{dsh:'max'}};
  const api=switchDshMode(account,'api');assert.equal(api.models.dsh,'');assert.equal(api.efforts.dsh,'');
  api.models.dsh='relay-test-model';
  api.efforts.dsh='high';
  const restored=switchDshMode(api,'account');assert.equal(restored.models.dsh,'deepseek-flash');assert.equal(restored.efforts.dsh,'max');
  const back=switchDshMode(restored,'api');assert.equal(back.models.dsh,'relay-test-model');assert.equal(back.efforts.dsh,'high');
});

test('custom reasoning is explicit, validated and not added for model defaults',()=>{
  const settings=apiSettings();
  let patch:any[]=buildDshPatch(settings,process.cwd(),false,path.resolve('guard.mjs'));
  let route:any=patch.find(item=>item.id==='llm-pi-ai').config.providers['airoom-api'];
  assert.equal(route.reasoning,undefined);assert.equal(route.models[0].reasoningEfforts,undefined);
  settings.efforts.dsh='max';settings.dshApiThinkingFormat='deepseek';
  patch=buildDshPatch(settings,process.cwd(),false,path.resolve('guard.mjs'));
  route=patch.find(item=>item.id==='llm-pi-ai').config.providers['airoom-api'];
  assert.equal(route.reasoning,'max');assert.equal(route.compat.thinkingFormat,'deepseek');assert.equal(route.models[0].reasoningEfforts.off,null);assert.equal(route.models[0].reasoningEfforts.max,'max');
  assert.throws(()=>dshApiReasoning({...settings,efforts:{dsh:'invented'}}));
  assert.throws(()=>dshApiReasoning({...settings,dshApiThinkingFormat:'invented' as any}));
});

test('native DSH sends selected API reasoning with OpenAI and DeepSeek formats',{timeout:180_000},async()=>{
  const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());env.AIROOM_NODE_EXE=process.execPath;env.AIROOM_NODE_SOURCE='local';
  const cwd=path.join(directory,'workspace');await mkdir(cwd,{recursive:true});
  const bodies:any[]=[];
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);bodies.push(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const delta of [{role:'assistant',content:'Reasoning request accepted by fixture.'},{}])res.write('data: '+JSON.stringify({id:'chatcmpl-effort',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:delta.content?null:'stop'}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));setDshApiKey('reasoning-fixture-key');
  try{
    for(const [effort,format] of [['high','openai'],['max','deepseek'],['off','deepseek']] as const){
      const settings=apiSettings(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`);settings.efforts.dsh=effort;settings.dshApiThinkingFormat=format;
      const adapter=new DshAdapter();
      try{
        const before=bodies.length,probe=await adapter.probe(settings,env);assert.equal(probe.available,true,probe.detail);assert.equal(bodies.length,before);assert.ok(probe.modelOptions?.[0].efforts.includes(effort));
        const ctx={run:{id:'run-'+effort,provider:'dsh'},session:{id:'session-'+effort,writeMode:false},cwd,settings,env,emit:()=>{},markDelivery:()=>{},persistNativeSession:()=>{},registerProcess:()=>{},recordConfig:()=>{},recordTiming:()=>{},progress:()=>{},freshInput:()=> 'Reply once.'} as unknown as AdapterContext;
        const result=await adapter.start(ctx,'Reply once.');assert.equal(result.failure,undefined,JSON.stringify(result));assert.equal(result.unknown,undefined,JSON.stringify(result));assert.equal(bodies.length,before+1);
        const body=bodies.at(-1);if(effort!=='off')assert.equal(body.reasoning_effort,effort);if(format==='deepseek')assert.equal(body.thinking?.type,effort==='off'?'disabled':'enabled');
      }finally{await adapter.dispose();}
    }
    await mkdir('tests/results',{recursive:true});await writeFile('tests/results/dsh-api-reasoning.json',JSON.stringify({passed:true,protocol:'openai-completions',checks:['high sent as reasoning_effort','DeepSeek max sends reasoning_effort and thinking enabled','DeepSeek off sends thinking disabled','native ACP selection accepted and no model requests during probes'],requests:bodies.length},null,2)+'\n');
  }finally{setDshApiKey();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

for(const runtime of [
  {label:'bundled DSH',file:undefined},
  {label:'DSH 0.2.1-rc.2',file:path.resolve('.airoom/members/dsh/0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js')},
])test(`${runtime.label} uses Chat Completions with a real file tool round trip; 401 never falls back`, {skip:!!runtime.file&&!existsSync(runtime.file),timeout:180_000}, async()=>{
  const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());
  env.AIROOM_NODE_EXE=process.execPath;env.AIROOM_NODE_SOURCE='local';
  const cwd=path.join(directory,'workspace-{{literal-directory}}');await mkdir(cwd,{recursive:true});
  const nonce=randomUUID();await writeFile(path.join(cwd,'probe.txt'),nonce);
  const requests:{url:string;body:any;authorization?:string}[]=[];
  let denied=false;
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text);requests.push({url:req.url!,body,authorization:req.headers.authorization});
    if(denied){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture invalid API key',type:'authentication_error'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    const tool=body.messages.some((item:any)=>item.role==='tool');
    const chunk=(delta:any,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'chatcmpl-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
    if(!tool){
      const read=body.tools.find((item:any)=>item.function.name==='read');assert.ok(read,'native read tool is exposed');
      chunk({role:'assistant',tool_calls:[{index:0,id:'call-fixture-read',type:'function',function:{name:read.function.name,arguments:JSON.stringify({file_path:path.join(cwd,'probe.txt')})}}]});
      chunk({},'tool_calls');
    }else{chunk({role:'assistant',content:'文件内容：'+nonce});chunk({},'stop');}
    res.write('data: '+JSON.stringify({id:'chatcmpl-fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100,prompt_tokens_details:{cached_tokens:750}}})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};const settings=apiSettings(`http://127.0.0.1:${address.port}/v1`);
  if(runtime.file){settings.paths={...settings.paths,dsh:runtime.file};settings.efforts.dsh='max';settings.dshApiThinkingFormat='deepseek';}
  const adapter=new DshAdapter();setDshApiKey('relay-fixture-key');
  const events:{kind:string;text:string;data?:unknown}[]=[],tokenReports:any[]=[];
  const ctx={run:{id:'run-dsh-test',provider:'dsh'},session:{id:'session-dsh-test',writeMode:false},cwd,settings,env,persona:'中文回复。人物卡文字含 {{cwd}} 和 {{unregistered-persona-variable}}，作为普通文本。',
    emit:(kind:string,text:string,data?:unknown)=>events.push({kind,text,data}),recordTokenUsage:(usage:unknown)=>tokenReports.push(usage),markDelivery:()=>{},persistNativeSession:()=>{},
    registerProcess:()=>{},recordConfig:()=>{},recordTiming:()=>{},progress:()=>{},freshInput:()=> 'Read probe.txt and reply with its content.',
  } as unknown as AdapterContext;
  try{
    const probe=await adapter.probe(settings,env);
    assert.equal(probe.available,true,probe.detail);assert.equal(probe.auth,'api');
    assert.equal(requests.length,0,'connection check does not consume model requests');
    const result=await adapter.start(ctx,'Read probe.txt');
    assert.equal(result.failure,undefined,JSON.stringify(result));assert.equal(result.unknown,undefined);
    assert.equal(requests.length,2);assert.ok(requests.every(item=>item.url==='/v1/chat/completions'&&item.body.model==='relay-test-model'&&item.authorization==='Bearer relay-fixture-key'));
    if(runtime.file)assert.ok(requests.every(item=>item.body.reasoning_effort==='max'&&item.body.thinking?.type==='enabled'),'current DSH preserves the selected DeepSeek max settings');
    assert.ok(!requests[0].body.tools.some((item:any)=>['write','edit','bash','pwsh'].includes(item.function.name)),'read-only permission limits survive the API route');
    assert.ok(requests[1].body.messages.some((item:any)=>item.role==='tool'&&JSON.stringify(item.content).includes(nonce)));
    const prompt=JSON.stringify(requests[0].body.messages);assert.ok(prompt.includes('workspace-{{literal-directory}}'),'model receives the literal task workspace on both runtime versions');
    if(runtime.file)assert.ok(requests[0].body.messages.some((item:any)=>item.role==='user'&&JSON.stringify(item.content).includes('workspace-{{literal-directory}}')),'current DSH also provides its native working-directory context');
    assert.ok(prompt.includes('Simplified Chinese'),'language requirement remains in the persona suffix');assert.ok(prompt.includes('{ {unregistered-persona-variable} }'),'persona card text cannot introduce native variables');
    assert.ok(events.some(event=>event.kind==='delta'&&event.text.includes(nonce)));
    assert.equal(tokenReports.at(-1)?.inputTokens,2000,'native DSH bridge preserves total prompt across both requests');
    assert.equal(tokenReports.at(-1)?.cacheReadTokens,1500);assert.equal(tokenReports.at(-1)?.outputTokens,200);
    const patches=path.join(env.AIROOM_DSH_HOME!,'api','launch-patches');
    const {readdir}=await import('node:fs/promises');
    for(const file of await readdir(patches))assert.ok(!(await readFile(path.join(patches,file),'utf8')).includes('relay-fixture-key'));
    denied=true;events.length=0;
    const failure=await adapter.start(ctx,'Test invalid credential');
    assert.ok(failure.failure||failure.unknown,'401 must not be reported as a successful turn');
    assert.equal(requests.length,3,'401 is not retried or sent to another provider');
    await mkdir('tests/results',{recursive:true});
    await writeFile(runtime.file?'tests/results/dsh-current-runtime-native.json':'tests/results/dsh-api-native.json',JSON.stringify({passed:true,version:probe.version,protocol:'openai-completions',requestPath:'/v1/chat/completions',requests:requests.length,checks:['no model request during probe','native file read tool round trip','read-only permissions retained','literal task workspace on old and current runtime','native current-directory context on 0.2.1','persona variable-like text remains plain text','language requirement retained',...(runtime.file?['max reasoning_effort and DeepSeek thinking enabled']:[]),'no key in patches','401 returns failure without retry or fallback']},null,2)+'\n');
  }finally{await adapter.dispose();setDshApiKey();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
