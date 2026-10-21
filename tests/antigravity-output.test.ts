import test from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityOutput, type AntigravityOutputEvent } from '../src/backend/adapters/antigravity-output';

const MAX_LINE_CHARS = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 8 * 1024 * 1024;

function createCollector(): { parser: AntigravityOutput; events: AntigravityOutputEvent[] } {
  const events: AntigravityOutputEvent[] = [];
  return { parser: new AntigravityOutput(event => { events.push(event); }), events };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function feedChunked(parser: AntigravityOutput, text: string, size: number): void {
  for (let i = 0; i < text.length; i += size) parser.feed(text.slice(i, i + size));
}

function deltaText(events: AntigravityOutputEvent[]): string {
  return events.filter(event => event.kind === 'delta').map(event => event.text).join('');
}

const initLine = line({ event: 'init', conversation_id: 'c1', init: { cwd: '/project', model: 'gemini-3.8-flash-high' } });

function stepLine(overrides: Record<string, unknown> = {}): string {
  return line({
    event: 'step_update',
    step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'x', ...overrides },
  });
}

const OFFICIAL_STREAM = [
  '{"event":"init","conversation_id":"c1","init":{"cwd":"/project","tools":["run_command"],"permission_mode":"request-review","model":"gemini-3.8-flash-high"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"hello"}}',
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":" world","usage":{"input_tokens":10}}}',
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo test"},"output":"test"}}}',
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"hello world","num_turns":1,"usage":{"input_tokens":10,"output_tokens":2}}}',
].join('\n') + '\n';

const CN_STREAM = [
  line({ event: 'init', conversation_id: 'c9', init: { cwd: '/tmp', model: 'gemini-3.8-flash-high' } }),
  line({ event: 'step_update', step_update: { conversation_id: 'c9', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: '你好' } }),
  line({ event: 'step_update', step_update: { conversation_id: 'c9', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: '，世界' } }),
  line({ event: 'step_update', step_update: { conversation_id: 'c9', step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: '！', usage: { input_tokens: 3 } } }),
  line({ event: 'result', result: { conversation_id: 'c9', status: 'SUCCESS', response: '你好，世界！', num_turns: 1, usage: { input_tokens: 3, output_tokens: 5 } } }),
].join('');

test('官方事件正常：完整官方样例流端到端解析', () => {
  const { parser, events } = createCollector();
  parser.feed(OFFICIAL_STREAM);
  const terminal = parser.finish();
  assert.deepEqual(events.map(event => event.kind), ['init', 'delta', 'delta', 'usage', 'tool', 'usage']);
  const [init, firstDelta, secondDelta] = events;
  assert.equal(init.kind, 'init');
  assert.equal(init.text, '');
  assert.deepEqual(init.data, { cwd: '/project', tools: ['run_command'], permission_mode: 'request-review', model: 'gemini-3.8-flash-high', conversation_id: 'c1' });
  assert.equal(firstDelta.text, 'hello');
  assert.equal(secondDelta.text, ' world');
  assert.equal(firstDelta.data.step_index, 2);
  const tool = events.find(event => event.kind === 'tool');
  assert.ok(tool);
  assert.equal(tool.text, 'run_command');
  assert.deepEqual(tool.data.tool_info, { name: 'run_command', parameters: { CommandLine: 'echo test' }, output: 'test' });
  const usages = events.filter(event => event.kind === 'usage');
  assert.deepEqual(usages[0].data, { input_tokens: 10 });
  assert.deepEqual(usages[1].data, { input_tokens: 10, output_tokens: 2 });
  assert.equal(deltaText(events), 'hello world');
  assert.deepEqual(terminal, { conversation_id: 'c1', status: 'SUCCESS', response: 'hello world', usage: { input_tokens: 10, output_tokens: 2 } });
});

