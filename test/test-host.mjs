/**
 * 宿主半集成测试：用真实 http server 挂载注册的路由，走真实 fetch 验证
 * 目录树 / 正文 / raw / 流式总结 / 越界防护 / 鉴权拒绝。
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const FIX = '/tmp/paper-test/fixtures';
rmSync(FIX, { recursive: true, force: true });
mkdirSync(path.join(FIX, 'sub'), { recursive: true });
mkdirSync(path.join(FIX, '.hidden'), { recursive: true });
mkdirSync(path.join(FIX, 'node_modules'), { recursive: true });
writeFileSync(path.join(FIX, 'paper.md'), '# Paper\n\n正文内容 attention\n');
writeFileSync(path.join(FIX, 'notes.txt'), 'plain notes\n');
writeFileSync(path.join(FIX, 'sub', 'nested.md'), '# Nested\n');
writeFileSync(path.join(FIX, '.hidden', 'secret.md'), '# Secret\n');
writeFileSync(path.join(FIX, 'node_modules', 'x.md'), '# skip\n');
writeFileSync(path.join(FIX, 'data.bin'), Buffer.from([0, 1, 2, 3]));
writeFileSync(path.join(FIX, 'figure.pdf'), Buffer.from('%PDF-1.4 fake'));

process.env.DSHA_PAPER_ROOTS = FIX;
const { apply } = await import(new URL('../lib/index.js', import.meta.url).href);

const problems = [];
const check = (label, condition, extra = '') => {
  if (condition) console.log(`  ✓ ${label}`);
  else { problems.push(label); console.log(`  ✗ ${label} ${extra}`); }
};

/** 假的 llm 服务：把收到的请求记下来，回一段确定性文本。 */
let llmRequest = null;
const fakeLlm = {
  stream(options) {
    llmRequest = options;
    return (async function* generate() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (const piece of ['## 一句话结论\n', '这是 **总结**。\n', '\n## 方法与技术路线\n- 步骤一\n']) {
        yield { type: 'text-delta', index: 0, text: piece };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  },
};

let rejectWith;
const services = new Map([
  ['llm', fakeLlm],
  ['agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) }],
]);

let route = null;
const webCtx = {
  webServer: { register(entry) { route = entry; return () => { route = null; }; } },
  connection: { requestRejection: () => rejectWith },
  effect(fn) { return fn(); },
  get: (name) => services.get(name),
  logger: { info() {}, warn() {} },
};
const ctx = {
  ...webCtx,
  inject(_deps, callback) { callback(webCtx); },
};
apply(ctx);

if (route === null) throw new Error('宿主半没有注册路由');
check('注册为 prefix 路由且路径正确', route.kind === 'prefix' && route.path === '/api/paper-reader');

const server = createServer((req, res) => { route.handler(req, res).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const getJson = async (url) => {
  const response = await fetch(`${base}${url}`);
  return { status: response.status, body: await response.json() };
};

// ------------------------------------------------------------------ tree ----
{
  const { status, body } = await getJson(`/api/paper-reader/tree?root=${encodeURIComponent(FIX)}`);
  check('tree 返回 200', status === 200);
  check('tree 根目录正确', body.root === FIX, body.root);
  const names = body.nodes.map((node) => node.name);
  check('tree 含 paper.md / notes.txt / figure.pdf', ['paper.md', 'notes.txt', 'figure.pdf'].every((name) => names.includes(name)), JSON.stringify(names));
  check('tree 默认过滤掉 data.bin', !names.includes('data.bin'), JSON.stringify(names));
  check('tree 跳过隐藏目录与 node_modules', !names.includes('.hidden') && !names.includes('node_modules'), JSON.stringify(names));
  const sub = body.nodes.find((node) => node.name === 'sub');
  check('tree 递归到子目录', sub?.children?.some((child) => child.name === 'nested.md') === true);
  const { body: allBody } = await getJson(`/api/paper-reader/tree?root=${encodeURIComponent(FIX)}&all=1`);
  check('all=1 显示 data.bin', allBody.nodes.some((node) => node.name === 'data.bin'));
}

// ------------------------------------------------------------------ 越界 ----
{
  const outside = await getJson('/api/paper-reader/tree?root=%2Fetc');
  check('越界 root 被拒（400）', outside.status === 400 && outside.body.error.code === 'bad-path', JSON.stringify(outside));
  const escape = await getJson(`/api/paper-reader/file?path=${encodeURIComponent('/etc/hostname')}`);
  check('越界 file 被拒（400）', escape.status === 400, JSON.stringify(escape));
  const traversal = await getJson(`/api/paper-reader/file?path=${encodeURIComponent(path.join(FIX, '..', '..', 'etc', 'hostname'))}`);
  check('.. 穿越被拒（400）', traversal.status === 400, JSON.stringify(traversal));
  const noPath = await getJson('/api/paper-reader/file');
  check('缺 path 被拒（400）', noPath.status === 400);
  const unknown = await getJson('/api/paper-reader/nope');
  check('未知端点 404', unknown.status === 404);
  const wrongMethod = await fetch(`${base}/api/paper-reader/tree`, { method: 'POST' });
  check('tree 的 POST 返回 405', wrongMethod.status === 405);
}

// ------------------------------------------------------------------ file ----
{
  const { status, body } = await getJson(`/api/paper-reader/file?path=${encodeURIComponent(path.join(FIX, 'paper.md'))}`);
  check('file 返回 markdown 类型与正文', status === 200 && body.kind === 'markdown' && body.text.includes('attention'), JSON.stringify(body).slice(0, 160));
  check('file 带 rawUrl', typeof body.rawUrl === 'string' && body.rawUrl.startsWith('/api/paper-reader/raw?path='));
  const bin = await getJson(`/api/paper-reader/file?path=${encodeURIComponent(path.join(FIX, 'data.bin'))}`);
  check('二进制文件不给 text', bin.body.kind === 'binary' && bin.body.text === null);
  const pdf = await getJson(`/api/paper-reader/file?path=${encodeURIComponent(path.join(FIX, 'figure.pdf'))}`);
  check('pdf 识别为 pdf', pdf.body.kind === 'pdf' && pdf.body.text === null);
}

// ------------------------------------------------------------------- raw ----
{
  const response = await fetch(`${base}/api/paper-reader/raw?path=${encodeURIComponent(path.join(FIX, 'figure.pdf'))}`);
  check('raw 返回 pdf 字节与 MIME', response.status === 200
    && response.headers.get('content-type') === 'application/pdf'
    && (await response.text()).startsWith('%PDF'), response.headers.get('content-type') ?? '');
  const download = await fetch(`${base}/api/paper-reader/raw?path=${encodeURIComponent(path.join(FIX, 'paper.md'))}&download=1`);
  check('download=1 走 attachment', (download.headers.get('content-disposition') ?? '').startsWith('attachment'));
  const bad = await fetch(`${base}/api/paper-reader/raw?path=${encodeURIComponent('/etc/hostname')}`);
  check('raw 越界被拒', bad.status === 400);
}

// --------------------------------------------------------------- summary ----
{
  const response = await fetch(`${base}/api/paper-reader/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.join(FIX, 'paper.md') }),
  });
  const text = await response.text();
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  check('summary 流式返回 NDJSON', response.status === 200 && response.headers.get('content-type')?.includes('ndjson'), response.headers.get('content-type') ?? '');
  check('summary 事件顺序 start→delta→done', events[0].type === 'start' && events.at(-1).type === 'done', events.map((event) => event.type).join(','));
  check('summary 拼出完整正文', events.at(-1).summary.includes('这是 **总结**。'));
  check('summary 带模型路由', events[0].route.model === 'deepseek-v4-flash');
  check('llm 收到 system 提示词', typeof llmRequest.system === 'string' && llmRequest.system.includes('一句话结论'));
  check('llm 收到 user 消息与正文', llmRequest.messages.length === 1
    && llmRequest.messages[0].role === 'user'
    && llmRequest.messages[0].content[0].text.includes('attention')
    && llmRequest.messages[0].content[0].text.includes('PAPER>>>'), JSON.stringify(llmRequest.messages[0]).slice(0, 200));
  check('llm 使用默认模型与 token 上限', llmRequest.provider === 'deepseek-official' && llmRequest.model === 'deepseek-v4-flash' && llmRequest.maxTokens === 3000);
  check('llm 收到取消信号', llmRequest.signal instanceof AbortSignal);

  // 省略 path、直接给 text
  const withText = await fetch(`${base}/api/paper-reader/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'inline.md', text: 'inline paper body' }),
  });
  const withTextEvents = (await withText.text()).trim().split('\n').map((line) => JSON.parse(line));
  check('可以用 text 直传正文', withTextEvents.at(-1).type === 'done' && llmRequest.messages[0].content[0].text.includes('inline paper body'));

  // 不可读格式
  const badFormat = await fetch(`${base}/api/paper-reader/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.join(FIX, 'figure.pdf') }),
  });
  check('pdf 直接总结被拒（415）', badFormat.status === 415, String(badFormat.status));

  // 没有默认模型
  services.set('agentDefaultModel', { currentSelection: () => undefined });
  const noModel = await fetch(`${base}/api/paper-reader/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x' }),
  });
  check('没有默认模型时 503', noModel.status === 503, String(noModel.status));
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });

  // 没有 llm 服务
  services.delete('llm');
  const noLlm = await fetch(`${base}/api/paper-reader/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x' }),
  });
  check('没有 llm 服务时 503', noLlm.status === 503, String(noLlm.status));
  services.set('llm', fakeLlm);
}

// ----------------------------------------------------------------- 鉴权 ----
{
  rejectWith = 401;
  const response = await fetch(`${base}/api/paper-reader/tree?root=${encodeURIComponent(FIX)}`);
  check('未鉴权返回 401', response.status === 401, String(response.status));
  rejectWith = 403;
  const forbidden = await fetch(`${base}/api/paper-reader/tree?root=${encodeURIComponent(FIX)}`);
  check('非信任域返回 403', forbidden.status === 403, String(forbidden.status));
  rejectWith = undefined;
  const ok = await fetch(`${base}/api/paper-reader/health`);
  check('鉴权通过后 health 正常', ok.status === 200 && (await ok.json()).ok === true);
}

server.close();
console.log(problems.length === 0 ? '\n宿主半：全部通过' : `\n宿主半：${problems.length} 项失败`);
process.exit(problems.length === 0 ? 0 : 1);
