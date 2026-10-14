交付状态: COMMITTED_AND_PUSHED

# Tech Mentor Studio 审查修复报告

分析日期：2026-10-13（America/New_York）。代码基线：`6da058a`；验证的实现版本：`274fa8d`。报告使用通用审查结构（flavor = null）。

## 结果与范围

审查发现的 13 项问题已逐项修复，另外完成版本一致的分析快照、历史预算、真实源码证据、扫描与渲染性能、模块拆分、本地资源构建和窄屏体验。42 项 Node 回归和 6 项 Chromium 回归通过，语法/构建检查通过，依赖审计为 0 漏洞。实际代理返回 27 个模型，Keeper 两个窗口均有最新记录；这些结果来自真实只读接口，模型回答行为来自测试替身。

稳定服务位于 <http://127.0.0.1:3300>，后端指纹与工作区代码一致，默认扫描根限制为当前项目；临时 3301 服务已停止。没有修改 CPA、Keeper 或对话依赖服务。授权和边界见 [审查范围](audit-scope.md)，分阶段设计与完成记录见 [修复计划](repair-plan.md)。

## 逐项发现与修复

以下 F-001 至 F-013 的 `status=validated`、`confidence=high`；每项同时引用源码审查 E-001 和行为回归 E-002 / E-003。表中的修复位置也是整改路径，验证列给出独立复现的测试文件。`npm test` 运行全部 Node 用例，浏览器用例按 README 的独立端口方式运行。

| Finding / 等级 / 类别 | 触发与影响 | 修复位置与结果 | evidence_ids / 复现 |
| --- | --- | --- | --- |
| F-001 / medium / design | 后端 done 与 finished 都触发前端收尾，回答与追问按钮重复 | `lib/stream.js:42` 单次终止事件；`public/app.js` 按请求只保存一次 | E-001、E-002、E-003；`test/lifecycle.test.js`、`test/e2e/security.spec.js` |
| F-002 / medium / design | 切仓库、目标或清空会话后，旧请求覆盖新内容和历史 | `public/app.js:946` 会话版本、请求序号、取消与响应归属检查 | E-001、E-002、E-003；`test/lifecycle.test.js`、`test/e2e/workflow.spec.js` |
| F-003 / medium / design | 旧 finally 清空新控制器，停止按钮失效；上游继续生成 | `lib/stream.js:71` 断连/超时取消；前端只清理自己拥有的控制器 | E-001、E-002、E-003；`test/http.test.js`、`test/lifecycle.test.js`、停止生成浏览器用例 |
| F-004 / high / vuln | Markdown HTML、特殊文件名与 Mermaid 可进入执行上下文 | `public/app.js:39` DOMPurify；数据属性事件委托；Mermaid strict；CSP 与本地固定资源 | E-001、E-002、E-003；`test/e2e/security.spec.js` 验证恶意属性、字面文件名、图表与无外部资源请求 |
| F-005 / high / vuln | 任意来源访问本机 API，伪造 repoId 解码为任意路径 | `lib/security.js:13` 校验 Host/Origin/Fetch Metadata 和本机会话；仓库只从登记表解析 | E-001、E-002、E-003；`test/security.test.js`、真实 API 浏览器安全用例 |
| F-006 / high / vuln | 未跟踪符号链接和事实文件可读到仓库外目标 | `lib/security.js:95` 逐段校验并拒绝链接；历史 blob 校验普通文件模式；Diff 排除 index 中的链接模式 | E-001、E-002；`test/security.test.js`、`test/git.test.js`、`test/mentor.test.js` |
| F-007 / high / design | start.sh 对占用端口的任意进程 kill -9 | `scripts/start.js:23` 核对 cwd、服务身份与代码指纹，同版本复用，其他/旧服务保留并报错 | E-001、E-002、E-005；`test/start.test.js` 覆盖无关服务、旧版本和当前版本 |
| F-008 / medium / design | 新目录、中文及换行等特殊文件名漏读或拆分错误 | `lib/git.js` 参数数组与 NUL 状态；`lib/diff.js` Git C 引号/UTF-8 路径处理 | E-001、E-002、E-003；`test/git.test.js` 的目录、特殊路径及 rename 用例 |
| F-009 / medium / design | 没有 HEAD 的仓库返回 500；预设引用不存在的祖先 | `lib/git.js:27` 明确处理 unborn HEAD；预设必须成功解析，引用先固定到 SHA | E-001、E-002；`test/git.test.js`、`test/http.test.js` |
| F-010 / medium / design | 首个大文件耗尽预算，后续代码缺失；部分 Git stdout 被视为成功 | `lib/diff.js:87` 分配文件预算并明确截断；`runGit` 对超时和 8 MiB 超限显式失败 | E-001、E-002；`test/git.test.js` 的大文件预算与超限用例 |
| F-011 / medium / design | hunk 内 +++ / --- 被当作文件头，计数与行号错误 | `lib/diff.js:35` 和前端按 hunk 剩余行数解析内容；分页仍维护原行号 | E-001、E-002、E-003；`test/git.test.js`、Diff 渲染与大 Diff 浏览器用例 |
| F-012 / medium / design | 全局 LIMIT 2 选到同窗口两条记录，遗漏另一窗口；过期额度误报为 100% | `lib/keeper.js:28` 按账号、quota_key、窗口选择最新观测；保留小数、clamp、UTC 和未知/过期状态 | E-001、E-002、E-005；`test/keeper.test.js` 的独立 SQLite 多窗口 fixture |
| F-013 / medium / design | Keeper 失败显示代理就绪；模型失败返回假预设；错误流加载不结束 | 独立计量/模型状态，失败原因可见，重试后恢复；失败/未完成回答不进入历史 | E-001、E-002、E-003、E-005；`test/keeper.test.js`、`test/lifecycle.test.js`、模型恢复浏览器用例 |

