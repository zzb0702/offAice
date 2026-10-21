import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {cacheHitRate, nativeTokenUsage, DshTokenUsage, TokenUsageTracker, formatTokens, type TokenUsage} from '../src/shared/token-usage';
import {dshUsageEvent, DSH_GUARD_SOURCE, DshAdapter} from '../src/backend/adapters/dsh';
import {MessageTokenUsage} from '../src/renderer/token-usage';
import {Engine} from '../src/backend/engine';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {runSummary} from '../src/shared/run-summary';
import {CodexAdapter} from '../src/backend/adapters/codex';

const codex=(inputTokens=1000,cachedInputTokens=750,outputTokens=200)=>nativeTokenUsage('codex',{tokenUsage:{total:{inputTokens,cachedInputTokens,outputTokens},last:{inputTokens:1,cachedInputTokens:0,outputTokens:1}}})!;

test('native schemas keep total input and cached input distinct, ignore context/quota',()=>{
  assert.equal(cacheHitRate(codex()),75);
  assert.equal(cacheHitRate(nativeTokenUsage('zcode',{inputTokens:1000,cacheReadTokens:750,cacheWriteTokens:0,outputTokens:200})),75);
  assert.equal(cacheHitRate(nativeTokenUsage('antigravity',{input_tokens:1000,cache_read_tokens:750,output_tokens:200})),75);
  assert.equal(nativeTokenUsage('dsh',{sessionUpdate:'usage_update',used:750,size:1000}),undefined);
  assert.equal(nativeTokenUsage('codex',{rateLimits:{usedPercent:50}}),undefined);
  assert.equal(nativeTokenUsage('zcode',{response:JSON.stringify({inputTokens:1000,cacheReadTokens:750})}),undefined);
});

test('DSH denominator includes cached input exactly once, missing writes require an exact total',()=>{
  const report=nativeTokenUsage('dsh',{inputTokens:250,cacheReadTokens:750,totalTokens:1200,outputTokens:200})!;
  assert.equal(report.inputTokens,1000);assert.equal(cacheHitRate(report),75);
  assert.equal(cacheHitRate(nativeTokenUsage('dsh',{inputTokens:200,cacheReadTokens:750,cacheWriteTokens:50,outputTokens:200})),75);
  assert.equal(cacheHitRate(nativeTokenUsage('dsh',{inputTokens:250,cacheReadTokens:750,outputTokens:200})),undefined);
  assert.equal(nativeTokenUsage('dsh',{inputTokens:250,cacheReadTokens:750,cacheWriteTokens:50,totalTokens:1200,outputTokens:200})?.status,'inconsistent');
  const claude=nativeTokenUsage('claude',{usage:{input_tokens:200,cache_read_input_tokens:750,cache_creation_input_tokens:50,output_tokens:200}})!;
  assert.equal(claude.inputTokens,1000);assert.equal(cacheHitRate(claude),75);
});

test('missing, explicit zero and invalid counters never collapse to the same percentage',()=>{
  assert.equal(cacheHitRate(codex(1000,0)),0);
  assert.equal(cacheHitRate(codex(0,0,0)),undefined);
  for(const value of [-1,NaN,Infinity,1.5,'50',true,Number.MAX_SAFE_INTEGER+1]){
    const report=nativeTokenUsage('zcode',{inputTokens:100,cacheReadTokens:value});
    assert.equal(report?.status,'inconsistent');assert.equal(cacheHitRate(report),undefined);
  }
  assert.equal(cacheHitRate(nativeTokenUsage('zcode',{inputTokens:100})),undefined);
  assert.equal(cacheHitRate(nativeTokenUsage('zcode',{inputTokens:100,cacheReadTokens:110})),undefined);
  assert.equal(cacheHitRate(nativeTokenUsage('zcode',{inputTokens:100,cacheReadTokens:90,cacheWriteTokens:20})),undefined);
});

test('DSH multiple requests, duplicate receipts, partial reports and overflow',()=>{
  const tracker=new DshTokenUsage(),row={inputTokens:250,cacheReadTokens:750,outputTokens:200,totalTokens:1200};
  assert.equal(tracker.add(1,row)?.requests,1);
  assert.equal(tracker.add(1,row)?.requests,1);
  const combined=tracker.add(2,{...row,cacheReadTokens:250,inputTokens:750})!;
  assert.equal(combined.inputTokens,2000);assert.equal(combined.cacheReadTokens,1000);assert.equal(cacheHitRate(combined),50);
  assert.equal(tracker.add(3,{inputTokens:100,outputTokens:50,totalTokens:150})?.cacheReadTokens,undefined);
  assert.equal(cacheHitRate(tracker.add(4,{inputTokens:100,cacheReadTokens:-1,outputTokens:50,totalTokens:150})),undefined);
  const overflow=new DshTokenUsage();overflow.add(1,{inputTokens:Number.MAX_SAFE_INTEGER,cacheReadTokens:0,cacheWriteTokens:0});
  assert.equal(overflow.add(2,{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0})?.status,'inconsistent');
});

