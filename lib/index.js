/**
 * dsh-paper-reader —— 论文阅读器插件（宿主半）。
 *
 * 全部挂在同一个 `/api/paper-reader` 前缀路由下：
 *   1. GET  tree        —— 工作区文稿目录树（左栏）；
 *   2. GET  file/raw    —— 单篇正文与原始字节（中间黑底论文区）；
 *   3. GET  text        —— pdf.js 抽取 PDF 文字（供对话上下文与总结）；
 *   4. GET  pdfjs/*     —— 转发 pdfjs-dist 静态资源（页面端动态 import，离线可用）；
 *   5. GET  chat        —— 论文对话历史；
 *   6. GET  chat        —— 论文子代理状态 + 只读镜像（右栏控制台）；
 *      POST chat        —— 在当前会话下起一个论文**子代理**（startContinuable）；
 *      GET  chat/stream —— 子代理输出的实时镜像（NDJSON，只读转发）；
 *      POST chat/interrupt —— 人类权限打断子代理；
 *      POST chat/reset  —— 忘掉映射（下次重新起子代理）；
 *   7. POST summary     —— 一次性中文精读总结（保留的旧接口，走 ctx.llm）。
 *
 * 设计约束（刻意保守）：
 *   - 对用户文件只读：不写、不改、不删；路径必须落在允许根目录内；
 *   - 不 import 任何 @deepseek-ai/* 运行时包（模型选择钩子内联在 lib/chat.js），
 *     只依赖 npm 上的 pdfjs-dist（插件自己的 dependencies）；
 *   - 路由自带 browserAuth 校验（复用 connection.requestRejection），与上游 /api 同级的信任边界。
 *
 * @module dsh-paper-reader
 */
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PaperSubagents, contextPreamble, MAX_CONTEXT_CHARS } from './chat.js';
import { extractPdfText, firstExisting, pdfjsDir } from './pdf-text.js';

/** Cordis 插件名（= package.json 的 name = client bundle 的 id）。 */
export const name = 'dsh-paper-reader';

/** 路由前缀；前缀注册在 webserver 里按最长匹配优先，因此不会被上游 /api 抢走。 */
const PREFIX = '/api/paper-reader';

/** 单个文本文件最多读多少字节（超出只读前一段并标记 truncated）。 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** 目录树最大深度。 */
const MAX_TREE_DEPTH = 4;
/** 目录树最大节点数（防爆内存）。 */
const MAX_TREE_NODES = 1500;
/** 送进模型的正文最大字符数（超出做头尾截断）。 */
const MAX_SUMMARY_CHARS = 60_000;
/** 摘要输出 token 上限。 */
const SUMMARY_MAX_TOKENS = 3_000;
/** 摘要请求总超时。 */
const SUMMARY_TIMEOUT_MS = 180_000;

/** 左栏默认展示的文稿类扩展名（all=1 时展示全部文件）。 */
const PAPER_EXT = new Set([
  'md', 'markdown', 'mdx', 'txt', 'text', 'tex', 'latex', 'ltx', 'bib', 'rst', 'org', 'adoc', 'asciidoc',
  'pdf', 'html', 'htm', 'xml', 'json', 'yaml', 'yml', 'csv', 'tsv', 'doc', 'docx', 'epub', 'rtf',
]);

/** 可以按纯文本读回来渲染的扩展名。 */
const TEXT_EXT = new Set([
  'md', 'markdown', 'mdx', 'txt', 'text', 'tex', 'latex', 'ltx', 'bib', 'rst', 'org', 'adoc', 'asciidoc',
  'json', 'yaml', 'yml', 'csv', 'tsv', 'toml', 'ini', 'conf', 'log', 'xml', 'srt', 'vtt',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'rb', 'php',
  'sh', 'bash', 'zsh', 'sql', 'css', 'scss',
]);

/** Markdown 家族（中间区用 MarkdownText 渲染）。 */
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);
/** 图片扩展名。 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);

/** 常见扩展名 → MIME（raw 路由用）。 */
const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  tex: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

/** 目录树里永远不进的目录（除非 all=1）。 */
const SKIP_DIR = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', 'dist', 'build', '.cache']);

