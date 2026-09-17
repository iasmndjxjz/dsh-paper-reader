/**
 * 论文实时对话引擎（宿主半）。
 *
 * 右栏的对话不是"假聊天"：它为每篇论文维护一个**真正的 DSH 会话**，
 * 用 `ctx.agents` 创建/恢复 Agent，把用户消息排进它的 inbox，
 * 再把 `agent/assistant-stream` 的增量转发给浏览器（NDJSON），
 * 因此工具调用、读写文件、上下文压缩、会话持久化都是原生的。
 *
 * 与 `@deepseek-ai/dsh-api-session-controller` 的关系：
 *   该包用 `installModelSelection()` 把"这条会话用哪个模型"装进 agent 上下文；
 *   本插件不 import 任何 @deepseek-ai/* 运行时包（保持零解析风险），
 *   因此这里内联了同一套钩子（system-prompt/assemble 变量 + agent/request 覆盖）。
 *
 * @module dsh-paper-reader/chat
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 一次提问最多等多久（毫秒）。 */
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** 每个论文会话最多保留多少条面板消息。 */
const MAX_STORED_MESSAGES = 300;
/** 注入给模型的论文正文上限（PDF 抽取结果）。 */
export const MAX_CONTEXT_CHARS = 60_000;

/** 上下文注入消息：告诉模型它在陪读哪篇论文。 */
export function contextPreamble({ path: paperPath, name, kind, pageCount, extracted, truncated, cache }) {
  const lines = [
    '【论文阅读上下文】我正在论文阅读器里读下面这篇论文，接下来请围绕它和我对话。',
    `文件：${name}`,
    `路径：${paperPath}`,
  ];
  if (kind === 'pdf') {
    lines.push('这是一份 PDF：正文已由插件抽取如下（供你直接阅读，不必尝试 read 该 PDF）。');
    if (pageCount !== undefined) lines.push(`PDF 共 ${pageCount} 页，抽取了 ${extracted} 页${truncated ? '（因长度截断）' : ''}。`);
    if (cache !== undefined) lines.push(`完整抽取结果也缓存在：${cache}（可用 read 工具读取）`);
  } else {
    lines.push('这是工作区里的文本文件，需要细节时请直接用 read 工具读取该路径。');
  }
  lines.push('回答请用中文，尽量给出原文依据（页码/小节/公式编号）。');
  return lines.join('\n');
}

/**
 * 读最近一次 turn 的结局：whenIdle() 即使模型调用失败也会正常返回，
 * 所以必须回读会话日志里的 `turn/end.reason`，否则右栏会出现"空回答"。
 * @param session - agent 的会话对象。
 * @param fromSeq - 本轮开始前的 seq。
 * @returns 失败原因（无失败/无日志时 undefined）。
 */
function readTurnFailure(session, fromSeq) {
  try {
    const length = Number.isSafeInteger(session?.seq) ? session.seq : 0;
    for (let seq = length - 1; seq >= fromSeq; seq -= 1) {
      const event = session.eventAt?.(seq);
      if (event?.type !== 'turn/end') continue;
      const reason = event.data?.reason;
      if (reason?.kind === 'error') return reason.error?.message ?? '模型调用失败';
      return undefined;
    }
  } catch { /* 日志读不到就当作正常结束 */ }
  return undefined;
}

/**
 * 内联版 installModelSelection（与 @deepseek-ai/dsh-agent 同语义的最小实现）：
 * 把 provider/model（可选 reasoningEffort）钉进这条会话的每次请求。
 * @param agentCtx - agent 自己的上下文。
 * @param selection - `{ current }` 形状的选择（current 为 {provider, model, reasoningEffort?}）。
 * @returns 释放器。
 */
export function installModelSelection(agentCtx, selection) {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;
    if (selected === undefined) return assembled;
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    };
  });
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    };
  });
  return () => {
    disposeAssembly();
    disposeRequest();
  };
}

/** 构造一条用户消息（内联版 createUserMessage；不依赖 @deepseek-ai/dsh-llm）。 */
export function userMessage(text, kind = 'user') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin: 'dsh-paper-reader' },
  };
}

