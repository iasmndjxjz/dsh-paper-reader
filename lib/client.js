/**
 * dsh-paper-reader —— 论文阅读器插件（浏览器半）。
 *
 * 版面（三段式保持不变）：
 *   左栏 = 工作区文稿目录树   中栏 = 黑底论文正文   右栏 = 实时对话
 *
 * 右栏不是"总结面板"：那是一个**随时可以打字的真 Agent 会话**（宿主半为每篇论文
 * 维护一个真正的 DSH session，这里只负责把流式增量画成气泡）。「精读总结」只是
 * 往对话里发一条开场指令，不再是锁住聊天的按钮。
 *
 * PDF：中栏用 pdf.js 真渲染（翻页/缩放/反色），文字抽取在宿主侧完成，
 * 所以 PDF 也能被总结、被追问。
 *
 * 入口 = 输入框右侧工具栏的「论文」按钮 → 切换 main 面板；「问 Agent」把当前论文
 * 写进原生输入框草稿并回到对话，原生聊天能力原样保留。
 *
 * 本文件是手写的 client bundle：`window.__ModuleLoader__.load(...)` 注册工厂，
 * 工厂返回 `{ name, inject, apply }`；只 require 平台基线模块（react / ui-primitives）。
 */
window.__ModuleLoader__.load({ id: 'dsh-paper-reader', factory: (require) => {
  const React = require('react');
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
  const h = React.createElement;
  const { useState, useEffect, useRef, useCallback, useMemo } = React;

  const API = '/api/paper-reader';
  const STORAGE_KEY = 'dsh-paper-reader:state:v1';
  const NARROW_WIDTH = 900;
  const PDF_MAX_RENDER_PAGES = 80;

  /** 图标（基线 UI 包里就有；缺失时退化为纯文字按钮）。 */
  const IconPaper = primitives.IconListPenOutline16;
  const IconFolder = primitives.IconFolderOpen16;
  const IconRefresh = primitives.IconRefreshOutline14;
  const IconSpark = primitives.IconSparkle16;
  const IconClose = primitives.IconCloseOutline16;
  const IconChevron = primitives.IconChevronRightOutline14;
  const IconChevronDown = primitives.IconChevronDownOutline14;
  const IconCopy = primitives.IconCopyOutline16;
  const IconStop = primitives.IconStopFill16;
  const IconChat = primitives.IconThinkOutline16;
  const IconSend = primitives.IconSendOutline14;
  const IconTrash = primitives.IconTrashOutline16;

  const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdx']);

  /** 右栏快捷提问。 */
  const SUMMARY_PROMPT = '请先通读这篇论文，按「一句话结论 / 研究问题与动机 / 方法与技术路线 / 关键实验与结果 / 结论、局限与可借鉴 / 术语速查」六段给我一份中文精读总结。';
  const QUICK_PROMPTS = [
    '这篇论文解决了什么问题？为什么以前的做法不够？',
    '方法部分的核心创新点是什么？和已有工作差在哪？',
    '实验结论可信吗？有哪些可疑或没说清的地方？',
    '把结论部分翻成中文，并列出可复用的点。',
  ];

  // ---------------------------------------------------------------- 样式 ----
  const CSS = `
.dpr-open{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:999px;
  border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.dpr-open:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpr-open[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dpr-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);overflow:hidden}
.dpr-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;flex:none;
  border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-height:44px}
.dpr-title{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;flex:none}
.dpr-crumb{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dpr-tools{display:flex;align-items:center;gap:6px;flex:none}
.dpr-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:8px;
  border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dpr-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpr-btn:disabled{opacity:.45;cursor:not-allowed}
.dpr-btn[data-primary="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dpr-btn[data-danger="true"]{color:var(--dsw-alias-state-error-primary)}
.dpr-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:264px minmax(0,1fr) 380px}
.dpr-body[data-narrow="true"]{grid-template-columns:minmax(0,1fr)}
.dpr-pane{min-width:0;min-height:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l2)}
.dpr-pane:last-child{border-right:0}
.dpr-pane-head{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;min-height:38px;
  border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dpr-pane-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.dpr-input{flex:1 1 auto;min-width:0;height:26px;padding:0 8px;border-radius:7px;font:inherit;font-size:12px;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dpr-tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}
.dpr-tab{flex:1 1 0;height:30px;border-radius:8px;border:.5px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;position:relative}
.dpr-tab[data-active="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-border-l2)}
.dpr-dot{position:absolute;top:4px;right:8px;width:6px;height:6px;border-radius:50%;
  background:var(--dsw-alias-brand-primary)}
.dpr-node{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:12.5px;cursor:pointer;
  border-radius:6px;margin:1px 4px;white-space:nowrap;overflow:hidden}
.dpr-node:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-node[data-selected="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
.dpr-node-name{overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
.dpr-node-meta{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption)}
.dpr-empty{padding:18px 14px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.7}
.dpr-error{padding:10px 12px;margin:8px 12px;border-radius:8px;font-size:12.5px;line-height:1.6;
  color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2)}
.dpr-paper{background:#0b0c0f;color:#e9e9ee}
.dpr-paper-head{display:flex;align-items:center;gap:8px;padding:6px 10px;flex:none;min-height:38px;
  background:#101116;border-bottom:.5px solid #24262e;color:#b9bcc7;font-size:12px}
.dpr-paper-head .dpr-btn{border-color:#2c2f38;color:#c3c6d1}
.dpr-paper-head .dpr-btn:hover{background:#1b1d24;color:#fff}
.dpr-paper-scroll{flex:1 1 auto;min-height:0;overflow:auto;background:#0b0c0f}
.dpr-paper-inner{max-width:54rem;margin:0 auto;padding:28px 22px 140px;font-size:15.5px;line-height:1.85;
  word-break:break-word;overflow-wrap:anywhere}
.dpr-paper-inner h1,.dpr-paper-inner h2,.dpr-paper-inner h3,.dpr-paper-inner h4{line-height:1.35;margin:1.6em 0 .6em;font-weight:650}
.dpr-paper-inner h1{font-size:1.6em;border-bottom:1px solid #24262e;padding-bottom:.35em}
.dpr-paper-inner h2{font-size:1.32em;border-bottom:1px solid #1d1f26;padding-bottom:.3em}
.dpr-paper-inner h3{font-size:1.14em}
.dpr-paper-inner h4{font-size:1em;color:#c9ccd6}
.dpr-paper-inner p{margin:.85em 0}
.dpr-paper-inner a{color:#7cb7ff;text-decoration:none;border-bottom:1px dashed #3a5f8f}
.dpr-paper-inner ul,.dpr-paper-inner ol{margin:.7em 0;padding-left:1.5em}
.dpr-paper-inner li{margin:.25em 0}
.dpr-paper-inner blockquote{margin:.9em 0;padding:.2em 0 .2em 1em;border-left:3px solid #38404d;color:#aeb3c0}
.dpr-paper-inner hr{border:0;border-top:1px solid #24262e;margin:1.6em 0}
.dpr-paper-inner pre{margin:1em 0;padding:12px 14px;background:#14161b;border:1px solid #22242c;border-radius:10px;
  overflow:auto;font-size:13px;line-height:1.6}
.dpr-paper-inner pre code{background:transparent;padding:0;font-size:inherit;color:#dfe3ea}
.dpr-paper-inner code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:#191c22;
  padding:1.5px 5px;border-radius:5px;color:#e6d9a8}
.dpr-paper-inner table{border-collapse:collapse;margin:1em 0;display:block;overflow-x:auto;max-width:100%;font-size:14px}
.dpr-paper-inner th,.dpr-paper-inner td{border:1px solid #262a33;padding:6px 10px;text-align:left}
.dpr-paper-inner th{background:#161922;font-weight:600}
.dpr-paper-inner img{max-width:100%;border-radius:8px;background:#fff}
.dpr-math{font-family:ui-monospace,Menlo,Consolas,monospace;color:#c8b6ff;background:#171a22;padding:1px 4px;border-radius:4px}
.dpr-pdf-wrap{display:flex;flex-direction:column;align-items:center;gap:14px;padding:14px 10px 60px}
.dpr-pdf-page{position:relative;background:#fff;border-radius:6px;overflow:hidden;
  box-shadow:0 2px 14px rgba(0,0,0,.5)}
.dpr-pdf-page canvas{display:block;max-width:100%;height:auto}
.dpr-pdf-invert .dpr-pdf-page canvas{filter:invert(1) hue-rotate(180deg)}
.dpr-pdf-placeholder{min-height:240px;min-width:320px;display:flex;align-items:center;justify-content:center;
  color:#8b8f9a;font-size:12.5px}
.dpr-pdf-toolbar{display:flex;align-items:center;gap:6px;flex:none;padding:4px 10px;background:#101116;
  border-bottom:.5px solid #24262e;color:#b9bcc7;font-size:12px}
.dpr-pdf-toolbar .dpr-btn{border-color:#2c2f38;color:#c3c6d1;height:24px;font-size:11.5px;padding:0 7px}
.dpr-pdf-toolbar .dpr-btn:hover{background:#1b1d24;color:#fff}
.dpr-iframe{flex:1 1 auto;width:100%;border:0;background:#15171c}
.dpr-loading{padding:24px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.dpr-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l3);
  border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dpr-rot .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes dpr-rot{to{transform:rotate(360deg)}}
/* ---- 右栏对话 ---- */
.dpr-chat{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}
.dpr-chat-head{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;min-height:38px;
  border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dpr-chat-head-title{display:flex;align-items:center;gap:5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dpr-chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;font-size:10.5px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.dpr-msgs{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 12px 4px;display:flex;flex-direction:column;gap:10px}
.dpr-msg{display:flex;flex-direction:column;gap:4px;max-width:100%}
.dpr-msg[data-role="user"]{align-items:flex-end}
.dpr-bubble{padding:8px 11px;border-radius:12px;font-size:13px;line-height:1.7;white-space:pre-wrap;
  word-break:break-word;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}
.dpr-msg[data-role="user"] .dpr-bubble{background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground);border-bottom-right-radius:4px}
.dpr-msg[data-role="assistant"] .dpr-bubble{background:var(--dsw-alias-bg-layer-1);
  border:.5px solid var(--dsw-alias-border-l2);border-bottom-left-radius:4px}
.dpr-msg[data-role="assistant"] .dpr-bubble.dpr-md{white-space:normal}
.dpr-msg[data-role="assistant"] .dpr-bubble h1,.dpr-msg[data-role="assistant"] .dpr-bubble h2,
.dpr-msg[data-role="assistant"] .dpr-bubble h3{font-size:1.05em;margin:1em 0 .4em}
.dpr-msg[data-role="assistant"] .dpr-bubble p{margin:.55em 0}
.dpr-msg[data-role="assistant"] .dpr-bubble ul,.dpr-msg[data-role="assistant"] .dpr-bubble ol{margin:.5em 0;padding-left:1.3em}
.dpr-msg[data-role="assistant"] .dpr-bubble pre{background:var(--dsw-alias-bg-layer-2);padding:10px 12px;
  border-radius:8px;overflow:auto;font-size:12.5px}
.dpr-msg[data-role="assistant"] .dpr-bubble code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;
  background:var(--dsw-alias-bg-layer-2);padding:1px 4px;border-radius:4px}
.dpr-msg[data-role="assistant"] .dpr-bubble table{border-collapse:collapse;font-size:12.5px;display:block;overflow-x:auto}
.dpr-msg[data-role="assistant"] .dpr-bubble th,.dpr-msg[data-role="assistant"] .dpr-bubble td{
  border:.5px solid var(--dsw-alias-border-l2);padding:4px 8px}
.dpr-msg[data-error="true"] .dpr-bubble{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dpr-msg-tools{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
.dpr-tool{display:inline-flex;align-items:center;gap:3px;font-size:10.5px;padding:1px 6px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.dpr-caret{display:inline-block;width:7px;height:14px;margin-left:2px;vertical-align:-2px;
  background:var(--dsw-alias-brand-primary);animation:dpr-blink 1s steps(1) infinite}
@keyframes dpr-blink{50%{opacity:0}}
.dpr-note{padding:2px 12px 6px;font-size:11px;color:var(--dsw-alias-label-caption)}
.dpr-quick{display:flex;flex-wrap:wrap;gap:6px;padding:2px 12px 10px}
.dpr-quick button{font:inherit;font-size:11.5px;line-height:1.5;text-align:left;padding:5px 9px;border-radius:9px;
  border:.5px dashed var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dpr-quick button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpr-composer{flex:none;border-top:.5px solid var(--dsw-alias-border-l2);padding:8px;display:flex;
  flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1)}
.dpr-composer textarea{width:100%;box-sizing:border-box;resize:none;border-radius:10px;padding:8px 10px;
  font:inherit;font-size:13px;line-height:1.6;min-height:38px;max-height:120px;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dpr-composer textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dpr-composer-row{display:flex;align-items:center;gap:6px}
.dpr-composer-hint{flex:1 1 auto;font-size:10.5px;color:var(--dsw-alias-label-caption);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-info{margin:0 12px 12px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);
  border:.5px solid var(--dsw-alias-border-l2);font-size:11.5px;line-height:1.6}
.dpr-info-row{display:flex;gap:8px}
.dpr-info-key{flex:none;width:52px;color:var(--dsw-alias-label-caption)}
.dpr-info-val{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-all}
/* ---- 右栏：子代理控制台（卡片式，贴合草图） ---- */
.dpr-console{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base)}
.dpr-console-head{display:flex;align-items:center;gap:6px;padding:8px 10px;flex:none;min-height:40px;
  border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dpr-console-actions{display:flex;flex-direction:column;gap:8px;padding:10px}
.dpr-card{display:flex;flex-direction:column;gap:3px;align-items:flex-start;text-align:left;cursor:pointer;
  padding:10px 12px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;
  transition:transform .16s ease, border-color .16s ease, background .16s ease}
.dpr-card:hover:not(:disabled){transform:translateY(-1px);border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-interactive-bg-hover)}
.dpr-card:disabled{opacity:.5;cursor:not-allowed}
.dpr-card-title{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dpr-card-desc{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dpr-console-msgs{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 10px 6px;display:flex;flex-direction:column;gap:8px}
.dpr-mirror{display:flex;flex-direction:column;gap:3px;animation:dpr-fade .24s ease both}
.dpr-mirror[data-role="user"]{align-items:flex-end}
.dpr-mirror[data-role="user"] .dpr-bubble{background:var(--dsw-alias-interactive-bg-active);
  border-color:transparent;border-bottom-right-radius:4px}
.dpr-mirror[data-role="assistant"] .dpr-bubble{border-bottom-left-radius:4px}
/* ---- 入场动画（按下「论文」时；三项错开一点点） ---- */
@keyframes dpr-in{from{opacity:0;transform:translateY(6px) scale(.995)}to{opacity:1;transform:none}}
@keyframes dpr-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.dpr-root{animation:dpr-in .26s cubic-bezier(.2,.7,.3,1) both}
.dpr-body>.dpr-pane:nth-child(1){animation:dpr-in .30s cubic-bezier(.2,.7,.3,1) both;animation-delay:.02s}
.dpr-body>.dpr-pane:nth-child(2){animation:dpr-in .30s cubic-bezier(.2,.7,.3,1) both;animation-delay:.07s}
.dpr-body>.dpr-pane:nth-child(3){animation:dpr-in .30s cubic-bezier(.2,.7,.3,1) both;animation-delay:.12s}
.dpr-tab[data-active="true"]{transition:background .18s ease,color .18s ease}
@media (prefers-reduced-motion:reduce){
  .dpr-root,.dpr-body>.dpr-pane,.dpr-mirror,.dpr-card{animation:none!important;transition:none!important}
}

/* ---- 右栏聊天：黑底白字，不用主题强调色（绿色太跳） ---- */
.dpr-chat{background:#0b0c0f;color:#e9e9ee}
.dpr-chat .dpr-chat-head{background:#101116;border-color:#24262e;color:#c3c6d1}
.dpr-chat .dpr-chat-head-title{color:#f2f3f6}
.dpr-chat .dpr-chip{background:#1b1e24;color:#9aa0ab}
.dpr-chat .dpr-btn{border-color:#2c2f38;color:#c3c6d1}
.dpr-chat .dpr-btn:hover:not(:disabled){background:#1b1d24;color:#fff}
.dpr-chat .dpr-btn[data-primary="true"]{border-color:#454b58;color:#e9e9ee}
.dpr-chat .dpr-btn[data-danger="true"]{border-color:#3a2a2e;color:#ff9a9a}
.dpr-chat .dpr-empty,.dpr-chat .dpr-note{color:#8b8f9a}
.dpr-chat .dpr-quick button{border-color:#2c2f38;color:#b9bcc7}
.dpr-chat .dpr-quick button:hover{background:#1b1d24;color:#fff}
.dpr-chat .dpr-msg[data-role="user"] .dpr-bubble{background:#232733;color:#f4f5f8}
.dpr-chat .dpr-msg[data-role="assistant"] .dpr-bubble{background:#14161b;border-color:#22242c;color:#e9e9ee}
.dpr-chat .dpr-msg[data-error="true"] .dpr-bubble{color:#ff9a9a;border-color:#3a2a2e}
.dpr-chat .dpr-tool{background:#1b1e24;color:#9aa0ab}
.dpr-chat .dpr-caret{background:#c3c6d1}
.dpr-chat .dpr-error{color:#ff9a9a;background:#1b1e24}
.dpr-chat .dpr-composer{background:#101116;border-color:#24262e}
.dpr-chat .dpr-composer textarea{background:#0b0c0f;border-color:#24262e;color:#e9e9ee}
.dpr-chat .dpr-composer textarea:focus{border-color:#454b58}
.dpr-chat .dpr-composer textarea::placeholder{color:#6f747f}
.dpr-chat .dpr-composer-hint{color:#7b808b}
.dpr-chat .dpr-bubble pre{background:#1b1e24;border-color:#24262e}
.dpr-chat .dpr-bubble code{background:#1b1e24;color:#e6d9a8}
.dpr-chat .dpr-bubble a{color:#8ab4ff}

@media (max-width:900px){
  .dpr-paper-inner{padding:18px 12px 120px;font-size:15px}
}
`;

  function installCss() {
    const id = 'dsh-paper-reader/styles';
    if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-paper-reader';
    tag.dataset.pluginCss = id;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ------------------------------------------------------------ 小工具 ----
  /** 纯样式 class 拼接。 */
  function cx(...parts) {
    return parts.filter((part) => typeof part === 'string' && part.length > 0).join(' ');
  }

  /** 人类可读的文件大小。 */
  function sizeText(bytes) {
    if (typeof primitives.fileSizeText === 'function') {
      try { return primitives.fileSizeText(bytes); } catch { /* 退化到本地实现 */ }
    }
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  /** 时间戳 → 本地字符串。 */
  function timeText(ms) {
    if (!Number.isFinite(ms)) return '';
    try { return new Date(ms).toLocaleString(); } catch { return ''; }
  }

  /** 复制文本（优先用基线工具）。 */
  async function copyText(text) {
    if (typeof primitives.writeClipboard === 'function') {
      try { await primitives.writeClipboard(text); return true; } catch { /* 继续退化 */ }
    }
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  /** 统一解包 `{ok, error}` 响应。 */
  async function unwrap(response) {
    let payload;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok || payload === undefined || payload.ok !== true) {
      const message = payload?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  /** GET JSON。 */
  async function apiGet(sub, params = {}) {
    const url = new URL(`${API}/${sub}`, location.origin);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    return unwrap(response);
  }

  /** POST JSON。 */
  async function apiPost(sub, body) {
    const response = await fetch(`${API}/${sub}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return unwrap(response);
  }

  /** 逐行读 NDJSON 流。 */
  async function readNdjson(response, onEvent) {
    if (response.body === null) throw new Error('响应没有可读流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          let event;
          try { event = JSON.parse(line); } catch { event = null; }
          if (event !== null) onEvent(event);
        }
        index = buffer.indexOf('\n');
      }
    }
  }

  /** 读取本地上次状态。 */
  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (typeof raw !== 'string') return {};
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  function saveStored(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* 隐私模式下忽略 */ }
  }

  // ------------------------------------------------- Markdown 渲染器 ----
  /** 行内元素解析：代码、粗体、斜体、链接、公式。 */
  function renderInline(text, keyPrefix) {
    const nodes = [];
    const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(?<![A-Za-z0-9_])_[^_\n]+_(?![A-Za-z0-9_])|(\[[^\]\n]+\]\([^)\s]+\))|(\$\$[^$\n]+\$\$)|(\$[^$\n]+\$)/g;
    let last = 0;
    let index = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      const token = match[0];
      const key = `${keyPrefix}-i${index}`;
      if (token.startsWith('`')) {
        nodes.push(h('code', { key }, token.slice(1, -1)));
      } else if (token.startsWith('$$')) {
        nodes.push(h('span', { key, className: 'dpr-math' }, token.slice(2, -2)));
      } else if (token.startsWith('$')) {
        nodes.push(h('span', { key, className: 'dpr-math' }, token.slice(1, -1)));
      } else if (token.startsWith('**') || token.startsWith('__')) {
        nodes.push(h('strong', { key }, token.slice(2, -2)));
      } else if (token.startsWith('[')) {
        const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
        if (link !== null) {
          nodes.push(h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer noopener' }, link[1]));
        } else nodes.push(token);
      } else {
        nodes.push(h('em', { key }, token.slice(1, -1)));
      }
      last = match.index + token.length;
      index += 1;
      match = pattern.exec(text);
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  /** 极简但稳定的 Markdown → React 元素（黑底论文区与对话气泡共用）。 */
  function renderMarkdown(source) {
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;
    let key = 0;
    const take = () => { key += 1; return `mb${key}`; };

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i += 1; continue; }

      const fence = /^\s*(```|~~~)\s*([A-Za-z0-9+#._-]*)\s*$/.exec(line);
      if (fence !== null) {
        const marker = fence[1];
        const lang = fence[2];
        // 收尾围栏与开头同字符、长度不短于开头（CommonMark 允许更长的收尾围栏）。
        const closing = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`);
        const body = [];
        i += 1;
        while (i < lines.length && !closing.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;
        blocks.push(h('pre', { key: take(), 'data-lang': lang || undefined },
          h('code', null, body.join('\n'))));
        continue;
      }

      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading !== null) {
        const level = Math.min(heading[1].length, 6);
        blocks.push(h(`h${level}`, { key: take() }, renderInline(heading[2], take())));
        i += 1;
        continue;
      }

      if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
        blocks.push(h('hr', { key: take() }));
        i += 1;
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        blocks.push(h('blockquote', { key: take() }, renderMarkdown(quoted.join('\n'))));
        continue;
      }

      if (/^\s{0,3}(\|.*\|)\s*$/.test(line) && i + 1 < lines.length
        && /^\s{0,3}\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
        const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        const head = splitRow(lines[i]);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s{0,3}\|.*\|\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        blocks.push(h('table', { key: take() },
          h('thead', null, h('tr', null, head.map((cell, index) => h('th', { key: `th${index}` }, renderInline(cell, take()))))),
          h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: `tr${rowIndex}` },
            row.map((cell, cellIndex) => h('td', { key: `td${cellIndex}` }, renderInline(cell, take()))))))));
        continue;
      }

      const listMatch = /^(\s*)([-*+]|\d{1,9}[.)])\s+/.exec(line);
      if (listMatch !== null) {
        const ordered = /^\d/.test(listMatch[2]);
        const baseIndent = listMatch[1].length;
        const items = [];
        while (i < lines.length) {
          const current = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
          if (current === null) {
            if (/^\s+\S/.test(lines[i]) && items.length > 0) {
              items[items.length - 1].push(lines[i].trim());
              i += 1;
              continue;
            }
            break;
          }
          if (current[1].length < baseIndent) break;
          items.push([current[3]]);
          i += 1;
          while (i < lines.length && /^\s*$/.test(lines[i]) === false
            && /^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(lines[i]) === false
            && /^\s+\S/.test(lines[i])) {
            items[items.length - 1].push(lines[i].trim());
            i += 1;
          }
        }
        const tag = ordered ? 'ol' : 'ul';
        blocks.push(h(tag, { key: take() }, items.map((item, itemIndex) => h('li', { key: `li${itemIndex}` },
          renderMarkdown(item.join('\n'))))));
        continue;
      }

      // 段落：连续非空、非块起始的行
      const paragraph = [line];
      i += 1;
      while (i < lines.length && /^\s*$/.test(lines[i]) === false
        && /^\s{0,3}(#{1,6}\s|>|\||```|~~~)/.test(lines[i]) === false
        && /^(\s*)([-*+]|\d{1,9}[.)])\s+/.test(lines[i]) === false
        && /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(lines[i]) === false) {
        paragraph.push(lines[i]);
        i += 1;
      }
      blocks.push(h('p', { key: take() }, renderInline(paragraph.join('\n'), take())));
    }
    return blocks;
  }

  /** 安全渲染：任何异常都退化为 <pre>。 */
  function MarkdownView({ text }) {
    const blocks = useMemo(() => {
      try { return renderMarkdown(text); } catch { return null; }
    }, [text]);
    if (blocks === null) return h('pre', null, String(text ?? ''));
    return h(React.Fragment, null, blocks);
  }

  // ------------------------------------------------------------ 目录树 ----
  function TreeNode({ node, depth, selected, expanded, onToggle, onOpen }) {
    const isDir = node.dir === true;
    const isOpen = expanded.has(node.path);
    return h(React.Fragment, null,
      h('div', {
        className: 'dpr-node',
        style: { paddingLeft: `${8 + depth * 12}px` },
        'data-selected': !isDir && selected === node.path ? 'true' : undefined,
        title: node.path,
        onClick: () => { if (isDir) onToggle(node.path); else onOpen(node.path); },
      },
        h('span', { style: { flex: 'none', width: '14px', display: 'inline-flex', justifyContent: 'center' } },
          isDir
            ? (isOpen && IconChevronDown ? h(IconChevronDown, { size: 12 }) : (IconChevron ? h(IconChevron, { size: 12 }) : (isOpen ? '▾' : '▸')))
            : (IconPaper ? h(IconPaper, { size: 12 }) : '·')),
        h('span', { className: 'dpr-node-name' }, node.name),
        !isDir && h('span', { className: 'dpr-node-meta' }, sizeText(node.size))),
      isDir && isOpen ? node.children.map((child) => h(TreeNode, {
        key: child.path, node: child, depth: depth + 1, selected, expanded, onToggle, onOpen,
      })) : null);
  }

  /** 在目录树里保留命中过滤词的分支。 */
  function filterNodes(nodes, keyword) {
    if (keyword.length === 0) return nodes;
    const lower = keyword.toLowerCase();
    const walk = (list) => {
      const out = [];
      for (const node of list) {
        if (node.dir) {
          const children = walk(node.children ?? []);
          if (children.length > 0 || node.name.toLowerCase().includes(lower)) out.push({ ...node, children });
        } else if (node.name.toLowerCase().includes(lower) || node.path.toLowerCase().includes(lower)) {
          out.push(node);
        }
      }
      return out;
    };
    return walk(nodes);
  }

  /** 深度优先找第一个可读文稿节点（首屏自动打开）：优先 Markdown，其次任意文件。 */
  function firstFile(nodes, fallback = null) {
    let best = fallback;
    for (const node of nodes ?? []) {
      if (node.dir) {
        best = firstFile(node.children, best);
        continue;
      }
      if (MARKDOWN_EXT.has(node.ext)) return node;
      if (best === null) best = node;
    }
    return best;
  }

  // ------------------------------------------------------ pdf.js 渲染 ----
  let pdfjsPromise;

  /** 动态加载 pdf.js（由本插件自己的路由转发，离线可用）。 */
  function loadPdfjs() {
    if (pdfjsPromise === undefined) {
      const url = `${API}/pdfjs/build/pdf.min.mjs`;
      pdfjsPromise = import(url).then((module) => {
        const lib = module?.default ?? module;
        try {
          if (lib.GlobalWorkerOptions !== undefined) {
            lib.GlobalWorkerOptions.workerSrc = `${API}/pdfjs/build/pdf.worker.min.mjs`;
          }
        } catch { /* 退化为主线程渲染 */ }
        return lib;
      }).catch((error) => {
        pdfjsPromise = undefined;
        throw error;
      });
    }
    return pdfjsPromise;
  }

  /**
   * 中栏 PDF 阅读器：pdf.js 逐页画到 canvas，滚到哪画到哪，支持缩放与反色。
   * 加载失败自动退化成浏览器内置 iframe 查看器。
   */
  function PdfViewer({ doc }) {
    const wrapRef = useRef(null);
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const [pages, setPages] = useState(0);
    const [scale, setScale] = useState(1.15);
    const [invert, setInvert] = useState(false);
    const pdfRef = useRef(null);
    const scaleRef = useRef(scale);
    const renderedRef = useRef(new Map());
    scaleRef.current = scale;

    /** 目标渲染宽度（受容器约束）。 */
    const baseWidth = useCallback(() => {
      const host = wrapRef.current;
      const available = host === null ? 640 : Math.max(320, host.clientWidth - 28);
      return Math.min(available, 900);
    }, []);

    /** 画一页（按当前缩放）；同一页同缩放下不重复画。 */
    const renderPage = useCallback(async (pageNumber, holder) => {
      const pdf = pdfRef.current;
      if (pdf === null) return;
      const record = renderedRef.current.get(pageNumber);
      if (record !== undefined && record.rendered === true && record.scale === scaleRef.current) return;
      try {
        const page = await pdf.getPage(pageNumber);
        const natural = page.getViewport({ scale: 1 });
        const target = (baseWidth() * scaleRef.current) / natural.width;
        const viewport = page.getViewport({ scale: target });
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        let canvas = holder.querySelector('canvas');
        if (canvas === null) {
          canvas = document.createElement('canvas');
          holder.replaceChildren(canvas);
        }
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext('2d');
        if (context === null) return;
        await page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        }).promise;
        renderedRef.current.set(pageNumber, { rendered: true, scale: scaleRef.current });
      } catch { /* 单页失败不影响其它页 */ }
    }, [baseWidth]);

    useEffect(() => {
      let cancelled = false;
      let task;
      let observer;
      const host = wrapRef.current;
      setStatus('loading');
      setError('');
      renderedRef.current = new Map();
      (async () => {
        try {
          const pdfjs = await loadPdfjs();
          if (cancelled || host === null) return;
          task = pdfjs.getDocument({
            url: doc.rawUrl,
            cMapUrl: `${API}/pdfjs/cmaps/`,
            cMapPacked: true,
            standardFontDataUrl: `${API}/pdfjs/standard_fonts/`,
            wasmUrl: `${API}/pdfjs/wasm/`,
          });
          const pdf = await task.promise;
          if (cancelled) return;
          pdfRef.current = pdf;
          setPages(pdf.numPages);
          setStatus('ready');
          const total = Math.min(pdf.numPages, PDF_MAX_RENDER_PAGES);
          observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const holder = entry.target;
              const pageNumber = Number(holder.dataset.page);
              if (Number.isSafeInteger(pageNumber)) void renderPage(pageNumber, holder);
            }
          }, { root: null, rootMargin: '500px 0px' });
          for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
            const holder = document.createElement('div');
            holder.className = 'dpr-pdf-page';
            holder.dataset.page = String(pageNumber);
            const placeholder = document.createElement('div');
            placeholder.className = 'dpr-pdf-placeholder';
            placeholder.textContent = `第 ${pageNumber} 页`;
            holder.appendChild(placeholder);
            host.appendChild(holder);
            observer.observe(holder);
          }
        } catch (caught) {
          if (cancelled) return;
          setStatus('error');
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })();
      return () => {
        cancelled = true;
        observer?.disconnect();
        renderedRef.current = new Map();
        pdfRef.current = null;
        if (task !== undefined) { try { task.destroy(); } catch { /* 忽略 */ } }
        if (host !== null) host.replaceChildren();
      };
    }, [doc.rawUrl, doc.path, renderPage]);

    /** 缩放后重画当前可见页。 */
    const applyScale = useCallback((next) => {
      scaleRef.current = next;
      setScale(next);
      const host = wrapRef.current;
      if (host === null) return;
      for (const holder of host.querySelectorAll('.dpr-pdf-page')) {
        const box = holder.getBoundingClientRect();
        if (box.bottom < -500 || box.top > window.innerHeight + 500) continue;
        const pageNumber = Number(holder.dataset.page);
        const record = renderedRef.current.get(pageNumber);
        if (record !== undefined) renderedRef.current.set(pageNumber, { ...record, rendered: false });
        if (Number.isSafeInteger(pageNumber)) void renderPage(pageNumber, holder);
      }
    }, [renderPage]);

    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
      h('div', { className: 'dpr-pdf-toolbar' },
        h('span', null, status === 'ready' ? `pdf.js · 共 ${pages} 页` : (status === 'error' ? 'pdf.js 不可用' : 'pdf.js 加载中…')),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { className: 'dpr-btn', onClick: () => applyScale(Math.max(0.6, Number((scale - 0.15).toFixed(2)))) }, '−'),
        h('span', { style: { minWidth: '38px', textAlign: 'center' } }, `${Math.round(scale * 100)}%`),
        h('button', { className: 'dpr-btn', onClick: () => applyScale(Math.min(3, Number((scale + 0.15).toFixed(2)))) }, '＋'),
        h('button', { className: 'dpr-btn', 'data-primary': invert ? 'true' : undefined, title: '反色（夜里读白底 PDF）', onClick: () => setInvert((value) => !value) }, invert ? '反色开' : '反色'),
        h('a', { className: 'dpr-btn', href: `${doc.rawUrl}&download=1`, download: doc.name, title: '下载原文件' }, '下载')),
      status === 'error'
        ? h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
          h('div', { className: 'dpr-error' }, `pdf.js 渲染失败：${error}（已退回浏览器内置查看器）`),
          h('iframe', { className: 'dpr-iframe', src: doc.rawUrl, title: doc.name }))
        : h('div', {
          ref: wrapRef,
          className: cx('dpr-pdf-wrap', invert ? 'dpr-pdf-invert' : ''),
          style: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
        }),
      status === 'loading' ? h('div', { className: 'dpr-loading' }, h('span', { className: 'dpr-spin' }), '正在加载 PDF…') : null);
  }

  // ------------------------------------------------ 中栏：黑底论文 ----
  function PaperView({ doc, onOpenRaw }) {
    if (doc === null) {
      return h('div', { className: 'dpr-empty' },
        '左侧选一篇论文开始阅读。', h('br'), '中间是论文正文（黑底），右边可以直接和 Agent 聊这篇论文。');
    }
    const ext = doc.ext ?? '';
    if (doc.kind === 'pdf') return h(PdfViewer, { doc });
    if (doc.kind === 'html') {
      return h(React.Fragment, null,
        h('iframe', { className: 'dpr-iframe', src: doc.rawUrl, title: doc.name, sandbox: 'allow-same-origin' }),
        h('div', { className: 'dpr-loading' },
          h('button', { className: 'dpr-btn', onClick: () => onOpenRaw(doc.rawUrl) }, '新窗口打开'),
          ' ',
          h('a', { className: 'dpr-btn', href: `${doc.rawUrl}&download=1`, download: doc.name }, '下载')));
    }
    if (doc.kind === 'image') {
      return h('div', { style: { padding: '18px', textAlign: 'center' } },
        h('img', { src: doc.rawUrl, alt: doc.name, style: { maxWidth: '100%' } }));
    }
    if (typeof doc.text === 'string') {
      const isMarkdown = MARKDOWN_EXT.has(ext);
      return h('div', { className: 'dpr-paper-inner' },
        isMarkdown ? h(MarkdownView, { text: doc.text }) : h('pre', { style: { border: '0', background: 'transparent', padding: '0' } }, doc.text));
    }
    return h('div', { className: 'dpr-empty' },
      `该格式（.${ext || '?'}）无法直接渲染。`,
      h('br'),
      h('a', { className: 'dpr-btn', href: `${doc.rawUrl}&download=1`, download: doc.name, style: { marginTop: '10px' } }, '下载文件'));
  }

  // ------------------------------------------------ 右栏：子代理控制台 ----
  /**
   * 右栏不再自绘聊天：它显示**论文子代理**的状态与只读镜像，真正打字进原生子会话
   * （`ctx.sessions.openSubagent(address)`），这样输出天然留在用户和 Agent 的对话里，
   * 也不需要在这里重造流式/工具/审批 UI。
   */
  function SubagentPane({ doc, getSessionId, openSubagent, dockPaper, canDock }) {
    const [state, setState] = useState({ status: 'none', messages: [], childId: null, address: null, running: false });
    const [error, setError] = useState('');
    const [live, setLive] = useState('');
    const [liveTools, setLiveTools] = useState([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [capability, setCapability] = useState(null);
    const scrollRef = useRef(null);
    const textRef = useRef(null);
    const stickRef = useRef(true);
    const path = doc?.path ?? '';

    /** 拉状态与镜像。 */
    const refresh = useCallback(async () => {
      if (path.length === 0) return;
      try {
        const payload = await apiGet('chat', { path, sessionId: getSessionId() });
        const server = Array.isArray(payload.messages) ? payload.messages : [];
        setState((previous) => ({
          status: payload.status ?? 'none',
          // 服务端镜像为准；本地刚发、服务端还没收录的那几条（pending）先留着，避免气泡闪没
          messages: [
            ...server,
            ...previous.messages.filter((message) => message.pending === true
              && !server.some((item) => item.role === message.role && item.text === message.text)),
          ],
          childId: payload.childId ?? null,
          address: payload.address ?? null,
          running: payload.running === true,
        }));
        setCapability(payload.chat ?? null);
        setError('');
      } catch (caught) {
        setError(caught.message);
      }
    }, [path, getSessionId]);

    useEffect(() => { void refresh(); }, [refresh]);

    /** 订阅只读镜像流。 */
    useEffect(() => {
      if (path.length === 0 || state.childId === null) return undefined;
      let cancelled = false;
      const controller = new AbortController();
      void (async () => {
        try {
          const url = new URL(`${API}/chat/stream`, location.origin);
          url.searchParams.set('path', path);
          const sessionId = getSessionId();
          if (typeof sessionId === 'string' && sessionId.length > 0) url.searchParams.set('sessionId', sessionId);
          const response = await fetch(url.toString(), { signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
          if (!response.ok || response.body === null) return;
          let acc = '';
          let tools = [];
          await readNdjson(response, (event) => {
            if (cancelled) return;
            if (event.type === 'delta') {
              acc += event.text;
              setLive(acc);
            } else if (event.type === 'tool') {
              // 工具调用要看得见：右边这条消息上挂一个小标签
              tools = [...tools, event.name];
              setLiveTools(tools);
            } else if (event.type === 'state') {
              setState((previous) => ({ ...previous, running: event.running === true }));
            } else if (event.type === 'idle') {
              const finished = acc;
              const usedTools = tools;
              acc = '';
              tools = [];
              setLive('');
              setLiveTools([]);
              setState((previous) => ({
                ...previous,
                running: false,
                ...finished.length === 0 ? {} : {
                  messages: [...previous.messages, { role: 'assistant', text: finished, tools: usedTools, at: Date.now(), pending: true }],
                },
              }));
              // 以服务端镜像为准（工具名、多轮顺序都在那边）
              void refresh();
            }
          });
        } catch { /* 流断了下次刷新会补上 */ }
      })();
      return () => { cancelled = true; controller.abort(); };
    }, [path, state.childId, getSessionId, refresh]);

    /** 有新内容就滚到底（用户没往上翻时）。 */
    useEffect(() => {
      const node = scrollRef.current;
      if (node === null || stickRef.current !== true) return;
      node.scrollTop = node.scrollHeight;
    }, [state.messages, live]);

    /** 输入框随内容长高。 */
    useEffect(() => {
      const node = textRef.current;
      if (node === null) return;
      node.style.height = 'auto';
      node.style.height = `${Math.min(120, Math.max(38, node.scrollHeight))}px`;
    }, [input]);

    /** 发一句：第一条会连带把论文交给子代理，之后就是普通追问。 */
    const send = useCallback(async (raw) => {
      const text = String(raw ?? '').trim();
      if (text.length === 0 || sending) return;
      if (doc === null) { setError('先选一篇论文'); return; }
      const sessionId = getSessionId();
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        setError('没找到当前会话，论文子代理需要挂在你的会话下');
        return;
      }
      setInput('');
      setError('');
      stickRef.current = true;
      setSending(true);
      // 先本地显示，镜像回来后再以服务端为准
      setState((previous) => ({ ...previous, running: true, messages: [...previous.messages, { role: 'user', text, at: Date.now(), pending: true }] }));
      try {
        const payload = await apiPost('chat', { path: doc.path, sessionId, message: text });
        setState((previous) => ({
          ...previous,
          childId: payload.childId ?? previous.childId,
          address: payload.address ?? previous.address,
          running: true,
        }));
      } catch (caught) {
        setError(caught.message);
        setState((previous) => ({
          ...previous,
          running: false,
          messages: [...previous.messages, { role: 'assistant', text: `发送失败：${caught.message}`, error: true }],
        }));
      } finally {
        setSending(false);
      }
    }, [doc, sending, getSessionId]);

    const stop = useCallback(async () => {
      if (path.length === 0) return;
      try {
        await apiPost('chat/interrupt', { path, sessionId: getSessionId() });
      } catch (caught) {
        setError(caught.message);
      }
    }, [path, getSessionId]);

    const openNative = useCallback(() => {
      if (state.address === null) { setError('还没有子代理，先问一句'); return; }
      if (typeof canDock === 'function' && canDock() && typeof dockPaper === 'function') dockPaper();
      if (typeof openSubagent !== 'function' || !openSubagent(state.address)) setError('没能切到原生会话');
    }, [state.address, openSubagent, dockPaper, canDock]);

    const onKeyDown = useCallback((event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (event.nativeEvent?.isComposing === true) return;
      event.preventDefault();
      void send(input);
    }, [send, input]);

    const usable = capability === null || capability.available !== false;
    const statusText = state.running ? '回答中' : state.status === 'none' ? '未开始'
      : state.status === 'cold' ? '已休眠' : '空闲';

    return h('div', { className: 'dpr-chat' },
      h('div', { className: 'dpr-chat-head' },
        h('span', { className: 'dpr-chat-head-title' }, IconChat ? h(IconChat, { size: 14 }) : null, '论文'),
        h('span', { className: 'dpr-chip' }, statusText),
        h('span', { style: { flex: '1 1 auto' } }),
        state.running
          ? h('button', { className: 'dpr-btn', 'data-danger': 'true', onClick: () => void stop() }, '停止')
          : null,
        state.address !== null
          ? h('button', { className: 'dpr-btn', title: '切到原生会话继续（桌面会把论文停靠到右边）', onClick: openNative }, '原生打开')
          : null),

      !usable ? h('div', { className: 'dpr-error' }, '当前组合没有子代理服务（dsh-subagent），这里用不了。') : null,

      h('div', { className: 'dpr-msgs', ref: scrollRef, onScroll: () => {
        const node = scrollRef.current;
        if (node !== null) stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      } },
        state.messages.length === 0 && live.length === 0 && liveTools.length === 0
          ? h(React.Fragment, null,
            h('div', { className: 'dpr-empty' }, doc === null ? '先选一篇论文。' : '直接问就行。第一次问会把这篇论文交给子代理，它自己去读。'),
            doc === null ? null : h('div', { className: 'dpr-quick' }, QUICK_PROMPTS.slice(0, 3).map((prompt) => h('button', {
              key: prompt,
              onClick: () => void send(prompt),
            }, prompt))))
          : null,
        state.messages.map((message, index) => h('div', {
          key: `${index}-${message.at ?? ''}`,
          className: 'dpr-msg',
          'data-role': message.role === 'user' ? 'user' : 'assistant',
          'data-error': message.error === true ? 'true' : undefined,
        },
          h('div', { className: cx('dpr-bubble', message.role === 'user' ? '' : 'dpr-md') },
            Array.isArray(message.tools) && message.tools.length > 0
              ? h('div', { className: 'dpr-msg-tools' }, message.tools.map((tool, toolIndex) => h('span', { key: `${tool}-${toolIndex}`, className: 'dpr-tool' }, tool)))
              : null,
            message.role === 'user' ? message.text : h(MarkdownView, { text: message.text })))),
        live.length > 0 || liveTools.length > 0
          ? h('div', { className: 'dpr-msg', 'data-role': 'assistant' },
            h('div', { className: 'dpr-bubble dpr-md' },
              liveTools.length > 0
                ? h('div', { className: 'dpr-msg-tools' }, liveTools.map((tool, toolIndex) => h('span', { key: `${tool}-${toolIndex}`, className: 'dpr-tool' }, tool)))
                : null,
              live.length > 0 ? h(MarkdownView, { text: live }) : null,
              h('span', { className: 'dpr-caret' })))
          : null),

      error.length > 0 ? h('div', { className: 'dpr-error' }, error) : null,

      h('div', { className: 'dpr-composer' },
        h('textarea', {
          ref: textRef,
          rows: 1,
          placeholder: doc === null ? '先选一篇论文…' : '问这篇论文（Enter 发送，Shift+Enter 换行）',
          value: input,
          disabled: doc === null,
          onChange: (event) => setInput(event.target.value),
          onKeyDown,
        }),
        h('div', { className: 'dpr-composer-row' },
          h('span', { className: 'dpr-composer-hint' }, state.childId === null ? '第一条会自动把论文交过去' : String(state.childId).slice(0, 20)),
          state.running
            ? h('button', { className: 'dpr-btn', 'data-danger': 'true', onClick: () => void stop() }, IconStop ? h(IconStop, { size: 11 }) : null, '停止')
            : null,
          h('button', {
            className: 'dpr-btn',
            'data-primary': 'true',
            disabled: doc === null || input.trim().length === 0,
            onClick: () => void send(input),
          }, IconSend ? h(IconSend, { size: 12 }) : null, '发送'))));
  }

  // ------------------------------------------------ 右栏停靠：紧凑版 ----
  /**
   * 右侧栏停靠形态（C 模式）：只放「目录 + 论文」，中间的原生聊天一动不动，
   * 所以随时能聊是原生的；想回到三栏点右上角「三栏阅读」。
   */
  function PaperDock(props) {
    const { openPanel } = props;
    const [tree, setTree] = useState(null);
    const [treeError, setTreeError] = useState('');
    const [root, setRoot] = useState('');
    const [showAll, setShowAll] = useState(false);
    const [expanded, setExpanded] = useState(() => new Set());
    const [keyword, setKeyword] = useState('');
    const [treeOpen, setTreeOpen] = useState(true);
    const [path, setPath] = useState('');
    const [doc, setDoc] = useState(null);
    const [docError, setDocError] = useState('');
    const [busy, setBusy] = useState(false);
    const pathRef = useRef('');
    const docRef = useRef(null);
    pathRef.current = path;
    docRef.current = doc;

    const loadTree = useCallback(async (nextRoot, all) => {
      setBusy(true);
      setTreeError('');
      try {
        const payload = await apiGet('tree', { root: nextRoot || undefined, all: all ? 1 : undefined });
        setTree(payload);
        setRoot(payload.root);
        if (pathRef.current === '' && docRef.current === null) {
          const auto = firstFile(payload.nodes);
          if (auto !== null) loadDoc(auto.path);
        }
      } catch (error) {
        setTreeError(error.message);
      } finally {
        setBusy(false);
      }
    }, []);

    const loadDoc = useCallback(async (nextPath) => {
      if (typeof nextPath !== 'string' || nextPath.length === 0) return;
      setBusy(true);
      setDocError('');
      try {
        const payload = await apiGet('file', { path: nextPath });
        setDoc(payload);
        setPath(payload.path);
      } catch (error) {
        setDocError(error.message);
        setDoc(null);
      } finally {
        setBusy(false);
      }
    }, []);

    useEffect(() => { loadTree('', false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // 停靠栏里也记忆上次读的那篇（与三栏模式共用同一份本地状态）。
    useEffect(() => {
      const stored = loadStored();
      if (typeof stored.path === 'string' && stored.path.length > 0) loadDoc(stored.path);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (path.length > 0) saveStored({ ...loadStored(), path }); }, [path]);

    const visibleNodes = useMemo(() => filterNodes(tree?.nodes ?? [], keyword.trim()), [tree, keyword]);

    return h('div', { className: 'dpr-root', style: { height: '100%' } },
      h('div', { className: 'dpr-bar' },
        h('div', { className: 'dpr-title' }, IconPaper ? h(IconPaper, { size: 14 }) : null, '论文（停靠）'),
        h('div', { className: 'dpr-crumb', title: doc?.path ?? '' }, doc?.name ?? ''),
        h('div', { className: 'dpr-tools' },
          h('button', { className: 'dpr-btn', title: treeOpen ? '收起目录' : '展开目录', onClick: () => setTreeOpen((value) => !value) }, '目录'),
          typeof openPanel === 'function' ? h('button', { className: 'dpr-btn', title: '切到三栏阅读（左目录 / 中论文 / 右对话）', onClick: openPanel }, '三栏阅读') : null)),
      h('div', {
        className: 'dpr-body',
        style: treeOpen ? { gridTemplateColumns: '220px minmax(0,1fr)' } : { gridTemplateColumns: 'minmax(0,1fr)' },
      },
        treeOpen ? h('div', { className: 'dpr-pane' },
          h('div', { className: 'dpr-pane-head', style: { minHeight: '32px' } },
            h('input', { className: 'dpr-input', placeholder: '过滤…', value: keyword, onChange: (event) => setKeyword(event.target.value) }),
            h('button', { className: 'dpr-btn', title: showAll ? '只看文稿' : '显示全部', onClick: () => { const next = !showAll; setShowAll(next); loadTree(root, next); } }, showAll ? '全部' : '文稿')),
          h('div', { className: 'dpr-pane-body' },
            treeError.length > 0 ? h('div', { className: 'dpr-error' }, treeError) : null,
            visibleNodes.map((node) => h(TreeNode, {
              key: node.path,
              node,
              depth: 0,
              selected: path,
              expanded,
              onToggle: (target) => setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(target)) next.delete(target); else next.add(target);
                return next;
              }),
              onOpen: (target) => loadDoc(target),
            })))) : null,
        h('div', { className: 'dpr-pane' },
          busy ? h('div', { className: 'dpr-loading' }, h('span', { className: 'dpr-spin' }), '加载中…') : null,
          docError.length > 0 ? h('div', { className: 'dpr-error' }, docError) : null,
          h('div', { className: 'dpr-paper-scroll' },
            h(PaperView, { doc, onOpenRaw: (url) => window.open(url, '_blank', 'noopener') })))));
  }

  /** 停靠标签的标题（dock 的 tab chip）。 */
  function PaperDockTitle() {
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
      IconPaper ? h(IconPaper, { size: 13 }) : null, '论文');
  }

  // ---------------------------------------------------------- 主面板 ----
  function PaperPanel(props) {
    const { close, askAgent, canAsk } = props;
    const stored = useRef(loadStored()).current;

    const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW_WIDTH);
    const [tab, setTab] = useState(stored.tab === 'tree' || stored.tab === 'chat' ? stored.tab : 'paper');
    const [root, setRoot] = useState(typeof stored.root === 'string' ? stored.root : '');
    const [roots, setRoots] = useState([]);
    const [showAll, setShowAll] = useState(stored.showAll === true);
    const [tree, setTree] = useState(null);
    const [treeError, setTreeError] = useState('');
    const [treeBusy, setTreeBusy] = useState(false);
    const [expanded, setExpanded] = useState(() => new Set(Array.isArray(stored.expanded) ? stored.expanded : []));
    const [keyword, setKeyword] = useState('');
    const [path, setPath] = useState(typeof stored.path === 'string' ? stored.path : '');
    const [doc, setDoc] = useState(null);
    const [docError, setDocError] = useState('');
    const [docBusy, setDocBusy] = useState(false);
    const pathRef = useRef(path);
    pathRef.current = path;
    const docRef = useRef(doc);
    docRef.current = doc;

    /** 持久化需要跨面板切换保留的少量状态。 */
    useEffect(() => {
      saveStored({ root, showAll, path, tab, expanded: [...expanded].slice(0, 200) });
    }, [root, showAll, path, tab, expanded]);

    useEffect(() => {
      const onResize = () => setNarrow(window.innerWidth < NARROW_WIDTH);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    /** 拉目录树。 */
    const loadTree = useCallback(async (nextRoot, all) => {
      setTreeBusy(true);
      setTreeError('');
      try {
        const payload = await apiGet('tree', { root: nextRoot || undefined, all: all ? 1 : undefined });
        setTree(payload);
        setRoot(payload.root);
        setRoots(Array.isArray(payload.roots) ? payload.roots : []);
        // 首屏没有任何选择时，自动打开第一篇文稿。
        if (pathRef.current === '' && docRef.current === null) {
          const auto = firstFile(payload.nodes);
          if (auto !== null) loadDoc(auto.path);
        }
      } catch (error) {
        setTreeError(error.message);
        setTree(null);
      } finally {
        setTreeBusy(false);
      }
    }, []);

    /** 拉正文。 */
    const loadDoc = useCallback(async (nextPath) => {
      if (typeof nextPath !== 'string' || nextPath.length === 0) return;
      setDocBusy(true);
      setDocError('');
      try {
        const payload = await apiGet('file', { path: nextPath });
        setDoc(payload);
        setPath(payload.path);
        if (narrow) setTab('paper');
      } catch (error) {
        setDocError(error.message);
        setDoc(null);
      } finally {
        setDocBusy(false);
      }
    }, [narrow]);

    useEffect(() => { loadTree(root, showAll); /* 首屏 */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
      if (path.length > 0 && doc === null && docError === '') loadDoc(path);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      const onKey = (event) => {
        if (event.key !== 'Escape') return;
        const tag = event.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable === true) return;
        close();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [close]);

    const visibleNodes = useMemo(() => filterNodes(tree?.nodes ?? [], keyword.trim()), [tree, keyword]);

    const treePane = h('div', { className: 'dpr-pane', style: narrow && tab !== 'tree' ? { display: 'none' } : undefined },
      h('div', { className: 'dpr-pane-head' },
        IconFolder ? h(IconFolder, { size: 14 }) : null,
        h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: root },
          tree?.root ?? root ?? '工作区'),
        h('button', { className: 'dpr-btn', title: showAll ? '只看文稿' : '显示全部文件', onClick: () => { const next = !showAll; setShowAll(next); loadTree(root, next); } },
          showAll ? '全部' : '文稿'),
        h('button', { className: 'dpr-btn', title: '刷新', onClick: () => loadTree(root, showAll) }, IconRefresh ? h(IconRefresh, { size: 12 }) : '刷新')),
      h('div', { className: 'dpr-pane-head', style: { minHeight: '34px' } },
        h('input', {
          className: 'dpr-input',
          placeholder: '过滤文件名…',
          value: keyword,
          onChange: (event) => setKeyword(event.target.value),
        }),
        roots.length > 1
          ? h('select', {
            className: 'dpr-input',
            style: { flex: 'none', width: '96px' },
            value: root,
            onChange: (event) => loadTree(event.target.value, showAll),
          }, roots.map((item) => h('option', { key: item, value: item }, item)))
          : null),
      h('div', { className: 'dpr-pane-body' },
        treeBusy && tree === null ? h('div', { className: 'dpr-loading' }, h('span', { className: 'dpr-spin' }), '读取目录…') : null,
        treeError.length > 0 ? h('div', { className: 'dpr-error' }, treeError) : null,
        tree !== null && visibleNodes.length === 0 ? h('div', { className: 'dpr-empty' },
          keyword.length > 0 ? '没有匹配的文件。' : '这个目录里没有文稿类文件（.md / .markdown / .txt / .tex / .pdf …）。',
          keyword.length === 0 ? h('div', { style: { marginTop: '6px' } },
            '点左上角「文稿」切成「全部」可以看到所有文件；也可以用环境变量 DSHA_PAPER_ROOTS 追加可读目录。') : null) : null,
        (tree?.parent ?? null) !== null ? h('div', {
          className: 'dpr-node',
          onClick: () => loadTree(tree.parent, showAll),
        }, h('span', { style: { flex: 'none', width: '14px' } }, '↑'), h('span', { className: 'dpr-node-name' }, '上一级目录')) : null,
        visibleNodes.map((node) => h(TreeNode, {
          key: node.path,
          node,
          depth: 0,
          selected: path,
          expanded,
          onToggle: (target) => setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(target)) next.delete(target); else next.add(target);
            return next;
          }),
          onOpen: (target) => loadDoc(target),
        })),
        tree?.truncated === true ? h('div', { className: 'dpr-empty' }, '文件太多，只显示了前一部分。') : null));

    const paperPane = h('div', { className: 'dpr-pane', style: narrow && tab !== 'paper' ? { display: 'none' } : undefined },
      h('div', { className: 'dpr-paper-head' },
        IconPaper ? h(IconPaper, { size: 14 }) : null,
        h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: doc?.path ?? '' },
          doc === null ? '论文正文' : doc.name),
        doc !== null && typeof doc.size === 'number' ? h('span', { style: { flex: 'none', opacity: .7 } }, sizeText(doc.size)) : null,
        h('button', {
          className: 'dpr-btn',
          disabled: doc === null || typeof doc.text !== 'string',
          title: '复制全文（Markdown / 文本）',
          onClick: async () => { if (typeof doc?.text === 'string') await copyText(doc.text); },
        }, IconCopy ? h(IconCopy, { size: 12 }) : null, '复制')),
      docBusy ? h('div', { className: 'dpr-loading' }, h('span', { className: 'dpr-spin' }), '加载正文…') : null,
      docError.length > 0 ? h('div', { className: 'dpr-error' }, docError) : null,
      h('div', { className: 'dpr-paper-scroll' },
        h(PaperView, { doc, onOpenRaw: (url) => window.open(url, '_blank', 'noopener') })));

    const chatPane = h('div', { className: 'dpr-pane', style: narrow && tab !== 'chat' ? { display: 'none' } : undefined },
      h(SubagentPane, {
        doc,
        getSessionId: props.sessionId,
        openSubagent: props.openSubagent,
        dockPaper: props.dockPaper,
        canDock: props.canDock,
      }));

    return h('div', { className: 'dpr-root', 'data-paper-reader': 'ready' },
      h('div', { className: 'dpr-bar' },
        h('div', { className: 'dpr-title' }, IconPaper ? h(IconPaper, { size: 15 }) : null, '论文阅读器'),
        h('div', { className: 'dpr-crumb', title: doc?.path ?? '' }, doc?.path ?? root ?? ''),
        h('div', { className: 'dpr-tools' },
          canAsk ? h('button', { className: 'dpr-btn', onClick: () => {
            const target = doc?.path ?? path;
            const prompt = target
              ? `请精读这篇论文：${target}\n先用 read 工具读原文，然后给出：\n1) 研究问题与动机；\n2) 方法与技术路线；\n3) 关键实验/结论与具体数据；\n4) 局限、可疑之处和可复用的点。`
              : '请帮我精读一篇论文，先问我要读哪个文件。';
            if (!askAgent(prompt)) setDocError('当前会话没有可写的输入框，请先回到对话再试');
          }, title: '在对话中提问' }, IconChat ? h(IconChat, { size: 12 }) : null, '问 Agent') : null,
          props.dock !== undefined ? h('button', { className: 'dpr-btn', title: '停靠到右侧栏（中间继续用原生聊天）', onClick: props.dock }, '停靠') : null,
          h('button', { className: 'dpr-btn', onClick: close, title: '返回对话（Esc）' },
            IconClose ? h(IconClose, { size: 12 }) : null, '返回对话'))),
      narrow ? h('div', { className: 'dpr-tabs' },
        h('button', { className: 'dpr-tab', 'data-active': tab === 'tree' ? 'true' : undefined, onClick: () => setTab('tree') }, '目录'),
        h('button', { className: 'dpr-tab', 'data-active': tab === 'paper' ? 'true' : undefined, onClick: () => setTab('paper') }, '论文'),
        h('button', { className: 'dpr-tab', 'data-active': tab === 'chat' ? 'true' : undefined, onClick: () => setTab('chat') },
          '对话')) : null,
      h('div', { className: 'dpr-body', 'data-narrow': narrow ? 'true' : undefined }, treePane, paperPane, chatPane));
  }

  // ------------------------------------------------- 输入框「论文」按钮 ----
  function PaperOpenButton(props) {
    const { open } = props;
    const usePanelInfo = typeof props.usePanelInfo === 'function' ? props.usePanelInfo : null;
    const active = usePanelInfo === null ? false : usePanelInfo((info) => info?.activePanelId === 'paper');
    return h('button', {
      type: 'button',
      className: 'dpr-open',
      'data-active': active ? 'true' : undefined,
      disabled: active,
      // 已经在阅读器里就不再响应：不允许"论文里再点论文"套壳。
      title: active ? '已经在论文阅读器里了' : '论文阅读：左目录 / 中论文（黑底）/ 右论文子代理',
      onClick: active ? undefined : open,
    }, IconPaper ? h(IconPaper, { size: 13 }) : null, active ? '阅读中' : '论文');
  }

  // ------------------------------------------------------------- 插件 ----
  /** 依赖的客户端服务：槽位注册表 + 布局面板服务。 */
  const inject = ['slots', 'layout'];

  /**
   * 浏览器半主体。
   * @param ctx - 客户端根上下文。
   */
  function apply(ctx) {
    ctx.effect(() => installCss(), 'dsh-paper-reader: 样式');

    /** 在原生对话输入框里写入草稿并回到对话面板。 */
    const askAgent = (text) => {
      try {
        const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined;
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        const current = sessions?.list?.getSnapshot?.()?.current;
        let shell;
        if (conversation?.input?.shells instanceof Map) shell = conversation.input.shells.get(current);
        if (shell === undefined && typeof conversation?.input?.shell === 'function' && typeof current === 'string') {
          shell = conversation.input.shell(current);
        }
        if (typeof shell?.actions?.setDraft !== 'function') return false;
        shell.actions.setDraft(text);
        ctx.layout.selectPanel(null);
        return true;
      } catch {
        return false;
      }
    };

    const canAsk = (() => {
      try {
        return (typeof ctx.get === 'function' && ctx.get('conversation') !== undefined)
          || (typeof ctx.get === 'function' && ctx.get('sessions') !== undefined);
      } catch { return false; }
    })();

    /** 当前顶层会话 id（若停在子代理上，取它的父会话）。 */
    const currentSessionId = () => {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        const current = sessions?.list?.getSnapshot?.()?.current;
        if (typeof current !== 'string' || current.length === 0) return undefined;
        const address = sessions?.subagentAddress?.(current);
        return typeof address?.parentSessionId === 'string' ? address.parentSessionId : current;
      } catch { return undefined; }
    };

    /** 切到原生子会话（可选把一句话写进原生输入框草稿）。 */
    const openSubagent = (address, draft) => {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : undefined;
        if (address === null || address === undefined || typeof sessions?.openSubagent !== 'function') return false;
        sessions.openSubagent(address);
        if (typeof draft !== 'string' || draft.length === 0) return true;
        let attempts = 0;
        const write = () => {
          attempts += 1;
          try {
            let shell = conversation?.input?.shells?.get?.(address.childSessionId);
            if (shell === undefined && typeof conversation?.input?.shell === 'function') {
              shell = conversation.input.shell(address.childSessionId);
            }
            if (typeof shell?.actions?.setDraft === 'function') {
              shell.actions.setDraft(draft);
              return;
            }
          } catch { /* 稍后重试 */ }
          if (attempts < 8) setTimeout(write, 80);
        };
        setTimeout(write, 60);
        return true;
      } catch { return false; }
    };

    /** 输入框右侧工具栏入口（面板已打开时不再叠加，避免"论文里再点论文"）。 */
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right',
      id: 'paper-reader-open',
      order: 15,
      inject: () => ({
        open: () => ctx.layout.selectPanel('paper'),
      }),
    }, PaperOpenButton));

    /** 右侧栏停靠形态：类型注册（stage 1）+ 主体/标题（stage 2）。 */
    const openDock = () => {
      try {
        const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
        if (typeof right?.openTab !== 'function') return false;
        right.openTab('paper');
        return true;
      } catch { return false; }
    };
    const canDock = (() => {
      try {
        const tabs = typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined;
        const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
        return typeof tabs?.register === 'function' && typeof right?.openTab === 'function';
      } catch { return false; }
    })();

    if (canDock) {
      ctx.effect(() => {
        const tabs = ctx.get('sidebarRightTabs');
        return tabs.register({
          id: 'dsh-paper-reader',
          kind: 'paper',
          priority: 'extension',
          title: () => '论文',
        });
      }, 'dsh-paper-reader: 停靠标签类型');
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: 'dsh-paper-reader',
        inject: () => ({ openPanel: () => ctx.layout.selectPanel('paper') }),
      }, PaperDock));
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: 'dsh-paper-reader',
      }, PaperDockTitle));
    }

    /** 主区域面板：三栏阅读界面。 */
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: 'paper',
      inject: () => ({
        close: () => ctx.layout.selectPanel(null),
        askAgent,
        canAsk,
        sessionId: currentSessionId,
        openSubagent,
        canDock: () => canDock,
        dockPaper: canDock ? () => { if (openDock()) ctx.layout.selectPanel(null); } : undefined,
        dock: canDock ? () => { if (openDock()) ctx.layout.selectPanel(null); } : undefined,
      }),
    }, PaperPanel));
  }

  return { name: 'dsh-paper-reader', inject, apply };
}});