test('new sessions and cumulative notifications use a single fixed baseline per turn',()=>{
  const first=new TokenUsageTracker();assert.equal(first.record(codex(),'native-1').usage.scope,'turn');
  const prior=first.record(codex(),'native-1').checkpoint;
  const next=new TokenUsageTracker('native-1',prior);
  assert.equal(next.record(codex(1500,1000,300),'native-1').usage.inputTokens,500);
  const latest=next.record(codex(2000,1250,400),'native-1').usage;
  assert.equal(latest.inputTokens,1000);assert.equal(latest.cacheReadTokens,500);assert.equal(latest.outputTokens,200);assert.equal(cacheHitRate(latest),50);
  assert.deepEqual(next.record(codex(2000,1250,400),'native-1').usage,latest);
});

test('legacy sessions, native resets and missing counters keep their scope and uncertainty',()=>{
  const legacy=new TokenUsageTracker('old');assert.equal(legacy.record(codex(),'old').usage.scope,'session');
  const checkpoint={nativeId:'old',usage:codex()},reset=new TokenUsageTracker('old',checkpoint);
  assert.equal(reset.record(codex(100,50,20),'old').usage.scope,'session');
  assert.equal(reset.record(codex(2000,1000,400),'old').usage.scope,'session','a reset cannot later silently reuse the old baseline');
  assert.equal(new TokenUsageTracker('old',checkpoint).record(codex(),'new').usage.scope,'turn');
  const partial=new TokenUsageTracker('old',{nativeId:'old',usage:{source:'codex',scope:'session',status:'partial',inputTokens:1000,outputTokens:200}});
  assert.equal(cacheHitRate(partial.record(codex(2000,1250,400),'old').usage),undefined);
});

test('Token formatting and reply footer preserve zero/missing, K/M and session labels',()=>{
  for(const [input,expected] of [[0,'0K'],[1,'0.001K'],[800,'0.8K'],[999,'0.999K'],[1000,'1.0K'],[12400,'12.4K'],[999949,'999.9K'],[999950,'1.0M'],[1250000,'1.3M']] as const)assert.equal(formatTokens(input),expected);
  assert.equal(formatTokens(undefined),'未提供');
  const html=renderToStaticMarkup(createElement(MessageTokenUsage,{usage:codex(1250000,1000000,12400)}));
  assert.match(html,/1.3M/);assert.match(html,/12.4K/);assert.match(html,/80.0%/);assert.match(html,/会话累计/);
  assert.match(renderToStaticMarkup(createElement(MessageTokenUsage,{speaking:true})),/待回报/);
  assert.match(renderToStaticMarkup(createElement(MessageTokenUsage,{})),/未提供/);
});

test('DSH bridge whitelists numeric metadata, gates idle/wrong turns, deduplicates and serializes standalone',async()=>{
  const session={header:{id:'native'}};
  const event={type:'assistant/message',seq:5,data:{turn:2,usage:{inputTokens:25,outputTokens:10,cacheReadTokens:75,totalTokens:110,apiKey:'never-copy'},message:{text:'never-copy'}}};
  const receipt=dshUsageEvent(session,event)!;
  assert.equal(JSON.stringify(receipt).includes('never-copy'),false);
  assert.equal(dshUsageEvent(session,{...event,type:'tool/result'}),undefined);
  // The serialized function in the actual Cordis plugin must remain self-contained.
  const plugin=await import('data:text/javascript;base64,'+Buffer.from(DSH_GUARD_SOURCE).toString('base64'));
  const callbacks=new Map<string,Function>(),lines:string[]=[];
  plugin.apply({on:(name:string,fn:Function)=>callbacks.set(name,fn),tools:{guard:()=>{}},agents:{},systemPrompt:{section:()=>{}}},{commands:'deny',workspaceRoot:process.cwd()});
  const original=process.stdout.write;process.stdout.write=((text:string)=>{lines.push(text);return true;}) as any;
  try{callbacks.get('session/event')!(session,event);}finally{process.stdout.write=original;}
  const packet=JSON.parse(lines[0]);assert.equal(packet.method,'airoom/tokenUsage');
  const reports:TokenUsage[]=[],adapter=new DshAdapter() as any;
  adapter.sessionId='native';adapter.nativeTurn=2;adapter.context={recordTokenUsage:(usage:TokenUsage)=>reports.push(usage)};
  await adapter.incoming(packet);assert.equal(reports.length,0);
  adapter.promptSent=true;await adapter.incoming({...packet,params:{...packet.params,turn:1}});assert.equal(reports.length,0);
  await adapter.incoming(packet);await adapter.incoming(packet);assert.equal(reports.at(-1)?.inputTokens,100);assert.equal(reports.at(-1)?.requests,1);
});

