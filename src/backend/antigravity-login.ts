import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {spawn,type ChildProcess} from 'node:child_process';
import type {AcpExecutor} from '../shared/types';
import {antigravityEnvironment} from './adapters/antigravity-policy';
import {antigravityCommand} from './adapters/antigravity';

const terminals=new Map<string,ChildProcess>();
/** Fixed interactive login launch; paths are passed as env values, never shell source. */
export async function openAntigravityLogin(executor:AcpExecutor,base:NodeJS.ProcessEnv,onClose?:()=>void,launch:typeof spawn=spawn){
  if(process.platform!=='win32')throw new Error('当前 Antigravity 登录终端只支持 Windows。');
  const {home,env}=antigravityEnvironment(executor,base),command=antigravityCommand(executor,env);
  if(command.prefix.length)throw new Error('Antigravity 登录请使用原生 agy.exe。');
  if(terminals.has(home))return {detail:'登录终端已经打开；完成授权并关闭终端后会自动检查。'};
  await mkdir(home,{recursive:true});
  const script='Write-Host "AIROOM Antigravity login - close this window when finished."; & $env:AIROOM_AGY_LOGIN_EXE';
  const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=launch(executable,['-NoLogo','-NoProfile','-NoExit','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {cwd:home,env:{...env,AIROOM_AGY_LOGIN_EXE:command.path},shell:false,detached:true,stdio:'ignore',windowsHide:false});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  terminals.set(home,child);child.once('exit',()=>{if(terminals.get(home)===child){terminals.delete(home);onClose?.();}});child.unref();
  return {detail:'已打开 Antigravity 登录终端。请完成原生授权并关闭终端，AIROOM 会自动检查；打开终端不代表已登录，本机其他 Antigravity 入口可能共用登录。'};
}
