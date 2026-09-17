/**
 * 客户端半集成测试（jsdom + react-dom 真挂载）：
 *   - 三段式版面、目录树、Markdown 渲染、面板切换（保留的能力）；
 *   - 右栏实时对话：历史、发送、流式回答、工具标签、精读总结、停止、新对话；
 *   - PDF 走 pdf.js 路径（jsdom 里加载失败 → 断言自动退回 iframe）。
 */
import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/?token=test',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.location = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------- 假数据 ----
const TREE = {
  ok: true,
  root: '/root',
  roots: ['/root'],
  all: false,
  truncated: false,
  parent: null,
  nodes: [
    { name: 'papers', path: '/root/papers', dir: true, children: [
      { name: 'attention.md', path: '/root/papers/attention.md', dir: false, ext: 'md', size: 2048, mtime: 1757000000000 },
      { name: 'survey.pdf', path: '/root/papers/survey.pdf', dir: false, ext: 'pdf', size: 99999, mtime: 1757000000000 },
    ] },
    { name: 'README.md', path: '/root/README.md', dir: false, ext: 'md', size: 120, mtime: 1757000000000 },
  ],
};
const DOC_TEXT = [
  '# Attention Is All You Need',
  '',
  '## Abstract',
  'The dominant sequence transduction models are based on complex **recurrent** or *convolutional* networks.',
  '',
  '- Transformer 只用注意力',
  '- 训练更快',
  '',
  '| Model | BLEU |',
  '| --- | --- |',
  '| Transformer | 28.4 |',
  '',
  '```python',
  'print("hello paper")',
  '```',
  '',
  '> 引用：`self-attention` 是关键。',
].join('\n');
const fileFor = (target) => ({
  ok: true,
  path: target,
  name: target.split('/').pop(),
  ext: target.endsWith('.pdf') ? 'pdf' : 'md',
  kind: target.endsWith('.pdf') ? 'pdf' : 'markdown',
  size: 2048,
  mtime: 1757000000000,
  rawUrl: `/api/paper-reader/raw?path=${encodeURIComponent(target)}`,
  text: target.endsWith('.pdf') ? null : DOC_TEXT,
  truncated: false,
});

const CHAT_STATE = {
  ok: true,
  path: '/root/papers/attention.md',
  chat: { available: true, provider: 'spawn', mode: 'subagent' },
  childId: null,
  address: null,
  status: 'none',
  running: false,
  messages: [],
};
const CHAT_STREAM = [
  JSON.stringify({ type: 'state', childId: 'child-1', running: true, live: true }),
  JSON.stringify({ type: 'delta', text: '## 一句话结论\n' }),
  JSON.stringify({ type: 'delta', text: '这篇用 **注意力** 取代循环。\n' }),
  JSON.stringify({ type: 'idle', at: Date.now() }),
].join('\n');
const CHAT_NDJSON = [
  JSON.stringify({ type: 'start', sessionId: 'session-test-1', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, contextInjected: true }),
  JSON.stringify({ type: 'delta', text: '## 一句话结论\n' }),
  JSON.stringify({ type: 'delta', text: '这篇论文用 **注意力** 取代了循环结构。\n' }),
  JSON.stringify({ type: 'delta', text: '\n- 并行训练更快\n- BLEU 28.4\n' }),
  JSON.stringify({ type: 'tool', name: 'read' }),
  JSON.stringify({ type: 'done', text: '## 一句话结论\n这篇论文用 **注意力** 取代了循环结构。\n\n- 并行训练更快\n- BLEU 28.4\n', tools: ['read'] }),
].join('\n');

