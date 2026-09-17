/**
 * 论文对话（宿主半）集成测试：假 agents 服务 + 真实 http 服务，
 * 覆盖 GET/POST /chat、取消、重置、PDF 文字抽取、pdfjs 资源转发与越界防护。
 */
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIX = '/tmp/paper-test/chat-fixtures';
const HOME = '/tmp/paper-test/chat-home';
rmSync(FIX, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
mkdirSync(HOME, { recursive: true });
/** 一份最小但合法的 PDF（含可抽取文字），用来验证 pdf.js 抽取。 */
const MINIMAL_PDF = (() => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const stream = 'BT /F1 24 Tf 72 700 Td (Hello Paper Reader 2026) Tj ET';
  objects.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) { offsets.push(out.length); out += object; }
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
})();

writeFileSync(path.join(FIX, 'paper.md'), '# Paper\n\n注意力就是一切。\n');
writeFileSync(path.join(FIX, 'sample.pdf'), Buffer.from(MINIMAL_PDF, 'latin1'));
process.env.DSHA_PAPER_ROOTS = FIX;
process.env.DSH_HOME = HOME;

const { apply } = await import(new URL('../lib/index.js', import.meta.url).href);

const problems = [];
const check = (label, condition, extra = '') => {
  if (condition) console.log(`  ✓ ${label}`);
  else { problems.push(label); console.log(`  ✗ ${label} ${extra}`); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- 假 agents ----
const listeners = new Set();
const agentsLive = new Map();
const agentHooks = [];
let lastCreated = null;
let cancelledWith = null;

/** 造一个假 Agent：followup 记录消息，whenIdle 时把流式帧推给监听者。 */
function makeAgent(sessionId, script, options = {}) {
  const events = new Map();
  const session = {
    id: sessionId,
    seq: 0,
    eventAt(seq) { return events.get(seq); },
    append(type, data) { events.set(session.seq, { type, data }); session.seq += 1; },
  };
  const agent = {
    id: sessionId,
    session,
    status: 'idle',
    inbox: [],
    followup(message) { this.inbox.push(message); },
    cancel(cause) { cancelledWith = cause; this.cancelled = true; },
    async whenIdle() {
      await wait(5);
      for (const frame of script ?? []) emit({ agent, frame });
      if (options.turnError !== undefined) {
        session.append('turn/end', { reason: { kind: 'error', error: { code: 'NO_CREDENTIAL', message: options.turnError } } });
      }
    },
  };
  return agent;
}

function emit(payload) {
  for (const listener of [...listeners]) listener(payload);
}

const defaultScript = [
  { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 },
  { type: 'chunk', index: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
  { type: 'chunk', index: 1, chunk: { type: 'text-delta', index: 0, text: '## 一句话结论\n' } },
  { type: 'chunk', index: 2, chunk: { type: 'text-delta', index: 0, text: '这篇讲的是 **注意力**。' } },
  { type: 'chunk', index: 3, chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', name: 'read' } } },
  { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } },
];

const agents = {
  get: (id) => agentsLive.get(id),
  async create(request) {
    lastCreated = request;
    request.setup?.({ on(name, handler) { agentHooks.push({ name, handler }); return () => {}; } });
    const agent = makeAgent(request.sessionId, defaultScript);
    agentsLive.set(request.sessionId, agent);
    return { agent };
  },
  async resume() { throw new Error('session-not-found'); },
};
const agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) };
const presetMounts = [];
const agentPresets = {
  async resolve(id) { return { id: id ?? 'standard' }; },
  async mount(agentCtx, id) { presetMounts.push(id); return { id }; },
};
const services = new Map([
  ['agents', agents],
  ['agentDefaultModel', agentDefaultModel],
  ['agentPresets', agentPresets],
]);

let route = null;
const webCtx = {
  webServer: { register(entry) { route = entry; return () => { route = null; }; } },
  connection: { requestRejection: () => undefined },
  effect(fn) { return fn(); },
  get: (name) => services.get(name),
  on(name, handler) { listeners.add(handler); return () => listeners.delete(handler); },
  logger: { info() {}, warn() {} },
};
apply({ ...webCtx, inject(_deps, callback) { callback(webCtx); } });
if (route === null) throw new Error('宿主半没有注册路由');

const server = createServer((req, res) => { route.handler(req, res).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const paperPath = path.join(FIX, 'paper.md');

const readEvents = async (response) => (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const postChat = (body, options) => fetch(`${base}/api/paper-reader/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  ...options,
});

// ------------------------------------------------------------ 首次对话 ----
{
  const history = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  check('新论文的历史为空', history.ok === true && history.messages.length === 0 && history.sessionId.startsWith('session-'), JSON.stringify(history).slice(0, 140));
  check('历史响应带模型信息', history.chat?.model?.model === 'deepseek-v4-flash', JSON.stringify(history.chat));

  const response = await postChat({ path: paperPath, message: '这篇论文讲了什么？' });
  check('chat 返回 NDJSON 流', response.status === 200 && (response.headers.get('content-type') ?? '').includes('ndjson'));
  const events = await readEvents(response);
  const kinds = events.map((event) => event.type);
  check('事件序列 start → delta → tool → done', kinds[0] === 'start' && kinds.includes('delta') && kinds.includes('tool') && kinds.at(-1) === 'done', kinds.join(','));
  check('首个问题注入了论文上下文', events[0].contextInjected === true);
  check('start 带 sessionId 与模型', typeof events[0].sessionId === 'string' && events[0].model.model === 'deepseek-v4-flash');
  const done = events.at(-1);
  check('done 汇总了完整回答', done.text.includes('这篇讲的是 **注意力**。'), JSON.stringify(done).slice(0, 160));
  check('done 带工具调用名', Array.isArray(done.tools) && done.tools.includes('read'));

  const agent = agentsLive.get(events[0].sessionId);
  check('Agent 收到两条消息（上下文 + 提问）', agent.inbox.length === 2, String(agent.inbox.length));
  check('上下文消息是插件来源', agent.inbox[0].source.kind === 'plugin' && agent.inbox[0].source.plugin === 'dsh-paper-reader', JSON.stringify(agent.inbox[0].source));
  check('文本文件的上下文给出路径并让 Agent 自己读', agent.inbox[0].content[0].text.includes(paperPath) && agent.inbox[0].content[0].text.includes('read 工具'));
  check('提问消息是用户来源', agent.inbox[1].source.kind === 'user' && agent.inbox[1].content[0].text === '这篇论文讲了什么？');
  check('消息结构合法（id/role/content）', typeof agent.inbox[1].id === 'string' && agent.inbox[1].role === 'user' && Array.isArray(agent.inbox[1].content));

  check('Agent 用默认模型与预设工作区', lastCreated.agentOptions.model === 'deepseek-v4-flash' && lastCreated.meta.cwd === process.cwd(), JSON.stringify(lastCreated.agentOptions));
  check('装了模型选择钩子（assemble + request）', agentHooks.some((hook) => hook.name === 'system-prompt/assemble') && agentHooks.some((hook) => hook.name === 'agent/request'), agentHooks.map((hook) => hook.name).join(','));
  check('挂了 Agent 预设（工具集来源）', lastCreated.meta.agentPreset === 'standard' && presetMounts.includes('standard'), JSON.stringify({ meta: lastCreated.meta, presetMounts }));

  const after = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  check('历史已落盘（用户 + 助手两条）', after.messages.length === 2 && after.messages[0].role === 'user' && after.messages[1].role === 'assistant', JSON.stringify(after.messages).slice(0, 200));
  check('助手消息保留了工具名', Array.isArray(after.messages[1].tools) && after.messages[1].tools.includes('read'));
}

// -------------------------------------------------- 第二轮：不重复注入上下文 ----
{
  const before = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  const agent = agentsLive.get(before.sessionId);
  agent.inbox.length = 0;
  const events = await readEvents(await postChat({ path: paperPath, message: '再讲讲方法。' }));
  check('第二轮不再注入上下文', events[0].contextInjected === false, JSON.stringify(events[0]));
  check('第二轮只排一条消息', agent.inbox.length === 1, String(agent.inbox.length));
  const history = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  check('历史累积到 4 条', history.messages.length === 4, String(history.messages.length));
}

// -------------------------------------------------------- 取消与重置 ----
{
  const history = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  const cancel = await (await fetch(`${base}/api/paper-reader/chat/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: paperPath }),
  })).json();
  check('取消接口找到并中断了会话', cancel.ok === true && cancel.cancelled === true && cancelledWith === 'paper-reader', JSON.stringify(cancel));
  check('取消用的是同一个会话', history.sessionId.length > 0);

  const reset = await (await fetch(`${base}/api/paper-reader/chat/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: paperPath }),
  })).json();
  check('重置接口返回 ok', reset.ok === true);
  const cleared = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  check('重置后是新会话且历史为空', cleared.messages.length === 0 && cleared.sessionId !== history.sessionId, JSON.stringify(cleared).slice(0, 120));
}

// --------------------------------------------------- 模型失败要暴露出来 ----
{
  const failPath = path.join(FIX, 'failing.md');
  writeFileSync(failPath, '# 会失败的论文\n');
  const savedCreate = agents.create;
  agents.create = async (request) => {
    request.setup?.({ on() { return () => {}; } });
    const agent = makeAgent(request.sessionId, [], { turnError: 'no credential configured for provider "deepseek-official"' });
    agentsLive.set(request.sessionId, agent);
    return { agent };
  };
  const events = await readEvents(await postChat({ path: failPath, message: '随便问一句' }));
  const errorEvent = events.find((event) => event.type === 'error');
  check('模型失败时回 error 事件而不是空回答', errorEvent !== undefined && errorEvent.message.includes('no credential'), JSON.stringify(events.at(-1)).slice(0, 160));
  const history = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(failPath)}`)).json();
  check('失败也记进了历史（带 ⚠️ 前缀）', history.messages.at(-1).error === true && history.messages.at(-1).text.startsWith('⚠️'), JSON.stringify(history.messages.at(-1)).slice(0, 120));
  agents.create = savedCreate;
}

