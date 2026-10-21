import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import {projectQoderUsage,qoderCreditsReport,creditsExhausted,creditsFresh} from '../src/shared/qoder-quota';
import {quotaReport,quotaPreference,quotaAt100,mergeQuota} from '../src/shared/quota';
import {queryQoderQuota,qoderQuotaStamp,qoderQuotaArguments} from '../src/backend/qoder-quota';
import {AcpAdapter} from '../src/backend/adapters/acp';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import type {AcpExecutor} from '../src/shared/types';
const at='2026-10-21T12:00:00Z',now=Date.parse(at),id='acp-qoderquota' as const;
const native={userId:'private-user',userType:'Pro',totalUsagePercentage:70,isQuotaExceeded:false,expiresAt:now/1000+86400,upgradeUrl:'https://private.example',session:{total_credits:22},
  userQuota:{total:100,used:100,remaining:0,percentage:100,unit:'Credits'},addOnQuota:{total:50,used:5,remaining:45,percentage:10,unit:'Credits',detailUrl:'https://private.example'}};
async function fixture(edition:'qoder'|'qodercn'='qodercn'){
  const {directory,env}=isolatedTestEnvironment(process.env,process.cwd()),home=path.join(env.AIROOM_ACP_HOME!,id),config=path.join(home,edition==='qodercn'?'qoder-cn':'qoder'),state=path.join(directory,'state.txt'),calls=path.join(directory,'calls.jsonl'),command=path.join(directory,'mock-qoder.cjs');
  await mkdir(path.join(config,'.auth'),{recursive:true});await writeFile(path.join(config,'.auth','user'),'fixture-account');await writeFile(state,'initial');await copyFile('tests/fixtures/qoder-quota.cjs',command);
  const executor:AcpExecutor={id,catalogId:edition,name:'Qoder',command,args:['--acp'],env:{TEST_QUOTA_STATE:state,TEST_QUOTA_CALLS:calls},authentication:edition,permissions:{commands:'deny',fileScope:'workspace',network:false},createdAt:at};
  const childEnv={...env,...executor.env,[edition==='qodercn'?'QODERCN_CONFIG_DIR':'QODER_CONFIG_DIR']:config};
  const run=(timeout=15000)=>queryQoderQuota(executor,{command:process.execPath,prefix:[command],path:command},childEnv,home,timeout);
  return {executor,env,home,state,calls,run};
}
test('native account projection retains separate pools while removing IDs, URLs and session counters',()=>{
  const projected=projectQoderUsage(native);assert.ok(!JSON.stringify(projected).includes('private'));assert.equal(projected.session,undefined);
  const report=qoderCreditsReport(projected,at);assert.equal(report.status,'ready');assert.equal(report.buckets.length,2);assert.equal(report.buckets[0].remaining,0);assert.equal(report.buckets[1].remaining,45);assert.equal(report.expiresAt,now/1000+86400);
});
test('empty, malformed and session-only payloads are unavailable rather than zero or full quota',()=>{
  for(const payload of [undefined,null,[],{},'text',{userId:'x',userType:'Pro'},{session:{total_credits:42}},{userQuota:{remaining:-1,total:NaN,percentage:101}},{userQuota:{remaining:'10'}}])assert.equal(qoderCreditsReport(payload,at).status,'unavailable');
  const zero=qoderCreditsReport({userQuota:{remaining:0,used:0,total:0}},at);assert.equal(zero.status,'ready');assert.equal(zero.buckets[0].remaining,0);assert.equal(zero.buckets[0].usedPercent,undefined);
});
test('organization cap, native partial fields and counts are interpreted without inventing missing totals',()=>{
  const report=qoderCreditsReport({orgResourcePackage:{cap:200,used:20,remaining:180,percentage:99,available:false,unit:'Credits'},userQuota:{remaining:25}},at);
  assert.equal(report.buckets[1].usedPercent,10);assert.equal(report.buckets[1].available,false);assert.equal(report.buckets[0].total,undefined);assert.equal(report.buckets[0].usedPercent,undefined);
});
test('one depleted pool never suspends an account with native aggregate quota remaining',()=>{
  const quota=quotaReport(id,{qoderUsage:native},at,'probe')!;assert.equal(quota.kind,'credits');assert.equal(quota.windows.length,0);assert.equal(quotaPreference(quota,now),1);assert.equal(quotaAt100(quota,now),false);
  const noAggregate=quotaReport(id,{qoderUsage:{userQuota:{total:100,used:100,remaining:0}}},at,'probe')!;assert.equal(quotaPreference(noAggregate,now),1);
  const explicit=quotaReport(id,{qoderUsage:{isQuotaExceeded:true,totalUsagePercentage:100}},at,'probe')!;assert.equal(quotaPreference(explicit,now),0);assert.equal(quotaAt100(explicit,now),true);
  const available=quotaReport(id,{qoderUsage:{isQuotaExceeded:false,totalUsagePercentage:100}},at,'probe')!;assert.ok(quotaPreference(available,now)>0);assert.equal(quotaAt100(available,now),false);
});
test('expiry does not become a reset window and old/failed samples cannot keep blocking calls',()=>{
  const quota=quotaReport(id,{qoderUsage:{...native,isQuotaExceeded:true,totalUsagePercentage:100}},at,'probe')!;
  assert.equal(creditsFresh(quota.credits,now+16*60000),false);assert.equal(creditsExhausted(quota.credits,now+16*60000),false);assert.equal(quotaPreference(quota,now+16*60000),1);
  const failed=quotaReport(id,{qoderUsage:{}},new Date(now+1000).toISOString(),'probe')!;assert.equal(mergeQuota(quota,failed).credits?.status,'unavailable');assert.equal(mergeQuota(failed,quota).credits?.status,'unavailable');
  assert.equal(qoderCreditsReport({...native,expiresAt:now+86400000},at).expiresAt,(now+86400000)/1000);
});
test('real child protocol sends only initialize/get_usage_info controls for both editions and strips private fields',async()=>{
  for(const edition of ['qoder','qodercn'] as const){
    const f=await fixture(edition),result=await f.run(),quota=quotaReport(id,result.payload,result.checkedAt,'probe')!;
    assert.equal(result.reason,'queried');assert.equal(quota.queryStatus,'ready');assert.ok(!JSON.stringify(result).includes('fixture-private-user'));
    const records=(await readFile(f.calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),launch=records.find(x=>x.kind==='launch');
    assert.deepEqual(launch.args,qoderQuotaArguments());assert.deepEqual(records.filter(x=>x.kind==='input').map(x=>x.message.request.type),['initialize','get_usage_info']);
    assert.ok(launch.args.includes('--no-session-persistence'));assert.ok(!launch.args.includes('--resume'));
  }
});
test('native unsupported, malformed, mismatched and callback responses fail without exposing native errors',async()=>{
  const f=await fixture();
  for(const state of ['unsupported','malformed','wrong-id','callback','session-only']){
    await writeFile(f.state,state);const result=await f.run();assert.equal(quotaReport(id,result.payload,result.checkedAt,'probe')?.queryStatus,'unavailable');assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  }
});
test('native timeout is bounded and changed authentication invalidates a late quota reply',async()=>{
  const f=await fixture(),before=qoderQuotaStamp(f.executor,f.home);await writeFile(f.state,'changed');const changed=await f.run();assert.equal(changed.reason,'account-changed');assert.notEqual(qoderQuotaStamp(f.executor,f.home),before);
  await writeFile(f.state,'timeout');const timeout=await f.run(1000);assert.equal(timeout.reason,'control-timeout');
});
test('ACP adapter exposes the same quota query and requires the private account directory',async()=>{
  const f=await fixture(),result=await new AcpAdapter(f.executor).accountQuota(DEFAULT_SETTINGS,f.env);assert.equal(result.reason,'queried');
  const denied=await queryQoderQuota(f.executor,{command:process.execPath,prefix:[],path:process.execPath},f.env,f.home);assert.equal(denied.reason,'account-directory-mismatch');
});
