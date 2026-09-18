/**
 * 论文子代理引擎（宿主半）—— 不再自搓会话，直接用平台的子代理子系统。
 *
 * 依据官方契约（docs/subsystems/subagent）：`ctx.subagents.startContinuable({provider, label, request})`
 * 会在**父会话**下开一个可续聊的 durable 子会话（child Session + 活着的 Activation）：
 *   - 子会话挂在用户当前的会话下 → 委派记录与交付通知都留在**用户和 Agent 的对话**里；
 *   - 子代理的上下文/工具由 provider 从父 Agent 组合继承，不需要我们内联模型选择钩子；
 *   - 后续消息由**人类侧**通道进入（浏览器 subagent.prompt，见客户端「在原生会话里打开」），
 *     宿主这里只负责：起会话、只读镜像、按人类权限打断。
 *
 * 因此本模块只做四件事：
 *   1. 每篇论文记住一个 childId（落盘，重启后仍是同一个子代理）；
 *   2. startContinuable 起会话（首轮把论文上下文/正文喂进去）；
 *   3. 从子会话事件日志读镜像 + 转发实时 assistant-stream（只读，不代替原生 UI）；
 *   4. interrupt 用 `{kind:'user', parentSessionId}` 权限打断——与浏览器端同一套权限。
 *
 * @module dsh-paper-reader/chat
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** 注入给子代理的论文正文上限（PDF 抽取结果）。 */
export const MAX_CONTEXT_CHARS = 60_000;
/** 镜像里最多保留多少条（超过就只留尾部）。 */
const MAX_MIRROR_MESSAGES = 60;
/** 默认的进程内子代理 provider 名（组合里 dsh-subagent-spawn-in-process 的 providerName）。 */
const DEFAULT_PROVIDER = 'spawn';

/**
 * 首轮提示词（中文）。按用户要求：**直接把文件给它，让它自己调工具读**；
 * 如果是 PDF，再给一个插件抽取好的纯文本缓存路径作为兜底（环境里未必有 pdf 解析工具）。
 * @param info - 论文信息。
 * @returns 中文提示词。
 */
export function firstPrompt({ path: paperPath, name, kind, pageCount, cachePath }) {
  const lines = [];
  lines.push(`我要读下面这篇论文，你先把正文读进来，再按“一句话结论 / 研究问题 / 方法与技术路线 / 关键实验与结果 / 局限与可借鉴 / 术语速查”六段给我中文精读总结。`);
  lines.push('');
  lines.push(`论文文件：${paperPath}`);
  if (kind === 'pdf') {
    lines.push('这是 PDF。请先用工具把正文读出来（read、bash 都可以试，比如 pdftotext、python 的 pdf 库）；');
    lines.push(`如果这个环境里没有能解析 PDF 的工具，我已经用 pdf.js 把文字抽取好放在这里，直接 read 它即可：${cachePath}`);
    if (pageCount !== undefined) lines.push(`原 PDF 共 ${pageCount} 页。`);
  } else {
    lines.push('这是工作区里的文本文件，直接用 read 读它。');
  }
  lines.push('');
  lines.push('回答一律用中文，给结论时尽量带上页码或小节编号。');
  return lines.join('\n');
}

/** 抽取正文的缓存路径（插件自己的目录，不动用户文件）。 */
export function cachePathFor(dir, paperPath, mtimeMs) {
  const hash = createHash('sha1').update(`${paperPath}:${mtimeMs ?? 0}`).digest('hex').slice(0, 16);
  return path.join(dir, 'cache', `${path.basename(paperPath).replace(/[^\w.-]+/g, '_')}.${hash}.md`);
}

