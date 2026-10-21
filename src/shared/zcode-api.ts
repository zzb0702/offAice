import type { AcpExecutor } from './types';

export const ZCODE_API_PROTOCOLS = ['openai-completions','openai-responses','anthropic-messages'] as const;
export type ZcodeApiProtocol = typeof ZCODE_API_PROTOCOLS[number];
export const ZCODE_API_PROVIDER = 'airoom-custom-api';
export const zcodeApiMode = (executor:AcpExecutor) => executor.catalogId==='zcode'&&executor.authentication==='custom-api';

export function zcodeApiConnection(executor:Pick<AcpExecutor,'env'|'model'>, selectedModel?:string){
  const api=executor.env.AIROOM_ZCODE_API_PROTOCOL??'openai-completions';
  if(!ZCODE_API_PROTOCOLS.includes(api as ZcodeApiProtocol))throw new Error('ZCode API 接口格式无效。');
  let url:URL;
  try{url=new URL(executor.env.AIROOM_ZCODE_BASE_URL?.trim()||'');}catch{throw new Error('请填写完整的 ZCode API 服务根地址。');}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)throw new Error('ZCode API 地址必须是无账号密码或查询参数的 HTTP/HTTPS 地址。');
  url.pathname=url.pathname.replace(/\/+$/,'')||'/';
  if(/\/(?:chat\/completions|completions|responses|messages)$/i.test(url.pathname))throw new Error('请填写 API 根地址（通常以 /v1 结尾），不要附加具体请求路径。');
  const model=(selectedModel??executor.model??executor.env.AIROOM_ZCODE_MODEL??'').trim();
  if(!model||model.length>200||/[\r\n\0]/.test(model))throw new Error('请填写中转服务实际支持的模型名称。');
  return {provider:ZCODE_API_PROVIDER,model,api:api==='openai-completions'?'openai-chat-completions':api,baseUrl:url.toString().replace(/\/$/,'')};
}
