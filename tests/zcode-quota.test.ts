import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import {zcodeCredentialCipher} from '../src/backend/zcode-login';
import {queryZcodeQuota,zcodeQuotaStamp,zcodeQuotaWindows} from '../src/backend/zcode-quota';
import {quotaReport,quotaPreference,quotaAt100,mergeQuota} from '../src/shared/quota';
import {ZcodeAdapter} from '../src/backend/adapters/zcode';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import type {AcpExecutor} from '../src/shared/types';

const now=Date.parse('2026-10-21T12:00:00Z'),at=new Date(now).toISOString();
const response=(limits:unknown[])=>({code:200,success:true,data:{limits}});
const limits=[{type:'TOKENS_LIMIT',unit:3,number:5,usage:100,currentValue:25,percentage:99,nextResetTime:now+3600_000},
  {type:'CREDIT_LIMIT',unit:6,number:1,percentage:20,nextResetTime:now+3*86400_000},
  {type:'TIME_LIMIT',unit:5,number:1,usage:100,currentValue:100,remaining:0,nextResetTime:now+20*86400_000}];
async function fixture(account:'bigmodel'|'zai'='bigmodel'){
  const {directory,env}=isolatedTestEnvironment(process.env,process.cwd()),id='acp-zcodequota' as const,home=path.join(env.AIROOM_ACP_HOME!,id),command=path.join(directory,'program','zcode.cjs');
  const folder=path.join(home,'.zcode','v2'),provider='official-'+account,key='fixture-only-'+account+'-coding-key';
  await mkdir(folder,{recursive:true});await mkdir(path.join(path.dirname(command),'provider'),{recursive:true});await writeFile(command,'// fixture');
  const rules={config:{providerConfigRules:{providerRules:[{providerId:provider,config:{access:{type:'zhipu-account',accountType:account,mode:'individual-coding-plan'},builtinModelIds:['test-model']}}]}}};
  await writeFile(path.join(path.dirname(command),'provider','zcode-builtin.json'),JSON.stringify(rules));
  const selection={config:{defaultModelSelection:{providerId:provider,modelId:'test-model'}}};
  const configFile=path.join(folder,'provider_config.json'),credentialsFile=path.join(folder,'credentials.json');await writeFile(configFile,JSON.stringify(selection));
  const values:Record<string,string>={'oauth:active_provider':account,[`oauth:${account}:access_token`]:'fixture-oauth',zcodejwttoken:'fixture-jwt',[`account-provider:${provider}:identity`]:'fixture-user',[`account-provider:coding-plan:${provider}:account:fixture-user:api-key`]:key};
  const cipher=zcodeCredentialCipher(home,env),save=async()=>writeFile(credentialsFile,JSON.stringify(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,cipher.encrypt(v)]))));await save();
  return {home,command,env,id,account,key,provider,values,save,configFile,credentialsFile,selection,executor:{id,catalogId:'zcode',name:'ZCode',command,args:[],env:{},authentication:account,permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:at} as AcpExecutor};
}
test('official selected account queries only its regional host with raw selected key and never writes credentials',async()=>{
  for(const account of ['bigmodel','zai'] as const){
    const f=await fixture(account),before=await readFile(f.credentialsFile,'utf8');let calls=0;
    const result=await queryZcodeQuota(f.home,f.command,account,{...f.env,ZCODE_BIGMODEL_USAGE_QUOTA_URL:'https://untrusted.example',BIGMODEL_USAGE_API_KEY:'wrong-key'},async input=>{
      calls++;assert.equal(input.url,`https://${account==='zai'?'api.z.ai':'bigmodel.cn'}/api/monitor/usage/quota/limit`);assert.equal(input.authorization,f.key);return {status:200,body:response(limits)};
    });
    assert.equal(calls,1);assert.equal(result.reason,'ready');assert.equal(await readFile(f.credentialsFile,'utf8'),before);
    assert.ok(!JSON.stringify(result).includes(f.key));assert.ok(!JSON.stringify(result).includes('fixture-user'));
  }
});
test('missing, mismatched, manual and unsupported selections never fall back to another account or environment key',async()=>{
  const f=await fixture();let calls=0;const request=async()=>{calls++;return {status:200,body:response(limits)};};
  assert.equal((await queryZcodeQuota(f.home,f.command,'zai',f.env,request)).reason,'no-matching-official-account');
  f.values[`account-provider:${f.provider}:auth-source`]='manual';await f.save();
  assert.equal((await queryZcodeQuota(f.home,f.command,'bigmodel',f.env,request)).reason,'no-matching-official-account');
  delete f.values[`account-provider:${f.provider}:auth-source`];delete f.values[`account-provider:coding-plan:${f.provider}:account:fixture-user:api-key`];
  f.values['account-provider:coding-plan:another-provider:account:another-user:api-key']='unrelated-key';await f.save();
  assert.equal((await queryZcodeQuota(f.home,f.command,'bigmodel',{...f.env,BIGMODEL_USAGE_API_KEY:'unrelated-env-key'},request)).reason,'no-matching-official-account');
  assert.equal(calls,0);
});
test('account switch while a request is pending invalidates the result and changes its cache identity',async()=>{
  const f=await fixture(),before=zcodeQuotaStamp(f.home,f.command,'bigmodel');
  const result=await queryZcodeQuota(f.home,f.command,'bigmodel',f.env,async()=>{f.values[`account-provider:${f.provider}:identity`]='next-user';await f.save();return {status:200,body:response(limits)};});
  assert.equal(result.reason,'account-changed');assert.deepEqual(result.payload.zcodeUsage,[]);assert.notEqual(zcodeQuotaStamp(f.home,f.command,'bigmodel'),before);
});
test('auth, network and business errors stay unavailable without logging out or exposing remote bodies',async()=>{
  const f=await fixture();
  for(const status of [401,403,429,500]){
    const result=await queryZcodeQuota(f.home,f.command,'bigmodel',f.env,async()=>({status,body:{secret:f.key}}));
    assert.equal(result.reason,'http-'+status);assert.deepEqual(result.payload.zcodeUsage,[]);assert.ok(!JSON.stringify(result).includes(f.key));
  }
  const failed=await queryZcodeQuota(f.home,f.command,'bigmodel',f.env,async()=>{throw Error(f.key);});assert.equal(failed.reason,'network-or-invalid-response');
  assert.deepEqual(zcodeQuotaWindows({code:401,data:{limits}}),[]);assert.deepEqual(zcodeQuotaWindows({code:200,success:false,data:{limits}}),[]);
});
test('custom API mode does not query official account quota',async()=>{
  const f=await fixture();let calls=0;
  const adapter=new ZcodeAdapter({...f.executor,authentication:'custom-api'},undefined,undefined,async()=>{calls++;throw Error('must not query');});
  assert.deepEqual((await adapter.accountQuota(DEFAULT_SETTINGS,f.env)).payload.zcodeUsage,[]);assert.equal(calls,0);
});
test('native monitor windows use exact categories and counts, with MCP separate from model limits',()=>{
  const rows=zcodeQuotaWindows(response(limits),now);assert.deepEqual(rows.map(x=>[x.id,x.usedPercent]),[['five_hour',25],['seven_day',20],['monthly_mcp',100]]);
  const quota=quotaReport('acp-zcodequota',{zcodeUsage:rows},at,'probe')!;
  assert.equal(quota.kind,'coding-plan');assert.equal(quota.windows[2].label,'每月 MCP');assert.equal(quota.windows[2].scope,'tools');
  assert.equal(quotaPreference(quota,now),1);assert.equal(quotaAt100(quota,now),false);
  const spent=quotaReport('acp-zcodequota',{zcodeUsage:[{id:'five_hour',usedPercent:100}]},at,'probe')!;assert.equal(quotaPreference(spent,now),0);assert.equal(quotaAt100(spent,now),true);
});
test('absent or malformed windows are never fabricated, while true zero usage remains valid',()=>{
  assert.deepEqual(zcodeQuotaWindows(response([{type:'TOKENS_LIMIT',unit:3,number:5,percentage:0}]),now),[{id:'five_hour',usedPercent:0}]);
  const malformed=[{type:'UNKNOWN',unit:3,number:5,percentage:0},{type:'TOKENS_LIMIT',percentage:1},{type:'TOKENS_LIMIT',unit:3,number:5,percentage:-1},{type:'TOKENS_LIMIT',unit:3,number:5,percentage:101}];
  assert.deepEqual(zcodeQuotaWindows(response(malformed),now),[]);assert.deepEqual(zcodeQuotaWindows({usage:{input_tokens:4}},now),[]);
  assert.equal(zcodeQuotaWindows(response([{type:'CREDIT_LIMIT',unit:6,number:1,usage:100,currentValue:110}]),now)[0].usedPercent,100);
});
test('missing, past, second-based and implausible reset timestamps do not invent recovery times',()=>{
  for(const nextResetTime of [undefined,now-1,now/1000,now+7*86400_000]){
    const row=zcodeQuotaWindows(response([{type:'TOKENS_LIMIT',unit:3,number:5,percentage:10,nextResetTime}]),now)[0];assert.equal(row.usedPercent,10);assert.equal(row.resetsAt,undefined);
  }
});
test('failed or narrower full samples replace old quota rows instead of reviving missing windows',()=>{
  const old=quotaReport('acp-zcodequota',{zcodeUsage:zcodeQuotaWindows(response(limits),now)},at,'probe')!;
  const missing=quotaReport('acp-zcodequota',{zcodeUsage:[]},new Date(now+1000).toISOString(),'probe')!;
  assert.equal(mergeQuota(old,missing).windows.length,0);assert.equal(mergeQuota(missing,old).windows.length,0);
});
