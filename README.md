# dsh-paper-reader

> DSHA（DeepSeek Harness）插件：**论文阅读器**。两种形态，随时切换，中间的聊天永远可用。

**三栏形态**（输入框右侧点「论文」）：

```
┌──────────┬────────────────────────┬─────────────────────┐
│ 目录     │  论文正文（黑底）       │  实时对话            │
│ 工作区树  │  Markdown / PDF(pdf.js)│  真 Agent · 流式 · 随时可聊 │
└──────────┴────────────────────────┴─────────────────────┘
```

**停靠形态**（三栏里点「停靠」，或从右侧栏打开）：论文+目录挂在右侧栏，**中间的原生聊天一动不动**，点「三栏阅读」切回来。

## 关键点

- **右栏是「随时能聊」的真对话**，不是需要先点「总结」才能用的面板：
  - 宿主半为**每篇论文维护一个真正的 DSH 会话**（`ctx.agents` 创建/恢复，挂上 Agent 预设 → 工具齐备），
    面板只是把它流式增量画成气泡；会话会落盘，重启后接着聊，也会出现在会话列表里。
  - 它自己会读文件、查目录、跑命令（工具调用会显示成气泡上的小标签）。
  - 「精读总结」只是往对话里发一条指令（开场白），不是聊天的前置开关。
  - 「新对话」清空这篇论文的会话；「停止」中断正在跑的一轮；「问 Agent」把论文写进**原生输入框**并回到主对话。
- **PDF 用 pdf.js**：中栏真渲染（翻页/缩放/反色/下载），并且**宿主侧抽取文字**——所以 PDF 也能被总结、被追问。
- **只读**：对用户文件不写不改不删；路径必须落在允许根目录内。
- 窄屏（<900px）三栏自动变成「目录 / 论文 / 对话」三个页签。

## 安装

```bash
dsha-plugin import /tmp/dsh-paper-reader.zip   # 打包方式见下
# 插件行是 patchReload: startup → 在 App 里重启一次 DSHA Web 生效
```

打包（zip 里必须有一层 `dsh-paper-reader/`，且不要带 node_modules）：

```bash
python3 - <<'PY'
import zipfile, os
root, out = '/root/dsh-paper-reader', '/tmp/dsh-paper-reader.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
        for f in files:
            full = os.path.join(base, f)
            z.write(full, os.path.relpath(full, '/root'))
PY
```

卸载：`dsha-plugin delete dsh-paper-reader`（同样需重启）。

## 使用

1. 任意会话 → 输入框右侧 **「论文」** → 三栏。
2. 左栏选文稿（首屏自动打开第一篇 Markdown）；中栏阅读；右栏**直接打字提问**。
3. 想让 Agent 先通读：点右栏「精读总结」。
4. 想用原生聊天读论文：点 **「停靠」**（或右栏打开「论文」标签）→ 中间聊天照常，「三栏阅读」切回。
5. `Esc` / 「返回对话」回到原聊天。

## 配置

| 环境变量 | 说明 |
|---|---|
| `DSHA_PAPER_ROOTS` | 追加可读根目录（`:` 分隔）。默认只有 dsh 进程工作目录（本机 = `/root`）。例：`DSHA_PAPER_ROOTS=/sdcard/Download:/sdcard/Documents` |
| `DSHA_PAPER_PDFJS_DIR` | 覆盖 pdfjs-dist 所在目录（默认插件内 `node_modules/pdfjs-dist`） |

## HTTP 接口（宿主半）

全部挂在 `prefix /api/paper-reader`，复用浏览器鉴权（未鉴权 401、非信任域 403）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, roots, version, chat:{available, model}}` |
| GET | `/tree?root=&all=1` | 工作区文稿目录树 |
| GET | `/file?path=` | 单篇：`{kind, text, rawUrl, size, mtime}` |
| GET | `/raw?path=&download=1` | 原始字节（PDF/图片，正确 MIME + CSP sandbox） |
| GET | `/text?path=` | **pdf.js 抽取的文字**（PDF / 文本；带缓存） |
| GET | `/pdfjs/*` | 转发 pdfjs-dist 静态资源（主模块/worker/cmaps/standard_fonts/wasm） |
| GET | `/chat?path=` | 这篇论文的对话历史 `{sessionId, messages, chat}` |
| POST | `/chat` | 驱动真 Agent，**NDJSON 流**：`start` / `delta` / `tool` / `done` / `error` / `cancelled` |
| POST | `/chat/cancel` | 停止正在跑的一轮 |
| POST | `/chat/reset` | 清空这篇论文的对话（下次开新会话） |
| POST | `/summary` | 旧的一次性总结接口（走 `ctx.llm`，保留备用） |

**安全边界**：路径先 `realpath` 再按路径边界校验必须落在允许根目录内（防 `..` 与同前缀逃逸），不跟随软链接，目录树跳过隐藏目录/`node_modules`/`dist`，节点上限 1500。

## 已知限制

- 论文对话是**真会话**，因此也会走模型的正常计费；无凭据/无模型时右栏会直接显示原因，不会假装成功。
- 需要「点允许」的审批交互不会在右栏弹出（本部署为 danger-full-access，通常不触发）；需要时请回到原生对话处理。
- LaTeX 公式按源码显示（不内置 KaTeX）；DOCX 之类不可渲染格式只给下载。
- 手机存储 `/sdcard` 默认不在可读范围，需用 `DSHA_PAPER_ROOTS` 显式开启。
- 插件行 `patchReload: startup`：安装/更新/卸载后都要重启 DSHA Web。

## 开发与测试

```bash
cd /root/dsh-paper-reader
pnpm install --ignore-scripts   # devDependencies：react / react-dom / jsdom（pdfjs-dist 是运行时依赖）
pnpm test
```

- `test/test-host.mjs`：文件接口、越界/穿越防护、鉴权 401/403。
- `test/test-chat.mjs`：真 http 服务 + 假 agents 服务，覆盖会话创建/恢复、预设挂载、上下文注入、
  流式事件、工具名、取消、重置、模型失败要暴露、PDF 抽取（真 pdf.js）、pdfjs 资源转发。
- `test/test-client.mjs`：jsdom + react-dom 真挂载，覆盖三栏、目录树、Markdown、实时对话
  （历史/发送/流式/工具标签/停止/新对话）、PDF 走 pdf.js 并自动退回 iframe、**停靠模式**与两种形态互切。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：路由层（文件/PDF 抽取/对话/总结）与路径安全 |
| `lib/chat.js` | 论文对话引擎：会话映射落盘、真 Agent 创建/恢复、Agent 预设挂载、流式转发 |
| `lib/pdf-text.js` | pdf.js：宿主侧文字抽取 + 浏览器侧资源定位 |
| `lib/client.js` | 浏览器半：输入框按钮、三栏面板、停靠标签、自带 Markdown 渲染与样式 |
| `test/*.mjs` | 三套集成测试 |

MIT。
