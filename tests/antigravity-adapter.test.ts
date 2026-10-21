import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {AntigravityAdapter} from '../src/backend/adapters/antigravity';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {observeTool} from '../src/shared/work-log';
import {existsSync} from 'node:fs';
import type {AcpExecutor,AdapterContext,AdapterResult} from '../src/shared/types';

const fake=String.raw`
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('Antigravity CLI 1.4.3');process.exit(0);}
if(args.includes('--help')){console.error('--input-format --output-format --conversation --sandbox --disable-slash-commands --print --print-timeout');process.exit(0);}
if(args[0]==='models'){console.log('gemini-test  Gemini test model');process.exit(0);}
if(args.includes('/usage')){
 fs.writeFileSync(path.join(process.env.USERPROFILE,'auth-check.json'),JSON.stringify({args}));
 if(process.env.TEST_AGY_SCENARIO==='signed-out'){console.error('authentication required');process.exit(1);}
 console.log('Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-24T07:23:28Z');process.exit(0);
}
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 const message=JSON.parse(input),scenario=process.env.TEST_AGY_SCENARIO||'success';
 const settings=JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE,'.gemini','antigravity-cli','settings.json'),'utf8'));
 fs.writeFileSync(path.join(process.env.USERPROFILE,'capture.json'),JSON.stringify({args,message,settings,home:process.env.USERPROFILE,inherited:process.env.ANTIGRAVITY_CSRF_TOKEN}));
 const id=scenario==='wrong-session'?'other':'conv-test';
 const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
 send({event:'init',conversation_id:id,init:{model:scenario==='wrong-model'?'wrong':'gemini-test',tools:['read_file'],permission_mode:scenario==='wrong-permissions'?'always-proceed':'request-review'}});
 if(scenario==='hang'){setInterval(()=>{},1000);return;}
 if(scenario==='truncated'){process.stdout.write('{"event":');return;}
 if(scenario==='failure'){send({event:'result',result:{conversation_id:id,status:'ERROR',response:'',error:'quota exceeded'}});return;}
 if(scenario==='waiting'){send({event:'result',result:{conversation_id:id,status:'WAITING',response:'',error:'waiting for approval'}});return;}
 send({event:'step_update',step_update:{conversation_id:id,step_index:0,state:'DONE',step_type:'tool',tool_name:'run_command',tool_info:{parameters:{CommandLine:'echo test'},output:'test'}}});
 send({event:'step_update',step_update:{conversation_id:id,step_index:1,state:'DONE',step_type:'agent_response',text_delta:'完成'}});
 send({event:'result',result:{conversation_id:id,status:'SUCCESS',response:'完成',usage:{input_tokens:10,output_tokens:2,cache_read_tokens:8}}});
 if(scenario==='nonzero')process.exitCode=1;
});
`;

async function setup(scenario='success'){
  const root=await mkdtemp(path.join(tmpdir(),'airoom-agy-adapter-')),command=path.join(root,'mock-agy.cjs'),home=path.join(root,'native'),cwd=path.join(root,'workspace');
  await writeFile(command,fake);await mkdir(cwd);await mkdir(home);
  const id='acp-agytest00' as const;
  const executor:AcpExecutor={id,name:'AGY test',adapter:'antigravity',command,args:[],env:{TEST_AGY_SCENARIO:scenario},permissions:{commands:'ask',fileScope:'workspace',network:false},createdAt:'2026-10-20'};
  const events:{kind:string;text:string;data?:unknown}[]=[],delivery:string[]=[],sessions:string[]=[],processes:unknown[]=[];
  const tokenReports:{inputTokens?:number;cacheReadTokens?:number}[]=[];
  const ctx={run:{id:'run-test',provider:id},session:{id:'session-test',writeMode:false},cwd,
    settings:{...DEFAULT_SETTINGS,models:{[id]:'gemini-test'},efforts:{[id]:'high'},permissions:{...DEFAULT_SETTINGS.permissions,[id]:executor.permissions}},
    env:{...process.env,AIROOM_ACP_HOME:home,ANTIGRAVITY_CSRF_TOKEN:'must-not-be-inherited'},recordTokenUsage:(usage:{inputTokens?:number;cacheReadTokens?:number})=>tokenReports.push(usage),
    emit:(kind:string,text:string,data?:unknown)=>events.push({kind,text,data}),markDelivery:(state:string)=>delivery.push(state),persistNativeSession:(id:string)=>sessions.push(id),registerProcess:(p:unknown)=>processes.push(p),recordConfig:()=>{},progress:()=>{},freshInput:()=> '完整历史与中文任务',
  } as unknown as AdapterContext;
  return {root,executor,ctx,events,delivery,sessions,processes,tokenReports,adapter:new AntigravityAdapter(executor)};
}

