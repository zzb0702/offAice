import { useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import type { AccountBalance, AccountCredits, CreditsBucket, AccountWallet, MemberQuota, ProviderId, QuotaWindow, Snapshot } from '../shared/types';
import { balanceAmount, balanceExhausted, balanceFresh, quotaFresh } from '../shared/quota';
import {zcodeApiMode} from '../shared/zcode-api';
import {creditsFresh,creditsExhausted} from '../shared/qoder-quota';
import { Modal } from './modals';
import { useTeam, Avatar } from './members';
import { errorText, useTicker, type Invoke } from './ui';

const resetText=(seconds:number)=>`${new Date(seconds*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})} 恢复`;

function visibleWindows(quota?:MemberQuota){
  if(quota?.kind)return quota.windows;
  const windows=quota?.windows??[],core=['5 小时','每周'].map(label=>windows.find(window=>window.label===label)||windows.find(window=>window.label.endsWith(` · ${label}`))||{id:label,label,checkedAt:''});
  return [...core,...windows.filter(window=>!core.some(item=>item.id===window.id))];
}
function tone(window:QuotaWindow,now:number){return !quotaFresh(window,now)?'stale':window.exhausted?'exhausted':window.warning||window.usedPercent!==undefined&&window.usedPercent>=80?'warning':'normal';}
function remaining(window:QuotaWindow,now:number){
  if(!window.checkedAt)return '未提供';
  if(!quotaFresh(window,now))return '待更新';
  if(window.exhausted&&window.usedPercent===undefined)return '已受限';
  return window.usedPercent===undefined?'未提供':`剩 ${Math.round((100-window.usedPercent)*10)/10}%`;
}
function detail(window:QuotaWindow,now:number){
  return `${window.label}：${remaining(window,now)}${window.usedPercent!==undefined?`，已用 ${Math.round(window.usedPercent*10)/10}%`:''}${window.resetsAt?`；${resetText(window.resetsAt)}`:''}${window.checkedAt?`；回报于 ${new Date(window.checkedAt).toLocaleTimeString('zh-CN')}`:'；成员程序还没有提供额度数据'}`;
}
const walletText=(wallet:AccountWallet)=>`${wallet.currency==='CNY'?'¥':'US$'}${balanceAmount(wallet.balance,wallet.currency==='CNY'?2:undefined)}`;
function balanceText(balance:AccountBalance|undefined,now:number){
  if(!balance||balance.status!=='ready'||!balance.wallets.length&&!balance.bonusWallets.length)return '未提供';
  if(!balanceFresh(balance,now))return '待更新';
}
function balanceRows(balance:AccountBalance){
  return [{label:'充值',wallets:balance.wallets},{label:'赠送',wallets:balance.bonusWallets}].flatMap(group=>group.wallets.map((wallet,index)=>({label:group.label,wallet,key:`${group.label}-${wallet.currency}-${index}`})));
}
function BalanceMeter({balance,now}:{balance?:AccountBalance;now:number}){
  const text=balanceText(balance,now);
  if(text)return <span className="quota-unavailable">余额 · {text}</span>;
  return <span className={`quota-mini balance-mini${balanceExhausted(balance,now)?' exhausted':''}`} aria-label="账户剩余余额">{balanceRows(balance!).map(row=><span className="balance-line" key={row.key} title={`${row.label}余额 ${walletText(row.wallet)}；更新于 ${new Date(balance!.checkedAt).toLocaleTimeString('zh-CN')}`}><span>{row.label}</span><span>{walletText(row.wallet)}</span></span>)}</span>;
}
function BalanceDetails({balance,now}:{balance?:AccountBalance;now:number}){
  const text=balanceText(balance,now);
  return <div className="balance-detail">{text?<p className="panel-muted">账户余额：{text}{text==='待更新'?'，请刷新余额。':'，账号服务暂未返回可验证的数据。'}</p>:balanceRows(balance!).map(row=><div className="balance-wallet" key={row.key}><span>{row.label}余额 · {row.wallet.currency==='CNY'?'人民币':'美元'}</span><strong>{walletText(row.wallet)}</strong></div>)}<small>按 API 扣费，充值和赠送余额分别显示；自动发言以两位小数的余额为准。{balanceExhausted(balance,now)?'余额已耗尽，自动发言已暂停。':''}</small></div>;
}
const creditNumber=(value:number)=>value.toLocaleString('zh-CN',{maximumFractionDigits:4});
const creditUnit=(bucket:CreditsBucket)=>bucket.unit?` ${bucket.unit}`:'';
function creditRemaining(bucket:CreditsBucket){
  if(bucket.available===false)return '当前不可用';
  if(bucket.remaining!==undefined)return `剩 ${creditNumber(bucket.remaining)}${creditUnit(bucket)}`;
  return bucket.usedPercent===undefined?'剩余未提供':`剩 ${Math.round((100-bucket.usedPercent)*10)/10}%`;
}
function creditsUnavailable(credits:AccountCredits|undefined,now:number){
  return !credits||credits.status!=='ready'?'还没有可验证的 Credits 额度':!creditsFresh(credits,now)?'Credits · 待更新':undefined;
}
function CreditsMeter({credits,now}:{credits?:AccountCredits;now:number}){
  const unavailable=creditsUnavailable(credits,now);if(unavailable)return <span className="quota-unavailable">{unavailable}</span>;
  return <span className="quota-mini quota-groups" aria-label="账号 Credits 额度">{credits!.buckets.slice(0,2).map(bucket=><span className="quota-line" key={bucket.id} title={`${bucket.label}：${creditRemaining(bucket)}`}><span>{bucket.label}</span><span>{creditRemaining(bucket)}</span></span>)}{!credits!.buckets.length&&<span>{creditsExhausted(credits,now)?'账号额度已用完':credits!.usedPercent!==undefined?`总额度剩 ${Math.round(100-credits!.usedPercent)}%`:'额度明细未提供'}</span>}{credits!.buckets.length>2&&<small>另有组织资源包，详见用量与额度</small>}</span>;
}
function CreditsDetails({credits,now}:{credits?:AccountCredits;now:number}){
  const unavailable=creditsUnavailable(credits,now);
  if(unavailable)return <p className="panel-muted">{unavailable}，请刷新额度。</p>;
  return <div className="credits-details">{credits!.plan&&<p className="panel-muted">套餐：{credits!.plan}</p>}{credits!.expiresAt!==undefined&&<p className="panel-muted">套餐到期：{new Date(credits!.expiresAt*1000).toLocaleString('zh-CN')}</p>}
    {credits!.buckets.map(bucket=><div className={`quota-detail ${bucket.usedPercent!==undefined&&bucket.usedPercent>=100?'exhausted':bucket.usedPercent!==undefined&&bucket.usedPercent>=80?'warning':''}`} key={bucket.id}>
      <div><span>{bucket.label}</span><strong>{creditRemaining(bucket)}</strong></div>
      {bucket.usedPercent!==undefined&&<span className="quota-track"><i style={{width:`${100-bucket.usedPercent}%`}}/></span>}
      <small>{bucket.used!==undefined?`已用 ${creditNumber(bucket.used)}${creditUnit(bucket)}`:'已用量未提供'}{bucket.total!==undefined?` / 总量 ${creditNumber(bucket.total)}${creditUnit(bucket)}`:''}{bucket.usedPercent!==undefined?` · 已用 ${Math.round(bucket.usedPercent*10)/10}%`:''}</small>
    </div>)}
    {credits!.usedPercent!==undefined&&<p className="panel-muted">账号总额度已用 {Math.round(credits!.usedPercent*10)/10}%</p>}
    {creditsExhausted(credits,now)&&<p className="inline-notice">官方账号已报告总额度耗尽，自动发言已暂停。</p>}
  </div>;
}
export function QuotaMeter({provider,quota}:{provider:ProviderId;quota?:MemberQuota}){
  const tick=useTicker(true,30000),now=Math.max(tick,Date.now());
  if(quota?.kind==='credits')return <CreditsMeter credits={quota.credits} now={now}/>;
  if(provider==='dsh')return <BalanceMeter balance={quota?.balance} now={now}/>;
  if(provider!=='codex'&&provider!=='claude'&&!quota)return <span className="quota-unavailable">程序未提供额度</span>;
  if(!visibleWindows(quota).some(window=>window.checkedAt))return <span className="quota-unavailable">还没有额度数据，可在“用量与额度”中刷新</span>;
  return <span className={`quota-mini${quota?.kind?' quota-groups':''}`} aria-label="成员剩余额度">{visibleWindows(quota).slice(0,2).map(window=><span key={window.id} className={`quota-line ${tone(window,now)}`} title={detail(window,now)}><span>{quota?.kind?window.label:window.label.includes('5 小时')?'5 小时':'每周'}</span><span>{remaining(window,now)}</span><span className="quota-track" aria-hidden="true"><i style={{width:`${quotaFresh(window,now)&&window.usedPercent!==undefined?100-window.usedPercent:0}%`}} /></span></span>)}{quota?.kind&&quota.windows.length>2&&<small>另有 {quota.windows.length-2} 项，详见用量与额度</small>}</span>;
}
/** Compact sidebar indicator: only real, fresh data is shown; "not provided" lives in the usage dialog. */
export function QuotaBadge({provider,quota}:{provider:ProviderId;quota?:MemberQuota}){
  const tick=useTicker(true,30000),now=Math.max(tick,Date.now());
  if(quota?.kind==='credits'){
    const credits=quota.credits;if(!creditsFresh(credits,now)||credits!.usedPercent===undefined&&!creditsExhausted(credits,now))return null;
    const exhausted=creditsExhausted(credits,now),remaining=exhausted?0:100-credits!.usedPercent!;
    return <span className={`quota-badge ${exhausted?'exhausted':credits!.usedPercent!>=80?'warning':''}`} title={credits!.buckets.map(bucket=>`${bucket.label}：${creditRemaining(bucket)}`).join('\n')} aria-label={`账号 Credits 总额度剩 ${Math.round(remaining)}%`}><span className="quota-track" aria-hidden="true"><i style={{width:`${remaining}%`}}/></span></span>;
  }
  if(provider==='dsh'){
    const balance=quota?.balance;
    if(balanceText(balance,now))return null;
    const first=balanceRows(balance!)[0];if(!first)return null;
    return <span className={`quota-badge balance${balanceExhausted(balance,now)?' exhausted':''}`} title={balanceRows(balance!).map(row=>`${row.label}余额 ${walletText(row.wallet)}`).join('；')}>{walletText(first.wallet)}</span>;
  }
  const windows=(quota?.windows??[]).filter(window=>window.scope!=='tools'&&quotaFresh(window,now)&&(window.usedPercent!==undefined||window.exhausted));
  if(!windows.length)return null;
  const tightest=windows.reduce((a,b)=>(b.exhausted?101:b.usedPercent??0)>(a.exhausted?101:a.usedPercent??0)?b:a);
  const left=tightest.exhausted?0:100-(tightest.usedPercent??0);
  return <span className={`quota-badge ${tone(tightest,now)}`} title={`${quota?.kind==='model-groups'?'各模型组额度（指示条为其中最低剩余）：\n':''}${windows.map(window=>detail(window,now)).join('\n')}`} aria-label={`${quota?.kind==='model-groups'?'模型组最低剩余':'剩余额度'} ${Math.round(left)}%`}><span className="quota-track" aria-hidden="true"><i style={{width:`${left}%`}}/></span></span>;
}
export function QuotaOverview({snapshot,invoke,onClose}:{snapshot:Snapshot;invoke:Invoke;onClose:()=>void}){
  const team=useTeam(),tick=useTicker(true,30000),now=Math.max(tick,Date.now());
  const [refreshing,setRefreshing]=useState<ProviderId>(),[errors,setErrors]=useState<Partial<Record<ProviderId,string>>>({});
  async function refresh(provider:ProviderId){if(refreshing)return;setRefreshing(provider);setErrors(previous=>({...previous,[provider]:''}));try{await invoke(provider==='dsh'?'provider.balance':'provider.quota',{provider});}catch(error){setErrors(previous=>({...previous,[provider]:errorText(error)}));}finally{setRefreshing(undefined);}}
  return <Modal title="用量与额度" subtitle="按成员程序的实际回报显示。使用同一个程序的成员共用账号额度。" onClose={onClose} className="quota-modal">
    <div className="modal-body">{team.members.map(member=>{
      const quota=snapshot.quotas?.[member.executor],windows=visibleWindows(quota),executor=snapshot.executors?.find(executor=>executor.id===member.executor),antigravity=executor?.adapter==='antigravity',zcode=executor?.catalogId==='zcode',zcodeApi=!!executor&&zcodeApiMode(executor),qoder=executor?.catalogId==='qoder'||executor?.catalogId==='qodercn',canRefresh=['codex','claude'].includes(member.executor)||antigravity||zcode&&!zcodeApi||qoder;
      return <section className="quota-card" aria-label={`${member.name} 的额度`} key={member.id}><div className="quota-card-heading"><Avatar member={member} size={30}/><strong>{member.name}</strong><small>{quota?`更新于 ${new Date(quota.checkedAt).toLocaleTimeString('zh-CN')}`:'等待程序回报'}</small></div>
        {qoder?<CreditsDetails credits={quota?.credits} now={now}/>:zcodeApi?<p className="panel-muted">自定义中转/API 按服务提供方规则计费，不查询 ZCode 官方 Coding Plan 额度。</p>:member.executor==='dsh'&&snapshot.settings.dshAuthMode==='api'?<p className="panel-muted">自定义 API 按服务提供方规则计费，不查询 DeepSeek 官方账号余额。</p>:member.executor==='dsh'?<BalanceDetails balance={quota?.balance} now={now}/>:!canRefresh&&!quota?<p className="panel-muted">这个成员程序尚未提供可验证的额度数据。</p>:!windows.some(window=>window.checkedAt)?(member.executor==='claude'&&snapshot.claudeTokenConfigured?null:<p className="panel-muted">还没有额度数据，点“刷新额度”查询。</p>):windows.map(window=><div className={`quota-detail ${tone(window,now)}`} key={window.id}><div><span>{window.label}</span><strong>{remaining(window,now)}</strong></div><span className="quota-track"><i style={{width:`${quotaFresh(window,now)&&window.usedPercent!==undefined?100-window.usedPercent:0}%`}} /></span><small>{window.usedPercent!==undefined?`已用 ${Math.round(window.usedPercent*10)/10}% · `:''}{window.resetsAt?resetText(window.resetsAt):'恢复时间未提供'}{tone(window,now)==='warning'?(window.scope==='tools'?' · MCP 工具额度较低':antigravity?' · 该模型组额度较低':' · 额度较低，自由讨论会减少自动点名'):tone(window,now)==='exhausted'?(window.scope==='tools'?' · MCP 工具额度已用完，不影响普通模型发言':antigravity?' · 该模型组额度已用完':' · 额度受限，自动发言已暂停'):tone(window,now)==='stale'&&window.checkedAt?' · 回报已过期，等待更新':''}</small></div>)}
        {qoder&&<p className="panel-muted">按当前计费周期显示账号 Credits；套餐、附加额度和组织资源包分开计算，是否耗尽以账号总额度为准。</p>}
        {zcode&&!zcodeApi&&<p className="panel-muted">{executor?.authentication==='bigmodel'?'BigModel 中国区':'Z.ai 海外'}官方 Coding Plan；仅显示服务实际返回的额度。MCP 工具额度与模型调用额度分开计算。</p>}
        {antigravity&&<p className="panel-muted">按 Antigravity 官方模型组显示剩余额度和恢复时间。当前仅展示，不将某一组用完视为所有模型均不可用。</p>}
        {member.executor==='claude'&&snapshot.claudeTokenConfigured?<p className="panel-muted">Claude 用长期令牌登录时不能单独查询额度。{member.name} 下次发言或做任务后，这里会自动显示最新额度。</p>
          :canRefresh&&quota?.queryStatus==='unavailable'&&<p className="panel-muted">已查询，{member.name} 暂未提供可验证的额度数据。请检查连接或稍后重试。</p>}
        {!(member.executor==='dsh'&&snapshot.settings.dshAuthMode==='api')&&(member.executor!=='claude'||!snapshot.claudeTokenConfigured)&&(member.executor==='dsh'||canRefresh)&&<><button type="button" className="button secondary small balance-refresh" disabled={!!refreshing} onClick={()=>void refresh(member.executor)}><RefreshCw size={13}/>{refreshing===member.executor?'正在查询…':member.executor==='dsh'?'刷新余额':'刷新额度'}</button>{errors[member.executor]&&<p className="inline-error" role="alert">{errors[member.executor]}</p>}</>}
      </section>;
    })}<p className="quota-explanation"><Activity size={14}/>显示最近一次账号回报；未提供或已过期的数据不计作零余额或零用量。Codex、Claude 和 ZCode 官方模型调用额度已用达到 80% 时减少自动点名，达到 100% 时暂停自动调用。</p></div>
    <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>关闭</button></div>
  </Modal>;
}
