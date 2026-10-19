# Tech Mentor Studio

在本机选择 Git 改动，查看 Diff，再由已配置的模型解释架构与实现。支持工作区、历史提交和提交区间、多轮追问、代码复制、Mermaid 图以及 Markdown 导出。

## 启动

需要 Node.js 22+、npm、Git 和 lsof，支持 macOS / Linux。Keeper 用量显示另外需要 `sqlite3`；Keeper 不可用时仍可查看仓库和使用已就绪的模型。安装 [gitleaks](https://github.com/gitleaks/gitleaks)（`brew install gitleaks`）后，发给模型的内容会先做密钥扫描。

```bash
npm ci
./start.sh
```

浏览器地址为 <http://127.0.0.1:3300>。`npm start` 使用相同的安全启动器；默认自动打开浏览器，`Ctrl+C` 停止这次启动的项目服务。前端资源的构建输入没有变化时，启动器跳过构建；`npm run build` 总是重新构建。

启动器先核对端口、进程工作目录、服务身份和代码指纹。同一目录的当前版本会直接复用；其他服务或旧版本占用端口时明确报错，保留所有已有进程。可以换用空闲端口：

```bash
PORT=3400 NO_BROWSER=1 npm start
```

## 配置代理

认证按以下顺序读取：`PROXY_KEY` 环境变量；`~/.config/tech-mentor-studio/proxy-key`（如果 `XDG_CONFIG_HOME` 设置为绝对路径，则改用该目录下的 `tech-mentor-studio/proxy-key`）；旧位置 `data/proxy-key`。默认位置在项目目录之外：项目放在 iCloud 同步的桌面上时，`data/` 下的文件即使权限为 600 也会被上传。如果仍从旧位置读取，或者认证文件对其他用户可读，启动日志会给出提示，但不会输出认证内容。旧位置仍然可用，已经配置的用户无需更换认证。要迁移，移动文件即可：

```bash
mkdir -p -m 700 ~/.config/tech-mentor-studio
mv data/proxy-key ~/.config/tech-mentor-studio/proxy-key
chmod 600 ~/.config/tech-mentor-studio/proxy-key
```

认证文件和关注列表都不提交到 Git。

缺少配置、代理认证失败、查询超时或没有模型时，界面显示原因并禁用分析。修好代理后点击“重试模型”。可选择的模型均来自代理实际返回的列表，选择偏好保存在浏览器中。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | 3300 | 只监听 `127.0.0.1` 的服务端口 |
| `PROXY_URL` | `http://127.0.0.1:8317/v1/chat/completions` | 分析接口 |
| `MODELS_URL` | 将分析地址末尾 `/chat/completions` 替换为 `/models` | 模型列表 |
| `PROXY_KEY` | 依次读取 `~/.config/tech-mentor-studio/proxy-key`、`data/proxy-key` | 代理认证 |
| `KEEPER_DB_PATH` | `/opt/homebrew/var/cpa-usage-keeper/app.db` | SQLite 只读计量 |
| `MODELS_TIMEOUT_MS` | 5000 | 模型列表超时，单位毫秒 |
| `ANALYSIS_TIMEOUT_MS` | 180000 | 分析总超时，单位毫秒 |
| `SCAN_ROOTS_JSON` | Desktop、Developer、Github 和主目录 | 绝对路径数组 |
| `NO_BROWSER` | 未设置 | 设为 `1` 跳过自动打开浏览器 |

扫描包括指定根目录及其一级子目录，还会读取已保存的关注列表；不会递归遍历整个磁盘。仓库列表缓存 30 秒，点击刷新按钮会立即重新扫描。把默认扫描根限制到当前项目可使用（仍保留已保存的关注列表）：

```bash
SCAN_ROOTS_JSON="$(node -p 'JSON.stringify([process.cwd()])')" npm start
```

Keeper 分别显示每个窗口的最新观测值，过期后显示“等待更新 / 未知”，不推测额度已恢复。今日统计使用 UTC 日期，计量状态与模型连接状态分别显示。用量每 15 秒刷新；页面在后台时暂停刷新，回到前台时立即刷新一次。

## 使用分析快照

1. 选择仓库，再选择工作区、单次提交或提交区间。特殊字符文件名和首次提交均可使用。
2. 点击文件标签查看单个文件，或保留“全部文件”。大 Diff 每页显示 2000 行，复制保留完整内容。
3. 点击精读动作或输入问题。新对话针对正在查看的文件（或全部文件），导师面板顶部的范围栏显示当前讨论范围。首轮生成代码、项目文档和带行号源码片段的快照；Diff 每行也标注真实行号，便于模型准确引用。首轮回答下方的“本次依据”列出模型实际收到的 Diff 文件、文档和源码行范围，以及哪些内容被截断。
4. 后续追问复用首次快照，修改工作区不会悄悄改变分析依据。精读动作在已有对话中作为追问执行，对话记录保存模型实际收到的指令。
5. 对话进行中可以随意查看其他文件，讨论范围不变；要换范围，点击范围栏的“针对 … 新开对话”。清空和新开对话都可在 10 秒内撤销。对话按“仓库 + 目标”分别保留：切到其他提交或仓库再切回来，会恢复原来的对话和查看位置。
6. 回答中的 `文件:行号` 可以点击，跳到 Diff 中对应的行并高亮；所引的行不在本次 Diff 内时，定位到最近的改动行并提示。在 Diff 中选中几行会浮出“就选中代码提问”，输入框自动带上文件、真实行号和选中的代码。输入框支持多行，Enter 发送，Shift+Enter 换行。

历史提交从对应 Git 版本读取文档和源码；离改动最近的子目录 `AGENTS.md` / `CLAUDE.md` 优先于通用文档进入预算。工作区捕获期间检测文件变化，检测到变化会提示重试。干净工作区的分析会回退到最新提交，回答和导出会记录实际目标。快照闲置超过 30 分钟或服务重启后，追问会自动重新捕获证据并保留对话，回答底部注明“分析快照已在会话中重新捕获”，模型也会被告知早先回答可能基于旧证据。服务重启后页面会自动换用新的本机会话，无需刷新。

窄屏通过“仓库 / 代码差异 / 导师”切换视图，点击回答中的代码引用会切到代码差异视图。停止生成会取消上游请求；生成过程中切换目标或仓库也会终止这次生成。未完成的回答不会加入历史或导出笔记。

## 检查与浏览器回归

```bash
npm run check
npm test
npm run build
npm audit
```

浏览器检查需要安装 Chromium，并让测试端口的服务运行。第一个终端：

```bash
npx playwright install chromium
PORT=3301 NO_BROWSER=1 SCAN_ROOTS_JSON="$(node -p 'JSON.stringify([process.cwd()])')" npm start
```

第二个终端：

```bash
npm run test:browser
```

已有服务也可用于验证：`MENTOR_TEST_URL=http://127.0.0.1:3300 npm run test:browser`。模型回答使用测试替身；测试不会调用真实模型或修改 Keeper。Node 测试使用独立临时 Git 仓库和 SQLite 文件。推送到 `main` 或提交 PR 时，GitHub Actions（`.github/workflows/ci.yml`）会在 Linux 上运行同样的检查、测试、构建、审计和浏览器回归。CI 上没有安装 gitleaks，真实扫描的用例会跳过。

## 实现与限制

| 模块 | 职责 |
| --- | --- |
| `server.js` | 应用组装、仓库扫描与路由 |
| `lib/git.js` / `lib/diff.js` | Git 引用、路径、Diff 与分析预算 |
| `lib/security.js` | 同源校验、本机会话、仓库登记与安全读取 |
| `lib/mentor.js` / `lib/facts.js` | 快照、历史裁剪、版本一致证据与模型上下文 |
| `lib/stream.js` | SSE 解码、单次完成、取消和超时 |
| `lib/config.js` / `lib/keeper.js` | 本地配置与只读计量 |
| `lib/runtime.js` / `scripts/start.js` | 服务版本识别与安全启动 |
| `public/` | 原生浏览器界面、净化渲染与响应式布局 |

前端资源按锁定版本构建至被忽略的 `public/vendor/`，运行时无需 CDN；Mermaid（约 3.4 MB）在回答首次出现图表时才加载。API 必须使用同源本机会话；它不是供公网部署的登录系统。仓库登记不构成本机用户之间的权限隔离。

Git 命令最多运行 15 秒，输出超过 8 MiB 显式失败。工作区中 `node_modules/`、`.venv/`、`__pycache__/` 等依赖与缓存目录下的未跟踪文件只计数、不读取；已跟踪的同类文件按噪声文件处理。读取的单个证据文件最多 500 kB；敏感文件（`.env*`、`.envrc`、私钥与证书、`.git-credentials`、`auth.json`、`*.tfvars`、`secrets.*`、服务账号 JSON 等）按新旧两侧路径排除，重命名或复制不能把敏感内容伪装成普通文件；符号链接和二进制同样排除。快照、提问和历史发给模型前，先用 gitleaks 默认规则扫描，命中的值替换为 `[REDACTED:规则]`。扫描在空目录中运行并忽略 `gitleaks:allow`，被分析仓库的 `.gitleaks.toml` 不能放行自己的密钥。未安装 gitleaks 时照常分析，“本次依据”注明未扫描；扫描失败或超时则停止发送。快照最多 24 份，闲置 30 分钟失效（每次使用都会续期），超出容量时回收最久未用的快照；服务重启也会使快照失效。文档、源码和 Diff 分别有预算，超出时截断并标记：文档按优先级分配预算，每份至少 2500 字符；聚焦单个文件时，源码尽量给出全文，放不下时保留每个改动处，并取预算内能放下的最宽上下文；历史按完整轮次保留最近 24k 字符，页面只发送这部分，完整对话留在页面用于复制和导出；模型回答最多 100k 字符。不能将这些片段视为完整项目审查。

源码中原有的代理认证已移至本地配置，并在应用输出的历史代码证据、仓库摘要和提交元数据中脱敏；原 Git 历史仍保留原始版本，未重写历史或轮换认证。

修复范围与验证记录见 [修复计划](docs/repair-plan.md)、[审查修复报告](docs/2026-10-13_code-audit-tech-mentor-studio-report.md) 、[2026-10-17 追加修复记录](docs/2026-10-17_follow-up-repair.md) 、[2026-10-18 长会话与证据质量修复](docs/2026-10-18_session-resilience.md) 和 [2026-10-18 阅读流程改进](docs/2026-10-18_reading-flow.md)。
