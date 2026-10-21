import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {antigravityEnvironment,antigravityArguments,antigravityPermissions,withAntigravityPolicy} from '../src/backend/adapters/antigravity-policy';
import {DEFAULT_SETTINGS,normalizeExecutor} from '../src/shared/defaults';
import {connectionLabel} from '../src/shared/executor-connection';
import type {AcpExecutor,AdapterContext,MemberPermissions} from '../src/shared/types';

const id='acp-agytest00' as const;
function executor():AcpExecutor{return {id,name:'Antigravity',adapter:'antigravity',command:process.execPath,args:[],env:{},permissions:{commands:'ask',fileScope:'workspace',network:true},createdAt:'2026-10-20'};}
function context(permissions:MemberPermissions={commands:'ask',fileScope:'workspace',network:true},writeMode=false):AdapterContext{
  return {run:{provider:id},session:{writeMode},cwd:path.resolve('test-project'),settings:{...DEFAULT_SETTINGS,models:{[id]:'gemini-test'},efforts:{[id]:'high'},permissions:{...DEFAULT_SETTINGS.permissions,[id]:permissions}}} as unknown as AdapterContext;
}

test('native environment isolates all account homes and clears host credentials',()=>{
  const root=path.resolve('test-native-root');
  const {home,env}=antigravityEnvironment(executor(),{AIROOM_ACP_HOME:root,USERPROFILE:'original',HOME:'original',ANTIGRAVITY_CSRF_TOKEN:'secret',AGY_ACCOUNT:'host',GOOGLE_APPLICATION_CREDENTIALS:'host.json',CODEX_HOME:'host',CLAUDECODE:'1',PATH:'system'});
  assert.equal(home,path.join(root,id));assert.equal(env.USERPROFILE,home);assert.equal(env.HOME,home);assert.equal(env.PATH,'system');
  for(const key of ['ANTIGRAVITY_CSRF_TOKEN','AGY_ACCOUNT','GOOGLE_APPLICATION_CREDENTIALS','CODEX_HOME','CLAUDECODE'])assert.equal(env[key],undefined);
  assert.throws(()=>antigravityEnvironment({...executor(),env:{USERPROFILE:'outside'}},{AIROOM_ACP_HOME:root}),/不能覆盖/);
  assert.throws(()=>antigravityEnvironment({...executor(),args:['--dangerously-skip-permissions']},{AIROOM_ACP_HOME:root}),/无需启动参数/);
  assert.throws(()=>antigravityEnvironment(executor(),{AIROOM_ACP_HOME:'relative'}),/独立账号目录/);
});

test('readonly sessions deny writing and commands even under automatic member permissions',()=>{
  const policy=antigravityPermissions(context({commands:'auto',fileScope:'any',network:false}),executor());
  assert.ok(policy.permissions.deny.includes('write_file(*)'));
  assert.ok(policy.permissions.deny.includes('command(*)'));
  assert.ok(policy.permissions.deny.includes('read_url(*)'));
  assert.ok(policy.permissions.deny.includes('mcp(*)'));
  assert.ok(policy.permissions.deny.includes('unsandboxed(*)'));
  assert.equal(policy.toolPermission,'request-review');assert.equal(policy.enableTerminalSandbox,true);
});

test('room speech is tool-free; project-room speech reads the bound project without writing',()=>{
  const ctx=context();ctx.conversation='room';
  let policy=antigravityPermissions(ctx,executor());assert.ok(policy.permissions.deny.includes('read_file(*)'));
  ctx.roomProjectDirectory=path.resolve('real-project');policy=antigravityPermissions(ctx,executor());
  assert.ok(!policy.permissions.deny.includes('read_file(*)'));assert.ok(policy.permissions.deny.includes('write_file(*)'));assert.equal(policy.allowNonWorkspaceAccess,false);
  assert.deepEqual(antigravityArguments(ctx).slice(-2),['--add-dir',ctx.roomProjectDirectory]);
});