## 进一步优化

- `lib/mentor.js` 保存最多 24 份、有效期 30 分钟的固定快照；追问不重新读取变化中的工作区。历史仅允许 user/assistant，按完整轮次保留最近 24k 字符。
- `lib/facts.js` 按所选 Git 版本提取文档、相关目录 AGENTS 和带真实行号的源码片段，标明截断与排除；系统提示明确区分证据数据和规则，并要求区分事实与推断。
- 流式 Markdown 以 80ms 节流，收尾完整刷新；Diff 每页 2000 行，复制保持全文。扫描使用有限并发、5 秒缓存和请求合并，界面显式刷新可跳过缓存。
- 前端本地构建固定版本资源；模型偏好、选择高亮、刷新顺序与窄屏视图切换得到修正。后端拆分 Git、Diff、安全、事实、快照、SSE、配置、Keeper 和运行识别模块。
- 代理认证迁出源码至忽略的本地文件，权限 600；已配置认证在历史 Diff 和模型证据中脱敏。模型的空回答、达到输出限制和未完整终止都会作为失败处理。

## Evidence

### E-001 源码与修复提交

- title: 基线人工审查与修复源码
- observed_at: 2026-10-13
- source_type: manual
- source_ref: Git 基线 `6da058a` 与下列六个实现提交；F 表中的源码位置
- content_hash: n/a（源引用由 Git 提交固定）
- artifact_path: n/a
- repro_command: `git log --oneline --reverse 6da058a..274fa8d`，并结合 F 表查看对应源码和测试断言
- raw_excerpt: 单次终止、已登记仓库、净化渲染、普通 blob、窗口分组、固定快照与服务指纹均可直接在对应模块定位
- linked_workitem: n/a（本报告 F-001 至 F-013 为逐项跟踪）
- supersedes: none

### E-002 Node 回归