test('init 载荷中的 conversation_id 被外层值覆盖', () => {
  const { parser, events } = createCollector();
  parser.feed(line({ event: 'init', conversation_id: 'outer', init: { conversation_id: 'inner', model: 'm' } }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'outer', status: 'SUCCESS', response: 'ok' } }));
  parser.finish();
  assert.equal(events[0].data.conversation_id, 'outer');
});

test('任意 chunk 切分含中文：拼接结果与整流一致', () => {
  for (const size of [1, 2, 3, 7, 40]) {
    const { parser, events } = createCollector();
    feedChunked(parser, CN_STREAM, size);
    const terminal = parser.finish();
    assert.deepEqual(events.filter(event => event.kind === 'delta').map(event => event.text), ['你好', '，世界', '！']);
    assert.equal(deltaText(events), '你好，世界！');
    assert.equal(terminal.response, '你好，世界！');
  }
});

test('CRLF 行尾及跨 chunk 的 CR/LF 拆分', () => {
  const crlf = CN_STREAM.replace(/\n/g, '\r\n');
  for (const size of [1, 3, 11]) {
    const { parser, events } = createCollector();
    feedChunked(parser, crlf, size);
    const terminal = parser.finish();
    assert.equal(deltaText(events), '你好，世界！');
    assert.equal(terminal.status, 'SUCCESS');
  }
});

test('最后一行仅以 CR 结束时 finish 仍处理', () => {
  const lines = CN_STREAM.split('\n').filter(value => value !== '');
  const { parser } = createCollector();
  parser.feed(lines.slice(0, -1).join('\r\n') + '\r\n' + lines[lines.length - 1] + '\r');
  const terminal = parser.finish();
  assert.equal(terminal.status, 'SUCCESS');
  assert.equal(terminal.response, '你好，世界！');
});

test('无末尾换行：finish 处理最后一行', () => {
  const { parser, events } = createCollector();
  parser.feed(OFFICIAL_STREAM.trimEnd());
  const terminal = parser.finish();
  assert.equal(terminal.status, 'SUCCESS');
  assert.equal(deltaText(events), 'hello world');
});

test('补尾不重复：result 以前缀补齐尾部，不重发全文', () => {
  const { parser, events } = createCollector();
  parser.feed(initLine);
  parser.feed(stepLine({ text_delta: 'hello' }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'hello world' } }));
  const terminal = parser.finish();
  assert.deepEqual(events.filter(event => event.kind === 'delta').map(event => event.text), ['hello', ' world']);
  assert.equal(terminal.response, 'hello world');
});

test('没有增量时 result 正文只发一次 delta', () => {
  const { parser, events } = createCollector();
  parser.feed(initLine);
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'full text' } }));
  const terminal = parser.finish();
  assert.deepEqual(events.filter(event => event.kind === 'delta').map(event => event.text), ['full text']);
  assert.equal(terminal.response, 'full text');
});

test('工具输出不污染正文', () => {
  const { parser, events } = createCollector();
  parser.feed(initLine);
  parser.feed(stepLine({ step_index: 1, text_delta: 'answer: ' }));
  parser.feed(line({
    event: 'step_update',
    step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', output: 'JUNK-STDOUT' } },
  }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'answer: 42' } }));
  const terminal = parser.finish();
  assert.equal(deltaText(events), 'answer: 42');
  const tool = events.find(event => event.kind === 'tool');
  assert.ok(tool);
  assert.deepEqual(tool.data.tool_info, { name: 'run_command', output: 'JUNK-STDOUT' });
  assert.equal(terminal.response, 'answer: 42');
});

test('重复合法 text 片段不按内容去重', () => {
  const { parser, events } = createCollector();
  parser.feed(initLine);
  parser.feed(stepLine({ text_delta: 'ab' }));
  parser.feed(stepLine({ text_delta: 'ab' }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'abab' } }));
  const terminal = parser.finish();
  assert.deepEqual(events.filter(event => event.kind === 'delta').map(event => event.text), ['ab', 'ab']);
  assert.equal(terminal.response, 'abab');
});

