import path from 'node:path';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import type {AcpExecutor,AdapterContext,MemberPermissions} from '../../shared/types';
import {ACP_DEFAULT_PERMISSIONS,isAcpId} from '../../shared/defaults';
import {plainRoomSpeech,roomProjectFiles} from './chat-policy';

const homes=new Map<string,Promise<void>>();
const reserved=/^(?:HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|XDG_.*|AGY_.*|ANTIGRAVITY_.*|CODEIUM_.*|WINDSURF_.*|GOOGLE_.*|GEMINI_.*|GCLOUD_.*|CLOUDSDK_.*|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|AIROOM_.*)$/i;

/** File-based configuration is private; HOME overrides do not attest native keyring isolation. */
export function antigravityEnvironment(executor:AcpExecutor,base:NodeJS.ProcessEnv){
  if(!base.AIROOM_ACP_HOME||!path.isAbsolute(base.AIROOM_ACP_HOME))throw new Error('Antigravity 的独立账号目录尚未准备好。');
  if(!isAcpId(executor.id))throw new Error('Antigravity 连接编号无效。');
  if(executor.args.length)throw new Error('Antigravity 连接无需启动参数；请在模型选项中选择模型和思考程度。');
  const home=path.join(base.AIROOM_ACP_HOME,executor.id),env={...base};
  for(const key of Object.keys(env))if(reserved.test(key)||/^(?:CLAUDE|ANTHROPIC|CODEX|OPENAI|DSH|QWEN|QODER|QODERCN|CURSOR|KIMI|OPENCODE|XAI|MINIMAX|ZCODE|ZAI|ZHIPU|BIGMODEL)_/i.test(key)||key==='CLAUDECODE')delete env[key];
  for(const [key,value]of Object.entries(executor.env)){
    if(reserved.test(key)||/^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR)$/i.test(key))throw new Error(`Antigravity 连接不能覆盖 ${key}；账号目录由 AIROOM 独立管理。`);
    env[key]=value;
  }
  Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),
    XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local','share'),XDG_STATE_HOME:path.join(home,'.local','state'),XDG_CACHE_HOME:path.join(home,'.cache'),
    AIROOM_EXECUTOR_HOME:home,AIROOM_NODE_CHILD_MODE:'1',NO_COLOR:'1'});
  return {home,env};
}

/** A fresh invocation is mandatory: never use the user's most recent conversation. */
export function antigravityArguments(context:AdapterContext){
  const model=context.settings.models[context.run.provider],effort=context.settings.efforts[context.run.provider];
  if(effort&&!['low','medium','high','xhigh','max'].includes(effort))throw new Error('Antigravity 不支持所选思考程度。');
  const args=['--input-format','stream-json','--output-format','stream-json','--disable-slash-commands','--sandbox'];
  if(model)args.push('--model',model);
  if(effort)args.push('--effort',effort);
  if(context.session.nativeId)args.push('--conversation',context.session.nativeId);
  const project=roomProjectFiles(context);if(project)args.push('--add-dir',project);
  return args;
}

export function antigravityPermissions(context:AdapterContext,executor:AcpExecutor){
  const permissions:MemberPermissions=context.settings.permissions[executor.id]??executor.permissions??ACP_DEFAULT_PERMISSIONS;
  const speech=plainRoomSpeech(context),project=roomProjectFiles(context),readOnly=!context.session.writeMode;
  const allow:string[]=[],deny=['mcp(*)','unsandboxed(*)'],ask:string[]=[];
  if(speech&&!project)deny.push('read_file(*)');
  else if(permissions.fileScope==='any'&&!speech)allow.push('read_file(*)');
  if(readOnly||speech)deny.push('write_file(*)','command(*)');
  else{
    allow.push(`write_file(${permissions.fileScope==='any'?'*':context.cwd.replace(/\\/g,'/')})`);
    if(permissions.commands==='auto')allow.push('command(*)');
    else if(permissions.commands==='deny')deny.push('command(*)');
    else ask.push('command(*)');
  }
  if(permissions.network&&!speech)allow.push('read_url(*)','execute_url(*)');
  else deny.push('read_url(*)','execute_url(*)');
  return {toolPermission:'request-review',enableTerminalSandbox:true,allowNonWorkspaceAccess:permissions.fileScope==='any'&&!speech,
    permissions:{allow,deny,ask}};
}

/** Settings are private, temporary and serialized for members sharing one executor. */
export async function withAntigravityPolicy<T>(home:string,context:AdapterContext,executor:AcpExecutor,action:()=>Promise<T>):Promise<T>{
  const previous=homes.get(home)??Promise.resolve();let release!:()=>void;
  const lock=new Promise<void>(resolve=>{release=resolve;});const tail=previous.catch(()=>{}).then(()=>lock);homes.set(home,tail);
  await previous.catch(()=>{});
  const file=path.join(home,'.gemini','antigravity-cli','settings.json');
  let original:string|undefined,published:string|undefined;
  try{
    await mkdir(path.dirname(file),{recursive:true});
    try{original=await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const saved=original===undefined?{}:JSON.parse(original);
    if(!saved||typeof saved!=='object'||Array.isArray(saved))throw new Error('Antigravity 独立设置格式无效，未发送任务。');
    published=JSON.stringify({...saved,...antigravityPermissions(context,executor)});
    await writeFile(file,published,{encoding:'utf8',mode:0o600});
    return await action();
  }finally{
    try{
      let current:string|undefined;
      if(published!==undefined)try{current=await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(published!==undefined&&current===published){
        if(original===undefined)await unlink(file);else await writeFile(file,original,{encoding:'utf8',mode:0o600});
      }
    }finally{release();if(homes.get(home)===tail)homes.delete(home);}
  }
}
