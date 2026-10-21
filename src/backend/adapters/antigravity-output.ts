export interface AntigravityOutputEvent {
  kind: 'init' | 'delta' | 'tool' | 'usage';
  text: string;
  data: Record<string, unknown>;
  usageScope?: 'step' | 'conversation';
}

export interface AntigravityTerminal {
  conversation_id: string;
  status: string;
  response: string;
  error?: string;
  usage?: Record<string, unknown>;
}

const MAX_LINE_CHARS = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 8 * 1024 * 1024;

// 文档将 step 的 state 表述为穷尽集合：运行中 ACTIVE，完成 DONE。
const STEP_STATES: ReadonlySet<string> = new Set(['ACTIVE', 'DONE']);
// 文档明示 step_type 是开放集合（include user_input/agent_response/tool/checkpoint），
// 因此只校验非空字符串；agent_response 之外不计正文，tool 之外不发 tool 事件。
const RESULT_STATUSES: ReadonlySet<string> = new Set(['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function preview(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
}

function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export class AntigravityOutput {
  private buffer = '';
  private conversationId: string | null = null;
  private bodyParts: string[] = [];
  private bodyLength = 0;
  private lastResponseStep: number | undefined;
  private lastResponseText = '';
  private terminal: AntigravityTerminal | null = null;
  private closed = false;

  constructor(private readonly callback: (event: AntigravityOutputEvent) => void) {}

  feed(chunk: string): void {
    if (this.closed) throw new Error('AntigravityOutput: feed() 已在 finish() 之后调用');
    if (typeof chunk !== 'string') throw new TypeError('AntigravityOutput: feed() 需要 string 分片');
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      const lineEnd = newline === -1 ? this.buffer.length : newline;
      if (lineEnd > MAX_LINE_CHARS) {
        throw new Error(`AntigravityOutput: 单行超过 ${MAX_LINE_CHARS} 字符上限: ${preview(this.buffer.slice(0, lineEnd))}`);
      }
      if (newline === -1) break;
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(stripTrailingCr(rawLine));
    }
  }

  finish(): AntigravityTerminal {
    if (this.closed) {
      if (this.terminal !== null) return this.terminal;
      throw new Error('AntigravityOutput: finish() 已调用且未获得 result');
    }
    const leftover = stripTrailingCr(this.buffer);
    this.buffer = '';
    if (leftover !== '') this.handleLine(leftover);
    this.closed = true;
    if (this.terminal === null) throw new Error('AntigravityOutput: 输出流缺少 result 终结事件');
    return this.terminal;
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`AntigravityOutput: 无效 JSON 行: ${preview(line)}`);
    }
    if (!isPlainObject(parsed)) throw new Error(`AntigravityOutput: 输出行不是 JSON 对象: ${preview(line)}`);
    const eventName = parsed['event'];
    if (typeof eventName !== 'string' || eventName === '') throw new Error(`AntigravityOutput: 缺少 event 字段: ${preview(line)}`);
    if (this.terminal !== null) {
      if (eventName === 'result') throw new Error('AntigravityOutput: 重复的 result 事件');
      throw new Error(`AntigravityOutput: result 之后仍有输出: ${preview(line)}`);
    }
    if (eventName === 'init') this.handleInit(parsed);
    else if (eventName === 'step_update') this.handleStepUpdate(parsed);
    else if (eventName === 'result') this.handleResult(parsed);
    // 未知 event 名称允许出现，跳过且不改变状态。
  }

  private handleInit(envelope: Record<string, unknown>): void {
    if (this.conversationId !== null) throw new Error('AntigravityOutput: 重复的 init 事件');
    const conversationId = envelope['conversation_id'];
    if (typeof conversationId !== 'string' || conversationId === '') throw new Error('AntigravityOutput: init 的 conversation_id 必须是非空字符串');
    const init = envelope['init'];
    if (!isPlainObject(init)) throw new Error('AntigravityOutput: init 载荷必须是对象');
    this.conversationId = conversationId;
    this.callback({ kind: 'init', text: '', data: { ...init, conversation_id: conversationId } });
  }

  private handleStepUpdate(envelope: Record<string, unknown>): void {
    if (this.conversationId === null) throw new Error('AntigravityOutput: init 之前收到 step_update');
    const step = envelope['step_update'];
    if (!isPlainObject(step)) throw new Error('AntigravityOutput: step_update 载荷必须是对象');
    const conversationId = step['conversation_id'];
    if (typeof conversationId !== 'string' || conversationId === '') throw new Error('AntigravityOutput: step_update 的 conversation_id 必须是非空字符串');
    if (conversationId !== this.conversationId) throw new Error(`AntigravityOutput: step_update 会话不一致: 期望 ${this.conversationId}，实际 ${conversationId}`);
    const stepIndex = step['step_index'];
    if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0) throw new Error('AntigravityOutput: step_index 必须是非负整数');
    const state = step['state'];
    if (typeof state !== 'string' || !STEP_STATES.has(state)) throw new Error(`AntigravityOutput: 未知的 step_update state: ${String(state)}`);
    const stepType = step['step_type'];
    if (typeof stepType !== 'string' || stepType === '') throw new Error('AntigravityOutput: step_type 必须是非空字符串');
    if (stepType === 'agent_response') {
      const textDelta = step['text_delta'];
      if (textDelta !== undefined) {
        if (typeof textDelta !== 'string') throw new Error('AntigravityOutput: text_delta 必须是字符串');
        if (this.lastResponseStep !== stepIndex) { this.lastResponseStep = stepIndex; this.lastResponseText = ''; }
        this.lastResponseText += textDelta;
        this.appendBody(textDelta);
        this.callback({ kind: 'delta', text: textDelta, data: step });
      }
    } else if (stepType === 'tool') {
      const toolName = step['tool_name'];
      this.callback({ kind: 'tool', text: typeof toolName === 'string' ? toolName : '', data: step });
    }
    // user_input/checkpoint 及未来类型：不影响正文，也不发 tool 事件。
    const usage = step['usage'];
    if (isPlainObject(usage)) this.callback({ kind: 'usage', text: '', data: usage, usageScope: 'step' });
  }

  private handleResult(envelope: Record<string, unknown>): void {
    if (this.terminal !== null) throw new Error('AntigravityOutput: 重复的 result 事件');
    const result = envelope['result'];
    if (!isPlainObject(result)) throw new Error('AntigravityOutput: result 载荷必须是对象');
    const status = result['status'];
    if (typeof status !== 'string' || !RESULT_STATUSES.has(status)) throw new Error(`AntigravityOutput: 未知的 result status: ${String(status)}`);
    const conversationId = result['conversation_id'];
    if (typeof conversationId !== 'string') throw new Error('AntigravityOutput: result 的 conversation_id 必须是字符串');
    let response = '';
    if (status === 'SUCCESS') {
      if (this.conversationId === null) throw new Error('AntigravityOutput: SUCCESS result 出现在 init 之前');
      if (conversationId === '') throw new Error('AntigravityOutput: SUCCESS result 的 conversation_id 不能为空');
      if (conversationId !== this.conversationId) throw new Error(`AntigravityOutput: result 会话不一致: 期望 ${this.conversationId}，实际 ${conversationId}`);
      const raw = result['response'];
      if (typeof raw !== 'string' || raw.trim() === '') throw new Error('AntigravityOutput: SUCCESS result 缺少非空字符串 response');
      const streamed = this.bodyParts.join('');
      // Earlier agent steps can be progress messages before tools. The terminal
      // response may contain only the last answer; never append that answer twice.
      const prefix = raw.startsWith(streamed) ? streamed : this.lastResponseText;
      if (streamed && (!prefix || !raw.startsWith(prefix))) throw new Error('AntigravityOutput: result.response 与已流式输出的 text_delta 不一致');
      const tail = raw.slice(prefix.length);
      if (tail !== '') {
        this.appendBody(tail);
        this.callback({ kind: 'delta', text: tail, data: result });
      }
      response = raw;
    } else {
      if (this.conversationId !== null && conversationId !== '' && conversationId !== this.conversationId) {
        throw new Error(`AntigravityOutput: result 会话不一致: 期望 ${this.conversationId}，实际 ${conversationId}`);
      }
      if (typeof result['response'] === 'string') response = result['response'];
    }
    const usage = result['usage'];
    const usageObject = isPlainObject(usage);
    if (usageObject) this.callback({ kind: 'usage', text: '', data: usage, usageScope: 'conversation' });
    const terminal: AntigravityTerminal = { conversation_id: conversationId, status, response };
    if (typeof result['error'] === 'string') terminal.error = result['error'];
    if (usageObject) terminal.usage = usage;
    this.terminal = terminal;
  }

  private appendBody(text: string): void {
    if (this.bodyLength + text.length > MAX_BODY_CHARS) throw new Error(`AntigravityOutput: 正文累计超过 ${MAX_BODY_CHARS} 字符上限`);
    this.bodyParts.push(text);
    this.bodyLength += text.length;
  }
}
