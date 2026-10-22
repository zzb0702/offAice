import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DshAdapter,setDshApiKey} from '../src/backend/adapters/dsh';
import {ZcodeAdapter} from '../src/backend/adapters/zcode';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {resolveRoomAccess,roomAccessInstruction} from '../src/shared/room-permissions';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import type {AcpExecutor,AdapterContext,Settings} from '../src/shared/types';

const dsh=path.resolve('.airoom/members/dsh/0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js');
const zcode=path.resolve('.airoom/members/zcode/3.16.2/resources/glm/zcode.cjs');
for(const native of ['dsh','zcode'] as const)for(const mode of ['collaborate','read-only'] as const){
  const file=native==='dsh'?dsh:zcode;
  test(`real ${native} ${mode} reads another directory; write schema and actual writes follow room mode`,{skip:!existsSync(file),timeout:120_000},async()=>{
    const {directory,env}=isolatedTestEnvironment(process.env,process.cwd());env.AIROOM_NODE_EXE=process.execPath;env.AIROOM_NODE_SOURCE='local';
    const cwd=path.join(directory,'project'),other=path.join(directory,'reference');await mkdir(cwd);await mkdir(other);
    const nonce=randomUUID(),input=path.join(other,'probe.txt'),output=path.join(other,'result.txt');await writeFile(input,nonce);
    let requests=0,readReturned=false,writeExposed=false;
    const diagnostics:string[]=[];
    const server=createServer(async(req,res)=>{
      let bodyText='';for await(const c of req)bodyText+=c;const body=JSON.parse(bodyText);requests++;
      res.writeHead(200,{'content-type':'text/event-stream'});
      const chunk=(delta:any,finish_reason:string|null=null)=>res.write('data: '+JSON.stringify({id:'meeting-native',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
      const tools=body.tools??[],readName=native==='dsh'?'read':'Read',writeName=native==='dsh'?'write':'Write';
      writeExposed=tools.some((t:any)=>t.function?.name===writeName);
      const results=body.messages.filter((m:any)=>m.role==='tool');
      if(results.some((m:any)=>JSON.stringify(m.content).includes(nonce)))readReturned=true;
      let tool:string|undefined,args:any;
      if(!results.length){tool=readName;args={file_path:input};}
      else if(mode==='collaborate'&&results.length===1){tool=writeName;args={file_path:output,content:'written-'+nonce};}
      if(tool&&!tools.some((t:any)=>t.function?.name===tool)){diagnostics.push('missing native tool '+tool);tool=undefined;}
      if(tool){chunk({role:'assistant',tool_calls:[{index:0,id:'call-'+requests,type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]});chunk({},'tool_calls');}
      else{chunk({role:'assistant',content:'Native meeting fixture finished.'});chunk({},'stop');}
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,id=native==='dsh'?'dsh':'acp-native-meeting';
    const access=resolveRoomAccess(mode,cwd,{commands:'auto',fileScope:'any',network:true},true);
    const settings:Settings={...DEFAULT_SETTINGS,dshAuthMode:'api',dshApiProtocol:'openai-completions',dshApiBaseUrl:url,paths:{dsh},models:{[id]:native==='dsh'?'meeting-fixture':'GLM-5.3-Flash'},efforts:{},permissions:{...DEFAULT_SETTINGS.permissions,[id]:access.permissions}};
    const executor:AcpExecutor={id:'acp-native-meeting',name:'ZCode fixture',catalogId:'zcode',command:zcode,args:[],authentication:'custom-api',env:{AIROOM_ZCODE_API_KEY:'local-fixture-key',AIROOM_ZCODE_BASE_URL:url,AIROOM_ZCODE_MODEL:'GLM-5.3-Flash'},permissions:access.permissions,createdAt:'2026-10-22'};
    const adapter=native==='dsh'?new DshAdapter():new ZcodeAdapter(executor);
    const events:any[]=[];
    const ctx={run:{id:'native-meeting-'+mode,provider:id,roomAccess:access},session:{id:'native-session-'+mode,writeMode:access.writeMode,autoApprove:access.autoApprove},cwd,conversation:'room',roomProjectDirectory:cwd,settings,env,
      emit:(kind:string,text:string,data:unknown)=>events.push({kind,text,data}),approve:async(request:any)=>({choice:request.allowChoice}),markDelivery:()=>{},persistNativeSession:()=>{},registerProcess:()=>{},recordConfig:()=>{},recordTiming:()=>{},progress:()=>{},freshInput:()=>roomAccessInstruction(access)+' Read the reference file and perform only the permitted work.'} as unknown as AdapterContext;
    if(native==='dsh')setDshApiKey('local-fixture-key');
    try {
      const result=await adapter.start(ctx,'Read the external reference.');assert.equal(result.failure,undefined,JSON.stringify(result));assert.equal(result.unknown,undefined,JSON.stringify(result));
      assert.deepEqual(diagnostics,[]);assert.equal(readReturned,true,'native read tool returns the real file contents from another directory');
      assert.equal(writeExposed,mode==='collaborate');assert.equal(requests,mode==='collaborate'?3:2);
      if(mode==='collaborate')assert.equal(await readFile(output,'utf8'),'written-'+nonce);else assert.equal(existsSync(output),false);
      if(native==='zcode'&&mode==='read-only'){
        ctx.settings.permissions[executor.id]={...access.permissions,fileScope:'workspace'};
        await assert.rejects(()=>adapter.start(ctx,'Check unsupported read isolation'),/ZCode 当前没有可核对的项目读取范围隔离/);
        assert.equal(requests,2,'unsupported isolation fails before another model request');
      }
      await mkdir('tests/results',{recursive:true});await writeFile(`tests/results/meeting-${native}-${mode}.json`,JSON.stringify({passed:true,scope:'unmodified installed native CLI, isolated profile, localhost mock API only',checks:['read outside starting directory with fileScope any','tool schema follows selected mode','real write permitted only in collaboration mode'],requests},null,2)+'\n');
    } finally {await adapter.stop();if(native==='dsh')setDshApiKey(undefined);await new Promise<void>(r=>server.close(()=>r()));}
  });
}