test('未知顶层事件被忽略且不中断', () => {
  const { parser, events } = createCollector();
  parser.feed(line({ event: 'telemetry', payload: { x: 1 } }));
  parser.feed(initLine);
  parser.feed(line({ event: 'future_event', data: 'whatever' }));
  parser.feed(stepLine({ text_delta: 'ok' }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'ok' } }));
  const terminal = parser.finish();
  assert.equal(terminal.status, 'SUCCESS');
  assert.equal(deltaText(events), 'ok');
});

test('user_input/checkpoint 类型步骤跳过且不发正文或工具事件', () => {
  const { parser, events } = createCollector();
  parser.feed(initLine);
  parser.feed(line({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 0, state: 'DONE', step_type: 'user_input', text_delta: 'ignored' } }));
  parser.feed(line({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 3, state: 'DONE', step_type: 'checkpoint', usage: { input_tokens: 1 } } }));
  parser.feed(stepLine({ text_delta: 'body' }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'body' } }));
  parser.finish();
  assert.equal(deltaText(events), 'body');
  assert.equal(events.some(event => event.kind === 'tool'), false);
  assert.deepEqual(events.filter(event => event.kind === 'usage').map(event => event.data), [{ input_tokens: 1 }]);
});

test('空行与空白行被容忍', () => {
  const { parser, events } = createCollector();
  parser.feed('\n');
  parser.feed(initLine);
  parser.feed('\n\n');
  parser.feed(stepLine({ text_delta: 'ok' }));
  parser.feed('\n');
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'ok' } }));
  parser.feed('\n');
  const terminal = parser.finish();
  assert.equal(terminal.status, 'SUCCESS');
  assert.equal(deltaText(events), 'ok');
});

test('非法 JSON 行抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  assert.throws(() => parser.feed('{not json\n'), /无效 JSON/);
});

test('截断的最后一行 JSON 由 finish 抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  parser.feed('{"event":"result","result":{"status":');
  assert.throws(() => parser.finish(), /无效 JSON/);
});

test('缺少 result 时 finish 抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  parser.feed(stepLine({ text_delta: 'partial' }));
  assert.throws(() => parser.finish(), /缺少 result/);
});

test('重复 result 抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'ok' } }));
  assert.throws(() => parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'ok' } })), /重复的 result/);
});

test('result 之后继续输出抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'ok' } }));
  assert.throws(() => parser.feed(stepLine({ text_delta: 'late' })), /result 之后/);
});

test('错会话：step_update 会话不一致抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  assert.throws(() => parser.feed(stepLine({ conversation_id: 'c2' })), /会话不一致/);
});

test('错会话：SUCCESS result 会话不一致抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  assert.throws(() => parser.feed(line({ event: 'result', result: { conversation_id: 'c2', status: 'SUCCESS', response: 'ok' } })), /会话不一致/);
});

test('错会话：init 之前出现 step_update 抛错', () => {
  const { parser } = createCollector();
  assert.throws(() => parser.feed(stepLine()), /init 之前/);
});

test('错会话：init 之前出现 SUCCESS result 抛错', () => {
  const { parser } = createCollector();
  assert.throws(() => parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'ok' } })), /init 之前/);
});

test('错会话：init 后非成功 result 携带其他非空会话抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  assert.throws(() => parser.feed(line({ event: 'result', result: { conversation_id: 'other', status: 'ERROR', error: 'boom' } })), /会话不一致/);
});

test('非法 usage 保持原始且不崩溃', () => {
  const { parser, events } = createCollector();
  parser.feed(initLine);
  parser.feed(stepLine({ text_delta: 'ok', usage: 123 }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'ok', usage: 'nope' } }));
  const terminal = parser.finish();
  assert.equal(terminal.status, 'SUCCESS');
  assert.equal(terminal.usage, undefined);
  assert.equal(events.some(event => event.kind === 'usage'), false);
  const deltaEvent = events.find(event => event.kind === 'delta');
  assert.ok(deltaEvent);
  assert.equal(deltaEvent.data.usage, 123);
});

