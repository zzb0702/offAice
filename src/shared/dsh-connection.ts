import type { Settings } from './types';

export const DSH_API_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type DshApiProtocol = typeof DSH_API_PROTOCOLS[number];
export const DSH_API_EFFORTS = ['off','minimal','low','medium','high','xhigh','max'] as const;
export const DSH_API_THINKING_FORMATS = ['openai','deepseek'] as const;
export type DshApiThinkingFormat = typeof DSH_API_THINKING_FORMATS[number];
export const dshApiMode = (settings: Pick<Settings, 'dshAuthMode'>) => settings.dshAuthMode === 'api';
export const dshProvider = (settings: Pick<Settings, 'dshAuthMode'>) => dshApiMode(settings) ? 'airoom-api' : 'deepseek-account';

export function switchDshMode(settings: Settings, mode: 'account' | 'api'): Settings {
  const wasApi=dshApiMode(settings);
  const dshAccountModel=wasApi?settings.dshAccountModel:settings.models.dsh;
  const dshApiModel=wasApi?settings.models.dsh:settings.dshApiModel;
  const dshAccountEffort=wasApi?settings.dshAccountEffort:settings.efforts.dsh;
  const dshApiEffort=wasApi?settings.efforts.dsh:settings.dshApiEffort;
  return {...settings,dshAuthMode:mode,dshAccountModel,dshApiModel,dshAccountEffort,dshApiEffort,
    models:{...settings.models,dsh:(mode==='api'?dshApiModel:dshAccountModel)??''},
    efforts:{...settings.efforts,dsh:(mode==='api'?dshApiEffort:dshAccountEffort)??''}};
}

/** Explicit user-specified request options; these are not remote capability discovery. */
export function dshApiReasoning(settings: Pick<Settings,'efforts'|'dshApiThinkingFormat'>) {
  const effort=settings.efforts.dsh||undefined,format=settings.dshApiThinkingFormat??'openai';
  if(effort&&!DSH_API_EFFORTS.includes(effort as typeof DSH_API_EFFORTS[number]))throw new Error('DSH API 思考程度无效，请重新选择。');
  if(!DSH_API_THINKING_FORMATS.includes(format))throw new Error('DSH API 思考参数格式无效。');
  return {effort,format};
}

/** A base URL is an API root; native adapters append the operation path. */
export function dshApiConnection(settings: Pick<Settings, 'dshApiBaseUrl' | 'dshApiProtocol'>) {
  let url: URL;
  try { url = new URL(settings.dshApiBaseUrl?.trim() || ''); }
  catch { throw new Error('请填写完整的 DSH API 服务地址，例如 https://你的中转/v1。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash)
    throw new Error('DSH API 地址须为不含账号密码、查询参数或片段的 HTTP/HTTPS 地址。');
  const api = settings.dshApiProtocol ?? 'openai-completions';
  if (!DSH_API_PROTOCOLS.includes(api)) throw new Error('DSH API 接口格式无效。');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (/\/(?:chat\/completions|completions|responses|messages)$/i.test(url.pathname))
    throw new Error('请填写 API 根地址（通常以 /v1 结尾），不要填写具体的请求路径。');
  return { api, baseURL: url.toString().replace(/\/$/, '') };
}

/** Non-secret settings used to invalidate both connection checks and idle runtimes. */
export function dshConnectionIdentity(settings: Settings) {
  return [settings.dshAuthMode ?? 'account', settings.dshProfile, settings.deepseekBaseUrl,
    settings.dshApiBaseUrl ?? '', settings.dshApiProtocol ?? 'openai-completions',settings.dshApiThinkingFormat??'openai'];
}