test('write, network and ask controls remain separate and do not introduce skip flags',()=>{
  const ctx=context({commands:'ask',fileScope:'workspace',network:true},true);
  const policy=antigravityPermissions(ctx,executor());
  assert.deepEqual(policy.permissions.ask,['command(*)']);assert.ok(policy.permissions.allow.some(value=>value.startsWith('write_file(')));
  assert.ok(policy.permissions.allow.includes('read_url(*)'));
  const args=antigravityArguments(ctx);assert.ok(args.includes('--sandbox'));assert.ok(!args.includes('--dangerously-skip-permissions'));assert.ok(!args.includes('--continue'));assert.ok(!args.includes('-p'));
  ctx.session.nativeId='conversation-1';assert.deepEqual(antigravityArguments(ctx).slice(-2),['--conversation','conversation-1']);
  ctx.settings.efforts[id]='invented';assert.throws(()=>antigravityArguments(ctx),/思考程度/);
});

test('policy serialization restores existing private preferences on success and failure',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'airoom-agy-policy-')),file=path.join(home,'.gemini','antigravity-cli','settings.json');
  await mkdir(path.dirname(file),{recursive:true});const original='{"model":"user-default","other":true}\n';await writeFile(file,original);
  const first=await withAntigravityPolicy(home,context(),executor(),async()=>{const active=JSON.parse(await readFile(file,'utf8'));assert.equal(active.model,'user-default');assert.ok(active.permissions.deny.includes('write_file(*)'));return 7;});
  assert.equal(first,7);assert.equal(await readFile(file,'utf8'),original);
  await assert.rejects(withAntigravityPolicy(home,context(),executor(),async()=>{throw new Error('task failed');}),/task failed/);
  assert.equal(await readFile(file,'utf8'),original);
});

test('one private settings file cannot be overwritten by a second concurrent run',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'airoom-agy-serialized-'));let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});const order:string[]=[];
  const a=withAntigravityPolicy(home,context(),executor(),async()=>{order.push('first');entered();await gate;order.push('first-end');});await ready;
  const b=withAntigravityPolicy(home,context(),executor(),async()=>{order.push('second');});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(order,['first']);release();await Promise.all([a,b]);assert.deepEqual(order,['first','first-end','second']);
});

test('policy cleanup preserves changed or deleted settings and releases its lock',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'airoom-agy-changed-')),file=path.join(home,'.gemini','antigravity-cli','settings.json');
  const changed='{"nativePreference":"changed during task"}';
  await withAntigravityPolicy(home,context(),executor(),async()=>{await writeFile(file,changed);});
  assert.equal(await readFile(file,'utf8'),changed);
  assert.equal(await withAntigravityPolicy(home,context(),executor(),async()=>{await unlink(file);return 9;}),9);
  await assert.rejects(readFile(file,'utf8'),{code:'ENOENT'});
  await assert.rejects(withAntigravityPolicy(home,context(),executor(),async()=>{await unlink(file);throw new Error('original task failure');}),/original task failure/);
  await withAntigravityPolicy(home,context(),executor(),async()=>{});
});

test('native connection normalization preserves old ACP data and locks the protocol of existing sessions',()=>{
  const raw={name:'test',command:process.execPath,args:[],env:{}};
  const old=normalizeExecutor(raw,undefined,id);assert.equal(old.adapter,undefined);
  const native=normalizeExecutor({...raw,adapter:'antigravity'},undefined,id);assert.equal(native.adapter,'antigravity');assert.match(connectionLabel(id,native),/Antigravity/);
  assert.equal(normalizeExecutor({...raw,name:'renamed'},native).adapter,'antigravity');
  assert.throws(()=>normalizeExecutor({...raw,adapter:'acp'},native),/连接类型已绑定/);
  assert.throws(()=>normalizeExecutor({...raw,adapter:'antigravity'},old),/连接类型已绑定/);
  assert.throws(()=>normalizeExecutor({...raw,adapter:'invented'},undefined,id),/未知的连接类型/);
  assert.equal(connectionLabel(id,old).includes('ACP'),true);
});
