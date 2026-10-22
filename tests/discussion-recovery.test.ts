import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {Store} from '../src/backend/store';
import {scopedRoomStore} from '../src/backend/room-store';
import {RoomDiscussionController} from '../src/backend/room-discussion';
import {discussionMemberRecovery,discussionRecoveryHint,parseDiscussionReply} from '../src/shared/discussion';
import type {RoomDiscussion} from '../src/shared/discussion';
import type {MemberProfile} from '../src/shared/types';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';

type Host=ConstructorParameters<typeof RoomDiscussionController>[1];
type Reply=Awaited<ReturnType<Host['turn']>>;
type Context={version:1;turn:string;revision:number;you:string};
const valid=(context:Context,action='speak'):Reply=>({status:'done',text:JSON.stringify({...context,action,body:action==='pass'?'':'已核实当前消息。'})});
const ambiguous=(context:Context):Reply=>({status:'done',text:valid(context).text+'\n'+valid(context).text});

function fixture(count=2) {
  const {directory}=isolatedTestEnvironment(process.env,process.cwd());
  const data=path.join(directory,'discussion');
  let root=new Store(data),store=scopedRoomStore(root,'global');
  const members=Array.from({length:count},(_,i)=>({id:'recovery-'+i,name:'成员'+i,executor:'codex',createdAt:new Date().toISOString()} as MemberProfile));
  for(const member of members)store.put('members',member.id,member);
  const calls:{member:string;prompt:string;context:Context;runId:string}[]=[];
  let busy=false,pending=Promise.resolve(),respond:(member:string,context:Context)=>Reply=(_id,context)=>valid(context);
  const host:Host={alive:()=>true,busy:()=>busy,changed:()=>{},random:()=>0,
    launch(flow){busy=true;pending=Promise.resolve().then(flow).finally(()=>{busy=false;});},
    async turn(member,prompt,onRun){
      assert.ok(calls.length<100,'unexpected unbounded room calls');
      const context=JSON.parse(prompt.slice(prompt.lastIndexOf('AIROOM_CONTEXT\n')+'AIROOM_CONTEXT\n'.length)) as Context;
      const runId='local-run-'+calls.length;
      calls.push({member:member.id,prompt,context,runId});onRun(runId);
      return respond(member.id,context);
    },async interrupt(){},
  };
  let controller=new RoomDiscussionController(store,host);
  return {
    members,calls,get store(){return store;},get controller(){return controller;},
    state:()=>store.roomState().discussion!,
    respond(fn:typeof respond){respond=fn;},
    async input(text='下一条消息',extra:Record<string,unknown>={}){await controller.input({text,memberIds:members.map(m=>m.id),style:'work',...extra});await pending;},
    async drain(){await pending;},
    restart(){assert.equal(busy,false);root.close();root=new Store(data);store=scopedRoomStore(root,'global');controller=new RoomDiscussionController(store,host);},
    close(){root.close();},
  };
}

test('one ambiguous reply skips only this human round, leaves peers running and recovers on the next message',async()=>{
  const f=fixture(),[a,b]=f.members.map(m=>m.id);
  try {
    f.respond((id,c)=>id===a?ambiguous(c):valid(c));
    await f.input('第一条问题');
    assert.deepEqual(f.calls.map(c=>c.member),[a,b]);
    assert.equal(f.state().phase,'waiting_user');
    assert.equal(f.state().memberFailures?.[a],1);
    assert.equal(discussionMemberRecovery(f.state(),a),'next-message');
    const failed=f.store.allRoomMessages(f.store.currentRoomThread().id).find(m=>m.author===a)!;
    assert.equal(failed.status,'failed');assert.match(failed.error!,/多个对象/);
    assert.match(discussionRecoveryHint(f.state(),a),/下一次发消息/);
    f.controller.wake();await f.drain();assert.equal(f.calls.length,2,'no background retry');
    f.respond((_id,c)=>valid(c));await f.input('新问题');
    assert.deepEqual(f.calls.map(c=>c.member),[a,b,a,b]);
    assert.equal(f.state().skippedMembers,undefined);assert.equal(f.state().memberFailures?.[a],undefined);
    assert.notEqual(f.calls[0].context.turn,f.calls[2].context.turn);
    assert.match(f.calls[2].prompt,/先核实实际状态，避免重复修改/);
    assert.equal(f.store.get<any>('room_messages',failed.id)?.status,'failed','retain failed history');
  } finally {f.close();}
});

test('a blocked single-member room can recover; three consecutive failures require manual rejoin',async()=>{
  const f=fixture(1),id=f.members[0].id;
  try {
    f.respond((_id,c)=>ambiguous(c));
    for(let i=1;i<=3;i++){await f.input('问题'+i);assert.equal(f.calls.length,i);assert.equal(f.state().memberFailures?.[id],i);assert.equal(f.state().phase,'blocked');}
    assert.equal(discussionMemberRecovery(f.state(),id),'repeated');
    await f.input('第四条问题');assert.equal(f.calls.length,3);
    assert.match(discussionRecoveryHint(f.state(),id),/连续 3 次失败/);
    f.respond((_id,c)=>valid(c));f.controller.resume({});await f.drain();
    assert.equal(f.calls.length,4);assert.equal(f.state().skippedMembers,undefined);assert.equal(f.state().memberFailures,undefined);
  } finally {f.close();}
});

