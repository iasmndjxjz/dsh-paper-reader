# dsh-paper-reader

> DSHA（DeepSeek Harness）插件：**论文阅读器**。右栏不是自绘聊天，而是**论文子代理**的状态台；
> 真正聊天走平台原生的子会话（输出天然留在你的会话下面）。两种形态自由切换。

```
┌──────────┬───────────────────────┬────────────────────────┐
│ 目录     │ 论文正文（黑底）        │ 论文子代理（控制台）     │
│ 工作区树  │ Markdown / PDF(pdf.js) │ 状态 + 只读镜像 + 一键入口 │
└──────────┴───────────────────────┴────────────────────────┘
```

- **三栏形态**：输入框右侧点「论文」。手机窄屏自动变成「目录 / 论文 / 对话」三个页签（同一套实现，桌面并排、手机分页）。
- **停靠形态**：三栏里点「停靠」（或从右侧栏开「论文」标签），论文挂右侧栏，**中间的原生聊天一动不动**，点「三栏阅读」切回来。

## 论文对话 = 真子代理（不是自搓会话）

右栏的「精读总结 / 在原生会话里打开」会调用平台的
[`ctx.subagents.startContinuable()`](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent)，
在**你当前这个会话**下面开一个可续聊的子代理：

- 子会话的持久化 header 里 `parentSession` 就是你的会话，所以**记录留在你跟 Agent 的对话里**（原生侧有子代理目录/芯片，可以点开、可以接着聊）；
- 子代理的**工具与系统提示继承父会话的 Agent 预设**（平台内部 `composeFrom(childCtx, parent.ctx)`），不需要插件做任何组装；
- 平台把子代理的审批策略钉为 `never`，所以面板里不会弹确认、也不会卡住；
- 续聊由**人类侧通道**进入：点「在原生会话里打开」→ `ctx.sessions.openSubagent(address)` → 在原生输入框里打字（桌面同时把论文停靠到右侧栏，边看边聊）。

右栏自己**只读**：显示子代理状态（未开始 / 运行中 / 空闲 / 已休眠）与镜像。一行跑完 Activation 会被回收，
镜像就用 `ctx.sessionQuery.readSession(childId)` 读**冷会话的完整日志**（官方“读冷会话、不激活”的口子），不会为了展示把子代理叫醒。

## 其它

- **PDF 用 pdf.js**：中栏真渲染（缩放 / 反色 / 下载），并且**宿主侧抽取文字**——所以 PDF 也能被总结、被追问。
- **只读**：对用户文件不写不改不删；路径必须落在允许根目录内（`realpath` + 路径边界校验，防 `..` 与前缀逃逸，不跟随软链接）。
- **不套壳**：阅读器内部没有任何「论文」入口；输入框那个按钮在阅读器打开时变成不可点的「阅读中」，不会出现“论文里再点论文”。
- **入场动画**：进入阅读器时三栏错开淡入（`prefers-reduced-motion` 下自动关闭）。

## 安装

```bash
dsha-plugin import /tmp/dsh-paper-reader.zip   # 打包见下
# 插件行是 patchReload: startup → 在 App 里重启一次 DSHA Web 生效
```

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
2. 左栏选文稿（首屏自动打开第一篇 Markdown），中栏阅读。
3. 右栏点 **「精读总结」**（首轮把论文上下文/PDF 抽取正文喂给子代理），或直接点一条快捷提问。
4. 想接着聊：点 **「在原生会话里打开」** → 在原生输入框里问（桌面论文停靠旁边）。子代理跑的时候右栏会同步镜像。
5. `Esc` / 「返回对话」回到原聊天。

## 配置

| 环境变量 | 说明 |
|---|---|
| `DSHA_PAPER_ROOTS` | 追加可读根目录（`:` 分隔）。默认只有 dsh 进程工作目录（本机 = `/root`）。例：`DSHA_PAPER_ROOTS=/sdcard/Download:/sdcard/Documents` |
| `DSHA_PAPER_PDFJS_DIR` | 覆盖 pdfjs-dist 目录（默认插件内 `node_modules/pdfjs-dist`） |