/** 从一段正文里抽出纯文本（一条消息的 text block）。 */
function textOfMessage(message) {
  if (message === undefined || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 论文对话管理器：会话映射持久化 + 真 Agent 驱动。
 */
export class PaperChats {
  /**
   * @param options - 注入的宿主上下文与存储位置。
   */
  constructor({ ctx, logger, home }) {
    this.ctx = ctx;
    this.logger = logger;
    this.dir = path.join(home ?? '/root/.dsh', 'storages', 'paper-reader');
    this.file = path.join(this.dir, 'chats.json');
    this.state = { version: 1, papers: {} };
    this.loaded = false;
    /** 正在跑的论文路径，避免同一篇并发两轮。 */
    this.running = new Set();
    /** 本进程内新建过的会话 id（重启后走 resume 而不是 create）。 */
    this.born = new Set();
  }

  /** 读一次存储（容错：坏文件直接重建）。 */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && parsed.papers !== undefined) {
        this.state = { version: 1, papers: parsed.papers };
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
      this.logger?.warn?.(`paper-reader: 论文会话存储写入失败：${error.message}`);
    }
  }

  /** 取（必要时创建）一篇论文的会话记录。 */
  async record(paperPath) {
    await this.load();
    let entry = this.state.papers[paperPath];
    if (entry === undefined || typeof entry.sessionId !== 'string') {
      entry = {
        sessionId: `session-${randomUUID()}`,
        paper: paperPath,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      this.state.papers[paperPath] = entry;
      await this.save();
    }
    return entry;
  }

  /** 面板历史（本插件自己记录的面板视图）。 */
  async history(paperPath) {
    const entry = await this.record(paperPath);
    return { sessionId: entry.sessionId, messages: entry.messages.map((message) => ({ ...message })), createdAt: entry.createdAt };
  }

  /** 清空这篇论文的对话（下一次提问会开一个新会话）。 */
  async reset(paperPath) {
    await this.load();
    const entry = this.state.papers[paperPath];
    if (entry !== undefined) delete this.state.papers[paperPath];
    await this.save();
    return entry !== undefined;
  }

  /** 当前默认模型选择。 */
  selection() {
    try {
      const service = this.ctx.get('agentDefaultModel');
      const selection = service?.currentSelection?.();
      if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return selection;
      }
    } catch { /* 交给调用方报错 */ }
    return undefined;
  }

  /**
   * 组装这条会话的 Agent 组合：解析 Agent 预设（决定工具集与系统提示）并挂上，
   * 同时把"用哪个模型"钉进请求。预设挂载与 api-session-controller 的做法一致。
   * @param entry - 会话记录（会写回 presetId）。
   * @param selection - 模型选择。
   * @returns `{ agentPreset, setup }`。
   */
  async compose(entry, selection) {
    const presets = this.ctx.get('agentPresets');
    const installSelection = (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    };
    if (presets === undefined || typeof presets.mount !== 'function') {
      return { agentPreset: undefined, setup: (agentCtx) => { installSelection(agentCtx); } };
    }
    let resolved;
    try {
      resolved = await presets.resolve(entry.presetId);
    } catch (error) {
      throw new Error(`论文会话的 Agent 预设不可用：${error instanceof Error ? error.message : String(error)}`);
    }
    entry.presetId = resolved.id;
    return {
      agentPreset: resolved.id,
      setup: async (agentCtx) => {
        installSelection(agentCtx);
        await presets.mount(agentCtx, resolved.id);
      },
    };
  }

  /**
   * 确保这条论文会话有一个活着的 Agent（优先复用 → 其次 resume → 最后 create）。
   * @param entry - 会话记录。
   * @param selection - 模型选择。
   * @param cwd - 会话工作目录。
   * @returns live Agent。
   */
  async ensureAgent(entry, selection, cwd) {
    const agents = this.ctx.get('agents');
    if (agents === undefined) throw new Error('当前组合没有 agents 服务，无法开启论文对话');
    const live = agents.get(entry.sessionId);
    if (live !== undefined) return live;
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    };
    const composition = await this.compose(entry, selection);
    // 注意：setup 的返回值会被 agent loop 当成带 commit() 的准备结果调用，
    // 因此组合回调必须是块体、不返回任何东西。
    // 先试恢复（会话已落盘 = 接着上次聊），失败再新建。
    try {
      const handle = await agents.resume({ resumeSessionId: entry.sessionId, agentOptions, setup: composition.setup });
      this.born.add(entry.sessionId);
      return handle.agent;
    } catch (error) {
      this.logger?.info?.(`paper-reader: 恢复会话 ${entry.sessionId} 失败，改为新建（${error.message}）`);
    }
    const handle = await agents.create({
      sessionId: entry.sessionId,
      meta: {
        cwd,
        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
      },
      agentOptions,
      setup: composition.setup,
    });
    this.born.add(entry.sessionId);
    return handle.agent;
  }

  /**
   * 跑一轮论文对话。
   * @param request - 论文、用户问题、可选上下文注入、取消信号、事件回调。
   * @returns `{ sessionId, text, tools }`。
   */
  async turn({ paper, name, message, context, signal, onEvent }) {
    const agents = this.ctx.get('agents');
    const selection = this.selection();
    if (agents === undefined) throw new Error('当前组合没有 agents 服务，无法开启论文对话');
    if (selection === undefined) throw new Error('没有可用的默认模型，请先在设置里选择模型');
    if (this.running.has(paper)) throw new Error('这篇论文上一个问题还在回答中，请稍候或点「停止」');

    const entry = await this.record(paper);
    const first = entry.messages.length === 0;
    this.running.add(paper);
    let agent;
    const unsubscribe = [];
    try {
      agent = await this.ensureAgent(entry, selection, agentCtxCwd(this.ctx));
      if (agent.status === 'running') throw new Error('这条论文会话正在回答上一个问题，请稍候');

      const collected = { text: '', tools: [] };
      const listen = this.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (subject !== agent) return;
        if (frame?.type !== 'chunk') return;
        const chunk = frame.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
          collected.text += chunk.text;
          onEvent({ type: 'delta', text: chunk.text });
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' && typeof chunk.block.name === 'string') {
          collected.tools.push(chunk.block.name);
          onEvent({ type: 'tool', name: chunk.block.name });
        }
      }, { global: true });
      unsubscribe.push(() => listen());

      const onAbort = () => {
        try { agent.cancel('paper-reader'); } catch { /* 已结束 */ }
      };
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const started = Date.now();
      const startSeq = Number.isSafeInteger(agent.session?.seq) ? agent.session.seq : 0;
      entry.messages.push({ role: 'user', text: message, at: started });
      await this.save();

      // 首轮先把论文上下文作为插件来源的用户消息注入，再排真实提问。
      if (first && typeof context === 'string' && context.length > 0) {
        agent.followup(userMessage(context, 'plugin'));
      }
      agent.followup(userMessage(message, 'user'));

      await withTimeout(agent.whenIdle(), TURN_TIMEOUT_MS, '论文对话超时（15 分钟）');
      signal?.throwIfAborted?.();

      const turnFailure = readTurnFailure(agent.session, startSeq);
      if (turnFailure !== undefined) throw new Error(turnFailure);

      const text = collected.text.trim();
      entry.messages.push({
        role: 'assistant',
        text: text.length > 0 ? text : '（模型这一轮没有返回内容，可以再问一次或换个说法）',
        tools: collected.tools,
        at: Date.now(),
      });
      if (entry.messages.length > MAX_STORED_MESSAGES) {
        entry.messages.splice(0, entry.messages.length - MAX_STORED_MESSAGES);
      }
      entry.updatedAt = Date.now();
      await this.save();
      return { sessionId: entry.sessionId, text, tools: collected.tools };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      entry.messages.push({ role: 'assistant', text: errorBubbleText(messageText), error: true, at: Date.now() });
      await this.save();
      throw error;
    } finally {
      for (const dispose of unsubscribe) dispose();
      this.running.delete(paper);
    }
  }
}

/** 错误气泡的统一前缀。 */
function errorBubbleText(text) {
  if (text.startsWith('论文对话超时')) return text;
  return `⚠️ ${text}`;
}

/** 会话工作目录：优先已注册工作区，其次 dsh 进程工作区（= 用户工作区）。 */
function agentCtxCwd(ctx) {
  try {
    const list = ctx.get('workspaceRegistry')?.list?.();
    const first = Array.isArray(list) ? list.find((item) => typeof item?.path === 'string') : undefined;
    if (first !== undefined) return first.path;
  } catch { /* 用进程工作目录 */ }
  return process.cwd();
}

/** 带超时的等待。 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 供路由层复用的健康检查信息。 */
export function chatCapabilities(ctx) {
  const agents = ctx.get?.('agents');
  const selection = (() => {
    try { return ctx.get?.('agentDefaultModel')?.currentSelection?.(); } catch { return undefined; }
  })();
  return {
    available: agents !== undefined,
    model: selection === undefined ? null : { provider: selection.provider, model: selection.model },
  };
}