const calls = [];
let startedChild = null;
let lastStart = null;
globalThis.fetch = async (input, init = {}) => {
  const method = init.method ?? 'GET';
  const url = new URL(String(input), 'http://127.0.0.1:3080');
  calls.push(`${method} ${url.pathname}${url.search}`);
  const target = url.searchParams.get('path') ?? '';
  if (url.pathname === '/api/paper-reader/tree') return Response.json(TREE);
  if (url.pathname === '/api/paper-reader/file') return Response.json(fileFor(target));
  if (url.pathname === '/api/paper-reader/chat' && method === 'GET') {
    return Response.json({ ...CHAT_STATE, path: target, ...(startedChild === null ? {} : {
      childId: startedChild,
      address: { parentSessionId: 's1', childSessionId: startedChild, mode: 'continuable' },
      status: 'running',
      running: true,
    }) });
  }
  if (url.pathname === '/api/paper-reader/chat' && method === 'POST') {
    const body = JSON.parse(String(init.body ?? '{}'));
    startedChild = 'child-1';
    lastStart = body;
    return Response.json({ ok: true, childId: 'child-1', address: { parentSessionId: 's1', childSessionId: 'child-1', mode: 'continuable' }, reused: false, chat: CHAT_STATE.chat });
  }
  if (url.pathname === '/api/paper-reader/chat/stream') {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const line of CHAT_STREAM.split('\n')) {
          controller.enqueue(encoder.encode(`${line}\n`));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  }
  if (url.pathname === '/api/paper-reader/chat/interrupt') return Response.json({ ok: true, interrupted: true });
  if (url.pathname === '/api/paper-reader/chat/reset') return Response.json({ ok: true });
  return new Response('not found', { status: 404 });
};

// ------------------------------------------------------------- 加载 bundle ----
let registered = null;
window.__ModuleLoader__ = { load: (entry) => { registered = entry; } };
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
new Function('window', 'document', bundle)(window, window.document);
if (registered === null) throw new Error('client bundle 没有调用 __ModuleLoader__.load');
if (registered.id !== 'dsh-paper-reader') throw new Error(`bundle id 不对：${registered.id}`);

const icon = (name) => (props) => React.createElement('svg', { 'data-icon': name, width: props?.size ?? 16 });
const primitives = new Proxy({
  fileSizeText: (bytes) => `${bytes} B`,
  writeClipboard: async () => {},
}, {
  get: (target, key) => (key in target ? target[key] : icon(String(key))),
});
const fakeRequire = (id) => {
  if (id === 'react') return React;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`未预期的 require：${id}`);
};

const plugin = registered.factory(fakeRequire);
if (typeof plugin.apply !== 'function') throw new Error('client bundle 没有导出 apply');
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('slots') || !plugin.inject.includes('layout')) {
  throw new Error(`inject 不对：${JSON.stringify(plugin.inject)}`);
}

// ------------------------------------------------------------- 假 ctx ----
const registrations = [];
const injections = [];
let panelSelected = [];
let draftWritten = null;
const dockOpen = [];
const openedSubagents = [];
let currentSession = 's1';
const tabTypes = [];
const ctx = {
  effect(fn) { return fn(); },
  get(name) {
    if (name === 'sidebarRight') return this.sidebarRight;
    if (name === 'sidebarRightTabs') return this.sidebarRightTabs;
    if (name === 'conversation') {
      return {
        input: {
          shells: new Map([['s1', { actions: { setDraft: (text) => { draftWritten = text; } } }]]),
          shell: () => ({ actions: { setDraft: (text) => { draftWritten = text; } } }),
        },
      };
    }
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ current: currentSession }) },
        openSubagent: (address) => { openedSubagents.push(address); return true; },
        subagentAddress: (id) => (id === 'child-1' ? { parentSessionId: 's1', childSessionId: 'child-1', mode: 'continuable' } : undefined),
      };
    }
    return undefined;
  },
  slots: {
    inject(slot, callback) { injections.push(slot); callback(); },
    register(options, Component) { registrations.push({ options, Component }); return () => {}; },
  },
  layout: { selectPanel: (id) => { panelSelected.push(id); } },
  sidebarRight: { openTab: (kind) => { dockOpen.push(kind); } },
  sidebarRightTabs: { register: (definition) => { tabTypes.push(definition); return () => {}; } },
};
plugin.apply(ctx);

