/** Provider-reported token accounting only; context occupancy and account quotas are different data. */
export interface TokenUsage {
  source: 'codex' | 'zcode' | 'antigravity' | 'dsh' | 'claude';
  scope: 'turn' | 'session' | 'reported-requests';
  status: 'reported' | 'partial' | 'inconsistent';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requests?: number;
}
export interface TokenUsageCheckpoint { nativeId: string; usage: TokenUsage }

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const countKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

function normalize(source: TokenUsage['source'], scope: TokenUsage['scope'], value: unknown, names: Record<typeof countKeys[number], string>, separateInput = false): TokenUsage | undefined {
  const raw = object(value), result: TokenUsage = { source, scope, status: 'partial' };
  let invalid = false, found = false;
  for (const key of countKeys) {
    const v = raw[names[key]];
    if (v === undefined || v === null) continue;
    found = true;
    if (tokenCount(v)) result[key] = v; else invalid = true;
  }
  if (!found) return;
  if (separateInput) {
    const total = raw.totalTokens ?? raw.total_tokens, output = result.outputTokens;
    const uncached = result.inputTokens, read = result.cacheReadTokens, write = result.cacheWriteTokens;
    // DSH/Anthropic count uncached input separately. Never use it as the full denominator.
    if (total !== undefined && total !== null && !tokenCount(total)) invalid = true;
    if (tokenCount(total) && output !== undefined) {
      result.inputTokens = total >= output ? total - output : undefined;
      if (total < output) invalid = true;
      const known = [uncached, read, write].reduce<number>((sum, n) => sum + (n ?? 0), 0);
      if (result.inputTokens !== undefined && (known > result.inputTokens || [uncached, read, write].every(tokenCount) && known !== result.inputTokens)) invalid = true;
    } else if ([uncached, read, write].every(tokenCount)) {
      const sum = uncached! + read! + write!;
      result.inputTokens = tokenCount(sum) ? sum : undefined;
      if (!tokenCount(sum)) invalid = true;
    } else result.inputTokens = undefined;
  }
  const input = result.inputTokens, read = result.cacheReadTokens, write = result.cacheWriteTokens;
  if (input !== undefined && (read ?? 0) + (write ?? 0) > input) invalid = true;
  result.status = invalid ? 'inconsistent' : input !== undefined && read !== undefined ? 'reported' : 'partial';
  return result;
}

const camel = { inputTokens: 'inputTokens', outputTokens: 'outputTokens', cacheReadTokens: 'cacheReadTokens', cacheWriteTokens: 'cacheWriteTokens' };
export function nativeTokenUsage(source: TokenUsage['source'], payload: unknown): TokenUsage | undefined {
  const value = object(payload);
  if (source === 'codex') return normalize(source, 'session', object(value.tokenUsage).total, { ...camel, cacheReadTokens: 'cachedInputTokens', cacheWriteTokens: 'cacheWriteInputTokens' });
  if (source === 'zcode') return normalize(source, 'turn', payload, camel);
  if (source === 'antigravity') return normalize(source, 'session', payload, { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens' });
  if (source === 'claude') return normalize(source, 'turn', value.usage, { inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens' }, true);
  return normalize(source, 'reported-requests', payload, camel, true);
}

/** Only complete, consistent reported counters produce a ratio. Explicit zero is distinct from missing. */
export function cacheHitRate(usage?: TokenUsage): number | undefined {
  if (!usage || usage.status === 'inconsistent' || !tokenCount(usage.inputTokens) || usage.inputTokens === 0 || !tokenCount(usage.cacheReadTokens) || usage.cacheReadTokens > usage.inputTokens) return;
  return usage.cacheReadTokens / usage.inputTokens * 100;
}

/** Replayed/duplicate receipts replace the same request, never add it twice. */
export class DshTokenUsage {
  private rows = new Map<number, TokenUsage>();
  add(seq: number, payload: unknown): TokenUsage | undefined {
    if (!tokenCount(seq) || !this.rows.has(seq) && this.rows.size >= 4096) return;
    const usage = nativeTokenUsage('dsh', payload);
    if (!usage) return;
    this.rows.set(seq, usage);
    const rows = [...this.rows.values()], result: TokenUsage = { source: 'dsh', scope: 'reported-requests', status: 'partial', requests: rows.length };
    for (const key of countKeys) {
      if (rows.every(row => row[key] !== undefined)) {
        const sum = rows.reduce((n, row) => n + row[key]!, 0);
        if (tokenCount(sum)) result[key] = sum; else result.status = 'inconsistent';
      }
    }
    if (rows.some(row => row.status === 'inconsistent')) result.status = 'inconsistent';
    else if (result.status !== 'inconsistent' && result.inputTokens !== undefined && result.cacheReadTokens !== undefined) result.status = 'reported';
    return result;
  }
}

/** Captures the baseline once per AIROOM run, even when multiple cumulative updates arrive. */
export class TokenUsageTracker {
  private baselines = new Map<string, TokenUsage | undefined>();
  constructor(private initialNativeId?: string, private checkpoint?: TokenUsageCheckpoint) {}
  record(native: TokenUsage, nativeId?: string): { usage: TokenUsage; checkpoint?: TokenUsageCheckpoint } {
    if (native.scope !== 'session' || !nativeId) return { usage: native };
    const key = `${native.source}:${nativeId}`;
    if (!this.baselines.has(key)) this.baselines.set(key,
      this.checkpoint?.nativeId === nativeId && this.checkpoint.usage.source === native.source && this.checkpoint.usage.status !== 'inconsistent' ? this.checkpoint.usage :
      nativeId !== this.initialNativeId ? { source: native.source, scope: 'session', status: 'reported', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } : undefined);
    const baseline = this.baselines.get(key), usage: TokenUsage = { ...native };
    if (baseline && native.status !== 'inconsistent') {
      const decreased = countKeys.some(k => native[k] !== undefined && baseline[k] !== undefined && native[k]! < baseline[k]!);
      if (decreased) this.baselines.set(key, undefined);
      if (!decreased) {
        usage.scope = 'turn';
        for (const k of countKeys) usage[k] = native[k] !== undefined && baseline[k] !== undefined ? native[k]! - baseline[k]! : undefined;
        usage.status = usage.inputTokens !== undefined && usage.cacheReadTokens !== undefined ? 'reported' : 'partial';
        if ((usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > (usage.inputTokens ?? Infinity)) usage.status = 'inconsistent';
      }
      // A reset/compaction without a reliable baseline remains explicitly session-scoped.
    }
    return { usage, checkpoint: { nativeId, usage: { ...native } } };
  }
}

/** Decimal Token units; promote before rounding so 999,999 never renders as 1000.0K. */
export function formatTokens(value?: number): string {
  if (!tokenCount(value)) return '未提供';
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Number((value / 1_000).toFixed(3))}K`;
}
