import path from 'node:path';
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fetch,ProxyAgent} from 'undici';
import {zcodeCredentialCipher} from './zcode-login';
import {registerSecret} from './security';
import type {ZcodeAccount} from './adapters/zcode-account';

export type ZcodeQuotaRequest=(input:{url:string;authorization:string;signal:AbortSignal})=>Promise<{status:number;body:unknown}>;
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:undefined;
function file(file:string){try{if(statSync(file).size>1024*1024)return '';return readFileSync(file,'utf8');}catch{return '';}}

/** Hash encrypted native files, never copy credentials into snapshots or a separate store. */
export function zcodeQuotaStamp(home:string,command:string,account:ZcodeAccount){
  return createHash('sha256').update(JSON.stringify([home,command,account,
    file(path.join(home,'.zcode','v2','credentials.json')),file(path.join(home,'.zcode','v2','provider_config.json')),
    file(path.join(path.dirname(command),'provider','zcode-builtin.json'))])).digest('hex');
}

/** Exact selected individual account only: no legacy/global files, other regions, or environment keys. */
function selectedAccount(home:string,command:string,account:ZcodeAccount,env:NodeJS.ProcessEnv){
  const stamp=zcodeQuotaStamp(home,command,account);
  try{
    const credentials=object(JSON.parse(file(path.join(home,'.zcode','v2','credentials.json'))));
    const config=object(JSON.parse(file(path.join(home,'.zcode','v2','provider_config.json'))));
    const builtin=object(JSON.parse(file(path.join(path.dirname(command),'provider','zcode-builtin.json'))));
    const cipher=zcodeCredentialCipher(home,env);
    const read=(name:string)=>{try{return typeof credentials[name]==='string'?cipher.decrypt(credentials[name]).trim():'';}catch{return '';}};
    const selection=config.config?.defaultModelSelection,rules=builtin.config?.providerConfigRules?.providerRules;
    const matches=Array.isArray(rules)?rules.filter(row=>row?.providerId===selection?.providerId):[];
    if(matches.length!==1)return;
    const rule=matches[0],access=rule.config?.access,provider=selection?.providerId;
    if(typeof provider!=='string'||access?.type!=='zhipu-account'||access.accountType!==account||access.mode!=='individual-coding-plan'||!Array.isArray(rule.config?.builtinModelIds)||!rule.config.builtinModelIds.includes(selection?.modelId))return;
    const active=read('oauth:active_provider');
    if(active&&active!==account||read(`account-provider:${provider}:auth-source`)==='manual'||!read(`oauth:${account}:access_token`)||!read('zcodejwttoken'))return;
    const identity=read(`account-provider:${provider}:identity`);
    if(!identity)return;
    const key=read(`account-provider:coding-plan:${provider}:account:${encodeURIComponent(identity)}:api-key`);
    if(!key||key.length>16_384||/[\r\n\0]/.test(key)||stamp!==zcodeQuotaStamp(home,command,account))return;
    registerSecret(key);
    return {key,stamp};
  }catch{return;}
}

/** Official monitor fields only; local token/cost counters cannot establish account quota. */
export function zcodeQuotaWindows(payload:unknown,now=Date.now()){
  const body=object(payload),data=object(body.data);
  if(body.success===false||![0,200].includes(body.code)||!Array.isArray(data.limits)||data.limits.length>100)return [];
  const windows:{id:'five_hour'|'seven_day'|'monthly_mcp';usedPercent:number;resetsAt?:number}[]=[];
  for(const raw of data.limits){
    const row=object(raw),coding=['TOKENS_LIMIT','CREDIT_LIMIT'].includes(row.type);
    const id=coding&&row.unit===3&&row.number===5?'five_hour':coding&&row.unit===6&&row.number===1?'seven_day':row.type==='TIME_LIMIT'&&row.unit===5&&row.number===1?'monthly_mcp':undefined;
    if(!id||windows.some(window=>window.id===id))continue;
    const total=finite(row.usage),used=finite(row.currentValue),remaining=finite(row.remaining);
    let percent=finite(row.percentage);
    if(total!==undefined&&total>0&&used!==undefined&&used>=0)percent=Math.min(100,used/total*100);
    else if(total!==undefined&&total>0&&remaining!==undefined&&remaining>=0&&remaining<=total)percent=(total-remaining)/total*100;
    if(percent===undefined||percent<0||percent>100)continue;
    // The official monitor returns milliseconds. Do not present an implausible 5h reset as a week-long wait.
    const resetMs=finite(row.nextResetTime),maxAhead=id==='five_hour'?6*60*60_000:id==='seven_day'?8*24*60*60_000:32*24*60*60_000;
    const resetsAt=resetMs!==undefined&&resetMs>=1_000_000_000_000&&resetMs>now&&resetMs<=now+maxAhead?resetMs/1000:undefined;
    windows.push({id,usedPercent:percent,...(resetsAt?{resetsAt}:{})});
  }
  return windows;
}

/** Single GET to the region's pinned official host; account switches discard late responses. */
export async function queryZcodeQuota(home:string,command:string,account:ZcodeAccount,env:NodeJS.ProcessEnv,injected?:ZcodeQuotaRequest){
  const unavailable=(reason:string)=>({payload:{zcodeUsage:[]},checkedAt:new Date().toISOString(),reason});
  const selected=selectedAccount(home,command,account,env);if(!selected)return unavailable('no-matching-official-account');
  const url=`https://${account==='zai'?'api.z.ai':'bigmodel.cn'}/api/monitor/usage/quota/limit`;
  const proxy=!injected&&env.HTTPS_PROXY?new ProxyAgent(env.HTTPS_PROXY):undefined;
  try{
    const signal=AbortSignal.timeout(15_000);
    const request:ZcodeQuotaRequest=injected??(async input=>{
      const response=await fetch(input.url,{method:'GET',headers:{authorization:input.authorization,accept:'application/json'},redirect:'error',dispatcher:proxy,signal:input.signal});
      let size=0;const chunks:Buffer[]=[];
      if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>256*1024){await response.body.cancel().catch(()=>{});throw Error('oversized quota response');}chunks.push(Buffer.from(chunk));}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
      return {status:response.status,body};
    });
    const response=await request({url,authorization:selected.key,signal});
    if(signal.aborted)return unavailable('timeout');
    if(selected.stamp!==zcodeQuotaStamp(home,command,account))return unavailable('account-changed');
    if(response.status!==200)return unavailable(`http-${response.status}`);
    const windows=zcodeQuotaWindows(response.body);
    return {payload:{zcodeUsage:windows},checkedAt:new Date().toISOString(),reason:windows.length?'ready':'unrecognized-quota-response'};
  }catch{return unavailable('network-or-invalid-response');}finally{await proxy?.close().catch(()=>{});}
}
