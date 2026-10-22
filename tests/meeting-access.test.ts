import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {Engine} from '../src/backend/engine';
import {DEFAULT_SETTINGS} from '../src/shared/defaults';
import {resolveRoomAccess,roomAccessInstruction} from '../src/shared/room-permissions';
import {plainRoomSpeech} from '../src/backend/adapters/chat-policy';
import {acpDenial,acpRoomReadAllowed} from '../src/backend/adapters/acp';
import {buildDshPatch,dshPermissionDenial,dshSessionPolicy} from '../src/backend/adapters/dsh';
import {codexSessionPolicy} from '../src/backend/adapters/codex';
import {claudeSessionPolicy} from '../src/backend/adapters/claude';
import {antigravityPermissions} from '../src/backend/adapters/antigravity-policy';
import {runtimeFingerprint} from '../src/backend/runtime-pool';
import {isolatedTestEnvironment} from '../scripts/test-environment.mjs';
import type {AdapterContext,Adapter,MemberProfile,Project,Run,Session} from '../src/shared/types';

const full={commands:'auto' as const,fileScope:'any' as const,network:true};
const ids=['dsh','codex','claude','acp-meeting-qwen','acp-meeting-glm','acp-meeting-gemini'] as const;
async function fixture(action?:(ctx:AdapterContext)=>Promise<void>) {
  const {directory}=isolatedTestEnvironment(process.env,process.cwd());
  const cwd=path.join(directory,'项目'),outside=path.join(directory,'other','reference.txt');
  await mkdir(cwd,{recursive:true});await mkdir(path.dirname(outside));await writeFile(outside,'outside-reference');
  const seen:AdapterContext[]=[];
  const factory=():Adapter=>({
    async probe(){return {id:'dsh',name:'fixture',available:true,runtimeReady:true,auth:'api',detail:'local fixture',checkedAt:new Date().toISOString(),capabilities:{streaming:true,write:true,history:true,cancel:'native',steer:false}} as any;},
    async start(ctx,text){seen.push(ctx);ctx.markDelivery('sent');await action?.(ctx);ctx.markDelivery('confirmed');ctx.emit('delta','fixture completed');return {summary:text};},
    async stop(){},
  });
  const engine=new Engine(path.join(directory,'data'),()=>{},()=>{},factory,{runBudgetMs:10_000,roomReplyIdleMs:5_000});
  const settings={...engine.settings,defaultAutoApprove:true,permissions:{...engine.settings.permissions,...Object.fromEntries(ids.map(id=>[id,{...full}]))}};
  engine.settings=settings;engine.store.put('settings','main',settings);
  const project:Project={id:'meeting-project',name:'会议测试',directory:cwd,createdAt:new Date().toISOString(),collaborationPaused:false};
  engine.store.put('projects',project.id,project);
  engine.store.ensureProjectRoom(project.id);
  const members=ids.map((id,index)=>({id:'member-'+index,name:id,executor:id,createdAt:project.createdAt} as MemberProfile));
  for(const m of members){
    engine.store.put('members',m.id,m);
    if(m.executor.startsWith('acp-'))engine.store.put('executors',m.executor,{id:m.executor,name:m.name,command:process.execPath,args:[],env:{},permissions:full,createdAt:project.createdAt});
  }
  const internal=engine as any,roomId='project:'+project.id;
  const session=(member=members[0])=>internal.rooms.run(roomId,()=>internal.loungeSession(member)) as Promise<Session>;
  const wait=async(id:string)=>{for(let i=0;i<400;i++){const r=engine.store.get<Run>('runs',id)!;if(!['queued','running','waiting_user'].includes(r.status))return r;await new Promise(r=>setTimeout(r,10));}throw Error('fixture run did not finish');};
  return {engine,internal,project,cwd,outside,members,seen,session,wait};
}

test('all project meeting members inherit full permissions, use the actual project, and can read/write controlled files',async()=>{
  const f=await fixture(async ctx=>{
    assert.equal(ctx.session.writeMode,true);assert.deepEqual(ctx.settings.permissions[ctx.run.provider as keyof typeof ctx.settings.permissions],full);
    assert.equal(plainRoomSpeech(ctx),false);assert.equal(await readFile(f.outside,'utf8'),'outside-reference');
    await writeFile(path.join(ctx.cwd,ctx.session.memberId+'.txt'),'actual write');
  });
  try {
    for(const member of f.members){const s=await f.session(member);assert.equal(s.workspace,f.cwd);const {runId}=await f.engine.send(s.id,'检查文件并完成工作') as {runId:string};const r=await f.wait(runId);assert.equal(r.status,'ended',r.error??'');assert.equal(r.roomAccess?.mode,'collaborate');assert.match(f.seen.at(-1)!.run.input,/检查文件/);assert.equal(await readFile(path.join(f.cwd,member.id+'.txt'),'utf8'),'actual write');}
    assert.equal(f.seen.length,6);
  } finally {await f.engine.close();}
});

