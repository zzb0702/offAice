import type { RunSummary } from '../shared/types';
import { cacheHitRate, formatTokens, type TokenUsage } from '../shared/token-usage';

export function MessageTokenUsage({ usage, run, speaking }: { usage?: TokenUsage; run?: RunSummary; speaking?: boolean }) {
  const waiting = speaking || run && ['queued', 'running', 'waiting_user', 'stopping'].includes(run.status);
  const unavailable = waiting ? '待回报' : '未提供';
  const rate = cacheHitRate(usage), invalid = usage?.status === 'inconsistent';
  return <div className="room-token-usage" aria-label="本次回复用量" title="缓存率 = 缓存读取 Token ÷ 总输入 Token。只统计执行端实际回报；不会根据上下文长度或账号额度估算。">
    <span>输入：{usage?.inputTokens === undefined ? unavailable : formatTokens(usage.inputTokens)}</span>
    <span>输出：{usage?.outputTokens === undefined ? unavailable : formatTokens(usage.outputTokens)}</span>
    <span>缓存率：{invalid ? '数据异常' : rate === undefined ? usage?.inputTokens === 0 ? '暂无输入' : unavailable : `${rate.toFixed(1)}%`}</span>
    {usage?.scope === 'session' && <span className="token-usage-scope">会话累计</span>}
    {usage?.scope === 'reported-requests' && <span className="token-usage-scope">已报告请求{usage.requests ? ` ${usage.requests} 次` : ''}</span>}
  </div>;
}
