import path from 'node:path';
import {createHash} from 'node:crypto';
import {zcodeInput} from './zcode-input';
import { latestPersona, nativeContextNeedsRefresh } from '../native-context';
import { plainRoomSpeech, ROOM_READ_TOOLS, roomProjectFiles } from './chat-policy';
import { zcodeRoomTools } from './zcode-chat';
import {mkdir} from 'node:fs/promises';
import type {ChildProcess} from 'node:child_process';
import type {AcpExecutor,Adapter,AdapterContext,AdapterResult,ProviderInfo,Settings} from '../../shared/types';
import {ACP_DEFAULT_PERMISSIONS} from '../../shared/defaults';
import {managedCatalogEnvironment} from '../executor-catalog';
import {resolveAcpProgram} from './acp';
import {collectCommand,spawnCli,type CliCommand} from './common';
import {stopOwned} from '../process-supervisor';
import {redact} from '../security';
import {observeArguments,observeVersion} from '../compatibility';
import {runOfficialExecutorLogin} from '../official-login';
import type {CatalogLoginState} from '../../shared/executor-catalog';
import {zcodeAccount,zcodeAccountName,zcodeAccountState,zcodeFailure} from './zcode-account';
import {loginZcodeBigmodel} from '../zcode-login';
import {ZcodeModelSession,ZcodeTaskOutput,zcodeModelOptions,zcodeRunModelEnvironment} from './zcode-model';
import {zcodeApiMode,zcodeApiConnection} from '../../shared/zcode-api';
import {zcodeApiEnvironment,zcodeApiFailure} from './zcode-api';
import {queryZcodeQuota,type ZcodeQuotaRequest} from '../zcode-quota';
import {nativeTokenUsage} from '../../shared/token-usage';

// Engine creates adapters per run. Keep notices across members and rooms for this process.
const warnedRoomToolVersions = new Set<string>();

