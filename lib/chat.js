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

/** 注入给子代理的论文正文上限（PDF 抽取结果）。 */
export const MAX_CONTEXT_CHARS = 60_000;
/** 镜像里最多保留多少条（超过就只留尾部）。 */
const MAX_MIRROR_MESSAGES = 60;
/** 默认的进程内子代理 provider 名（组合里 dsh-subagent-spawn-in-process 的 providerName）。 */
const DEFAULT_PROVIDER = 'spawn';

/** 上下文前言：告诉子代理它在陪读哪篇论文。 */
export function contextPreamble({ path: paperPath, name, kind, pageCount, extracted, truncated }) {
  const lines = [
    '【论文阅读上下文】你在陪读下面这篇论文，接下来的提问都围绕它。',
    `文件：${name}`,
    `路径：${paperPath}`,
  ];
  if (kind === 'pdf') {
    lines.push('这是一份 PDF：正文已由插件抽取如下（直接读即可，不必尝试 read 该 PDF）。');
    if (pageCount !== undefined) lines.push(`PDF 共 ${pageCount} 页，抽取 ${extracted ?? '?'} 页${truncated ? '（因长度截断）' : ''}。`);
  } else {
    lines.push('这是工作区里的文本文件，需要细节时请直接用 read 工具读取该路径。');
  }
  lines.push('回答用中文，尽量给出原文依据（页码/小节/公式编号）。');
  return lines.join('\n');
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
   * 人类权限打断（与浏览器端 subagents.interruptByParent 同一权限模型）。
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