const wrap = (Component, props) => {
  const usePanelInfo = (selector) => selector({ activePanelId: 'paper' });
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  React.act(() => { root.render(React.createElement(Component, { ...props, usePanelInfo })); });
  return { container, root };
};
const flush = async (ms = 40) => {
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
};
const click = (node) => React.act(() => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const findByText = (container, text) => [...container.querySelectorAll('button')].find((node) => node.textContent.includes(text));
/**
 * 模拟用户输入。
 * jsdom 里 React 18 的 input 事件委托不稳定（原生 input 事件到了、React 的 onChange 却不触发），
 * 因此这里直接调用控件上的 React onChange 回调——与用户输入走的是同一个处理函数。
 */
const type = (textarea, value) => React.act(() => {
  const propsKey = Object.keys(textarea).find((key) => key.startsWith('__reactProps'));
  const handler = propsKey === undefined ? undefined : textarea[propsKey]?.onChange;
  if (typeof handler === 'function') {
    handler({ target: { value }, currentTarget: textarea, preventDefault() {}, stopPropagation() {} });
    return;
  }
  textarea.value = value;
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
});

const problems = [];
const check = (label, condition, extra = '') => {
  if (condition) console.log(`  ✓ ${label}`);
  else { problems.push(label); console.log(`  ✗ ${label} ${extra}`); }
};

console.log('注册的槽位：', registrations.map((item) => `${item.options.name}${item.options.key ? `#${item.options.key}` : ''}`).join(', '));
check('inject 了 conversation.input.right', injections.includes('conversation.input.right'));
check('inject 了 main', injections.includes('main'));

const openEntry = registrations.find((item) => item.options.name === 'conversation.input.right');
const { container: buttonContainer } = wrap(openEntry.Component, openEntry.options.inject());
check('「论文」按钮渲染为按钮', buttonContainer.innerHTML.includes('论文') && buttonContainer.querySelector('button') !== null);

const mainEntry = registrations.find((item) => item.options.name === 'main');
check('main 面板带 key=paper', mainEntry.options.key === 'paper');
const { container } = wrap(mainEntry.Component, mainEntry.options.inject());
await flush(80);

check('渲染出三栏容器', container.querySelectorAll('.dpr-pane').length === 3, String(container.querySelectorAll('.dpr-pane').length));
check('左栏出现目录', container.innerHTML.includes('papers'));
check('调用了 tree 接口', calls.some((call) => call.startsWith('GET /api/paper-reader/tree')));

// 展开目录 → 看到文件
click([...container.querySelectorAll('.dpr-node')].find((node) => node.textContent.includes('papers')));
check('左栏出现目录树文件', container.innerHTML.includes('attention.md') && container.innerHTML.includes('survey.pdf'));

// 打开 Markdown → 中栏渲染
click([...container.querySelectorAll('.dpr-node')].find((node) => node.textContent.includes('attention.md')));
await flush(60);
check('调用了 file 接口', calls.some((call) => call.startsWith('GET /api/paper-reader/file')));
check('中栏渲染 Markdown 标题', container.querySelector('.dpr-paper-inner h1')?.textContent === 'Attention Is All You Need');
check('中栏渲染代码块', container.querySelector('.dpr-paper-inner pre code')?.textContent.includes('hello paper') === true);
check('中栏渲染表格', container.querySelector('.dpr-paper-inner table') !== null);
check('中栏渲染引用', container.querySelector('.dpr-paper-inner blockquote') !== null);
check('中栏渲染行内代码', container.querySelectorAll('.dpr-paper-inner code').length >= 2);

// ------------------------------------------------ 右栏：子代理控制台 ----
check('右栏标题是「论文子代理」', container.innerHTML.includes('论文子代理'));
check('拉了子代理状态', calls.some((call) => call.startsWith('GET /api/paper-reader/chat?path=')));
check('显示状态标签（未开始）', container.innerHTML.includes('未开始'));
check('有「精读总结」卡片', findByText(container, '精读总结') !== undefined);
check('有「在原生会话里打开」卡片', findByText(container, '在原生会话里打开') !== undefined);
check('空态给出快捷提问', container.querySelectorAll('.dpr-quick button').length >= 3);
check('右栏没有自绘发送框（打字进原生会话）', container.querySelector('.dpr-console textarea') === null);

// 点「精读总结」→ 宿主起子代理
click(findByText(container, '精读总结'));
await flush(80);
check('POST /chat 启动了论文子代理', calls.some((call) => call.startsWith('POST /api/paper-reader/chat')));
check('启动带了 mode=summary 与父会话 id', lastStart?.mode === 'summary' && lastStart?.sessionId === 's1', JSON.stringify(lastStart).slice(0, 160));
check('启动带上了论文路径', lastStart?.path === '/root/papers/attention.md', String(lastStart?.path));
check('状态不再显示「未开始」', !container.innerHTML.includes('未开始'), container.querySelector('.dpr-console-msgs')?.innerHTML.slice(0,120));

// 只读镜像流
await flush(400);
console.log('DEBUG mirror:', container.querySelector('.dpr-console-msgs')?.innerHTML?.replace(/\s+/g,' ').slice(0, 260));
check('订阅了只读镜像流', calls.some((call) => call.startsWith('GET /api/paper-reader/chat/stream')));
check('镜像渲染了子代理输出', container.querySelector('.dpr-console-msgs .dpr-bubble')?.textContent.includes('注意力') === true,
  container.querySelector('.dpr-console-msgs')?.innerHTML.slice(0, 200));

// 「在原生会话里打开」→ openSubagent + 论文停靠
const beforeOpen = openedSubagents.length;
click(findByText(container, '在原生会话里打开'));
await flush(30);
check('切到了原生子会话', openedSubagents.length === beforeOpen + 1 && openedSubagents.at(-1).childSessionId === 'child-1', JSON.stringify(openedSubagents));
check('桌面同时把论文停靠到右侧栏', dockOpen.at(-1) === 'paper', JSON.stringify(dockOpen));

// 快捷提问：有子代理时写进原生输入框草稿
const quickButton = container.querySelector('.dpr-quick button');
click(quickButton);
await flush(250);
check('快捷提问写进了原生草稿', typeof draftWritten === 'string' && draftWritten.length > 0, String(draftWritten));

// ---------------------------------------------------------- 停靠模式 ----
{
  check('注册了停靠标签类型（kind=paper）', tabTypes.some((item) => item.id === 'dsh-paper-reader' && item.kind === 'paper'), JSON.stringify(tabTypes));
  check('inject 了停靠主体与标题槽位', injections.includes('sidebar.right.pane.tab') && injections.includes('sidebar.right.pane.tab.title'));
  const dockEntry = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab');
  check('停靠主体挂在 dsh-paper-reader id 上', dockEntry?.options.key === 'dsh-paper-reader', JSON.stringify(dockEntry?.options));
  const { container: dockContainer } = wrap(dockEntry.Component, dockEntry.options.inject());
  await flush(80);
  check('停靠面板渲染目录 + 论文两栏', dockContainer.querySelectorAll('.dpr-pane').length === 2, String(dockContainer.querySelectorAll('.dpr-pane').length));
  check('停靠面板列出工作区文件', dockContainer.innerHTML.includes('papers'));
  check('停靠面板标题带「停靠」字样', dockContainer.innerHTML.includes('论文（停靠）'));
  const three = [...dockContainer.querySelectorAll('button')].find((node) => node.textContent.includes('三栏阅读'));
  check('停靠面板有「三栏阅读」入口', three !== undefined);
  click(three);
  check('「三栏阅读」切回 paper 面板', panelSelected.includes('paper'));
  const beforeOpen = dockOpen.length;
  click(findByText(container, '停靠'));
  check('三栏里的「停靠」打开右栏标签', dockOpen.length === beforeOpen + 1 && dockOpen.at(-1) === 'paper', JSON.stringify(dockOpen));
  check('停靠同时切回原生对话', panelSelected.at(-1) === null);
}

// 「返回对话」与输入框按钮 + 防套壳
click(findByText(container, '返回对话'));
check('返回对话调用 selectPanel(null)', panelSelected.filter((id) => id === null).length >= 2);
const openButtons = [[...buttonContainer.querySelectorAll('button')], registrations];
click(buttonContainer.querySelector('button'));
check('输入框按钮切到 paper 面板', panelSelected.includes('paper'));
// 面板已激活时：按钮不响应、不可点（禁止"论文里再点论文"套壳）
const secondEntry = registrations.filter((item) => item.options.name === 'conversation.input.right')[0];
const { container: activeButton } = wrap(secondEntry.Component, { ...secondEntry.options.inject(), usePanelInfo: (selector) => selector({ activePanelId: 'paper' }) });
const activeNode = activeButton.querySelector('button');
check('阅读器里按钮变为不可点', activeNode.disabled === true && activeNode.textContent.includes('阅读中'), activeNode.outerHTML);
panelSelected = [];
React.act(() => { activeNode.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
check('阅读器里点击不再嵌套打开', panelSelected.length === 0, JSON.stringify(panelSelected));

console.log(problems.length === 0 ? '\n客户端半：全部通过' : `\n客户端半：${problems.length} 项失败`);
process.exit(problems.length === 0 ? 0 : 1);
