import test from 'node:test';
import assert from 'node:assert/strict';
import {antigravityAuthentication} from '../src/backend/adapters/antigravity-auth';

const quota='Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-24T07:23:28Z\nClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-21T14:24:35Z\n';
const result=(stdout=quota,code:number|null=0,stderr='')=>({stdout,code,stderr});

test('native tab-separated quota report confirms account authentication',()=>{
  assert.equal(antigravityAuthentication(result()),'account');
});
test('exhausted quota is still an authenticated account',()=>{
  assert.equal(antigravityAuthentication(result(quota.replace('99%','0%').replace('100%','0%'))),'account');
});
test('model listing and generic successful output cannot confirm authentication',()=>{
  for(const text of ['','SUCCESS','gemini-test  Gemini model','Authenticated','{"status":"SUCCESS"}'])assert.equal(antigravityAuthentication(result(text)),'unknown');
});
test('explicit missing or expired login is distinct from an unknown result',()=>{
  for(const text of ['authentication required','You are not logged into Antigravity','Please sign in','Authentication expired','登录已失效']){
    assert.equal(antigravityAuthentication(result('',1,text)),'none');
    assert.equal(antigravityAuthentication(result(text)),'none');
  }
});
test('network errors and unsuccessful exits do not imply a signed-out account',()=>{
  assert.equal(antigravityAuthentication(result('',1,'keyringAuth: token validation failed due to network error')),'unknown');
  assert.equal(antigravityAuthentication(result(quota,1,'request failed')),'unknown');
});
test('ANSI controls and report headers do not hide valid native rows',()=>{
  assert.equal(antigravityAuthentication(result('Model quotas\n\x1b[32m'+quota+'\x1b[0m')),'account');
});
test('malformed quota values and unsupported report formats stay unconfirmed',()=>{
  for(const text of [quota.replaceAll(/\d+%/g,'101%'),quota.replaceAll(/2026-[^\n]+/g,'invalid-date'),'Gemini\tRemaining\t99%\t2026-10-24T07:23:28Z'])assert.equal(antigravityAuthentication(result(text)),'unknown');
});
test('explicit auth failure is never overridden by a partial quota report',()=>{
  assert.equal(antigravityAuthentication(result(quota,0,'Authentication required')),'none');
});