- title: Node 回归
- observed_at: 2026-10-13
- source_type: command
- source_ref: `npm test`
- content_hash: `c9dc4b8818a92876c8e30bced96e9f3039f7b6f91cca6376936180b4028be72b`
- artifact_path: [verification/node-tests.tap](verification/node-tests.tap)
- repro_command: `npm test`（浏览器先按 README 启动服务；实际依赖证据需本地已有代理和 Keeper）
- raw_excerpt: 42 项通过、0 失败
- linked_workitem: n/a（关联项见 F 表）
- supersedes: none

### E-003 Chromium 回归

- title: Chromium 回归
- observed_at: 2026-10-13
- source_type: command
- source_ref: `MENTOR_TEST_URL=http://127.0.0.1:3300 npm run test:browser`
- content_hash: `3dc9d0a6b3d8e71bc46612d945d6a311a64e8f4d22cb9f1b3e397c2516f85c8a`
- artifact_path: [verification/browser-results.json](verification/browser-results.json)
- repro_command: `MENTOR_TEST_URL=http://127.0.0.1:3300 npm run test:browser`（浏览器先按 README 启动服务；实际依赖证据需本地已有代理和 Keeper）
- raw_excerpt: 6 项通过，覆盖安全、失败恢复、窄屏、多轮、复制导出、大 Diff 与停止
- linked_workitem: n/a（关联项见 F 表）
- supersedes: none

### E-004 依赖审计

- title: 依赖审计
- observed_at: 2026-10-13
- source_type: command
- source_ref: `npm audit --json`
- content_hash: `866a9ccb1b01a3c345f69dbaa5b300d592630e6b11b9b66d3e0c1692631f53fa`
- artifact_path: [verification/dependencies.json](verification/dependencies.json)
- repro_command: `npm audit --json`（浏览器先按 README 启动服务；实际依赖证据需本地已有代理和 Keeper）
- raw_excerpt: 所有严重等级均为 0
- linked_workitem: n/a（关联项见 F 表）
- supersedes: none

### E-005 真实运行与依赖

- title: 真实运行与依赖
- observed_at: 2026-10-13
- source_type: command
- source_ref: `NO_BROWSER=1 PORT=3300 ./start.sh`
- content_hash: `2fd3b161581e956b6ab8e57cf9c22375dfab82c09f9315093a72352fbc193235`
- artifact_path: [verification/runtime.json](verification/runtime.json)
- repro_command: `NO_BROWSER=1 PORT=3300 ./start.sh`，随后运行附录的真实接口复查代码；需已有本地代理和 Keeper
- raw_excerpt: 当前项目/版本复用，健康、模型、Keeper 与仓库接口均为 200
- linked_workitem: n/a（关联项见 F 表）
- supersedes: none

## Path

### P-001 固定分析与多轮回答

- path_type: callflow
- start: 用户选择仓库、目标与文件，并提交分析
- goal: 回答只使用固定、版本一致的证据，旧请求不会影响新会话
- steps:
  1. `RepositoryRegistry` 解析已登记仓库，Git 目标固定到 SHA；E-001、E-002，F-005/F-009。
  2. 安全读取文档/源码并生成固定快照，追问复用快照；E-001、E-002，F-006/F-010。
  3. 带取消信号调用代理，SSE 只发送一次完整终止；E-001、E-002，F-001/F-003/F-013。
  4. 前端校验会话归属，净化 Markdown，再处理高亮/图表和保存历史；E-001、E-002、E-003，F-002/F-004。
- residual_risks: 模型正确性需人工判断；证据有预算和期限限制，不能声称覆盖未展示代码。

### P-002 本机请求与安全启动

- path_type: callflow
- start: 本机启动脚本或外部来源尝试访问 API
- goal: 保留无关服务，限制跨来源访问及任意路径读取
- steps:
  1. 启动器检查监听进程 cwd、身份和后端指纹；E-001、E-002、E-005，F-007。
  2. 已验证的本项目版本直接复用，其他占用者报错并继续运行；E-002、E-005，F-007。
  3. 请求先经过 Host/Origin/Fetch Metadata 与会话校验，随后登记表与文件读取限制生效；E-001、E-002、E-003，F-005/F-006。
