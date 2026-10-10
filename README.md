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