test('所有非成功状态返回 terminal 交由主控决定', () => {
  for (const status of ['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']) {
    const { parser } = createCollector();
    parser.feed(initLine);
    parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status, response: 'partial work', error: 'boom', num_turns: 1 } }));
    const terminal = parser.finish();
    assert.equal(terminal.status, status);
    assert.equal(terminal.conversation_id, 'c1');
    assert.equal(terminal.response, 'partial work');
    assert.equal(terminal.error, 'boom');
  }
});

test('认证前失败的 ERROR result：无 init、空会话也可接受', () => {
  const { parser, events } = createCollector();
  parser.feed(line({
    event: 'result',
    result: { conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection: unknown model', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
  }));
  const terminal = parser.finish();
  assert.equal(terminal.status, 'ERROR');
  assert.equal(terminal.conversation_id, '');
  assert.equal(terminal.response, '');
  assert.equal(terminal.error, 'invalid model selection: unknown model');
  assert.deepEqual(terminal.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  assert.deepEqual(events.filter(event => event.kind === 'usage').map(event => event.data), [{ input_tokens: 0, output_tokens: 0, total_tokens: 0 }]);
});

test('未知 result status 拒绝', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  assert.throws(() => parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'WEIRD', response: 'x' } })), /未知的 result status/);
});

test('空 SUCCESS：response 缺失、空串或非字符串均抛错', () => {
  for (const response of [undefined, '', '   \n', 42]) {
    const { parser } = createCollector();
    parser.feed(initLine);
    const result: Record<string, unknown> = { conversation_id: 'c1', status: 'SUCCESS' };
    if (response !== undefined) result.response = response;
    assert.throws(() => parser.feed(line({ event: 'result', result })), /response/);
  }
});

test('result 正文与已发增量不一致抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  parser.feed(stepLine({ text_delta: 'hello' }));
  assert.throws(() => parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'goodbye' } })), /不一致/);
});

test('result 正文比已发增量更短同样抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  parser.feed(stepLine({ text_delta: 'hello world' }));
  assert.throws(() => parser.feed(line({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'hello' } })), /不一致/);
});

test('多个回答步骤的最终回执可只包含最后一步，补尾且不重复最终回答', () => {
  for (const tail of ['', ' All checked.']) {
    const {parser,events}=createCollector();
    parser.feed(initLine);
    parser.feed(stepLine({step_index:1,text_delta:'Starting work.\n'}));
    parser.feed(stepLine({step_index:3,text_delta:'Done.'}));
    parser.feed(line({event:'result',result:{conversation_id:'c1',status:'SUCCESS',response:'Done.'+tail}}));
    assert.equal(parser.finish().response,'Done.'+tail);
    assert.equal(deltaText(events),'Starting work.\nDone.'+tail);
  }
});

