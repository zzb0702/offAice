import { useState } from 'react';
import type { Settings, Snapshot } from '../shared/types';
import { dshApiMode, switchDshMode, DSH_API_EFFORTS, type DshApiProtocol, type DshApiThinkingFormat } from '../shared/dsh-connection';
import type { Invoke, Notify } from './ui';

export function DshConnection({settings,setSettings,snapshot,invoke,notify,beforeSave}:{
  settings:Settings;setSettings:(update:(previous:Settings)=>Settings)=>void;snapshot:Snapshot;
  invoke:Invoke;notify:Notify;beforeSave:()=>Promise<void>;
}) {
  const [key,setKey]=useState(''),[busy,setBusy]=useState(false);
  async function saveKey(clear=false){
    const value=clear?'':key.trim();setKey('');setBusy(true);
    try{if(!clear)await beforeSave();await invoke('dshApiKey.set',{value});notify(clear?'DSH API Key 已清除。':'DSH API Key 已加密保存。');}catch{}finally{setBusy(false);}
  }
  return <div className="dsh-connection" aria-label="DSH 连接配置">
    <label className="field compact">DSH 连接方式<select aria-label="DSH 连接方式" disabled={busy} value={settings.dshAuthMode??'account'} onChange={event=>setSettings(previous=>switchDshMode(previous,event.target.value as 'account'|'api'))}>
      <option value="account">DeepSeek 官方账号登录</option><option value="api">自定义中转/API</option>
    </select></label>
    {dshApiMode(settings)?<>
      <label className="field compact">接口格式<select aria-label="DSH API 接口格式" value={settings.dshApiProtocol??'openai-completions'} onChange={event=>setSettings(previous=>({...previous,dshApiProtocol:event.target.value as DshApiProtocol}))}>
        <option value="openai-completions">OpenAI Chat Completions（默认）</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option>
      </select></label>
      <label className="field compact">API 服务地址<input aria-label="DSH API 服务地址" value={settings.dshApiBaseUrl??''} onChange={event=>setSettings(previous=>({...previous,dshApiBaseUrl:event.target.value}))} placeholder="https://你的中转/v1" spellCheck={false}/><small>填写服务提供的 API 根地址，通常包含 /v1；不要加 /chat/completions。</small></label>
      <label className="field compact">模型<input aria-label="DSH API 模型" value={settings.models.dsh??''} onChange={event=>setSettings(previous=>({...previous,models:{...previous.models,dsh:event.target.value}}))} placeholder="中转服务提供的模型名称" spellCheck={false}/></label>
      <label className="field compact">思考程度<select aria-label="DSH API 思考程度" value={settings.efforts.dsh??''} onChange={event=>setSettings(previous=>({...previous,efforts:{...previous.efforts,dsh:event.target.value}}))}>
        <option value="">模型默认</option>{DSH_API_EFFORTS.map(level=><option key={level} value={level}>{({off:'关闭',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高'})[level]}（{level}）</option>)}
      </select><small>只选择服务支持的档位；这些是可发送的参数，不代表中转已验证支持。修改后点击底部“保存设置”。</small></label>
      {(settings.dshApiProtocol??'openai-completions')==='openai-completions'&&!!settings.efforts.dsh&&<label className="field compact">思考参数格式<select aria-label="DSH API 思考参数格式" value={settings.dshApiThinkingFormat??'openai'} onChange={event=>setSettings(previous=>({...previous,dshApiThinkingFormat:event.target.value as DshApiThinkingFormat}))}>
        <option value="openai">OpenAI 兼容（默认）</option><option value="deepseek">DeepSeek</option>
      </select><small>按中转文档选择；DeepSeek 格式还会发送思考开关。</small></label>}
      <label className="field compact">API Key<input type="password" autoComplete="off" aria-label="DSH API Key" value={key} disabled={busy} onChange={event=>setKey(event.target.value)} placeholder={snapshot.dshApiKeyConfigured?'已保存；留空保留现有密钥':'填写该中转服务的 API Key'} spellCheck={false}/></label>
      <div className="catalog-actions"><button className="button secondary" disabled={busy||!key.trim()||!snapshot.backendReady} onClick={()=>void saveKey()}>加密保存 DSH API Key</button>{snapshot.dshApiKeyConfigured&&<button className="button quiet danger" disabled={busy||!snapshot.backendReady} onClick={()=>void saveKey(true)}>清除 DSH API Key</button>}</div>
      <p className="provider-detail">{snapshot.dshApiKeyConfigured?'密钥已加密保存。':''}会话请求将发送到你填写的服务，按该服务的规则计费。此模式无需 DeepSeek 官方账号登录，也不查询官方账号余额。保存后点击“检查”验证本地连接配置；实际服务可用性通过对话确认。</p>
    </>:<p className="provider-detail">使用独立 DSH 后台和独立账号登录，不需要桌面客户端运行，也不读取桌面登录凭据。点击登录后在官方浏览器页面授权一次。</p>}
  </div>;
}