test('unknown and limited members stay isolated while a confirmed ordinary failure recovers',async()=>{
  const f=fixture(3),[a,b,c]=f.members.map(m=>m.id);
  try {
    f.respond((id,ctx)=>id===a?{status:'failed',text:'',error:'结果待核对',unknown:true}:id===b?{status:'failed',text:'',error:'额度不足',limited:true}:ambiguous(ctx));
    await f.input();assert.deepEqual(f.calls.map(call=>call.member),[a,b,c]);
    f.respond((_id,ctx)=>valid(ctx));await f.input('继续新问题');
    assert.deepEqual(f.calls.map(call=>call.member),[a,b,c,c]);
    assert.equal(discussionMemberRecovery(f.state(),a),'unknown');assert.equal(discussionMemberRecovery(f.state(),b),'limited');
    assert.throws(()=>f.controller.resume({}),/结果未知/);
    f.controller.resume({acknowledgeUnknown:true});await f.drain();
    assert.deepEqual(f.calls.map(call=>call.member),[a,b,c,c,a,b]);
    assert.equal(f.state().unknownRunIds,undefined);
  } finally {f.close();}
});

test('temporary skips survive restart, recover for a new message and do not count nonconsecutive failures',async()=>{
  const f=fixture(1),id=f.members[0].id;
  try {
    f.respond((_id,c)=>ambiguous(c));await f.input();f.restart();
    assert.equal(f.state().memberFailures?.[id],1);
    f.respond((_id,c)=>valid(c));await f.input('重启后新问题');
    assert.equal(f.calls.length,2);assert.equal(f.state().memberFailures,undefined);
    f.respond((_id,c)=>ambiguous(c));await f.input('再次偶发');
    assert.equal(f.state().memberFailures?.[id],1);assert.equal(discussionMemberRecovery(f.state(),id),'next-message');
  } finally {f.close();}
});

test('legacy skips without a streak recover, but unknown run correlation remains protected',async()=>{
  const f=fixture(1),id=f.members[0].id;
  try {
    f.respond((_id,c)=>ambiguous(c));await f.input();
    const legacy:RoomDiscussion={...f.state(),memberFailures:undefined};
    f.store.put('room','state',{...f.store.roomState(),discussion:legacy});
    f.respond((_id,c)=>valid(c));await f.input();assert.equal(f.calls.length,2);
    const guarded:RoomDiscussion={...legacy,unknownRunId:legacy.skippedMembers![id].runId};
    assert.equal(discussionMemberRecovery(guarded,id),'unknown');
  } finally {f.close();}
});

test('chat members recover for new human input without retries during peer conversation',async()=>{
  const f=fixture(),[a,b]=f.members.map(m=>m.id);
  try {
    f.respond((id,c)=>id===a?ambiguous(c):valid(c,'pass'));
    await f.input('闲聊问题',{style:'chat'});
    assert.deepEqual(f.calls.map(call=>call.member),[a,b]);assert.equal(f.state().phase,'idle');
    f.respond((_id,c)=>valid(c,'pass'));await f.input('新的闲聊',{style:'chat'});
    assert.deepEqual(f.calls.map(call=>call.member),[a,b,a,b]);assert.equal(f.state().skippedMembers,undefined);
  } finally {f.close();}
});

test('a new mention respects the addressed members; pause commands do not release skipped members',async()=>{
  const f=fixture(),[a,b]=f.members.map(m=>m.id);
  try {
    f.respond((id,c)=>id===a?ambiguous(c):valid(c));await f.input();
    await f.input('暂停讨论');assert.equal(f.state().skippedMembers?.[a]?.unknown,false);assert.equal(f.calls.length,2);
    f.respond((_id,c)=>valid(c));await f.input('@成员1 仅回答新问题');
    assert.deepEqual(f.calls.map(call=>call.member),[a,b,b]);
    await f.input('@成员0 请回答新问题');assert.deepEqual(f.calls.map(call=>call.member),[a,b,b,a]);
  } finally {f.close();}
});

test('the unique-object, unique-field and turn validation guards are unchanged',()=>{
  const context:Context={version:1,turn:'current',revision:7,you:'member'};
  assert.throws(()=>parseDiscussionReply(ambiguous(context).text,'current',7),/多个对象/);
  assert.throws(()=>parseDiscussionReply(valid({...context,turn:'old'}).text,'current',7),/当前轮次不符/);
  const duplicate=valid(context).text.replace('"turn":"current"','"turn":"old","turn":"current"');
  assert.throws(()=>parseDiscussionReply(duplicate,'current',7),/重复或不明确/);
});

test('one failed turn with a format correction counts once, and input never clears an unresolved request',async()=>{
  const f=fixture(1),id=f.members[0].id;
  try {
    f.respond(()=>({status:'done',text:'{'}));await f.input();
    assert.equal(f.calls.length,2,'existing single format correction remains bounded');
    assert.equal(f.state().memberFailures?.[id],1);
    const unknown={...f.state(),unknownRunId:f.calls[1].runId};
    f.store.put('room','state',{...f.store.roomState(),discussion:unknown});
    f.respond((_id,c)=>valid(c));await f.input('新的问题');
    assert.equal(f.calls.length,2);assert.equal(discussionMemberRecovery(f.state(),id),'unknown');
  } finally {f.close();}
});

test('a paused legacy unknown request without a member receipt stays paused on new input',async()=>{
  const f=fixture(1);
  try {
    await f.input();const before=f.calls.length;
    f.store.put('room','state',{...f.store.roomState(),discussion:{...f.state(),phase:'paused',unknownRunId:'orphaned-unknown',skippedMembers:undefined}});
    await f.input('新的问题');
    assert.equal(f.calls.length,before);assert.equal(f.state().phase,'paused');
  } finally {f.close();}
});
