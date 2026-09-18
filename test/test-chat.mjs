/**
 * 论文**子代理**引擎集成测试（宿主半）：
 * 用假 subagents/agents 服务 + 真 http 服务，验证
 *   startContinuable 入参（父会话、上下文注入、provider）、状态/只读镜像、
 *   只读流、人类权限打断、重置、错误分支，以及 PDF 抽取与 pdfjs 资源转发。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FIX = '/tmp/paper-test/subagent-fixtures';
const HOME = '/tmp/paper-test/subagent-home';
rmSync(FIX, { recursive: true, force: true });
rmSync(HOME, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
mkdirSync(HOME, { recursive: true });

/** 一份最小但合法的 PDF（含可抽取文字）。 */
const MINIMAL_PDF = (() => {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const stream = 'BT /F1 24 Tf 72 700 Td (Hello Paper Subagent 2026) Tj ET';
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

// ------------------------------------------------------- 假 agents/subagents ----
const listeners = new Set();
const parents = new Map();
const children = new Map();
const starts = [];
const interrupts = [];
const prompts = [];

/** 造一个假 Agent（父或子）。 */
function makeAgent(sessionId, options = {}) {
  const events = new Map();
  const session = {
    id: sessionId,
    seq: 0,
    eventAt(seq) { return events.get(seq); },
    append(type, data) { events.set(session.seq, { type, data }); session.seq += 1; },
  };
  return {
    id: sessionId,
    session,
    status: options.status ?? 'idle',
    append: (type, data) => session.append(type, data),
  };
}

const parentAgent = makeAgent('session-parent', { status: 'idle' });
const otherParent = makeAgent('session-other', { status: 'idle' });
parents.set('session-parent', parentAgent);
parents.set('session-other', otherParent);

const agents = {
  get: (id) => parents.get(id) ?? children.get(id),
  async resume({ resumeSessionId }) {
    const existing = parents.get(resumeSessionId);
    if (existing !== undefined) return { agent: existing };
    throw new Error(`session "${resumeSessionId}" not found`);
  },
};

const subagents = {
  getProvider: (name) => (name === 'spawn' ? { name } : undefined),
  listProviders: () => ['spawn', 'fork'],
  async startContinuable(options) {
    starts.push(options);
    const child = makeAgent('child-1', { status: 'idle' });
    children.set('child-1', child);
    // 子代理首轮：写入用户消息 + 助手回答（供只读镜像折叠）
    child.append('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: options.request.prompt[0].text }], source: { kind: 'user' } });
    child.append('assistant/message', { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '这是子代理的总结。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } } });
    return { childId: 'child-1', messageId: 'm1' };
  },
  async prompt(request) { prompts.push(request); return { messageId: 'm-prompt-1' }; },
  interrupt: (childId, authority) => { interrupts.push({ childId, authority }); return undefined; },
};

/** 冷子代理：Activation 被回收后，日志仍在持久化里，用 sessionQuery 读。 */
const coldSessions = new Map();
const sessionQuery = {
  async readSession(sessionId) {
    const record = coldSessions.get(sessionId);
    if (record === undefined) throw new Error(`session "${sessionId}" not found`);
    return record;
  },
};
const services = new Map([['agents', agents], ['subagents', subagents], ['sessionQuery', sessionQuery]]);

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
const pdfPath = path.join(FIX, 'sample.pdf');

const post = (sub, body) => fetch(`${base}/api/paper-reader/${sub}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------- 能力声明 ----
{
  const health = await (await fetch(`${base}/api/paper-reader/health`)).json();
  check('health 报告子代理模式与 provider', health.chat?.mode === 'subagent' && health.chat?.available === true && health.chat?.provider === 'spawn', JSON.stringify(health.chat));

  const beforeState = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  check('未开始时状态为 none', beforeState.status === 'none' && beforeState.childId === null, JSON.stringify(beforeState).slice(0, 120));
  const noChildStream = await fetch(`${base}/api/paper-reader/chat/stream?path=${encodeURIComponent(paperPath)}`);
  check('未开始时 stream 返回 404', noChildStream.status === 404, String(noChildStream.status));
}

// ------------------------------------------------------------ 起子代理 ----
{
  const missing = await post('chat', { path: paperPath });
  check('缺 sessionId 被拒（400）', missing.status === 400, String(missing.status));
  const outside = await post('chat', { path: '/etc/hostname', sessionId: 'session-parent' });
  check('越界路径被拒（400）', outside.status === 400, String(outside.status));

  const response = await post('chat', { path: paperPath, sessionId: 'session-parent' });
  const payload = await response.json();
  check('启动成功并拿到子会话地址', response.status === 200 && payload.childId === 'child-1'
    && payload.address.childSessionId === 'child-1' && payload.address.parentSessionId === 'session-parent', JSON.stringify(payload).slice(0, 200));
  check('用的是进程内 spawn provider', starts[0]?.provider === 'spawn', String(starts[0]?.provider));
  check('label 带论文名', String(starts[0]?.label).includes('paper.md'), String(starts[0]?.label));
  check('父 Agent 是当前会话的 agent', starts[0]?.request?.parent === parentAgent);
  const promptText = starts[0]?.request?.prompt?.[0]?.text ?? '';
  check('提示词是中文', /[\u4e00-\u9fa5]/.test(promptText.slice(0, 40)), promptText.slice(0, 60));
  check('提示词直接给文件路径并让它自己读', promptText.includes(paperPath) && promptText.includes('read'), promptText.slice(0, 160));
  check('提示词带六段精读指令', promptText.includes('一句话结论'), promptText.slice(-80));
  check('不带 message 时退化成“先通读一遍”的兜底句', promptText.includes('请先通读全文') && !promptText.includes('【我的问题】'), promptText.slice(-70));

  // 已有子代理 + 带 message → 走人类通道直接发（不再另起）
  const sent = await (await post('chat', { path: paperPath, sessionId: 'session-parent', message: '它的注意力是怎么算的？' })).json();
  check('已有子代理时直接发消息', sent.ok === true && sent.delivered === true && sent.childId === 'child-1', JSON.stringify(sent).slice(0, 160));
  check('发消息没有再另起子代理', starts.length === 1, `starts=${starts.length}`);
  check('用的是人类通道 subagents.prompt', prompts.at(-1)?.parentSessionId === 'session-parent'
    && prompts.at(-1)?.childSessionId === 'child-1'
    && prompts.at(-1)?.content?.[0]?.text === '它的注意力是怎么算的？'
    && prompts.at(-1)?.mode === 'continuable'
    && prompts.at(-1)?.delivery === 'queue'
    && typeof prompts.at(-1)?.requestId === 'string' && prompts.at(-1).requestId.length > 0, JSON.stringify(prompts.at(-1)));

  const again = await (await post('chat', { path: paperPath, sessionId: 'session-parent' })).json();
  check('不带 message 再调用复用同一个子代理', again.reused === true && starts.length === 1, `starts=${starts.length}`);

  const other = await (await post('chat', { path: paperPath, sessionId: 'session-other' })).json();
  check('换了父会话会另起一个（并记录新父）', other.reused === false && starts.length === 2, `starts=${starts.length}`);
}

// ------------------------------------------------------- 状态 + 只读镜像 ----
{
  const state = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}&sessionId=session-other`)).json();
  check('状态返回 childId 与地址', state.childId === 'child-1' && state.address.parentSessionId === 'session-other', JSON.stringify(state).slice(0, 160));
  check('状态标出 idle/running', state.status === 'idle' && state.running === false, String(state.status));
  const assistant = state.messages.find((message) => message.role === 'assistant');
  check('镜像折叠出助手消息', assistant?.text === '这是子代理的总结。', JSON.stringify(state.messages).slice(0, 200));
  check('镜像保留工具名', Array.isArray(assistant?.tools) && assistant.tools.includes('read'), JSON.stringify(assistant?.tools));
  const user = state.messages.find((message) => message.role === 'user');
  check('首轮交接提示词不出现在镜像里', user === undefined, JSON.stringify(user ?? null).slice(0, 120));
}

// ---------------------------------------- 带提问的首轮：只显示用户那句话 ----
{
  const askPath = path.join(FIX, 'ask.md');
  writeFileSync(askPath, '# Ask\n\n正文。\n');
  const response = await post('chat', { path: askPath, sessionId: 'session-parent', message: '它的方法是什么？' });
  const payload = await response.json();
  check('带提问也能起子代理', response.status === 200 && typeof payload.childId === 'string', JSON.stringify(payload).slice(0, 120));
  const promptText = starts.at(-1)?.request?.prompt?.[0]?.text ?? '';
  check('提示词里有分隔标记和用户那句话', promptText.includes('【我的问题】') && promptText.endsWith('它的方法是什么？'), promptText.slice(-60));
  const state = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(askPath)}`)).json();
  const users = state.messages.filter((message) => message.role === 'user');
  check('镜像里只留下用户那句话', users.length === 1 && users[0].text === '它的方法是什么？', JSON.stringify(users).slice(0, 140));
}

// --------------------------------------------- 冷子代理镜像（跑完被回收） ----
{
  // 把活着的子代理"回收"掉，并把它的日志放进持久化，模拟一轮跑完后的真实状态
  const live = children.get('child-1');
  const events = [];
  for (let seq = 0; seq < live.session.seq; seq += 1) events.push(live.session.eventAt(seq));
  children.delete('child-1');
  coldSessions.set('child-1', { session: { id: 'child-1' }, inheritedEventCount: 0, events });

  const state = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  check('子代理被回收后状态为 cold', state.status === 'cold' && state.running === false, String(state.status));
  check('冷子代理仍能读出镜像（读持久化日志）', state.messages.some((message) => message.role === 'assistant' && message.text === '这是子代理的总结。'), JSON.stringify(state.messages).slice(0, 200));
  check('冷镜像保留工具名', state.messages.some((message) => Array.isArray(message.tools) && message.tools.includes('read')));
}

// ------------------------------------------------------------ 只读镜像流 ----
{
  // 让子代理重新"活"过来（流式转发需要活的 agent）
  children.set('child-1', makeAgent('child-1'));
  children.get('child-1').append('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '上下文' }], source: { kind: 'user' } });
  const response = await fetch(`${base}/api/paper-reader/chat/stream?path=${encodeURIComponent(paperPath)}`);
  check('stream 返回 NDJSON', response.status === 200 && (response.headers.get('content-type') ?? '').includes('ndjson'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let replayTail;
  const readEvent = async () => {
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) return JSON.parse(line);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return undefined;
      buffer += decoder.decode(value, { stream: true });
    }
  };
  const first = await readEvent();
  check('首个事件是 state', first?.type === 'state' && first.childId === 'child-1', JSON.stringify(first));
  const replayed = [];
  for (;;) {
    const event = await readEvent();
    if (event?.type !== 'message') { replayTail = event; break; }
    replayed.push(event.message);
  }
  check('随后回放镜像消息', replayed.some((message) => message.role === 'user'), JSON.stringify(replayed).slice(0, 160));

  // 子代理的实时帧（只转发这个子代理的）
  const child = children.get('child-1');
  const otherChild = makeAgent('child-9');
  for (const listener of [...listeners]) {
    listener({ agent: otherChild, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '不该出现' } } });
  }
  for (const listener of [...listeners]) {
    listener({ agent: child, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '实时' } } });
    listener({ agent: child, frame: { type: 'chunk', chunk: { type: 'block-end', block: { type: 'tool-call', name: 'bash' } } } });
  }
  // 期间可能有 idle/ping 之类的状态事件，跳过它们直到拿到想要的类型
  const waitFor = async (type, max = 8) => {
    let event = replayTail;
    replayTail = undefined;
    for (let index = 0; index < max; index += 1) {
      event = event ?? await readEvent();
      if (event === undefined) return undefined;
      if (event.type === type) return event;
      event = undefined;
    }
    return undefined;
  };
  const delta = await waitFor('delta');
  const tool = await waitFor('tool');
  check('转发子代理的文本增量', delta?.type === 'delta' && delta.text === '实时', JSON.stringify(delta));
  check('转发子代理的工具调用', tool?.type === 'tool' && tool.name === 'bash', JSON.stringify(tool));
  check('不转发别的子代理的帧', delta?.text !== '不该出现');
  await reader.cancel();
}

// ------------------------------------------- 打断 / 重置（人类权限） ----
{
  const denied = await post('chat/interrupt', { path: paperPath, sessionId: 'session-wrong' });
  check('非父会话打断被拒（403）', denied.status === 403, String(denied.status));
  const ok = await (await post('chat/interrupt', { path: paperPath, sessionId: 'session-other' })).json();
  check('父会话打断成功', ok.ok === true && ok.interrupted === true, JSON.stringify(ok));
  check('打断用的是人类权限 {kind:user, parentSessionId}', interrupts.at(-1)?.authority?.kind === 'user'
    && interrupts.at(-1)?.authority?.parentSessionId === 'session-other'
    && interrupts.at(-1)?.childId === 'child-1', JSON.stringify(interrupts.at(-1)));

  const reset = await (await post('chat/reset', { path: paperPath })).json();
  check('重置忘掉映射', reset.ok === true && reset.forgotten === true);
  const after = await (await fetch(`${base}/api/paper-reader/chat?path=${encodeURIComponent(paperPath)}`)).json();
  check('重置后回到 none', after.status === 'none' && after.childId === null, JSON.stringify(after).slice(0, 120));
}

// -------------------------------------------------- 上下文注入：PDF ----
{
  const response = await post('chat', { path: pdfPath, sessionId: 'session-parent' });
  check('PDF 也能起子代理', response.status === 200, String(response.status));
  const promptText = starts.at(-1)?.request?.prompt?.[0]?.text ?? '';
  check('PDF 直接把文件交给它、让它用工具读', promptText.includes(pdfPath) && promptText.includes('工具'), promptText.slice(0, 200));
  check('PDF 提示词给出缓存兜底路径', /cache\/[^\s]+\.md/.test(promptText), promptText.slice(0, 300));
  check('PDF 写明页数', promptText.includes('1 页'), promptText.slice(0, 240));
  const cacheMatch = promptText.match(/\/cache\/[^\s]+\.md/);
  const cacheFile = cacheMatch === null ? undefined : path.join(HOME, 'storages', 'paper-reader', cacheMatch[0]);
  check('抽取正文确实写进了缓存文件', cacheFile !== undefined && existsSync(cacheFile) && readFileSync(cacheFile, 'utf8').includes('Hello Paper Subagent 2026'), String(cacheFile));
}

// ------------------------------------------------------------ 错误分支 ----
{
  const empty = await post('chat', { path: paperPath, message: '   ', sessionId: 'session-parent' });
  check('message 只有空白时退化成复用（不误发空消息）', empty.status === 200, String(empty.status));
  const badStream = await fetch(`${base}/api/paper-reader/chat/stream?path=${encodeURIComponent('/etc/hostname')}`);
  check('stream 越界被拒（400）', badStream.status === 400, String(badStream.status));
  const badMethod = await fetch(`${base}/api/paper-reader/chat/interrupt`);
  check('interrupt 的 GET 返回 405', badMethod.status === 405, String(badMethod.status));

  const saved = services.get('subagents');
  services.delete('subagents');
  const noSub = await post('chat', { path: paperPath, sessionId: 'session-parent' });
  check('没有子代理服务时 503', noSub.status === 503, String(noSub.status));
  const health = await (await fetch(`${base}/api/paper-reader/health`)).json();
  check('health 同步报告不可用', health.chat.available === false, JSON.stringify(health.chat));
  services.set('subagents', saved);
}

// --------------------------------------------------- PDF 抽取与资源转发 ----
{
  const extracted = await (await fetch(`${base}/api/paper-reader/text?path=${encodeURIComponent(pdfPath)}`)).json();
  check('PDF 文字抽取成功', extracted.ok === true && extracted.text.includes('Hello Paper Subagent 2026'), JSON.stringify(extracted).slice(0, 140));
  const worker = await fetch(`${base}/api/paper-reader/pdfjs/build/pdf.worker.min.mjs`);
  check('pdfjs worker 可转发', worker.status === 200 && (worker.headers.get('content-type') ?? '').includes('javascript'));
  const traversal = await fetch(`${base}/api/paper-reader/pdfjs/..%2F..%2Fpackage.json`);
  check('资源路径穿越被拒', traversal.status === 400 || traversal.status === 404, String(traversal.status));
}

server.close();
console.log(problems.length === 0 ? '\n论文子代理（宿主半）：全部通过' : `\n论文子代理（宿主半）：${problems.length} 项失败`);
process.exit(problems.length === 0 ? 0 : 1);