test('real child-process path sends one stdin prompt and returns a native successful result',async()=>{
  const s=await setup();const info=await s.adapter.probe(s.ctx.settings,s.ctx.env);
  assert.equal(info.runtimeReady,true);assert.equal(info.available,true);assert.equal(info.auth,'account');assert.equal(info.modelOptions?.[0].id,'gemini-test');
  assert.ok((info.quota as {antigravityUsage:unknown[]}).antigravityUsage.length);assert.ok(info.quotaCheckedAt);
  const auth=JSON.parse(await readFile(path.join(s.ctx.env.AIROOM_ACP_HOME!,s.executor.id,'auth-check.json'),'utf8'));
  assert.deepEqual(auth.args,['--print','/usage','--output-format','text','--print-timeout','20s']);
  assert.equal(existsSync(path.join(s.ctx.env.AIROOM_ACP_HOME!,s.executor.id,'capture.json')),false,'probe sends no inference input');
  const result=await s.adapter.start(s.ctx,'task');assert.equal(result.unknown,undefined);assert.equal(result.failure,undefined);
  assert.deepEqual(s.sessions,['conv-test']);assert.deepEqual(s.delivery,['sent','confirmed']);assert.equal(s.processes.length,1);
  assert.equal(s.events.filter(e=>e.kind==='delta').map(e=>e.text).join(''),'完成');
  assert.deepEqual(result.usage,{scope:'conversation',native:{input_tokens:10,output_tokens:2,cache_read_tokens:8}});
  assert.equal(s.tokenReports[0]?.inputTokens,10);assert.equal(s.tokenReports[0]?.cacheReadTokens,8);
  const tool=s.events.find(event=>event.kind==='tool');assert.ok(tool);
  const observation=observeTool(tool as any);assert.equal(observation?.command,'echo test');assert.equal(observation?.phase,'unknown');assert.equal(observation?.exitCode,undefined);
  const capture=JSON.parse(await readFile(path.join(s.ctx.env.AIROOM_ACP_HOME!,s.executor.id,'capture.json'),'utf8'));
  assert.equal(capture.message.event,'user');assert.match(capture.message.message.content,/完整历史与中文任务/);assert.equal(capture.inherited,undefined);
  assert.ok(capture.args.includes('--sandbox'));assert.ok(!capture.args.includes('--dangerously-skip-permissions'));assert.ok(!capture.args.includes('-p'));
  assert.ok(capture.settings.permissions.deny.includes('write_file(*)'));assert.ok(capture.settings.permissions.deny.includes('command(*)'));
});

test('probe reports a signed-out native account without starting inference',async()=>{
  const s=await setup('signed-out'),info=await s.adapter.probe(s.ctx.settings,s.ctx.env);
  assert.equal(info.runtimeReady,true);assert.equal(info.available,false);assert.equal(info.auth,'none');assert.match(info.detail,/尚未登录/);
  assert.equal(existsSync(path.join(s.ctx.env.AIROOM_ACP_HOME!,s.executor.id,'capture.json')),false);
});

test('terminal failure and waiting results do not turn into success',async()=>{
  for(const [scenario,expected]of [['failure','failure'],['waiting','unknown']] as const){
    const s=await setup(scenario),result=await s.adapter.start(s.ctx,'task');
    assert.ok(result[expected]);assert.deepEqual(s.sessions,[]);
    if(scenario==='failure')assert.equal(result.failure?.kind,'rate_limited');
  }
});

test('truncation and contradictory exit are unknown, never retried',async()=>{
  for(const scenario of ['truncated','nonzero']){const s=await setup(scenario),result=await s.adapter.start(s.ctx,'task');assert.equal(result.unknown,true);assert.equal(s.processes.length,1);assert.deepEqual(s.sessions,[]);}
});

test('wrong native model or resumed conversation is rejected without fallback',async()=>{
  for(const scenario of ['wrong-model','wrong-session','wrong-permissions']){const s=await setup(scenario);s.ctx.session.nativeId='conv-test';const result=await s.adapter.start(s.ctx,'task');assert.equal(result.unknown,true);assert.deepEqual(s.sessions,[]);assert.equal(s.processes.length,1);}
});

test('images are rejected before launch and plain resume uses only the bound conversation',async()=>{
  const s=await setup();s.ctx.attachments=[{id:'i',name:'image.png',kind:'image',mime:'image/png',size:1,path:'image.png'}];
  await assert.rejects(s.adapter.start(s.ctx,'look'),/仅支持文字/);assert.equal(s.processes.length,0);assert.deepEqual(s.delivery,[]);
  s.ctx.attachments=[];s.ctx.session.nativeId='conv-test';await s.adapter.start(s.ctx,'next');
  const capture=JSON.parse(await readFile(path.join(s.ctx.env.AIROOM_ACP_HOME!,s.executor.id,'capture.json'),'utf8'));
  const index=capture.args.indexOf('--conversation');assert.equal(capture.args[index+1],'conv-test');assert.match(capture.message.message.content,/next/);assert.doesNotMatch(capture.message.message.content,/完整历史与中文任务/);
});

test('stop terminates an owned hanging process',async()=>{
  const s=await setup('hang');let result:AdapterResult|undefined;
  const running=s.adapter.start(s.ctx,'wait').then(value=>{result=value;});
  const deadline=Date.now()+15_000;while(!s.delivery.includes('confirmed')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(s.delivery.includes('confirmed'));await s.adapter.stop();await running;assert.equal(result?.stopped,true);assert.deepEqual(s.sessions,[]);
});
