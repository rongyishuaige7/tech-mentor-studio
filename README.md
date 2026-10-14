# 🧭 Tech Mentor Studio

> **本地代码内化与 AI 技术导师工作台（Local-First AI Code Digest & Mentor Workbench）**  
> 一键巡检本地所有 Git 仓库，可视化对比最新代码提交与未暂存 Diff，一键呼叫专属技术导师深度剖析架构意图、核心代码与防御暗桩。

---

## 🌟 核心特色

1. **多仓库聚合看板**：
   - 自动扫描并监控 `~/Desktop`、`~/Developer`、`~/Github` 及自定义目录下的所有本地 Git 仓库；
   - 实时感知分支、未提交变动（Dirty Badge）与最新提交动态。
2. **可视化 Diff 对比查看**：
   - 无需在黑底终端里翻滚长篇字符 diff；
   - 支持实时查看“未提交改动 (Working Tree)”与任意历史 Commit，语法高亮，清晰直观。
3. **一键导师带读 (Tech Mentor Engine)**：
   - `[🏛️ 四阶全景带读]`：意图权衡 ➔ 心智模型 (Mermaid 流程图) ➔ 核心代码实相 ➔ 暗坑防御。
   - `[🔬 核心代码实相]`：萃取本次改动最灵魂的 15~30 行代码并做逐行机制解剖。
   - `[⚠️ 生产暗桩挖掘]`：专项排查平台兼容（ExFAT/macOS/Windows）、并发竞态与未处理异常。
   - `[💡 苏格拉底考题]`：生成 1~2 道实战推演题反向考查你，促成认知内化。
   - 自由追问对话框：对当前选中的代码改动随时提问。
4. **极速本地流式传输**：
   - 直连本地 `CLIProxyAPI`（8317 端口），支持 Claude Sonnet 4.6 (Thinking) 与 Gemini 3.1 Flash，打字机实时呈现富文本与流程图。

---

## 🚀 极速启动

在项目目录下执行：
```bash
./start.sh
```
或者手动运行：
```bash
npm start
```
服务将在本地启动并自动打开浏览器：`http://localhost:3300`。

## 本地代理配置

需要 Node.js 22+。认证从 `PROXY_KEY` 环境变量或未提交的 `data/proxy-key` 读取；本地文件应使用权限 600，缺少认证时界面明确提示配置失败。不要把真实凭据提交到 Git。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `PROXY_URL` | `http://127.0.0.1:8317/v1/chat/completions` | 分析接口 |
| `MODELS_URL` | 由分析地址推导 `/v1/models` | 模型列表 |
| `KEEPER_DB_PATH` | `/opt/homebrew/var/cpa-usage-keeper/app.db` | SQLite 只读计量 |
| `MODELS_TIMEOUT_MS` | 5000 | 模型列表超时 |
| `ANALYSIS_TIMEOUT_MS` | 180000 | 分析总超时 |
| `SCAN_ROOTS_JSON` | 本地常用开发目录 | 绝对路径数组 |

Keeper 每个窗口显示最新观测值，过期后显示等待更新；今日统计使用 UTC 日期。计量不可用不代表代理可用，模型连接状态单独显示。
