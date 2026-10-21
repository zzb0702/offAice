// Explicit opt-in verification of the currently configured native CLI; no model prompt or profile writes.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {AntigravityAdapter,antigravityCommand} from '../src/backend/adapters/antigravity.ts';
import {antigravityEnvironment} from '../src/backend/adapters/antigravity-policy.ts';
import {collectCommand} from '../src/backend/adapters/common.ts';
import {buildEnvironment} from '../src/backend/security.ts';
import {quotaReport} from '../src/shared/quota.ts';

if(process.env.AIROOM_VERIFY_NATIVE_QUOTA!=='1')throw Error('Native account verification requires explicit opt-in.');
const db=new DatabaseSync(path.resolve('.airoom/airoom.sqlite'),{readOnly:true});
const executors=db.prepare("SELECT value FROM entities WHERE entity='executors'").all().map(x=>JSON.parse(x.value));
const settings=JSON.parse(db.prepare("SELECT value FROM entities WHERE entity='settings' AND id='main'").get().value);db.close();
const executor=executors.find(x=>x.adapter==='antigravity');assert.ok(executor);
const base={...buildEnvironment(settings),AIROOM_ACP_HOME:path.resolve('.airoom/native/acp')};
const {home,env}=antigravityEnvironment(executor,base);
const version=await collectCommand(antigravityCommand(executor,env),['--version'],env,home,20_000);
const result=await new AntigravityAdapter(executor).accountQuota(settings,base);
const quota=quotaReport(executor.id,result.payload,result.checkedAt,'probe');
assert.equal(result.auth,'account');assert.equal(quota?.queryStatus,'ready');assert.ok(quota.windows.length);
assert.ok(quota.windows.every(x=>x.usedPercent>=0&&x.usedPercent<=100&&x.resetsAt>0));
const report={passed:true,version:version.stdout.trim(),auth:result.auth,queryStatus:quota.queryStatus,groups:quota.windows.map(x=>x.label),checkedAt:result.checkedAt,inferenceMessages:0,checks:['actual selected native CLI account quota parsed','model-group labels retained with native period','percentages and reset timestamps validated','account identifiers, actual quota values and tokens omitted from report']};
await mkdir('tests/results',{recursive:true});await writeFile('tests/results/antigravity-quota-native.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