/** 摘要系统提示词：固定结构 + 禁止编造。 */
const SUMMARY_SYSTEM = [
  '你是资深科研论文精读助手，面向中文读者工作。',
  '用户会给你一篇论文/技术文稿的正文（Markdown、LaTeX 或纯文本）。',
  '只输出中文 Markdown，不要输出思考过程、不要复述指令、不要编造正文中不存在的数据或结论。',
  '严格按下面的小节顺序输出（信息不足的小节写「正文未提供」）：',
  '',
  '## 一句话结论',
  '## 研究问题与动机',
  '## 方法与技术路线',
  '## 关键实验与结果',
  '## 结论、局限与可借鉴之处',
  '## 术语速查',
].join('\n');

/** 允许读取的根目录：dsh 进程工作目录（= 会话工作区），可用环境变量追加。 */
function allowedRoots() {
  const roots = [];
  const push = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const resolved = path.resolve(value.trim());
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  push(process.cwd());
  for (const extra of String(process.env.DSHA_PAPER_ROOTS ?? '').split(path.delimiter)) push(extra);
  return roots;
}

/** 路径是否在根目录内（前缀按路径边界判断，防 /root-evil 这类同前缀逃逸）。 */
function insideRoot(target, root) {
  if (target === root) return true;
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(base);
}

/** 解析并校验一个客户端传来的路径；越界抛错。 */
async function resolveInside(raw, roots) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('缺少 path 参数');
  if (raw.includes('\u0000')) throw new Error('路径包含非法字符');
  if (raw.length > 4096) throw new Error('路径过长');
  const absolute = path.resolve(raw);
  let real;
  try {
    real = await realpath(absolute);
  } catch {
    real = absolute; // 不存在时保留字面路径，交给后续 stat 报错
  }
  const ok = roots.some((root) => insideRoot(real, root) || insideRoot(absolute, root));
  if (!ok) throw new Error('路径不在允许的工作区目录内');
  return real;
}

/** 取扩展名（小写，无点）。 */
function extOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ext;
}

/** 判断是哪种展示类型。 */
function kindOf(ext) {
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (TEXT_EXT.has(ext)) return ext === 'tex' || ext === 'latex' || ext === 'ltx' ? 'tex' : 'text';
  return 'binary';
}