## HTTP 接口（宿主半）

全部挂在 `prefix /api/paper-reader`，复用浏览器鉴权（未鉴权 401、非信任域 403）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ok, roots, version, chat:{available, provider, mode:'subagent'}}` |
| GET | `/tree?root=&all=1` | 工作区文稿目录树 |
| GET | `/file?path=` | 单篇：`{kind, text, rawUrl, size, mtime}` |
| GET | `/raw?path=&download=1` | 原始字节（PDF/图片，正确 MIME + CSP sandbox） |
| GET | `/text?path=` | pdf.js 抽取的文字（PDF / 文本，带缓存） |
| GET | `/pdfjs/*` | 转发 pdfjs-dist 静态资源（主模块/worker/cmaps/standard_fonts/wasm） |
| GET | `/chat?path=&sessionId=` | 子代理状态 + 只读镜像（活会话读事件，冷会话读持久化日志） |
| POST | `/chat` | 在当前会话下起论文子代理：`{path, sessionId, mode?:'summary'\|'ask', message?}` → `{childId, address, reused}` |
| GET | `/chat/stream?path=&sessionId=` | 只读镜像流（NDJSON：`state` / `message` / `delta` / `tool` / `idle` / `ping`） |
| POST | `/chat/interrupt` | 人类权限打断：`subagents.interrupt(childId, {kind:'user', parentSessionId})` |
| POST | `/chat/reset` | 忘掉这篇论文的子代理映射（下次重起） |
| POST | `/summary` | 旧的一次性总结接口（走 `ctx.llm`，保留备用） |

## 已知限制

- 面板只做只读镜像；**操作面是原生子会话**（那边有完整的流式、工具、队列、审批）。
- 子代理一轮跑完会被平台回收（`cold`）：镜像仍能读，但要继续聊需点「在原生会话里打开」让它冷恢复。
- PDF 抽取靠 pdf.js；扫描版（无文字层）PDF 抽不出正文，只能看图。
- LaTeX 公式按源码显示；DOCX 等不可渲染格式只给下载。
- 手机存储 `/sdcard` 默认不在可读范围，需 `DSHA_PAPER_ROOTS` 显式开启。
- 插件行 `patchReload: startup`：安装/更新/卸载后都要重启 DSHA Web。

## 开发与测试

```bash
cd /root/dsh-paper-reader
pnpm install --ignore-scripts   # devDependencies：react / react-dom / jsdom（pdfjs-dist 是运行时依赖）
pnpm test
```

- `test/test-host.mjs`：文件接口、越界/穿越防护、鉴权 401/403、PDF 抽取、pdfjs 资源转发。
- `test/test-chat.mjs`：假 agents/subagents/sessionQuery + 真 http，覆盖 `startContinuable` 入参（父会话、provider、上下文注入）、
  复用/换父会话、状态与镜像（含**冷子代理读持久化日志**）、只读流转发与过滤、人类权限打断、重置、错误分支。
- `test/test-client.mjs`：jsdom + react-dom 真挂载，覆盖三栏、目录树、Markdown、右栏子代理控制台
  （状态/卡片/快捷提问/镜像渲染/切原生会话/停靠）、停靠模式互切、防套壳、PDF 走 pdf.js 并自动退回 iframe。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半：路由层（文件/PDF 抽取/子代理/总结）与路径安全 |
| `lib/chat.js` | 论文子代理引擎：映射落盘、`startContinuable`、活/冷镜像、人类权限打断 |
| `lib/pdf-text.js` | pdf.js：宿主侧文字抽取 + 浏览器侧资源定位 |
| `lib/client.js` | 浏览器半：输入框按钮、三栏面板、子代理控制台、停靠标签、动画与样式 |
| `test/*.mjs` | 三套集成测试 |

MIT。