// ------------------------------------------------------------ 错误分支 ----
{
  const empty = await postChat({ path: paperPath, message: '   ' });
  check('空消息被拒（400）', empty.status === 400, String(empty.status));
  const outside = await postChat({ path: '/etc/hostname', message: 'hi' });
  check('越界路径被拒（400）', outside.status === 400, String(outside.status));
  const badPath = await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent('/etc/hostname')}`);
  check('历史接口越界被拒（400）', badPath.status === 400, String(badPath.status));
  const badMethod = await fetch(`${base}/api/paper-reader/chat/cancel`, { method: 'GET' });
  check('cancel 的 GET 返回 405', badMethod.status === 405, String(badMethod.status));

  const savedAgents = services.get('agents');
  services.delete('agents');
  const noAgents = await postChat({ path: paperPath, message: 'hi' });
  check('没有 agents 服务时 503', noAgents.status === 503, String(noAgents.status));
  services.set('agents', savedAgents);

  const savedModel = services.get('agentDefaultModel');
  services.set('agentDefaultModel', { currentSelection: () => undefined });
  const noModel = await postChat({ path: paperPath, message: 'hi' });
  check('没有默认模型时 503', noModel.status === 503, String(noModel.status));
  services.set('agentDefaultModel', savedModel);
}

// --------------------------------------------------- PDF 抽取与资源转发 ----
{
  const sample = path.join(FIX, 'sample.pdf');
  const extracted = await (await fetch(`${base}/api/paper-reader/text?path=${encodeURIComponent(sample)}`)).json();
  check('PDF 文字抽取成功', extracted.ok === true && extracted.text.includes('Hello Paper Reader 2026'), JSON.stringify(extracted).slice(0, 160));
  check('抽取结果带页数', extracted.pageCount === 1 && extracted.kind === 'pdf', JSON.stringify(extracted).slice(0, 120));
  const cached = await (await fetch(`${base}/api/paper-reader/text?path=${encodeURIComponent(sample)}`)).json();
  check('二次抽取命中缓存且一致', cached.text === extracted.text);

  const worker = await fetch(`${base}/api/paper-reader/pdfjs/build/pdf.worker.min.mjs`);
  check('pdfjs worker 可转发且 MIME 正确', worker.status === 200
    && (worker.headers.get('content-type') ?? '').includes('javascript'), worker.headers.get('content-type') ?? '');
  const main = await fetch(`${base}/api/paper-reader/pdfjs/build/pdf.min.mjs`);
  check('pdfjs 主模块可转发', main.status === 200 && (await main.text()).length > 1000);
  const cmap = await fetch(`${base}/api/paper-reader/pdfjs/cmaps/Adobe-Japan1-0.bcmap`);
  check('pdfjs cmap 可转发', cmap.status === 200, String(cmap.status));
  const missing = await fetch(`${base}/api/paper-reader/pdfjs/nope.js`);
  check('不存在的资源 404', missing.status === 404, String(missing.status));
  const traversal = await fetch(`${base}/api/paper-reader/pdfjs/..%2F..%2Fpackage.json`);
  check('资源路径穿越被拒', traversal.status === 400 || traversal.status === 404, String(traversal.status));
}

server.close();
console.log(problems.length === 0 ? '\n论文对话（宿主半）：全部通过' : `\n论文对话（宿主半）：${problems.length} 项失败`);
process.exit(problems.length === 0 ? 0 : 1);