test('Codex only records the active thread and turn; quotas and old notifications cannot overwrite token usage',()=>{
  const adapter=new CodexAdapter() as any,reports:TokenUsage[]=[];
  adapter.context={emit:()=>{},recordTokenUsage:(usage:TokenUsage)=>reports.push(usage)};adapter.finished=false;adapter.threadId='thread';adapter.turnId='turn';adapter.delivered=true;
  const report={threadId:'thread',turnId:'turn',tokenUsage:{total:{inputTokens:1000,cachedInputTokens:750,outputTokens:200}}};
  adapter.notification('thread/tokenUsage/updated',{...report,threadId:'other'});
  adapter.notification('thread/tokenUsage/updated',{...report,turnId:'old'});
  adapter.notification('thread/tokenUsage/updated',{tokenUsage:report.tokenUsage});
  assert.equal(reports.length,0);
  adapter.notification('thread/tokenUsage/updated',report);assert.equal(reports.length,1);assert.equal(cacheHitRate(reports[0]),75);
  adapter.notification('account/rateLimits/updated',{usedPercent:100});assert.equal(reports.length,1);
  adapter.finished=true;adapter.notification('thread/tokenUsage/updated',report);assert.equal(reports.length,1);
});

test('engine persists per-reply usage, historical message fallback and checkpoints without account data',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'airoom-token-test-'));
  const engine=new Engine(root,()=>{},()=>{},undefined,{maintenanceOnly:true}) as any;
  try{
    const store=engine.store,at=new Date().toISOString(),member={id:'test-codex',executor:'codex',name:'Codex',createdAt:at};
    store.put('members',member.id,member);store.put('settings','main',{...DEFAULT_SETTINGS});
    store.put('projects','project',{id:'project',name:'Test',directory:root,createdAt:at,updatedAt:at});
    let session:any={id:'session',projectId:'project',provider:'codex',memberId:member.id,title:'Test',createdAt:at,updatedAt:at,revision:0,writeMode:false};
    const putRun=(id:string)=>{const run={id,sessionId:session.id,projectId:'project',provider:'codex',revision:0,status:'running',input:'test',createdAt:at,updatedAt:at,bootId:'test',delivery:'sent'};store.put('runs',id,run);store.put('room_messages',id,{id,runId:id,author:member.id,text:'Reply',at,status:'done'});return run;};
    store.put('sessions',session.id,session);let run=putRun('first'),ctx=engine.context(run,session);engine.active.set(run.id,{ctx,children:[]});
    ctx.persistNativeSession('native');ctx.recordTokenUsage(codex(),'native');
    assert.equal(store.get('runs',run.id).tokenUsage.inputTokens,1000);assert.equal(store.get('room_messages',run.id).tokenUsage.inputTokens,1000);
    assert.equal(runSummary(store.get('runs',run.id)).tokenUsage?.inputTokens,1000);
    store.put('room_messages','first',{id:'first',runId:'first',author:member.id,text:'Completed from an earlier copy',at,status:'done'});
    assert.equal(store.get('room_messages','first').tokenUsage.inputTokens,1000,'a stale completion copy cannot erase the receipt');
    session=store.get('sessions',session.id);engine.active.clear();run=putRun('second');ctx=engine.context(run,session);engine.active.set(run.id,{ctx,children:[]});
    ctx.recordTokenUsage(codex(2000,1250,400),'native');assert.equal(store.get('runs',run.id).tokenUsage.inputTokens,1000);
    assert.equal(cacheHitRate(store.get('room_messages',run.id).tokenUsage),50);
    engine.active.clear();ctx.recordTokenUsage(codex(3000,2000,600),'native');assert.equal(store.get('runs',run.id).tokenUsage.inputTokens,1000,'late data cannot update a finished run');
    store.delete('runs','first');assert.equal(store.get('room_messages','first').tokenUsage.inputTokens,1000);
    store.put('room_messages','first',{...store.get('room_messages','first'),runId:'correction'});
    assert.equal(store.get('room_messages','first').tokenUsage,undefined,'a correction does not inherit the earlier attempt usage');
  }finally{await engine.close();}
});
