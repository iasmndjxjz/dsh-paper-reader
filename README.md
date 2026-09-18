# dsh-paper-reader

不定时更新。

一个给 DSHA（DeepSeek Harness）用的论文阅读插件。点输入框旁边的「论文」，聊天区会换成三栏：左边是工作区里的文稿目录，中间是正文，右边是这篇论文的子代理。

## 怎么工作

论文对话用平台的子代理，没有自己实现一套。在右栏第一次提问时，会在你当前这个会话下面开一个可续聊的子代理，把论文文件交给它，让它自己用工具读；之后每一条都通过人类通道（`ctx.subagents.prompt`）发给同一个子代理，所以右栏可以直接聊。子代理处于休眠状态时，这条通道会顺手把它唤醒。子会话在持久化里的 `parentSession` 就是你当前会话，记录留在你原来的对话里，原生那边能看到它也能点开接着聊。

子代理的工具和系统提示继承父会话的 Agent 预设，插件不做组装；审批策略由平台固定为不询问，面板里不会弹确认。

右栏显示的是只读镜像：活着的时候转发它的流式输出，跑完被平台回收之后改读持久化日志（`sessionQuery.readSession()`），不会为了显示把它叫醒。想让它在原生界面里跑，点「原生打开」，桌面端会同时把论文停靠到右边。

## 版面

- 三栏：输入框右侧点「论文」。窗口窄于 900px 时自动变成「目录 / 论文 / 对话」三个页签。
- 停靠：三栏里点「停靠」，论文挂到右侧栏，中间的原生聊天不受影响；点「三栏阅读」切回来。

阅读器内部没有第二个「论文」入口，输入框那个按钮在阅读器打开时会变成不可点的「阅读中」，不会叠出一层。进入阅读器时三栏有淡入动画，系统开启减少动态效果时自动关闭。

右栏是聊天样式，黑底白字，消息流加输入框，Enter 发送、Shift+Enter 换行。运行中也点得动发送，它会排队；旁边多一个「停止」。

子代理调用的工具会以小标签贴在对应的那条回答上，流式过程中就能看到。

首轮的交接提示词不进聊天：镜像里只保留你真正问的那句话，纯点击开始（比如「精读总结」）时那条提示词整条不显示。

## 安装

```
dsha-plugin import /tmp/dsh-paper-reader.zip
```

插件行是 `patchReload: startup`，装完要在 App 里重启一次 DSHA Web 才会加载。

打包用的脚本：

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

卸载用 `dsha-plugin delete dsh-paper-reader`，同样要重启。

## 使用

1. 打开任意会话，点输入框右侧的「论文」。
2. 左栏选一篇文稿（第一次进去会自动打开第一篇 Markdown），中栏阅读。
3. 在右栏直接问。第一条会把这篇论文交给子代理（提示词是中文，PDF 直接把文件路径给它，让它自己调工具读；环境里没有 PDF 解析工具时，提示词里还给了插件抽取好的纯文本缓存路径兜底）。
4. 之后每条都发给同一个子代理，可以一直追问。跑的时候右栏会流式显示，也可以点「停止」。
5. 想用原生界面，点「原生打开」。按 Esc 或点「返回对话」回到原来的聊天。

## PDF

中栏用 pdf.js 渲染，支持缩放、反色和下载。文字抽取在宿主侧做，所以 PDF 也能总结和追问。扫描版 PDF 没有文字层，抽不出正文，只能当图片看。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `DSHA_PAPER_ROOTS` | 追加可读根目录，用 `:` 分隔。默认只有 dsh 进程的工作目录，本机是 `/root`。例如要读手机存储：`DSHA_PAPER_ROOTS=/sdcard/Download:/sdcard/Documents` |
| `DSHA_PAPER_PDFJS_DIR` | pdf.js 所在目录，默认是插件内的 `node_modules/pdfjs-dist` |

## 接口

都挂在 `/api/paper-reader` 下面，用和上游 `/api` 一样的浏览器鉴权，没登录返回 401，非信任域返回 403。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 状态、可读根目录、子代理是否可用 |
| GET | `/tree?root=&all=1` | 工作区文稿目录树 |
| GET | `/file?path=` | 单篇文件，返回类型、正文和下载地址 |
| GET | `/raw?path=&download=1` | 原始字节，给 PDF、图片和下载用 |
| GET | `/text?path=` | pdf.js 抽取出来的文字，带缓存 |
| GET | `/pdfjs/*` | 转发 pdfjs-dist 的静态资源 |
| GET | `/chat?path=&sessionId=` | 子代理状态和只读镜像 |
| POST | `/chat` | 没有子代理就起一个，已经有就把 `message` 发给它。参数 `path`、`sessionId`，可选 `message`、`delivery` |
| GET | `/chat/stream?path=&sessionId=` | 镜像的流式输出，NDJSON |
| POST | `/chat/interrupt` | 打断子代理 |
| POST | `/chat/reset` | 忘掉这篇论文的子代理映射，下次重新起 |
| POST | `/summary` | 早期的一次性总结接口，走 `ctx.llm`，保留备用 |

文件接口只读，不写不改不删。路径会先 `realpath` 再校验是否落在允许的根目录内，防 `..` 和前缀逃逸，不跟随软链接。

## 限制

- 面板是只读镜像加一个输入框，更完整的操作（队列、审批、模型切换）在原生子会话里。
- 子代理一轮结束后会被回收，镜像还能看，继续追问会把它唤醒。
- LaTeX 公式按源码显示，DOCX 之类的格式只能下载。
- 手机存储默认不在可读范围，要用 `DSHA_PAPER_ROOTS` 打开。
- 安装、更新、卸载后都需要重启 DSHA Web。

## 开发

```
pnpm install --ignore-scripts
pnpm test
```

`pdfjs-dist` 是运行时依赖，`react`、`react-dom`、`jsdom` 只在测试时用。

测试分三个文件。`test/test-host.mjs` 覆盖文件接口、越界防护、鉴权和 pdf.js 资源；`test/test-chat.mjs` 用假的 agents、subagents、sessionQuery 服务配真实 http，覆盖子代理的启动参数、复用和换父会话、状态与镜像（包括冷会话读持久化日志）、流式转发、打断和错误分支；`test/test-client.mjs` 用 jsdom 挂载真实组件，覆盖三栏、目录树、Markdown、右栏控制台、两种版面互切和 PDF 回退。

## 目录

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 路由和路径校验 |
| `lib/chat.js` | 子代理：映射存储、启动、活/冷镜像、打断 |
| `lib/pdf-text.js` | pdf.js 的文字抽取和资源定位 |
| `lib/client.js` | 按钮、三栏面板、子代理控制台、停靠标签、样式 |

MIT
