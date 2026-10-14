# Tech Mentor Studio

在本机选择 Git 改动，查看 Diff，再由已配置的模型解释架构与实现。支持工作区、历史提交和提交区间、多轮追问、代码复制、Mermaid 图以及 Markdown 导出。

## 启动

需要 Node.js 22+、npm、Git 和 lsof，支持 macOS / Linux。Keeper 用量显示另外需要 `sqlite3`；Keeper 不可用时仍可查看仓库和使用已就绪的模型。

```bash
npm ci
./start.sh
```

浏览器地址为 <http://127.0.0.1:3300>。`npm start` 使用相同的安全启动器；默认自动打开浏览器，`Ctrl+C` 停止这次启动的项目服务。

启动器先核对端口、进程工作目录、服务身份和代码指纹。同一目录的当前版本会直接复用；其他服务或旧版本占用端口时明确报错，保留所有已有进程。可以换用空闲端口：

```bash
PORT=3400 NO_BROWSER=1 npm start
```

## 配置代理

认证从 `PROXY_KEY` 环境变量或本地 `data/proxy-key` 读取，环境变量优先。本地文件应设为权限 600；它和关注列表都不提交到 Git。已经配置的用户无需更换认证。

缺少配置、代理认证失败、查询超时或没有模型时，界面显示原因并禁用分析。修好代理后点击“重试模型”。可选择的模型均来自代理实际返回的列表，选择偏好保存在浏览器中。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | 3300 | 只监听 `127.0.0.1` 的服务端口 |
| `PROXY_URL` | `http://127.0.0.1:8317/v1/chat/completions` | 分析接口 |
| `MODELS_URL` | 将分析地址末尾 `/chat/completions` 替换为 `/models` | 模型列表 |
| `PROXY_KEY` | 读取 `data/proxy-key` | 代理认证 |
| `KEEPER_DB_PATH` | `/opt/homebrew/var/cpa-usage-keeper/app.db` | SQLite 只读计量 |
| `MODELS_TIMEOUT_MS` | 5000 | 模型列表超时，单位毫秒 |
| `ANALYSIS_TIMEOUT_MS` | 180000 | 分析总超时，单位毫秒 |
| `SCAN_ROOTS_JSON` | Desktop、Developer、Github 和主目录 | 绝对路径数组 |
| `NO_BROWSER` | 未设置 | 设为 `1` 跳过自动打开浏览器 |

扫描包括指定根目录及其一级子目录，还会读取已保存的关注列表；不会递归遍历整个磁盘。把默认扫描根限制到当前项目可使用（仍保留已保存的关注列表）：

```bash
SCAN_ROOTS_JSON="$(node -p 'JSON.stringify([process.cwd()])')" npm start
```

Keeper 分别显示每个窗口的最新观测值，过期后显示“等待更新 / 未知”，不推测额度已恢复。今日统计使用 UTC 日期，计量状态与模型连接状态分别显示。

## 使用分析快照

1. 选择仓库，再选择工作区、单次提交或提交区间。特殊字符文件名和首次提交均可使用。
2. 点击文件标签聚焦，或保留“全部文件”。大 Diff 每页显示 2000 行，复制保留完整内容。
3. 点击精读动作或输入问题。首轮生成代码、项目文档和带行号源码片段的快照。
4. 后续追问复用首次快照，修改工作区不会悄悄改变分析依据。重新精读、切换选择或清空对话会创建新会话。

历史提交从对应 Git 版本读取文档和源码。工作区捕获期间检测文件变化，检测到变化会提示重试。干净工作区的分析会回退到最新提交，回答和导出会记录实际目标。

窄屏通过“仓库 / 代码差异 / 导师”切换视图。停止生成会取消上游请求；未完成的回答不会加入历史或导出笔记。

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

已有服务也可用于验证：`MENTOR_TEST_URL=http://127.0.0.1:3300 npm run test:browser`。模型回答使用测试替身；测试不会调用真实模型或修改 Keeper。Node 测试使用独立临时 Git 仓库和 SQLite 文件。

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

前端资源按锁定版本构建至被忽略的 `public/vendor/`，运行时无需 CDN。API 必须使用同源本机会话；它不是供公网部署的登录系统。仓库登记不构成本机用户之间的权限隔离。

Git 命令最多运行 15 秒，输出超过 8 MiB 显式失败。读取的单个证据文件最多 500 kB；敏感文件、链接和二进制排除。快照最多 24 份、有效期 30 分钟，服务重启也会使快照失效。文档、源码和 Diff 分别按预算截断并标记；历史按完整轮次保留最近 24k 字符，模型回答最多 100k 字符。不能将这些片段视为完整项目审查。

源码中原有的代理认证已移至本地配置，并在应用输出的历史代码证据中脱敏；原 Git 历史仍保留原始版本，未重写历史或轮换认证。

修复范围与验证记录见 [修复计划](docs/repair-plan.md) 和 [审查修复报告](docs/2026-10-13_code-audit-tech-mentor-studio-report.md)。
