import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';
import type {AcpExecutor} from '../shared/types';
import {projectQoderUsage} from '../shared/qoder-quota';
import {spawnCli,type CliCommand} from './adapters/common';
import {stopOwned} from './process-supervisor';

export const qoderQuotaSupported=(executor:AcpExecutor|undefined)=>executor?.catalogId==='qoder'||executor?.catalogId==='qodercn';
function fingerprint(file:string){try{return statSync(file).size<=1024*1024?createHash('sha256').update(readFileSync(file)).digest('hex'):'oversized';}catch{return 'missing';}}
/** Native encrypted account file is hashed, never decoded or copied. Logs/session files do not affect identity. */
export function qoderQuotaStamp(executor:AcpExecutor,home:string){
  const config=path.join(home,executor.catalogId==='qodercn'?'qoder-cn':'qoder');
  return createHash('sha256').update(JSON.stringify([executor.catalogId,executor.command,executor.authentication,executor.env,
    fingerprint(path.join(config,'.auth','user')),fingerprint(path.join(config,'settings.json'))])).digest('hex');
}
export function qoderQuotaArguments(){
  return ['--print','--input-format','stream-json','--output-format','stream-json','--no-session-persistence','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--permission-mode','dont_ask'];
}

/** Two native SDK controls only; no user prompt, resume, Agent turn, or SDK dependency. */
export async function queryQoderQuota(executor:AcpExecutor,command:CliCommand,env:NodeJS.ProcessEnv,home:string,timeoutMs=15_000){
  const unavailable=(reason:string)=>({payload:{qoderUsage:{}},checkedAt:new Date().toISOString(),reason});
  if(!qoderQuotaSupported(executor))return unavailable('unsupported-executor');
  const variable=executor.catalogId==='qodercn'?'QODERCN_CONFIG_DIR':'QODER_CONFIG_DIR';
  const expected=path.join(home,executor.catalogId==='qodercn'?'qoder-cn':'qoder');
  if(!path.isAbsolute(home)||env[variable]!==expected)return unavailable('account-directory-mismatch');
  const stamp=qoderQuotaStamp(executor,home);await mkdir(home,{recursive:true});
  const child=spawnCli(command,qoderQuotaArguments(),{env,cwd:home}),decoder=new StringDecoder('utf8');
  const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  let buffer='',bytes=0,failure:Error|undefined;
  const fail=(reason:string)=>{failure??=new Error(reason);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(failure);}pending.clear();};
  child.on('error',()=>fail('spawn-failed'));child.on('close',()=>{if(pending.size)fail('process-closed');});
  child.stdin?.on('error',()=>fail('stdin-closed'));child.stderr?.resume();
  child.stdout?.on('data',(chunk:Buffer)=>{
    if(failure)return;bytes+=chunk.length;if(bytes>2*1024*1024){fail('oversized-control-output');return;}
    buffer+=decoder.write(chunk);
    for(let index;(index=buffer.indexOf('\n'))>=0;){
      const line=buffer.slice(0,index).replace(/\r$/,'');buffer=buffer.slice(index+1);if(!line.trim())continue;
      let message;try{message=JSON.parse(line);}catch{fail('invalid-control-output');return;}
      if(message.type==='control_response'){
        const response=message.response,entry=pending.get(response?.request_id);if(!entry){fail('unexpected-control-response');return;}
        pending.delete(response.request_id);clearTimeout(entry.timer);
        if(response.subtype==='success')entry.resolve(response.response);
        else entry.reject(new Error('native-control-unavailable'));
      }else if(message.type==='control_request'){
        child.stdin?.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Quota checks deny callbacks and tools'}})+'\n');
        fail('unexpected-control-callback');return;
      }else if(!['system','status'].includes(message.type)){fail('unexpected-agent-output');return;}
    }
  });
  const request=(type:string)=>new Promise<any>((resolve,reject)=>{
    if(failure){reject(failure);return;}
    const request_id=randomUUID(),timer=setTimeout(()=>{pending.delete(request_id);reject(new Error('control-timeout'));},Math.max(100,Math.min(timeoutMs,20_000)));
    pending.set(request_id,{resolve,reject,timer});
    child.stdin?.write(JSON.stringify({type:'control_request',request_id,request:type==='initialize'?{type,hooks:{},allowedTools:[],mcpServers:{}}:{type}})+'\n');
  });
  try{
    await request('initialize');const response=await request('get_usage_info');
    if(failure)return unavailable(failure.message);
    if(stamp!==qoderQuotaStamp(executor,home))return unavailable('account-changed');
    // Session-only statistics are never used as remaining account quota.
    return {payload:{qoderUsage:projectQoderUsage(response?.usage)},checkedAt:new Date().toISOString(),reason:'queried'};
  }catch(error){return unavailable((error as Error).message);}
  finally{
    for(const entry of pending.values())clearTimeout(entry.timer);pending.clear();
    child.stdin?.end();await stopOwned(child,5000);
  }
}
