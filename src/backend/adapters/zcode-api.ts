import path from 'node:path';
import {mkdtemp,mkdir,writeFile,rm,rmdir,chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {AcpExecutor} from '../../shared/types';
import {zcodeApiConnection} from '../../shared/zcode-api';
import {registerSecret} from '../security';

/** Native ZCode accepts a literal key in its provider file, not environment interpolation. */
export async function zcodeApiEnvironment(executor:AcpExecutor,env:NodeJS.ProcessEnv,model?:string){
  const connection=zcodeApiConnection(executor,model);
  const key=executor.env.AIROOM_ZCODE_API_KEY?.trim();
  if(!key)throw new Error('请先在 ZCode 自定义中转/API 设置中保存 API Key。');
  registerSecret(key);
  const home=env.ZCODE_DATA_BASE_DIR;
  if(!home||!path.isAbsolute(home))throw new Error('ZCode 独立配置目录尚未准备好。');
  const root=path.join(home,'api-launch');await mkdir(root,{recursive:true});
  const directory=await mkdtemp(path.join(root,'run-')),file=path.join(directory,'provider_config.json');
  const cleanup=async()=>{await rm(file,{force:true});await rmdir(directory);};
  try{
    if(process.platform==='win32'){
      const {stdout}=await promisify(execFile)('whoami.exe',['/user','/fo','csv','/nh'],{windowsHide:true,timeout:5000});
      const sid=stdout.match(/S-1-[0-9-]+/)?.[0];if(!sid)throw new Error('无法确认当前 Windows 用户，未写入临时 API 凭据。');
      await promisify(execFile)('icacls.exe',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],{windowsHide:true,timeout:5000});
    }else await chmod(directory,0o700);
    const config={schemaVersion:1,config:{
      providerConfigRules:{providerRules:[{providerId:connection.provider,providerName:'AIROOM 自定义 API',config:{
        group:'standard-personal',access:{type:'api-key',apiKey:key},api:{type:connection.api,baseUrl:connection.baseUrl},personalModelIds:[connection.model],
      }}]},modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]},
      defaultModelSelection:{providerId:connection.provider,modelId:connection.model},
    }};
    await writeFile(file,JSON.stringify(config),{flag:'wx',mode:0o600});
    const childEnv:NodeJS.ProcessEnv={...env,ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:file};delete childEnv.AIROOM_ZCODE_API_KEY;
    return {env:childEnv,connection,cleanup};
  }catch(error){await cleanup().catch(()=>{});throw error;}
}

export function zcodeApiFailure(stderr:string){
  const status=stderr.match(/(?:responseStatus|statusCode|HTTP)\s*[:=]?\s*(401|403|429|5\d\d)\b/i)?.[1];
  const httpStatus=status?Number(status):undefined;
  return {code:undefined as string|undefined,httpStatus,message:httpStatus===401||httpStatus===403?'ZCode 中转/API 鉴权失败，请核对该服务的 API Key。':httpStatus===429?'ZCode 中转/API 限流或额度不足，请检查服务状态。':undefined};
}
