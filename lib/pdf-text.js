/**
 * pdf.js 支持层：宿主侧文字抽取 + 浏览器侧静态资源定位。
 *
 * 依赖：`pdfjs-dist`（plugins 的 dependencies，安装时由插件管理器 pnpm 装好）。
 *   - 宿主抽取走 `pdfjs-dist/legacy/build/pdf.mjs`（无 DOM 的 Node 构建）；
 *   - 浏览器渲染走 `pdfjs-dist/build/pdf.min.mjs` + `pdf.worker.min.mjs`，
 *     由本插件自己的路由转发，页面端用动态 import 加载（离线可用，不依赖 CDN）。
 *
 * @module dsh-paper-reader/pdf-text
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 插件根目录（lib 的上一级）。 */
export const PLUGIN_ROOT = path.resolve(HERE, '..');

/** 抽取结果上限（字符），防止超长 PDF 撑爆上下文。 */
const MAX_EXTRACT_CHARS = 200_000;
/** 单次抽取最多读多少页。 */
const MAX_EXTRACT_PAGES = 400;

/** 缓存 pdfjs 模块（动态 import 一次）。 */
let pdfjsPromise;

/** pdfjs-dist 包目录；缺失时抛出可读错误。 */
export function pdfjsDir() {
  const override = process.env.DSHA_PAPER_PDFJS_DIR;
  return typeof override === 'string' && override.trim().length > 0
    ? path.resolve(override.trim())
    : path.join(PLUGIN_ROOT, 'node_modules', 'pdfjs-dist');
}

/** 按顺序找到第一个存在的候选文件。 */
export async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

/** 加载 Node 版 pdf.js；找不到依赖时给出明确指引。 */
export async function loadPdfjs() {
  if (pdfjsPromise === undefined) {
    pdfjsPromise = (async () => {
      const attempts = [
        'pdfjs-dist/legacy/build/pdf.mjs',
        'pdfjs-dist/build/pdf.mjs',
        path.join(pdfjsDir(), 'legacy/build/pdf.mjs'),
      ];
      const failures = [];
      for (const specifier of attempts) {
        try {
          return await import(specifier);
        } catch (error) {
          failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new Error(`pdfjs-dist 不可用（插件依赖未安装？）：${failures.join(' | ')}`);
    })();
  }
  return pdfjsPromise;
}

/**
 * 抽取一个 PDF 的文字。
 * @param file - PDF 绝对路径。
 * @param options - 上限覆盖。
 * @returns 每页文字拼成的正文与页数。
 */
export async function extractPdfText(file, options = {}) {
  const maxPages = Number.isSafeInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : MAX_EXTRACT_PAGES;
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : MAX_EXTRACT_CHARS;
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await readFile(file));
  const standardFontDataUrl = path.join(pdfjsDir(), 'standard_fonts') + path.sep;
  const cMapUrl = path.join(pdfjsDir(), 'cmaps') + path.sep;
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages = [];
    let used = 0;
    let truncated = false;
    const limit = Math.min(doc.numPages, maxPages);
    for (let index = 1; index <= limit; index += 1) {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      const items = Array.isArray(content?.items) ? content.items : [];
      let text = '';
      for (const item of items) {
        const piece = typeof item?.str === 'string' ? item.str : '';
        if (piece.length === 0) continue;
        text += piece;
        if (item.hasEOL === true) text += '\n';
      }
      const block = `\n\n----- 第 ${index} 页 -----\n${text.replace(/\n{3,}/g, '\n\n').trim()}`;
      pages.push(block);
      used += block.length;
      if (used >= maxChars) {
        truncated = index < doc.numPages;
        break;
      }
    }
    return {
      text: pages.join('').trim(),
      pageCount: doc.numPages,
      pagesRead: pages.length,
      truncated: truncated || pages.length < doc.numPages,
    };
  } finally {
    try { await task.destroy(); } catch { /* 关闭失败不影响结果 */ }
  }
}