test('switching a room affects the next turn, retires native permissions, and retains historical receipts',async()=>{
  let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const f=await fixture(async()=>{entered();await gate;});
  try {
    const first=await f.session();const {runId}=await f.engine.send(first.id,'work') as {runId:string};await ready;
    await f.engine.invoke('project.update',{projectId:f.project.id,meetingMode:'read-only'});
    assert.equal(f.seen[0].session.writeMode,true);assert.equal(f.seen[0].run.roomAccess?.permissions.commands,'auto');
    release();assert.equal((await f.wait(runId)).status,'ended');
    const next=await f.session();assert.notEqual(next.id,first.id);assert.equal(next.nativeId,undefined);assert.equal(next.writeMode,false);
    assert.ok(f.engine.store.get<Session>('sessions',first.id)?.roomRetiredAt);
    const r=await f.engine.send(next.id,'read only') as {runId:string};await f.wait(r.runId);
    assert.equal(f.seen[1].session.writeMode,false);assert.equal(f.seen[1].settings.permissions.dsh.commands,'deny');assert.equal(f.seen[1].settings.permissions.dsh.fileScope,'any');
    const before=f.seen[0],after=f.seen[1];assert.notEqual(runtimeFingerprint(before),runtimeFingerprint(after));
    assert.equal(f.engine.store.get<Run>('runs',runId)?.roomAccess?.mode,'collaborate');
    const thread=f.internal.rooms.get('project:'+f.project.id).store.currentRoomThread();
    const message={id:'receipt',threadId:thread.id,runId,author:f.members[0].id,text:'result',at:new Date().toISOString(),status:'done'} as const;
    f.engine.store.put('room_messages',message.id,message);f.engine.store.delete('runs',runId);f.engine.store.put('room_messages',message.id,message);
    assert.equal(f.engine.store.get<any>('room_messages',message.id).roomAccess.mode,'collaborate');
    const stale=f.engine.store.get<any>('room_messages',message.id);
    f.engine.store.put('room_messages',message.id,{...stale,runId:'other-run-without-receipt'});
    assert.equal(f.engine.store.get<any>('room_messages',message.id).roomAccess,undefined,'a different run never inherits an old permission receipt');
    assert.equal(f.engine.store.get<Session>('sessions',first.id)?.writeMode,true);
  } finally {release?.();await f.engine.close();}
});

test('read-only mode and strict command approval survive adapter mapping; ordinary tea speech stays separate',async()=>{
  const f=await fixture();
  try {
    const access=resolveRoomAccess('read-only',f.cwd,full,true);
    const ctx={run:{provider:'dsh',roomAccess:access},session:{writeMode:access.writeMode},conversation:'room',cwd:f.cwd,roomProjectDirectory:f.cwd,settings:{...DEFAULT_SETTINGS,permissions:{...DEFAULT_SETTINGS.permissions,dsh:access.permissions}}} as AdapterContext;
    assert.equal(access.autoApprove,false);assert.match(roomAccessInstruction(access),/只读讨论/);
    assert.equal(acpDenial('execute',access.permissions,false),'这个会话是只读的，不允许修改文件或执行命令');assert.equal(acpRoomReadAllowed('read',{file_path:f.outside},ctx),true);
    assert.ok(dshPermissionDenial('write',{file_path:path.join(f.cwd,'x')},dshSessionPolicy(access.permissions,false),f.cwd));
    const patch:any[]=buildDshPatch(ctx.settings,f.cwd,false,path.join(f.cwd,'guard.mjs'));assert.equal(patch.find(p=>p.id==='sandbox-policy').config.mode,'read-only');
    assert.equal(codexSessionPolicy(access.permissions,false).sandbox,'read-only');assert.ok(!claudeSessionPolicy(access.permissions,false).tools.includes('Bash'));
    const agy={id:'acp-agy',permissions:full} as any;ctx.run.provider=agy.id;ctx.settings.permissions[agy.id]=access.permissions;
    const ap=antigravityPermissions(ctx,agy);assert.ok(ap.permissions.deny.includes('write_file(*)'));assert.ok(ap.permissions.deny.includes('command(*)'));assert.equal(ap.allowNonWorkspaceAccess,true);
    const strict=resolveRoomAccess('collaborate',f.cwd,{...full,commands:'ask'},true);assert.equal(strict.permissions.commands,'ask');assert.equal(strict.autoApprove,false);
    const workspace=resolveRoomAccess('read-only',f.cwd,{...full,fileScope:'workspace'});ctx.run.provider='dsh';ctx.run.roomAccess=workspace;ctx.settings.permissions.dsh=workspace.permissions;
    assert.equal(acpRoomReadAllowed('read',{file_path:f.outside},ctx),false);
    assert.equal(acpRoomReadAllowed('read',{unknownPath:f.outside},ctx),false);
    assert.equal(acpRoomReadAllowed('search',{pattern:'../reference/*'},ctx),false);
    assert.equal(acpRoomReadAllowed('read',{path:f.cwd},ctx),true);
    for(const purpose of ['room-hand','room-minutes','room-image'] as const){
      const auxiliary=await f.internal.rooms.run('project:'+f.project.id,()=>f.internal.loungeSession(f.members[0],purpose));
      assert.equal(auxiliary.writeMode,false);assert.equal(auxiliary.autoApprove,false);
    }
    await assert.rejects(()=>f.engine.invoke('project.update',{projectId:f.project.id,meetingMode:'invented'}),/只读讨论/);
    const tea={...ctx,run:{...ctx.run,roomAccess:undefined},roomProjectDirectory:undefined};assert.equal(plainRoomSpeech(tea),true);
  } finally {await f.engine.close();}
});
