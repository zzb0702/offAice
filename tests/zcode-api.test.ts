import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {mkdir,writeFile,readdir,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import type {AcpExecutor,AdapterContext,Settings} from '../src/shared/types';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {catalogAuthentication} from '../src/backend/executor-catalog';
import {zcodeApiConnection} from '../src/shared/zcode-api';
import {ZcodeAdapter} from '../src/backend/adapters/zcode';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';

const command=path.resolve('.airoom/members/zcode/3.14.5/resources/glm/zcode.cjs');
const executor=(baseUrl='http://127.0.0.1:1/v1'):AcpExecutor=>({id:'acp-zcodeapi',catalogId:'zcode',name:'ZCode API test',command,args:[],env:{AIROOM_ZCODE_MODEL:'relay-zcode-test',AIROOM_ZCODE_BASE_URL:baseUrl,AIROOM_ZCODE_API_KEY:'fixture-zcode-relay-key'},model:'relay-zcode-test',authentication:'custom-api',permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:'2026-10-21'});

test('ZCode API catalog saves non-secret configuration and separates official auth',()=>{
  const old=executor();old.env.BIGMODEL_API_KEY='wrong-inherited-key';
  const result=catalogAuthentication(old,{authentication:'custom-api',model:'relay-zcode-test',baseUrl:'https://relay.example/v1/',secrets:{AIROOM_ZCODE_API_KEY:'fixture-zcode-relay-key'}});
  assert.equal(result.executor.env.AIROOM_ZCODE_BASE_URL,'https://relay.example/v1');
  assert.equal(result.executor.env.AIROOM_ZCODE_API_KEY,undefined);
  assert.equal(zcodeApiConnection(result.executor).api,'openai-chat-completions');
  assert.equal(result.secrets.AIROOM_ZCODE_API_KEY,'fixture-zcode-relay-key');
  const official=catalogAuthentication(result.executor,{authentication:'bigmodel',model:'should-not-persist',baseUrl:'https://relay.example/v1',secrets:{}});
  assert.equal(official.executor.model,undefined);assert.equal(official.executor.env.AIROOM_ZCODE_BASE_URL,undefined);assert.equal(official.executor.env.AIROOM_ZCODE_API_PROTOCOL,undefined);
  for(const value of ['https://u:p@relay.example/v1','file:///tmp/a','https://relay.example/v1?key=x','https://relay.example/v1/chat/completions'])assert.throws(()=>zcodeApiConnection({...old,env:{...old.env,AIROOM_ZCODE_BASE_URL:value}}));
  assert.throws(()=>catalogAuthentication(old,{authentication:'custom-api',model:'x',baseUrl:'https://relay.example/v1',apiProtocol:'unknown',secrets:{AIROOM_ZCODE_API_KEY:'fixture-zcode-relay-key'}}));
});

test('real ZCode uses the custom OpenAI endpoint, runs a read tool and removes temporary keys',{skip:!existsSync(command),timeout:180_000},async()=>{
  const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());env.AIROOM_NODE_EXE=process.execPath;env.AIROOM_NODE_SOURCE='local';
  const cwd=path.join(directory,'workspace');await mkdir(cwd,{recursive:true});
  const nonce=randomUUID();await writeFile(path.join(cwd,'probe.txt'),nonce);
  const requests:{url:string;body:any;authorization?:string}[]=[];let denied=false;
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
    requests.push({url:req.url!,body,authorization:req.headers.authorization});
    if(denied){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture invalid key',type:'authentication_error'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const chunk=(delta:any,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'chatcmpl-zcode',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
    const hasTool=body.messages.some((item:any)=>item.role==='tool');
    if(!hasTool){
      const tool=body.tools.find((item:any)=>item.function.name==='Read');assert.ok(tool,'ZCode exposes the read tool');
      chunk({role:'assistant',tool_calls:[{index:0,id:'call-zcode-read',type:'function',function:{name:'Read',arguments:JSON.stringify({file_path:path.join(cwd,'probe.txt')})}}]});chunk({},'tool_calls');
    }else{chunk({role:'assistant',content:'文件内容：'+nonce});chunk({},'stop');}
    res.write('data: '+JSON.stringify({id:'chatcmpl-zcode',object:'chat.completion.chunk',created:1,model:body.model,choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100,prompt_tokens_details:{cached_tokens:750}}})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,e=executor(`http://127.0.0.1:${port}/v1`),adapter=new ZcodeAdapter(e);
  const settings:Settings={...DEFAULT_SETTINGS,permissions:{...DEFAULT_SETTINGS.permissions,[e.id]:e.permissions},models:{},efforts:{}};
  const events:{kind:string;text:string;data?:unknown}[]=[],tokenReports:any[]=[];
  const ctx={run:{id:'run-zcode-api',provider:e.id},session:{id:'session-zcode-api',writeMode:false},cwd,env,settings,recordTokenUsage:(usage:unknown)=>tokenReports.push(usage),
    emit:(kind:string,text:string,data?:unknown)=>events.push({kind,text,data}),markDelivery:()=>{},persistNativeSession:()=>{},registerProcess:()=>{},recordConfig:()=>{},recordTiming:()=>{},progress:()=>{},freshInput:()=> 'Read probe.txt and return its contents.',
  } as unknown as AdapterContext;
  try{
    const unknown=await adapter.probe(settings,env);assert.equal(unknown.available,true,unknown.detail);assert.deepEqual(unknown.modelOptions?.[0].efforts,['disabled','enabled']);
    e.model='GLM-5.3';e.env.AIROOM_ZCODE_MODEL='GLM-5.3';settings.efforts[e.id]='max';
    const probe=await adapter.probe(settings,env);assert.equal(probe.available,true,probe.detail);assert.equal(probe.auth,'api');assert.equal(requests.length,0);
    assert.deepEqual(probe.modelOptions?.[0].efforts,['low','high','max']);
    const result=await adapter.start(ctx,'Read probe.txt');assert.equal(result.failure,undefined,JSON.stringify(result));assert.equal(result.unknown,undefined,JSON.stringify(result));assert.match(result.summary!,new RegExp(nonce));
    assert.equal(requests.length,2);assert.ok(requests.every(item=>item.url==='/v1/chat/completions'&&item.body.model==='GLM-5.3'&&item.body.reasoning_effort==='max'&&item.authorization==='Bearer fixture-zcode-relay-key'));
    assert.equal(tokenReports.at(-1)?.inputTokens,2000);assert.equal(tokenReports.at(-1)?.cacheReadTokens,1500);assert.equal(tokenReports.at(-1)?.outputTokens,200);
    assert.ok(requests[1].body.messages.some((item:any)=>item.role==='tool'&&JSON.stringify(item.content).includes(nonce)));
    assert.ok(!requests[0].body.tools.some((item:any)=>['Write','Edit','Bash'].includes(item.function.name)));
    const launchRoot=path.join(env.AIROOM_ACP_HOME!,e.id,'api','api-launch');assert.deepEqual(await readdir(launchRoot),[]);
    settings.efforts[e.id]='xhigh';await assert.rejects(()=>adapter.start(ctx,'Unsupported effort'),/思考程度不受/);assert.equal(requests.length,2);settings.efforts[e.id]='max';
    denied=true;const failed=await adapter.start(ctx,'Test invalid key');assert.ok(failed.failure||failed.unknown);assert.equal(requests.length,3);
    assert.deepEqual(await readdir(launchRoot),[]);
    const root=path.join(env.AIROOM_ACP_HOME!,e.id,'api');
    async function scan(dir:string):Promise<void>{for(const item of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await scan(file);else if(/\.(?:json|jsonl|log|txt)$/.test(item.name))assert.ok(!(await readFile(file)).includes(Buffer.from('fixture-zcode-relay-key')),'no plaintext key persists: '+file);}}
    await scan(root);
    await mkdir('tests/results',{recursive:true});await writeFile('tests/results/zcode-api-native.json',JSON.stringify({passed:true,version:probe.version,protocol:'openai-chat-completions',checks:['native provider configuration and model discovery','generic model retains native disabled/enabled levels','GLM-5.3 native low/high/max options','max reasoning_effort in every Chat Completions request','unsupported effort rejected before request','no model request during probe','native read tool round trip','read-only tools retained','401 failure without fallback','temporary credential files cleaned on success and failure','no plaintext credential in persistent JSON/log files']},null,2)+'\n');
  }finally{await adapter.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