- residual_risks: 本机会话不是多用户登录或操作系统权限隔离，不用于公网部署。

### P-003 配额与依赖状态

- path_type: callflow
- start: 界面读取计量和模型列表
- goal: 失败可见，窗口数据不重复、不推测恢复额度
- steps:
  1. SQLite 使用参数数组和 readonly/json 查询，按账号/窗口选最新记录；E-001、E-002、E-005，F-012。
  2. 过期或无效 reset 状态返回未知，UI 显示等待更新；E-001、E-002，F-012。
  3. 模型列表失败返回明确错误，界面禁用分析，重试成功后恢复；E-001、E-002、E-003、E-005，F-013。
- residual_risks: 配额是最近观测值，并非实时保证；Keeper 不可用与代理不可用需要分别诊断。

## Timeline 与提交

| 顺序 | 提交 | 交付内容 |
| --- | --- | --- |
| 1 | `5e6fd34` | 请求生命周期与单次终止 |
| 2 | `ebea1e5` | 本地访问、安全读取、净化与本地资源 |
| 3 | `7befcdb` | Git/Diff 路径、引用与 HTTP 回归 |
| 4 | `8ba7a42` | 真实配额、模型状态与本地配置 |
| 5 | `406daed` | 固定快照、历史预算、版本证据 |
| 6 | `274fa8d` | 渲染、窄屏、安全启动与最终功能验证 |

六个实现提交均已推送 `origin/main`。本报告和验证证据作为独立文档提交归档，可使用 `git log -1 --oneline` 查看最终归档提交。

## 验证边界与保留事项

- 42 项 Node 和 6 项 Chromium 检查验证具体行为，真实只读接口验证本机依赖可用。未发起真实模型推理请求，因此没有宣称生产模型完整回答质量已实测。
- 原 Git 历史包含曾经硬编码的认证声明；应用内的已配置值已脱敏，原历史没有重写，认证没有轮换。若需要从共享历史中彻底清除或轮换，需要单独执行仓库/代理维护。
- 文件名及已配置凭据的排除不是任意源码中的通用秘密识别器。工作区变化检测也不是文件系统事务；本机拥有写权限的进程仍可能竞争修改文件。
- Git 超时/超限、被排除文件、截断证据和快照过期均显式告知。浏览器会话记录不落盘，刷新页面或重启服务需要重新分析。
- 最终只保留本次创建的 3300 项目服务；验证用 3301 进程已退出，原 CPA 服务未重启。

## 附录与检查清单

在项目根目录复查实际接口（仅输出状态、模型数量和窗口状态，不输出本机会话令牌或用量明细）：

```bash
node --input-type=module <<'JS'
const base = 'http://127.0.0.1:3300';
const { token } = await (await fetch(base + '/api/session')).json();
for (const endpoint of ['/api/health', '/api/models', '/api/tokens/keeper-stats', '/api/repos']) {
  const response = await fetch(base + endpoint, { headers: { 'X-Local-Token': token } });
  const data = await response.json();
  console.log(JSON.stringify({ endpoint, status: response.status, success: data.success,
    modelCount: data.models?.length, repoCount: data.repos?.length,
    windows: data.rateLimits?.map(r => ({ label: r.label, state: r.state })), error: data.error }));
}
JS
```


验证环境：Node.js 22.22.0、npm 10.9.4、Git 2.50.1、SQLite 3.51.0、Playwright 1.64.0 / Chromium。完整复现命令及前置条件见 [README](../README.md)。

- [x] 授权与项目边界明确，保留原用户数据和无关服务。
- [x] 人工检查可达性与实际影响，未把扫描器提示直接当成漏洞。
- [x] 13 项 Finding 引用源码和行为 Evidence，并有可复现测试。
- [x] Evidence 记录脱敏，归档文件提供 SHA-256；Path 与修复位置可追踪。
- [x] 实际依赖与模拟模型测试分别说明，保留事项明确。
- [x] 使用通用报告结构，无恶意软件/APT 专属内容或厂商原文。