/** ZCode has its own CLI protocol. Never send ACP requests to its app-server. */
export class ZcodeAdapter implements Adapter{
  private child?:ChildProcess;
  private loginAbort?:AbortController;
  private stopped=false;
  constructor(private executor:AcpExecutor,private bigmodelLogin=loginZcodeBigmodel,private roomTools=zcodeRoomTools,private quotaRequest?:ZcodeQuotaRequest){}
  private environment(base:NodeJS.ProcessEnv){
    if(!base.AIROOM_ACP_HOME||!path.isAbsolute(base.AIROOM_ACP_HOME))throw new Error('ZCode 的独立登录目录尚未准备好，请重启工作台。');
    const home=path.join(base.AIROOM_ACP_HOME,this.executor.id,...(zcodeApiMode(this.executor)?['api']:[]));
    const env:NodeJS.ProcessEnv={...managedCatalogEnvironment(this.executor,base,home),ZCODE_DATA_BASE_DIR:home};
    delete env.AIROOM_ZCODE_API_KEY;
    return env;
  }
  private command(env:NodeJS.ProcessEnv):CliCommand{
    const program=resolveAcpProgram(this.executor.command,env);
    return {command:program.script?process.execPath:program.file,prefix:program.script?[program.file]:[],path:program.file};
  }
  private modelEnvironment(env:NodeJS.ProcessEnv,command:CliCommand):NodeJS.ProcessEnv{
    return {...env,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:path.join(path.dirname(command.path),'provider','zcode-builtin.json'),ZCODE_PERSONAL_PROVIDER_CONFIG_FILE:path.join(env.ZCODE_DATA_BASE_DIR!,'.zcode','v2','provider_config.json')};
  }
  private state(env:NodeJS.ProcessEnv,command:CliCommand,model?:string){
    if(!zcodeApiMode(this.executor))return zcodeAccountState(env.ZCODE_DATA_BASE_DIR!,command.path,zcodeAccount(this.executor.authentication),env);
    const connection=zcodeApiConnection(this.executor,model),ready=!!this.executor.env.AIROOM_ZCODE_API_KEY;
    return {ready,model:connection.model,provider:connection.provider,detail:ready?'ZCode 自定义 API 已配置；远端密钥和模型可用性以实际对话为准。':'请在 ZCode 自定义中转/API 中保存 API Key。'};
  }
  private requestedModel(context:AdapterContext){
    return context.run.requestedConfig?context.run.requestedConfig.model:Object.hasOwn(context.settings.models,this.executor.id)?context.settings.models[this.executor.id]:this.executor.model;
  }
  async accountQuota(_settings:Settings,base:NodeJS.ProcessEnv){
    if(zcodeApiMode(this.executor))return {payload:{zcodeUsage:[]},checkedAt:new Date().toISOString()};
    const env=this.environment(base),command=this.command(env);
    return queryZcodeQuota(env.ZCODE_DATA_BASE_DIR!,command.path,zcodeAccount(this.executor.authentication),env,this.quotaRequest);
  }
  async probe(settings:Settings,base:NodeJS.ProcessEnv):Promise<ProviderInfo>{
    let temporary:Awaited<ReturnType<typeof zcodeApiEnvironment>>|undefined;
    const info:ProviderInfo={id:this.executor.id,name:this.executor.name,available:false,runtimeReady:false,auth:'unknown',detail:'',checkedAt:new Date().toISOString(),capabilities:{streaming:false,write:true,history:true,cancel:'native',steer:false,images:true},configuration:{model:false,effort:'unreported',detail:'请完成官方登录后读取原生模型清单。'},permissionSupport:{commandReadIsolation:false,commandWriteIsolation:'none',networkIsolation:'partial'}};
    if(zcodeApiMode(this.executor)){info.capabilities.images=false;info.configuration={model:true,effort:'unreported',detail:'请填写中转服务地址、模型和 API Key。'};}
    try{
      const env=this.environment(base),command=this.command(env);await mkdir(env.ZCODE_DATA_BASE_DIR!,{recursive:true});info.path=command.path;
      const check=await collectCommand(command,['doctor','--json'],env,env.ZCODE_DATA_BASE_DIR,30_000);
      const value=JSON.parse(check.stdout);if(check.code!==0||value.cli?.name!=='zcode'||typeof value.cli.version!=='string')throw new Error('程序没有返回 ZCode CLI 的运行信息。');
      info.version=value.cli.version;observeVersion(info.version!);info.runtimeReady=true;
      const custom=zcodeApiMode(this.executor),state=this.state(env,command,settings.models[this.executor.id]);
      info.auth=state.ready?(custom?'api':'subscription'):'none';info.detail=state.detail;
      if(state.ready){
        if(custom)temporary=await zcodeApiEnvironment(this.executor,this.modelEnvironment(env,command),state.model);
        const native=await ZcodeModelSession.open(command,temporary?.env??this.modelEnvironment(env,command),env.ZCODE_DATA_BASE_DIR!,state.provider,undefined,!custom);
        try{
          const catalog=await native.load(undefined,true);info.modelOptions=zcodeModelOptions(catalog,state.model);
          if(!info.modelOptions.length)throw new Error('ZCode 原生接口尚未报告当前套餐的模型清单，请刷新连接。');
          info.available=true;info.model=state.model;
          const adjustable=info.modelOptions.some(option=>option.efforts.length);
          info.configuration={model:true,effort:adjustable?'reported':'unsupported',detail:custom
            ?adjustable?'思考选项来自 ZCode 原生模型规则；保存设置后从下一轮生效。实际支持情况以中转服务为准，连接检查不发送模型请求。':'ZCode 未识别这个模型的可调思考档位，当前使用模型默认。中转自定义别名可能无法匹配原生规则；请核对服务提供的模型名称。'
            :`模型和思考选项来自 ${zcodeAccountName(zcodeAccount(this.executor.authentication))} 原生清单；默认模型 ${state.model}。修改从下一轮生效，每轮核对实际请求模型。`};
        }finally{await native.close();}
        if(!custom){const quota=await this.accountQuota(settings,base);info.quota=quota.payload;info.quotaCheckedAt=quota.checkedAt;}
      }
    }catch(error){info.detail=String(redact((error as Error).message));}
    finally{await temporary?.cleanup();}
    return info;
  }
  async authenticate(base:NodeJS.ProcessEnv,method=this.executor.authentication??'zai',progress?:(state:CatalogLoginState)=>void){
    const account=zcodeAccount(method);
    if(account!==zcodeAccount(this.executor.authentication))throw new Error('请先保存所选地区的登录方式，再完成官方登录。');
    this.stopped=false;
    const env=this.environment(base);await mkdir(env.ZCODE_DATA_BASE_DIR!,{recursive:true});
    if(this.stopped)throw new Error('登录已取消。');
    const command=this.command(env);
    const controller=new AbortController();this.loginAbort=controller;
    try{
      if(account==='bigmodel')await this.bigmodelLogin(env.ZCODE_DATA_BASE_DIR!,command.path,env,controller.signal,progress);
      else await runOfficialExecutorLogin('zcode',command,['login',account,'--json'],env,env.ZCODE_DATA_BASE_DIR!,child=>{this.child=child;if(this.stopped)void stopOwned(child,1500);},progress);
    }finally{this.child=undefined;if(this.loginAbort===controller)this.loginAbort=undefined;}
    if(this.stopped)throw new Error('登录已取消。');
    const state=zcodeAccountState(env.ZCODE_DATA_BASE_DIR!,command.path,account,env);
    if(!state.ready)throw new Error(state.detail);
    return {method:`${zcodeAccountName(account)} 官方浏览器登录`};
  }
  async start(context:AdapterContext,text:string):Promise<AdapterResult>{
    if(!zcodeApiMode(this.executor))return this.startPrepared(context,text);
    if(this.child&&this.child.exitCode===null&&this.child.signalCode===null)throw new Error('ZCode 已有正在进行的任务。');
    const env=this.environment(context.env),command=this.command(env);
    const temporary=await zcodeApiEnvironment(this.executor,this.modelEnvironment(env,command),this.requestedModel(context));
    try{return await this.startPrepared(context,text,temporary.env);}finally{await temporary.cleanup();}
  }
  private async startPrepared(context:AdapterContext,text:string,apiEnv?:NodeJS.ProcessEnv):Promise<AdapterResult>{
    if(this.child&&this.child.exitCode===null&&this.child.signalCode===null)throw new Error('ZCode 已有正在进行的任务。');this.child=undefined;this.stopped=false;
    const base=this.environment(context.env),permissions=context.settings.permissions[this.executor.id]??this.executor.permissions??ACP_DEFAULT_PERMISSIONS;
    if(context.run.roomAccess&&permissions.fileScope==='workspace')throw new Error('ZCode 当前没有可核对的项目读取范围隔离，不能保证“仅限工作区”。请为该成员选择“文件范围不限制”，或使用支持该限制的执行端；本轮尚未发送模型请求。');
    const command=this.command(base),env=apiEnv??this.modelEnvironment(base,command),custom=zcodeApiMode(this.executor),state=this.state(env,command,this.requestedModel(context));
    if(!state.ready)throw new Error(state.detail);
    // Project meeting rooms keep the read tools; plan mode and the denials below still forbid changes.
    const roomFiles=roomProjectFiles(context);
    const roomTools=plainRoomSpeech(context)?(await this.roomTools(command.path,hash=>{
      if(warnedRoomToolVersions.has(hash))return;
      context.emit('warning','新版 ZCode 的聊天室工具裁剪尚未核对，本轮未裁剪',undefined,'derived');
      warnedRoomToolVersions.add(hash);
    })).filter(tool=>!roomFiles||!ROOM_READ_TOOLS.includes(tool)):[];
    if(context.session.writeMode&&(permissions.commands!=='auto'||permissions.fileScope!=='any'||!permissions.network))throw new Error('ZCode 写入任务需要自动允许命令、任意文件范围和联网；当前权限下请关闭“允许修改”后进行只读对话。');
    const personaHash=createHash('sha256').update(context.persona??'').digest('hex');
    const remembered=context.session.nativeId&&context.session.nativePersona?.nativeId===context.session.nativeId&&context.session.nativePersona.hash===personaHash&&!nativeContextNeedsRefresh(context.session,text.length);
    const input=context.session.nativeId?text:context.freshInput?.(true)??text;
    const prompt=[remembered?undefined:latestPersona(context.persona),input].filter(Boolean).join('\n\n');
    const inputChannel=zcodeInput(command,prompt);
    await mkdir(env.ZCODE_DATA_BASE_DIR!,{recursive:true});
    const model=this.requestedModel(context);
    const effort=context.run.requestedConfig?context.run.requestedConfig.effort:context.settings.efforts[this.executor.id];
    let selection:{providerId:string;modelId:string;options?:{reasoningLevel?:string}};
    let native:ZcodeModelSession|undefined;
    try{
      native=await ZcodeModelSession.open(command,env,context.cwd,state.provider,child=>{this.child=child;context.registerProcess(child);if(this.stopped)void stopOwned(child,1500);},!custom);
      const catalog=await native.load(context.session.nativeId,!context.session.nativeId);
      if(this.stopped)return {stopped:true};
      selection=await native.select(catalog,model||state.model,effort,!!context.session.nativeId);
      context.recordConfig?.({source:'zcode.session',model:selection.modelId,modelStatus:'accepted',effort:selection.options?.reasoningLevel,effortStatus:selection.options?.reasoningLevel?'accepted':'default'});
    }catch(error){if(this.stopped)return {stopped:true};context.recordConfig?.({source:'zcode.session',modelStatus:'rejected',effortStatus:effort?'rejected':'default'});throw error;}
    finally{if(native){await native.close();if(this.child===native.child)this.child=undefined;}else this.child=undefined;}
    if(this.stopped)return {stopped:true};
    const nativeId=context.session.nativeId;
    const args=['-p',inputChannel.argument,'--output-format','stream-json','--mode',context.session.writeMode?'yolo':'plan'];
    if(nativeId)args.push('--resume',nativeId);
    const denied:string[]=[];
    if(!context.session.writeMode)denied.push('Bash','js','NodeREPL','Write','Edit','MultiEdit','NotebookEdit','Agent','Task','Skill','ExitPlanMode','CreateWorkflow','AmendWorkflow','SaveWorkflow','CronCreate','CronUpdate','CronDelete','OffPeakCreate');
    // Ordinary room speech already forbids tools. Remove their schemas for this invocation
    // only; desk work, reports, attachments and task runs retain their existing capabilities.
    denied.push(...roomTools);
    if(!permissions.network)denied.push('WebFetch','WebSearch');
    if(denied.length)args.push('--disallowed-tools',[...new Set(denied)].join(','));
    for(const attachment of context.attachments??[])args.push('--attach',attachment.path);
    observeArguments(['--output-format','stream-json','--mode',context.session.writeMode?'yolo':'plan',permissions.network?'network':'offline']);
    const taskEnvironment=await zcodeRunModelEnvironment(env,selection);
    if(this.stopped){await taskEnvironment.cleanup();return {stopped:true};}
    const child=spawnCli(inputChannel.command,args,{cwd:context.cwd,env:taskEnvironment.env});this.child=child;context.registerProcess(child);
    if(inputChannel.stdin!==undefined){child.stdin?.on('error',()=>{});child.stdin?.end(inputChannel.stdin,'utf8');}
    let generationStarted=false;
    const output=new ZcodeTaskOutput(event=>{
      if(this.stopped||nativeId&&event.sessionId!==nativeId||!output.models.some(model=>model.sessionId===event.sessionId&&model.turnId===event.turnId&&model.providerId===selection.providerId&&model.modelId===selection.modelId))return;
      context.progress?.();
      if(!generationStarted){generationStarted=true;context.recordTiming?.('generation-start');context.emit('status','ZCode 正在生成回复。',undefined,'derived');}
    });let stderr='',stderrHead='';
    child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
    child.stdout?.on('data',(chunk:string)=>{output.feed(chunk);if(output.invalid)void stopOwned(child,5000).catch(()=>{});});
    child.stderr?.on('data',(chunk:string)=>{stderrHead=(stderrHead+chunk).slice(0,12000);stderr=(stderr+chunk).slice(-12000);});
    try{
      const ended=new Promise<{code:number|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code}));});
      context.markDelivery('sent');context.recordTiming?.('sent');
      const {code}=await ended;
      if(this.stopped)return {stopped:true};
      const diagnostic=custom?zcodeApiFailure(stderrHead+'\n'+stderr):zcodeFailure(stderrHead+'\n'+stderr,zcodeAccount(this.executor.authentication));
      output.finish();const result=output.result;
      if(output.invalid||!result||typeof result.sessionId!=='string'||!result.sessionId||nativeId&&result.sessionId!==nativeId||typeof result.response!=='string'){
        const reason=diagnostic.message??'ZCode 没有返回可核对的最终结果。';
        context.markDelivery('unknown');context.emit('warning',reason+'本轮结果未确认，不会自动重发。',{providerCode:diagnostic.code,httpStatus:diagnostic.httpStatus,exitCode:code},'derived');return {unknown:true,unknownReason:reason};
      }
      context.persistNativeSession(result.sessionId,'airoom');context.markDelivery('confirmed',result.turnId);
      if(output.compactions.some(event=>event.sessionId===result.sessionId&&event.turnId===result.turnId))context.invalidateNativeContext?.();
      if(code!==0||!['idle','completed'].includes(result.projection?.status))return {failure:{kind:diagnostic.code==='1113'?'blocked':diagnostic.code==='1302'||diagnostic.httpStatus===429?'rate_limited':'failed',message:diagnostic.message??'ZCode 本轮未完成，请查看活动记录。'},summary:result.response};
      const models=output.models.filter(item=>item.sessionId===result.sessionId&&item.turnId===result.turnId);
      context.recordRuntime?.('zcode-context',{promptChars:prompt.length,personaInjected:!remembered,requests:models.length,tools:models.at(-1)?.toolCount??null});
      if(!models.length||models.some(item=>item.modelId!==selection.modelId||item.providerId!==selection.providerId)){
        const actual=[...new Set(models.map(item=>`${item.providerId}/${item.modelId}`))].slice(0,3).join('、');
        const message=models.length?`ZCode 实际请求模型与所选模型不一致（所选：${selection.providerId}/${selection.modelId}；实际：${actual}），本轮不会自动重发。`:'ZCode 本轮未报告可核对的实际请求模型，本轮不会自动重发。';
        context.recordConfig?.({source:'zcode.model-request',model:models.at(-1)?.modelId,modelStatus:models.length?'rejected':'unreported'});
        context.emit('warning',message,undefined,'derived');return {failure:{kind:'failed',message},summary:result.response};
      }
      context.recordConfig?.({source:'zcode.model-request',model:selection.modelId,modelStatus:'reported'});
      context.persistNativePersona?.(result.sessionId,personaHash);
      if(result.response)context.emit('delta',result.response,{nativeSessionId:result.sessionId},'native');
      if(result.usage){
        const usage=nativeTokenUsage('zcode',result.usage);
        if(usage)context.recordTokenUsage?.(usage,result.sessionId);
        context.emit('usage','ZCode 本轮用量',result.usage,'native');
      }
      return {summary:result.response,usage:result.usage};
    }finally{if(this.child===child)this.child=undefined;if(child.exitCode===null&&child.signalCode===null)await stopOwned(child,5000);await taskEnvironment.cleanup();}
  }
  async stop(){this.stopped=true;this.loginAbort?.abort();if(this.child)await stopOwned(this.child,5000);}
}