/** 从一条消息里取纯文本。 */
function textOfMessage(message) {
  if (message === undefined || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 把子会话的事件日志折叠成面板镜像消息（只读视图）。
 * @param session - 子会话对象（有 eventAt / seq）。
 * @returns 镜像消息数组。
 */
export function mirrorOf(source) {
  const out = [];
  try {
    const events = Array.isArray(source)
      ? source
      : (() => {
        const length = Number.isSafeInteger(source?.seq) ? source.seq : 0;
        const list = [];
        for (let seq = 0; seq < length; seq += 1) {
          const event = source.eventAt?.(seq);
          if (event !== undefined) list.push(event);
        }
        return list;
      })();
    const calls = new Map();
    for (const event of events) {
      if (event === undefined) continue;
      if (event.type === 'user/message') {
        const message = event.data;
        const text = textOfMessage(message);
        if (text.length === 0) continue;
        out.push({ role: 'user', text, plugin: message?.source?.kind !== 'user', at: SeqTime(event) });
      } else if (event.type === 'assistant/message') {
        const message = event.data?.message;
        const text = textOfMessage(message);
        const tools = [];
        for (const block of message?.content ?? []) {
          if (block?.type === 'tool-call') {
            if (typeof block.name === 'string') tools.push(block.name);
            if (typeof block.id === 'string') calls.set(block.id, block.name);
          }
        }
        if (text.length === 0 && tools.length === 0) continue;
        out.push({ role: 'assistant', text, tools, at: SeqTime(event) });
      }
    }
  } catch { /* 日志读不到就给空镜像 */ }
  return out.slice(-MAX_MIRROR_MESSAGES);
}

/** 事件里没有时间戳时用 seq 占位，避免前端排序出问题。 */
function SeqTime(event) {
  const stamp = event?.time ?? event?.at;
  return typeof stamp === 'number' ? stamp : undefined;
}

/**
 * 论文子代理管理器。
 */
export class PaperSubagents {
  /**
   * @param options - 宿主上下文、日志、存储根。
   */
  constructor({ ctx, logger, home }) {
    this.ctx = ctx;
    this.logger = logger;
    this.dir = path.join(home ?? '/root/.dsh', 'storages', 'paper-reader');
    this.file = path.join(this.dir, 'subagents.json');
    this.state = { version: 2, papers: {} };
    this.loaded = false;
    /** 正在启动中的 childId，避免并发起两个子代理。 */
    this.starting = new Map();
  }

  /** 读存储（容错）。 */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && parsed.papers !== undefined) {
        this.state = { version: 2, papers: parsed.papers };
      }
    } catch { /* 首次运行或文件损坏 */ }
  }

  /** 原子写回。 */
  async save() {
    try {
      await mkdir(this.dir, { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.state), 'utf8');
      await rename(temp, this.file);
    } catch (error) {
      this.logger?.warn?.(`paper-reader: 子代理映射写入失败：${error.message}`);
    }
  }

  /** 取（不创建）一篇论文的子代理记录。 */
  async record(paperPath) {
    await this.load();
    const entry = this.state.papers[paperPath];
    return entry !== undefined && typeof entry.childId === 'string' ? entry : undefined;
  }

  /** 忘掉一篇论文的子代理（下次重新起）。 */
  async forget(paperPath) {
    await this.load();
    const existed = this.state.papers[paperPath] !== undefined;
    delete this.state.papers[paperPath];
    if (existed) await this.save();
    return existed;
  }

  /** 子代理服务（组合里没有就返回 undefined）。 */
  subagents() {
    try { return this.ctx.get('subagents'); } catch { return undefined; }
  }

  /** 选一个可用的 provider 名：优先组合里配置的 spawn，再退到第一个已注册的。 */
  providerName() {
    const service = this.subagents();
    if (service === undefined) return undefined;
    for (const candidate of [DEFAULT_PROVIDER, 'fork']) {
      try { if (service.getProvider(candidate) !== undefined) return candidate; } catch { /* 试下一个 */ }
    }
    try {
      const names = service.listProviders?.();
      if (Array.isArray(names) && names.length > 0) return names[0];
    } catch { /* 没有清单 */ }
    return undefined;
  }

  /** 取父 Agent（人类正在聊的那个会话的 agent）。 */
  async parentAgent(sessionId) {
    const agents = this.ctx.get('agents');
    if (agents === undefined) throw new Error('当前组合没有 agents 服务');
    const live = agents.get(sessionId);
    if (live !== undefined) return live;
    // 会话不在内存里（比如刚重启）：按会话恢复一个父 Agent 再起子代理。
    const handle = await agents.resume({ resumeSessionId: sessionId });
    return handle.agent;
  }

  /** 子代理活着的 Agent（用于镜像与状态）。 */
  liveChild(childId) {
    try { return this.ctx.get('agents')?.get(childId); } catch { return undefined; }
  }

  /**
   * 起一个论文子代理（已存在就复用）。
   * @param request - 论文路径、父会话 id、首个提问（可选）、上下文前言。
   * @returns `{ childId, address, reused }`。
   */
  async ensure({ paper, sessionId, prompt, preamble }) {
    const service = this.subagents();
    if (service === undefined || typeof service.startContinuable !== 'function') {
      throw new Error('当前组合没有子代理服务（dsh-subagent），无法开论文子代理');
    }
    const provider = this.providerName();
    if (provider === undefined) throw new Error('没有已注册的子代理 provider，无法开论文子代理');

    const existing = await this.record(paper);
    if (existing !== undefined && existing.parentSessionId === sessionId) {
      const live = this.liveChild(existing.childId);
      return {
        childId: existing.childId,
        parentSessionId: sessionId,
        address: { parentSessionId: sessionId, childSessionId: existing.childId, mode: 'continuable' },
        reused: true,
        live: live !== undefined,
      };
    }

    const inFlight = this.starting.get(paper);
    if (inFlight !== undefined) return inFlight;

    const task = (async () => {
      const parent = await this.parentAgent(sessionId);
      const text = [preamble ?? '', prompt ?? ''].filter((part) => part.length > 0).join('\n\n');
      // 注意：startContinuable 同时要顶层 signal 与 request.signal（见 dsh-subagent 实现），
      // 少一个就会在 spec.signal.throwIfAborted() 处炸。
      const signal = AbortSignal.timeout(60_000);
      const started = await service.startContinuable({
        provider,
        label: `论文：${path.basename(paper)}`,
        signal,
        request: {
          prompt: [{ type: 'text', text }],
          parent,
          signal,
        },
      });
      const entry = {
        childId: started.childId,
        parentSessionId: sessionId,
        paper,
        provider,
        createdAt: Date.now(),
      };
      await this.load();
      this.state.papers[paper] = entry;
      await this.save();
      return {
        childId: entry.childId,
        parentSessionId: sessionId,
        address: { parentSessionId: sessionId, childSessionId: entry.childId, mode: 'continuable' },
        reused: false,
        live: true,
      };
    })().finally(() => this.starting.delete(paper));
    this.starting.set(paper, task);
    return task;
  }

  /**
   * 面板状态 + 只读镜像。
   * @param request - 论文路径（可带父会话 id 以便校验）。
   * @returns 状态与镜像消息。
   */
  async stateOf({ paper, sessionId }) {
    const entry = await this.record(paper);
    if (entry === undefined) {
      return { childId: null, address: null, status: 'none', running: false, messages: [] };
    }
    const child = this.liveChild(entry.childId);
    // 活着的子代理直接读它的会话；已被回收（一轮跑完 Activation 就释放）的
    // 冷子代理用 sessionQuery.readSession 读完整日志——官方"读冷会话、不激活"的口子。
    let messages = [];
    if (child !== undefined) {
      messages = mirrorOf(child.session);
    } else {
      const read = this.ctx.get('sessionQuery');
      if (read !== undefined && typeof read.readSession === 'function') {
        try {
          const cold = await read.readSession(entry.childId);
          messages = mirrorOf(cold?.events ?? []);
        } catch (error) {
          this.logger?.info?.(`paper-reader: 读冷子代理日志失败（${error.message}）`);
        }
      }
    }
    return {
      childId: entry.childId,
      address: { parentSessionId: entry.parentSessionId, childSessionId: entry.childId, mode: 'continuable' },
      parentSessionId: entry.parentSessionId,
      status: child === undefined ? 'cold' : (child.status === 'running' ? 'running' : 'idle'),
      running: child !== undefined && child.status === 'running',
      messages,
      createdAt: entry.createdAt,
      stale: sessionId !== undefined && entry.parentSessionId !== sessionId,
    };
  }

  /**
   * 把抽取出来的正文写到插件自己的缓存目录（用户文件不动）。
   * @param paper - 论文路径。
   * @param mtimeMs - 文件修改时间，用于生成缓存名。
   * @param text - 正文。
   * @returns 缓存文件路径。
   */
  async writeCache(paper, mtimeMs, text) {
    const target = cachePathFor(this.dir, paper, mtimeMs);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, 'utf8');
      return target;
    } catch (error) {
      this.logger?.warn?.(`paper-reader: 正文缓存写入失败：${error.message}`);
      return undefined;
    }
  }

  /**
   * 用人类权限给子代理发一条消息（等价于浏览器端 subagents.prompt）。
   * 子代理处于冷状态时，这条通道会自动把它恢复起来；父会话不在内存里会先恢复父会话。
   * @param request - 论文、父会话、消息内容。
   * @returns `{ childId, messageId }`。
   */
  async send({ paper, sessionId, message, delivery }) {
    const service = this.subagents();
    if (service === undefined || typeof service.prompt !== 'function') {
      throw new Error('当前组合没有子代理服务，无法发送');
    }
    const entry = await this.record(paper);
    if (entry === undefined) throw new Error('这篇论文还没有子代理，请先开始');
    const parentSessionId = sessionId ?? entry.parentSessionId;
    if (entry.parentSessionId !== parentSessionId) throw new Error('这条子代理不属于当前会话，请先重置');
    // prompt() 要求父会话在内存里活着
    await this.parentAgent(parentSessionId);
    const result = await service.prompt({
      parentSessionId,
      childSessionId: entry.childId,
      // 这几个字段是 subagent.prompt 的校验必填项（见 dsh-subagent CONTROL_ID_SCHEMAS）
      mode: 'continuable',
      delivery: delivery === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text: message }],
      // requestId 必须给（浏览器端由 Remote 生成）：留空会让 rpcId 变成 undefined，
      // 而会话日志要求事件数据可 JSON 序列化，undefined 会被判为非法。
      requestId: randomUUID(),
    }, AbortSignal.timeout(120_000)).catch((error) => { // 浏览器侧由 Remote 传 signal；宿主直调要自己给
      const cause = error?.cause;
      const detail = cause === undefined ? '' : `：${cause instanceof Error ? cause.message : String(cause)}`;
      this.logger?.warn?.(`paper-reader: 发消息失败${detail}`);
      throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
    });
    return { childId: entry.childId, messageId: result?.messageId, parentSessionId };
  }

  /**
   * 人类权限打断（与浏览器端 interruptByParent 同一权限模型）。
   * @param request - 论文路径与父会话 id。
   */
  async interrupt({ paper, sessionId }) {
    const service = this.subagents();
    const entry = await this.record(paper);
    if (service === undefined || entry === undefined) return { interrupted: false };
    const parentSessionId = sessionId ?? entry.parentSessionId;
    if (entry.parentSessionId !== parentSessionId) throw new Error('子代理不属于当前会话，拒绝打断');
    service.interrupt(entry.childId, { kind: 'user', parentSessionId });
    return { interrupted: true };
  }
}
