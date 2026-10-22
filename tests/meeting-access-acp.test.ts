import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {AcpAdapter} from '../src/backend/adapters/acp';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {resolveRoomAccess} from '../src/shared/room-permissions';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import type {AcpExecutor,AdapterContext} from '../src/shared/types';

const fixture=String.raw`
const fs=require('fs'),rl=require('readline').createInterface({input:process.stdin});
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');let prompt,phase=0;const out=process.env.FIXTURE_OUTPUT,reference=process.env.FIXTURE_INPUT;
function request(){const kind=phase===0?'read':phase===1?'edit':'execute';const toolCallId='tool-'+phase;
 send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'local-qwen',update:{sessionUpdate:'tool_call',toolCallId,title:kind,kind,status:'pending',rawInput:{file_path:phase===0?reference:out}}}});
 send({jsonrpc:'2.0',id:'permission-'+phase,method:'session/request_permission',params:{sessionId:'local-qwen',toolCall:{toolCallId},options:[{optionId:'allow',kind:'allow_once',name:'allow once'},{optionId:'deny',kind:'reject_once',name:'reject'}]}});
}
rl.on('line',line=>{const p=JSON.parse(line);
 if(p.method==='initialize')return send({id:p.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'local Qoder ACP fixture',version:'fixture'}}});
 if(p.method==='session/new')return send({id:p.id,result:{sessionId:'local-qwen'}});
 if(p.method==='session/prompt'){prompt=p.id;return request();}
 if(p.id==='permission-'+phase){const allow=p.result?.outcome?.optionId==='allow';
  if(allow&&phase===0)send({method:'session/update',params:{sessionId:'local-qwen',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:fs.readFileSync(reference,'utf8')}}}});
  if(allow&&phase===1)fs.writeFileSync(out,'actual edit');
  if(allow&&phase===2)fs.writeFileSync(out+'.command','actual command approval');
  send({method:'session/update',params:{sessionId:'local-qwen',update:{sessionUpdate:'tool_call_update',toolCallId:'tool-'+phase,status:allow?'completed':'failed',content:[]}}});
  phase++;if(phase<3)return request();return send({id:prompt,result:{stopReason:'end_turn'}});
 }
 if(p.id!==undefined)send({id:p.id,result:{}});
});rl.on('close',()=>process.exit(0));
`;

for(const mode of ['collaborate','read-only','strict'] as const)test(`Qoder CN ACP permission round trip: ${mode}`,{timeout:20_000},async()=>{
  const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());env.AIROOM_NODE_EXE=process.execPath;env.AIROOM_NODE_SOURCE='local';
  const cwd=path.join(directory,'project'),other=path.join(directory,'reference');await mkdir(cwd);await mkdir(other);
  const command=path.join(directory,'local-qwen.cjs'),input=path.join(other,'input.txt'),output=path.join(other,'result.txt');await writeFile(command,fixture);await writeFile(input,'actual outside reference');
  const access=resolveRoomAccess(mode==='read-only'?'read-only':'collaborate',cwd,{commands:mode==='strict'?'ask':'auto',fileScope:'any',network:true},true);
  const executor:AcpExecutor={id:'acp-local-qwen',catalogId:'qodercn',name:'Qwen fixture',command,args:['--acp'],env:{FIXTURE_INPUT:input,FIXTURE_OUTPUT:output},permissions:access.permissions,createdAt:'2026-10-22'};
  const adapter=new AcpAdapter(executor),events:any[]=[],approvals:any[]=[];
  const ctx={run:{id:'run-'+mode,provider:executor.id,roomAccess:access},session:{id:'session-'+mode,writeMode:access.writeMode,autoApprove:access.autoApprove},conversation:'room',roomProjectDirectory:cwd,cwd,env,
    settings:{...DEFAULT_SETTINGS,models:{},efforts:{},permissions:{...DEFAULT_SETTINGS.permissions,[executor.id]:access.permissions}},
    emit:(kind:string,text:string,data:any)=>events.push({kind,text,data}),approve:async(request:any)=>{approvals.push(request);return {choice:request.allowChoice};},markDelivery:()=>{},persistNativeSession:()=>{},registerProcess:()=>{},recordConfig:()=>{},freshInput:()=> 'Use the tools permitted for this turn.'} as unknown as AdapterContext;
  try {
    const result=await adapter.start(ctx,'fixture task');assert.equal(result.failure,undefined);assert.equal(result.unknown,undefined);
    assert.ok(events.some(e=>e.kind==='delta'&&e.text==='actual outside reference'));
    if(mode==='read-only'){assert.equal(existsSync(output),false);assert.equal(existsSync(output+'.command'),false);assert.equal(events.filter(e=>e.kind==='warning').length,2);}
    else {assert.equal(await readFile(output,'utf8'),'actual edit');assert.equal(await readFile(output+'.command','utf8'),'actual command approval');}
    assert.equal(approvals.length,mode==='strict'?2:0,'read tools follow the room scope, while strict write/command requests still wait for approval');
  } finally {await adapter.stop();}
});