test('包结构逐级校验：非法信封抛错', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['顶层数组', '[1,2]\n', /不是 JSON 对象/],
    ['顶层字符串', '"hello"\n', /不是 JSON 对象/],
    ['缺少 event 字段', line({ conversation_id: 'c1' }), /缺少 event 字段/],
    ['event 非字符串', line({ event: 7 }), /缺少 event 字段/],
    ['init 载荷缺失', line({ event: 'init', conversation_id: 'c1' }), /init 载荷/],
    ['init 载荷为 null', line({ event: 'init', conversation_id: 'c1', init: null }), /init 载荷/],
    ['init 会话为空', line({ event: 'init', conversation_id: '', init: {} }), /conversation_id 必须/],
    ['重复 init', initLine + initLine, /重复的 init/],
    ['step 载荷缺失', initLine + line({ event: 'step_update' }), /step_update 载荷/],
    ['step 会话为空', initLine + stepLine({ conversation_id: '' }), /conversation_id 必须/],
    ['step_index 为负', initLine + stepLine({ step_index: -1 }), /step_index/],
    ['step_index 非整数', initLine + stepLine({ step_index: 1.5 }), /step_index/],
    ['step_index 非数字', initLine + stepLine({ step_index: '2' }), /step_index/],
    ['state 非法', initLine + stepLine({ state: 'RUNNING' }), /state/],
    ['state 缺失', initLine + line({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, step_type: 'agent_response' } }), /state/],
    ['step_type 为空', initLine + stepLine({ step_type: '' }), /step_type/],
    ['step_type 非字符串', initLine + stepLine({ step_type: 5 }), /step_type/],
    ['text_delta 非字符串', initLine + stepLine({ text_delta: 9 }), /text_delta/],
    ['result 载荷缺失', initLine + line({ event: 'result' }), /result 载荷/],
    ['result 会话非字符串', initLine + line({ event: 'result', result: { status: 'ERROR' } }), /conversation_id 必须/],
  ];
  for (const [name, chunk, message] of cases) {
    const { parser } = createCollector();
    assert.throws(() => parser.feed(chunk), message, `case: ${name}`);
  }
});

test('单行超过 2MiB 抛错', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  const huge = `{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"${'a'.repeat(MAX_LINE_CHARS)}"}}`;
  assert.throws(() => parser.feed(`${huge}\n`), /单行超过/);
});

test('正文累计超过 8MiB 抛错，恰好 8MiB 允许', () => {
  const { parser } = createCollector();
  parser.feed(initLine);
  const oneMiB = 'a'.repeat(1024 * 1024);
  const chunk = line({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: oneMiB } });
  for (let i = 0; i < MAX_BODY_CHARS / oneMiB.length; i += 1) parser.feed(chunk);
  assert.throws(() => parser.feed(chunk), /正文累计超过/);
});

test('parser 单次使用：finish 后 feed 抛错、重复 finish 幂等', () => {
  const { parser } = createCollector();
  parser.feed(OFFICIAL_STREAM);
  const terminal = parser.finish();
  assert.throws(() => parser.feed('{"event":"result"}\n'), /finish\(\) 之后/);
  assert.equal(parser.finish(), terminal);
});

test('文档式样例：agent/json_schema 透传与带换行正文（拼接一致）', () => {
  const { parser, events } = createCollector();
  parser.feed(line({
    event: 'init',
    conversation_id: 'b7',
    init: { cwd: '/project', tools: ['run_command'], permission_mode: 'request-review', agent: { name: 'My Agent', description: 'demo' }, json_schema: { type: 'object', properties: { status: { type: 'string' } } } },
  }));
  parser.feed(line({ event: 'step_update', step_update: { conversation_id: 'b7', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Understood. Starting execution now.\n' } }));
  parser.feed(line({ event: 'step_update', step_update: { conversation_id: 'b7', step_index: 0, state: 'DONE', step_type: 'agent_response', text_delta: 'Done.\n', usage: { input_tokens: 150, output_tokens: 1 } } }));
  parser.feed(line({ event: 'result', result: { conversation_id: 'b7', status: 'SUCCESS', response: 'Understood. Starting execution now.\nDone.\n', duration_seconds: 12.5, num_turns: 4, usage: { input_tokens: 150, output_tokens: 1 } } }));
  const terminal = parser.finish();
  assert.equal(deltaText(events), 'Understood. Starting execution now.\nDone.\n');
  assert.equal(terminal.response, 'Understood. Starting execution now.\nDone.\n');
  assert.deepEqual(events[0].data.agent, { name: 'My Agent', description: 'demo' });
  assert.deepEqual(events[0].data.json_schema, { type: 'object', properties: { status: { type: 'string' } } });
});
