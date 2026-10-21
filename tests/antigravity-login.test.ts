import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {spawn} from 'node:child_process';
import {openAntigravityLogin} from '../src/backend/antigravity-login';
import type {AcpExecutor} from '../src/shared/types';

test('login opens an isolated interactive terminal without claiming authentication, holds it until exit',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'airoom-agy-login-'));
  const executor:AcpExecutor={id:'acp-agytest00',name:'AGY',adapter:'antigravity',command:process.execPath,args:[],env:{},permissions:{commands:'ask',fileScope:'workspace',network:true},createdAt:'2026-10-20'};
  let launches=0,closed=0,captured:any;
  const child=Object.assign(new EventEmitter(),{unref(){}});
  const launch=((command:string,args:string[],options:unknown)=>{launches++;captured={command,args,options};queueMicrotask(()=>child.emit('spawn'));return child;}) as unknown as typeof spawn;
  const result=await openAntigravityLogin(executor,{...process.env,AIROOM_ACP_HOME:root,ANTIGRAVITY_CSRF_TOKEN:'host-secret'},()=>closed++,launch);
  assert.match(result.detail,/不代表已登录/);assert.equal(launches,1);assert.equal(closed,0);
  assert.equal(captured.options.shell,false);assert.equal(captured.options.windowsHide,false);assert.equal(captured.options.env.ANTIGRAVITY_CSRF_TOKEN,undefined);
  assert.equal(captured.options.env.USERPROFILE,path.join(root,executor.id));assert.equal(captured.options.env.AIROOM_AGY_LOGIN_EXE,process.execPath);
  const script=Buffer.from(captured.args.at(-1),'base64').toString('utf16le');assert.match(script,/& \$env:AIROOM_AGY_LOGIN_EXE/);assert.ok(!script.includes(process.execPath));
  await openAntigravityLogin(executor,{AIROOM_ACP_HOME:root},()=>closed++,launch);assert.equal(launches,1);
  child.emit('exit',0);assert.equal(closed,1);
});
