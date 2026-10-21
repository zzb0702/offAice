import test from 'node:test';
import assert from 'node:assert/strict';
import {antigravityUsageRows} from '../src/backend/adapters/antigravity-quota';
import {antigravityAuthentication} from '../src/backend/adapters/antigravity-auth';
import {mergeQuota,quotaAt100,quotaPreference,quotaReport,quotaFresh} from '../src/shared/quota';

const at='2026-10-21T12:00:00Z',provider='acp-agyquota' as const;
const report='Gemini Models\tWeekly Limit Remaining\t92.5%\t2026-10-24T07:23:28Z\nClaude and GPT models\tFive Hour Limit Remaining\t0%\t2026-10-21T14:24:35Z\n';
const quota=(text=report,checkedAt=at)=>quotaReport(provider,{antigravityUsage:antigravityUsageRows(text)},checkedAt,'probe')!;

test('native model groups retain their actual period, remaining percentage and reset time',()=>{
  const result=quota();assert.equal(result.kind,'model-groups');assert.equal(result.queryStatus,'ready');
  assert.equal(result.windows.length,2);
  assert.deepEqual(result.windows.map(x=>({label:x.label,used:x.usedPercent,reset:x.resetsAt,exhausted:x.exhausted})),[
    {label:'Gemini Models · 每周',used:7.5,reset:Date.parse('2026-10-24T07:23:28Z')/1000,exhausted:false},
    {label:'Claude and GPT models · 5 小时',used:100,reset:Date.parse('2026-10-21T14:24:35Z')/1000,exhausted:true},
  ]);
});
test('unknown native periods stay unclassified rather than becoming a five-hour or weekly limit',()=>{
  const result=quota(report.split('\n')[0].replace('Weekly Limit','Daily Quota'));
  assert.equal(result.windows[0].label,'Gemini Models · 剩余额度');
});
test('ANSI, duplicate rows and headers do not duplicate quota groups',()=>{
  const result=quota('Model quotas\n\x1b[32m'+report+report+'\x1b[0m');assert.equal(result.windows.length,2);
});
test('invalid native values and untrusted token output cannot create quota data',()=>{
  const row=report.split('\n')[0];
  for(const invalid of [row.replace('92.5%','101%'),row.replace('92.5%','-1%'),row.replace('92.5%','NaN%'),row.replace('2026-10-24T07:23:28Z','invalid'),row.replace('2026-10-24T07:23:28Z','2026-10-24T07:23:28'),row.replace('Gemini Models','x'.repeat(121)),'{"usage":{"input_tokens":42}}','SUCCESS']){
    assert.equal(quota(invalid).queryStatus,'unavailable');assert.equal(quota(invalid).windows.length,0);
  }
  assert.equal(quotaReport('codex',{antigravityUsage:antigravityUsageRows(report)},at,'probe'),undefined);
});
test('explicit failed refresh replaces old data, while stale or reset samples cannot look fresh',()=>{
  const previous=quota(),failed=quota('', '2026-10-21T12:01:00Z');
  assert.deepEqual(mergeQuota(previous,failed).windows,[]);
  assert.equal(mergeQuota(previous,failed).queryStatus,'unavailable');
  assert.equal(mergeQuota(failed,previous).windows.length,0);
  assert.equal(quotaFresh(previous.windows[0],Date.parse(at)+16*60_000),false);
  assert.equal(quotaFresh({...previous.windows[0],resetsAt:Date.parse(at)/1000},Date.parse(at)),false);
});
test('one exhausted native group never blocks another model or skips review automatically',()=>{
  const result=quota();assert.equal(quotaPreference(result,Date.parse(at),'gemini-test'),1);
  assert.equal(quotaAt100(result,Date.parse(at),'gemini-test'),false);
  const codex=quotaReport('codex',{accountRateLimits:{rateLimits:{primary:{windowDurationMins:300,usedPercent:100}}}},at,'probe')!;
  assert.equal(quotaPreference(codex,Date.parse(at)),0);assert.equal(quotaAt100(codex,Date.parse(at)),true);
});
test('failed native refresh never promotes cached rows to a fresh authenticated sample',()=>{
  assert.equal(antigravityAuthentication({code:0,stdout:report,stderr:'Failed to refresh quotas: network error'}),'unknown');
});