/** 递归列目录树。 */
async function buildTree(dir, depth, options, counter) {
  if (depth > options.depth || counter.count >= options.maxNodes) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (counter.count >= options.maxNodes) break;
    const entryName = entry.name;
    if (!options.all) {
      if (entryName.startsWith('.')) continue;
      if (entry.isDirectory() && SKIP_DIR.has(entryName)) continue;
    }
    const full = path.join(dir, entryName);
    if (entry.isSymbolicLink()) continue; // 不跟随软链接，避免环与越界
    if (entry.isDirectory()) {
      const children = await buildTree(full, depth + 1, options, counter);
      if (children.length > 0) {
        dirs.push({ name: entryName, path: full, dir: true, children });
        counter.count += 1;
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extOf(entryName);
    if (!options.all && !PAPER_EXT.has(ext)) continue;
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    files.push({
      name: entryName,
      path: full,
      dir: false,
      ext,
      size: info.size,
      mtime: Math.round(info.mtimeMs),
    });
    counter.count += 1;
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return [...dirs, ...files];
}

/** 头尾截断，保留论文的摘要与结论两端。 */
function truncateForModel(text) {
  if (text.length <= MAX_SUMMARY_CHARS) return { text, truncated: false };
  const head = Math.floor(MAX_SUMMARY_CHARS * 0.75);
  const tail = MAX_SUMMARY_CHARS - head;
  const omitted = text.length - MAX_SUMMARY_CHARS;
  return {
    text: `${text.slice(0, head)}\n\n…（中间省略 ${omitted} 字符）…\n\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** 读一个响应体（带大小上限）。 */
function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > limit) {
        reject(new Error('请求体过大'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('请求已取消')));
  });
}

/** 写一个 JSON 响应。 */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** 统一错误响应。 */
function fail(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } });
}

/** 读一个 JSON 请求体；失败时已经写好响应并返回 undefined。 */
async function readJsonBody(req, res, limit = 4 * 1024 * 1024) {
  let raw;
  try {
    raw = await readBody(req, limit);
  } catch (error) {
    fail(res, 400, 'bad-body', `请求体无效：${error.message}`);
    return undefined;
  }
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(res, 400, 'bad-body', '请求体必须是 JSON 对象');
      return undefined;
    }
    return parsed;
  } catch {
    fail(res, 400, 'bad-body', '请求体不是合法 JSON');
    return undefined;
  }
}

/**
 * 插件主体：把 webServer + connection 注入进来后注册路由。
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.webServer;
    const connection = webCtx.connection;

    /** 复用浏览器鉴权（cookie / 同源信任域），与上游 /api 一致。 */
    const reject = (req, res) => {
      let rejection;
      try {
        rejection = connection.requestRejection(req);
      } catch {
        rejection = 403;
      }
      if (rejection === undefined) return false;
      res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return true;
    };

    /** 论文子代理引擎（每篇论文一个挂在当前会话下的续聊子代理）。 */
    const chats = new PaperSubagents({
      ctx: webCtx,
      logger: webCtx.logger,
      home: process.env.DSH_HOME ?? '/root/.dsh',
    });
    /** PDF 抽取缓存：path -> { mtime, text, pageCount, pagesRead, truncated }。 */
    const pdfCache = new Map();
    /** 正在抽取的 Promise，避免同一文件并发抽取。 */
    const pdfInflight = new Map();

    /**
     * 取一篇论文的可读正文：文本文件直接读，PDF 走 pdf.js 抽取（带缓存）。
     * @param target - 已校验的绝对路径。
     * @param ext - 小写扩展名。
     * @returns `{ kind, text, pageCount?, truncated?, cachePath? }`。
     */
    const paperTextOf = async (target, ext) => {
      const info = await stat(target);
      if (ext === 'pdf') {
        const cached = pdfCache.get(target);
        if (cached !== undefined && cached.mtime === info.mtimeMs) return cached;
        if (pdfInflight.has(target)) return pdfInflight.get(target);
        const task = (async () => {
          const result = await extractPdfText(target, { maxChars: MAX_CONTEXT_CHARS });
          const value = {
            kind: 'pdf',
            text: result.text,
            pageCount: result.pageCount,
            pagesRead: result.pagesRead,
            truncated: result.truncated,
            mtime: info.mtimeMs,
          };
          pdfCache.set(target, value);
          return value;
        })().finally(() => pdfInflight.delete(target));
        pdfInflight.set(target, task);
        return task;
      }
      const text = await readFile(target, 'utf8');
      return { kind: 'text', text: text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text, truncated: text.length > MAX_CONTEXT_CHARS };
    };

    /** GET text：抽取 PDF/文本正文（右栏对话与总结共用）。 */
    const handleText = async (req, res, url) => {
      const roots = allowedRoots();
      let target;
      try {
        target = await resolveInside(url.searchParams.get('path'), roots);
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      let info;
      try {
        info = await stat(target);
      } catch {
        fail(res, 404, 'not-found', '文件不存在');
        return;
      }
      if (!info.isFile()) {
        fail(res, 400, 'not-a-file', 'path 必须是文件');
        return;
      }
      const ext = extOf(target);
      if (ext !== 'pdf' && !TEXT_EXT.has(ext)) {
        fail(res, 415, 'not-readable', '该格式无法提取文字');
        return;
      }
      try {
        const extracted = await paperTextOf(target, ext);
        json(res, 200, {
          ok: true,
          path: target,
          name: path.basename(target),
          kind: extracted.kind,
          pageCount: extracted.pageCount ?? null,
          truncated: extracted.truncated === true,
          length: extracted.text.length,
          text: extracted.text,
        });
      } catch (error) {
        fail(res, 500, 'extract-failed', `文字提取失败：${error.message}`);
      }
    };

    /** GET pdfjs/*：转发 pdfjs-dist 静态资源（页面端动态 import / worker / cmaps / wasm）。 */
    const handlePdfAsset = async (req, res, url) => {
      const relative = url.pathname.slice(`${PREFIX}/pdfjs/`.length);
      if (relative.length === 0 || relative.includes('..') || relative.includes('\u0000')) {
        fail(res, 400, 'bad-asset', '资源名非法');
        return;
      }
      const dir = pdfjsDir();
      const candidates = [
        path.join(dir, relative),
        path.join(dir, 'build', path.basename(relative)),
      ];
      const found = await firstExisting(candidates);
      if (found === undefined) {
        fail(res, 404, 'asset-missing', `pdfjs 资源不存在：${relative}`);
        return;
      }
      const ext = extOf(found);
      const mime = ext === 'mjs' || ext === 'js' ? 'text/javascript; charset=utf-8'
        : ext === 'wasm' ? 'application/wasm'
          : ext === 'bcmap' || ext === 'ttf' || ext === 'otf' || ext === 'pfb' ? 'application/octet-stream'
            : 'text/plain; charset=utf-8';
      const assetInfo = await stat(found);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': assetInfo.size,
        'Cache-Control': 'public, max-age=86400',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(found);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    };

    /** 子代理能力摘要（给 client/health 用）。 */
    const chatCapability = () => {
      const service = webCtx.get('subagents');
      const available = service !== undefined && typeof service.startContinuable === 'function';
      return { available, provider: available ? (chats.providerName() ?? null) : null, mode: 'subagent' };
    };

    /** GET chat：子代理状态 + 只读镜像。 */
    const handleChatState = async (req, res, url) => {
      let target;
      try {
        target = await resolveInside(url.searchParams.get('path'), allowedRoots());
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const state = await chats.stateOf({ paper: target, sessionId });
      json(res, 200, { ok: true, path: target, chat: chatCapability(), ...state });
    };

    /** POST chat：在当前会话下起一个论文子代理（已存在则复用）。 */
    const handleChatStart = async (req, res) => {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      const capability = chatCapability();
      if (!capability.available) {
        fail(res, 503, 'subagents-unavailable', '当前组合没有子代理服务（dsh-subagent），无法开论文子代理');
        return;
      }
      let target;
      try {
        target = await resolveInside(body.path, allowedRoots());
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined;
      if (sessionId === undefined) {
        fail(res, 400, 'missing-session', '需要当前会话 id：论文子代理必须挂在你的会话下');
        return;
      }
      let info;
      try {
        info = await stat(target);
      } catch {
        fail(res, 404, 'not-found', '文件不存在');
        return;
      }
      if (!info.isFile()) {
        fail(res, 400, 'not-a-file', 'path 必须是文件');
        return;
      }

      const existing = await chats.record(target);
      const mode = body.mode === 'summary' ? 'summary' : 'ask';
      try {
        // 首次（或换了父会话）才需要喂上下文；已存在就只返回地址，让人类侧继续聊。
        let prompt;
        let preamble;
        if (existing === undefined || existing.parentSessionId !== sessionId || mode === 'summary') {
          const ext = extOf(target);
          let extracted;
          if (ext === 'pdf' || TEXT_EXT.has(ext)) {
            try {
              extracted = await paperTextOf(target, ext);
            } catch (error) {
              webCtx.logger?.warn?.(`paper-reader: 论文上下文抽取失败（${error.message}）`);
            }
          }
          preamble = contextPreamble({
            path: target,
            name: path.basename(target),
            kind: ext === 'pdf' ? 'pdf' : 'text',
            pageCount: extracted?.pageCount,
            extracted: extracted?.pagesRead,
            truncated: extracted?.truncated === true,
          });
          if (extracted?.kind === 'pdf' && typeof extracted.text === 'string' && extracted.text.length > 0) {
            preamble = `${preamble}\n\n===== 抽取正文开始 =====\n${extracted.text}\n===== 抽取正文结束 =====`;
          }
          const ask = typeof body.message === 'string' && body.message.trim().length > 0 ? body.message.trim() : '请先通读这篇论文，按「一句话结论 / 研究问题与动机 / 方法与技术路线 / 关键实验与结果 / 结论、局限与可借鉴 / 术语速查」六段给我一份中文精读总结。';
          prompt = ask;
        }
        const started = await chats.ensure({ paper: target, sessionId, prompt, preamble });
        json(res, 200, {
          ok: true,
          path: target,
          childId: started.childId,
          address: started.address,
          reused: started.reused === true,
          chat: capability,
        });
      } catch (error) {
        fail(res, 500, 'subagent-failed', error instanceof Error ? error.message : String(error));
      }
    };

    /** GET chat/stream：只读转发子代理输出（NDJSON，长连接）。 */
    const handleChatStream = async (req, res, url) => {
      let target;
      try {
        target = await resolveInside(url.searchParams.get('path'), allowedRoots());
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const record = await chats.record(target);
      if (record === undefined) {
        fail(res, 404, 'no-subagent', '这篇论文还没有子代理，先点「开始/精读总结」');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      let closed = false;
      const write = (event) => {
        if (closed || res.writableEnded) return;
        res.write(`${JSON.stringify(event)}\n`);
      };
      const child = chats.liveChild(record.childId);
      write({ type: 'state', childId: record.childId, running: child !== undefined && child.status === 'running', live: child !== undefined });
      if (child !== undefined) {
        for (const message of mirrorMessages(child)) write({ type: 'message', message });
      }
      // 只转发这个子代理自己的帧。
      const off = webCtx.on?.('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (subject === undefined || subject.session?.id !== record.childId) return;
        if (frame?.type !== 'chunk') return;
        const chunk = frame.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          write({ type: 'delta', text: chunk.text });
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' && typeof chunk.block.name === 'string') {
          write({ type: 'tool', name: chunk.block.name });
        }
      }, { global: true }) ?? (() => {});
      const heartbeat = setInterval(() => write({ type: 'ping', at: Date.now() }), 20_000);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        off();
        if (!res.writableEnded) res.end();
      };
      res.on('close', stop);
      // 子代理结束一轮后补一条 done，前端可据此收尾。
      const watch = setInterval(() => {
        const current = chats.liveChild(record.childId);
        if (current === undefined || current.status !== 'running') {
          write({ type: 'idle', at: Date.now() });
          clearInterval(watch);
        }
      }, 1_500);
      if (typeof watch.unref === 'function') watch.unref();
      req.on('close', () => { clearInterval(watch); stop(); });
      return undefined;
    };

    /** 从活的子会话里取镜像消息（供流式首帧）。 */
    const mirrorMessages = (child) => {
      try {
        const messages = [];
        const length = Number.isSafeInteger(child.session?.seq) ? child.session.seq : 0;
        for (let seq = 0; seq < length; seq += 1) {
          const event = child.session.eventAt?.(seq);
          if (event?.type === 'assistant/message') {
            const text = (event.data?.message?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
            if (text.length > 0) messages.push({ role: 'assistant', text });
          } else if (event?.type === 'user/message') {
            const text = (event.data?.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
            if (text.length > 0) messages.push({ role: 'user', text });
          }
        }
        return messages.slice(-40);
      } catch { return []; }
    };

    /** POST chat/interrupt：人类权限打断子代理。 */
    const handleChatInterrupt = async (req, res) => {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      let target;
      try {
        target = await resolveInside(body.path, allowedRoots());
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      try {
        const result = await chats.interrupt({
          paper: target,
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        });
        json(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, 403, 'interrupt-denied', error instanceof Error ? error.message : String(error));
      }
    };

    /** POST chat/reset：忘掉这篇论文的子代理映射。 */
    const handleChatReset = async (req, res) => {
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      let target;
      try {
        target = await resolveInside(body.path, allowedRoots());
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      const forgotten = await chats.forget(target);
      json(res, 200, { ok: true, forgotten });
    };

/** GET tree：列出工作区文稿目录树。 */
    const handleTree = async (req, res, url) => {
      const roots = allowedRoots();
      const all = url.searchParams.get('all') === '1';
      const rawRoot = url.searchParams.get('root') ?? roots[0];
      let dir;
      try {
        dir = await resolveInside(rawRoot, roots);
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      const counter = { count: 0 };
      let info;
      try {
        info = await stat(dir);
      } catch {
        fail(res, 404, 'not-found', '目录不存在');
        return;
      }
      if (!info.isDirectory()) {
        fail(res, 400, 'not-a-directory', 'root 必须是目录');
        return;
      }
      const nodes = await buildTree(dir, 0, {
        all,
        depth: MAX_TREE_DEPTH,
        maxNodes: MAX_TREE_NODES,
      }, counter);
      const parent = path.dirname(dir);
      json(res, 200, {
        ok: true,
        root: dir,
        roots,
        all,
        nodes,
        truncated: counter.count >= MAX_TREE_NODES,
        parent: roots.some((root) => insideRoot(parent, root)) ? parent : null,
      });
    };

    /** GET file：读单篇正文（文本内联，二进制给 raw 链接）。 */
    const handleFile = async (req, res, url) => {
      const roots = allowedRoots();
      let target;
      try {
        target = await resolveInside(url.searchParams.get('path'), roots);
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      let info;
      try {
        info = await stat(target);
      } catch {
        fail(res, 404, 'not-found', '文件不存在');
        return;
      }
      if (!info.isFile()) {
        fail(res, 400, 'not-a-file', 'path 必须是文件');
        return;
      }
      const ext = extOf(target);
      const kind = kindOf(ext);
      const base = {
        ok: true,
        path: target,
        name: path.basename(target),
        dir: path.dirname(target),
        ext,
        kind,
        size: info.size,
        mtime: Math.round(info.mtimeMs),
        rawUrl: `${PREFIX}/raw?path=${encodeURIComponent(target)}`,
      };
      if (kind === 'pdf' || kind === 'binary' || kind === 'image' || kind === 'html') {
        json(res, 200, { ...base, text: null, truncated: false });
        return;
      }
      if (info.size > MAX_TEXT_BYTES) {
        json(res, 200, {
          ...base,
          kind: 'binary',
          text: null,
          truncated: false,
          note: `文件超过 ${Math.round(MAX_TEXT_BYTES / 1024 / 1024)} MiB，请下载后阅读`,
        });
        return;
      }
      let text;
      try {
        text = await readFile(target, 'utf8');
      } catch (error) {
        fail(res, 500, 'read-failed', `读取失败：${error.message}`);
        return;
      }
      json(res, 200, { ...base, text, truncated: false });
    };

    /** GET raw：原样回字节（PDF/图片/HTML 内嵌）。 */
    const handleRaw = async (req, res, url) => {
      const roots = allowedRoots();
      let target;
      try {
        target = await resolveInside(url.searchParams.get('path'), roots);
      } catch (error) {
        fail(res, 400, 'bad-path', error.message);
        return;
      }
      let info;
      try {
        info = await stat(target);
      } catch {
        fail(res, 404, 'not-found', '文件不存在');
        return;
      }
      if (!info.isFile()) {
        fail(res, 400, 'not-a-file', 'path 必须是文件');
        return;
      }
      const ext = extOf(target);
      const download = url.searchParams.get('download') === '1';
      const name = path.basename(target);
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Security-Policy': "sandbox allow-same-origin; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(target);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    };

        /** POST summary：流式（NDJSON）生成中文精读总结。 */
    const handleSummary = async (req, res) => {
      const roots = allowedRoots();
      let body;
      try {
        body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
      } catch (error) {
        fail(res, 400, 'bad-body', `请求体无效：${error.message}`);
        return;
      }
      const llm = typeof webCtx.get === 'function' ? webCtx.get('llm') : undefined;
      if (llm === undefined || typeof llm.stream !== 'function') {
        fail(res, 503, 'llm-unavailable', '当前组合没有可用的 llm 服务，无法生成总结');
        return;
      }
      const defaultModel = typeof webCtx.get === 'function' ? webCtx.get('agentDefaultModel') : undefined;
      let route;
      try {
        route = defaultModel?.currentSelection?.();
      } catch {
        route = undefined;
      }
      if (route === undefined || typeof route.provider !== 'string' || typeof route.model !== 'string') {
        fail(res, 503, 'no-default-model', '没有可用的默认模型，请先在设置里选择模型');
        return;
      }

      let paperText = typeof body.text === 'string' && body.text.length > 0 ? body.text : undefined;
      let paperName = typeof body.name === 'string' ? body.name : '正文';
      let paperPath = typeof body.path === 'string' ? body.path : undefined;
      if (paperText === undefined) {
        if (paperPath === undefined) {
          fail(res, 400, 'missing-input', '需要 path 或 text');
          return;
        }
        let target;
        try {
          target = await resolveInside(paperPath, roots);
        } catch (error) {
          fail(res, 400, 'bad-path', error.message);
          return;
        }
        const ext = extOf(target);
        if (!TEXT_EXT.has(ext)) {
          fail(res, 415, 'not-readable', '该格式无法直接提取文字（PDF/Word 请先在对话里让 Agent 转成 Markdown）');
          return;
        }
        try {
          paperText = await readFile(target, 'utf8');
        } catch (error) {
          fail(res, 500, 'read-failed', `读取失败：${error.message}`);
          return;
        }
        paperName = path.basename(target);
        paperPath = target;
      }

      const framed = truncateForModel(paperText);
      const userText = [
        `请精读这篇论文并按要求输出中文总结。文件：${paperName}`,
        paperPath === undefined ? '' : `路径：${paperPath}`,
        framed.truncated ? '（正文过长，已做头尾截断）' : '',
        '',
        '<<<PAPER',
        framed.text,
        'PAPER>>>',
      ].filter((line) => line !== '').join('\n');

      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.on('close', onClose);
      const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
      let closed = false;
      const writeEvent = (event) => {
        if (closed || res.writableEnded) return;
        res.write(`${JSON.stringify(event)}\n`);
      };
      try {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        writeEvent({ type: 'start', route: { provider: route.provider, model: route.model }, name: paperName, truncated: framed.truncated });

        const message = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: userText }],
          source: { kind: 'plugin', plugin: 'dsh-paper-reader' },
        };
        const chunks = new Map();
        let finish;
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [message],
          system: SUMMARY_SYSTEM,
          maxTokens: SUMMARY_MAX_TOKENS,
          purpose: 'paper-summary',
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') {
            chunks.set(chunk.index, (chunks.get(chunk.index) ?? '') + chunk.text);
            writeEvent({ type: 'delta', text: chunk.text });
          } else if (chunk.type === 'finish') {
            finish = chunk.reason;
          }
        }
        if (finish !== undefined && finish.kind !== 'stop') {
          const detail = finish.kind === 'max-tokens'
            ? '输出达到长度上限，总结可能不完整'
            : finish.failure?.message ?? '模型调用未正常结束';
          writeEvent({ type: 'error', message: detail });
        } else {
          const summary = [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('');
          if (summary.trim().length === 0) writeEvent({ type: 'error', message: '模型没有返回任何内容' });
          else writeEvent({ type: 'done', summary, truncated: framed.truncated });
        }
        closed = true;
        res.end();
      } catch (error) {
        closed = true;
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) fail(res, 500, 'summary-failed', message);
        else {
          writeEvent({ type: 'error', message });
          res.end();
        }
      } finally {
        clearTimeout(timer);
        res.off('close', onClose);
      }
    };

    const route = async (req, res) => {
      if (reject(req, res)) return;
      let url;
      try {
        url = new URL(req.url ?? PREFIX, 'http://localhost');
      } catch {
        fail(res, 400, 'bad-url', '无法解析请求 URL');
        return;
      }
      const sub = url.pathname.slice(PREFIX.length).replace(/^\/+/, '');
      try {
        if (sub === 'tree') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', '需要 GET');
          return await handleTree(req, res, url);
        }
        if (sub === 'file') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', '需要 GET');
          return await handleFile(req, res, url);
        }
        if (sub === 'raw') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', '需要 GET');
          return await handleRaw(req, res, url);
        }
        if (sub === 'text') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', '需要 GET');
          return await handleText(req, res, url);
        }
        if (sub.startsWith('pdfjs/')) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', '需要 GET');
          return await handlePdfAsset(req, res, url);
        }
        if (sub === 'chat') {
          if (req.method === 'GET' || req.method === 'HEAD') return await handleChatState(req, res, url);
          if (req.method === 'POST') return await handleChatStart(req, res);
          return fail(res, 405, 'method', '需要 GET 或 POST');
        }
        if (sub === 'chat/stream') {
          if (req.method !== 'GET') return fail(res, 405, 'method', '需要 GET');
          return await handleChatStream(req, res, url);
        }
        if (sub === 'chat/interrupt') {
          if (req.method !== 'POST') return fail(res, 405, 'method', '需要 POST');
          return await handleChatInterrupt(req, res);
        }
        if (sub === 'chat/reset') {
          if (req.method !== 'POST') return fail(res, 405, 'method', '需要 POST');
          return await handleChatReset(req, res);
        }
        if (sub === 'summary') {
          if (req.method !== 'POST') return fail(res, 405, 'method', '需要 POST');
          return await handleSummary(req, res);
        }
        if (sub === 'health' || sub === '') {
          return json(res, 200, {
            ok: true,
            roots: allowedRoots(),
            version: '0.2.0',
            chat: chatCapability(),
          });
        }
        return fail(res, 404, 'unknown', '未知的 paper-reader 端点');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        webCtx.logger?.warn?.(`paper-reader: ${sub} 处理失败：${message}`);
        if (!res.headersSent) fail(res, 500, 'internal', message);
        else res.destroy();
      }
      return undefined;
    };

    webCtx.effect(() => webServer.register({ kind: 'prefix', path: PREFIX, handler: route }), 'dsh-paper-reader: /api/paper-reader 路由');
    webCtx.logger?.info?.(`dsh-paper-reader: 论文阅读接口已挂载 ${PREFIX}（根目录 ${allowedRoots().join(', ')}）`);
  });
}
