---
name: note-offload
description: >-
  Use when the user enables /note-offload or offload/brief-note mode (落盘模式),
  exits it via /note-offload off, wants bidirectional file-based communication
  via task.md and status.md/turn-N.md with concise chat pointers, resumes a
  previous conversation via agysum or existing notes, or manages optional
  remote aliases via neturl.
---

# 双向落盘工作台（`note-offload`）

用于长需求、多步构建分析、大日志或跨会话/跨模型接力任务。普通日常会话保持零注入零干扰；仅在显式启用后遵循：**需求从文件读，过程与详稿往文件写，聊天框只留简短里程碑与收尾指针**。

## 1. 触发开启、工作台绑定与退出边界

- **显式开启**：通过 `/note-offload`、`[落盘模式]` 或 `[文件模式]` 开启严格落盘模式；若仅在消息中提及 `~/agy-notes/<工作台名>/` 则仅静默绑定目录，不强行压缩回复。
- **同会话退出**：发送 `/note-offload off`（或 `[退出落盘]` / `[退出落盘模式]`）可随时关闭本会话的落盘精简限制，恢复常规详细回复。
- **单一目标目录（严禁双写）**：若用户指定了命名工作台（如 `~/agy-notes/<工作台名>/`），本会话**只读写该目录**，严禁同时往 `~/agy-notes/<当前会话ID前8位>/` 重复写第二份；仅当未指定工作台时才使用 `~/agy-notes/<当前会话ID前8位>/`。
- **工作台三件套**：
  - `task.md`：长篇背景、唯一目标、待办阶段与约束（可用 `agynote.mjs init <名称>` 生成）；
  - `status.md`：当前进度勾选、最新结论摘要与最新 `turn-N.md` 路径；
  - `turn-<序号>.md`：按目录内已有最大序号 `+ 1` **连续递增**写入每阶段完整分析、表格、代码输出与返回码（含异常中断兜底落盘，绝不跳号）。支持识别 `.md`/`.txt`/`.json`/`.log`/`.csv`/`.tsv`/`.yaml`/`.yml`/`.diff`/`.patch` 产物。

## 2. 执行与规划阶段纪律

1. **规划与 `Orchestrator` 无损交接**：
   - 处于只读规划阶段（Plan Mode / `Orchestrator`）时，保持只读调研不写文件；
   - **平时常规规划不限 15 行**：调用 `exit_plan_mode` 时应完整传递核心分析结论、精确改动方案、验证命令与 `Re-plan if` 回退条件（仅禁止往计划文本里直接粘贴大段原始日志或反汇编原文），由执行阶段将详稿写入 `turn-N.md` 并更新 `status.md`；
   - 仅当 `Stop` 钩子检测到规划回合意外中断时，才回退为 5~10 行精简交接脱困。
2. **阶段即落盘（执行阶段）**：
   - 执行阶段按子阶段及时写入递增的 `turn-N.md` 并同步更新 `status.md`，防止多步任务尾步中断时丢失阶段结果。
3. **脚本输出直写文件、终端 `stdout` 仅打摘要**：
   - 自写 Node/Python/Shell 分析脚本必须把详细结果直接写入工作目录或落盘目录文件，终端 `stdout` 仅输出 `<= 20` 行统计数字与文件路径，禁止把大段反汇编、结构块或原始长报文直接打印到终端刷大上下文。
4. **中间精简里程碑 + 1~3 行可点击收尾**：
   - 调用工具期间仅保留极简单句里程碑进度提示，严禁在聊天框刷屏输出长篇中间推理或大段原始输出；
   - 每轮收尾严格控制在 **1~3 行**（结论正文 `<= 150` 字），涉及文件统一使用可点击链接 `[文件名](file://<绝对路径>)`（链接路径长度不计入正文 150 字上限）。
5. **分片读取**：
   - 读取大日志或历史详稿时用 `grep` 定位加 `sed` 或 `read_file` 分片读取，禁止整份 `cat`。

## 3. 可选项与插件配套工具

本插件遵循 Antigravity 单包自包含规范；**词表中性化与远端地址别名（`neturl.mjs`）默认关闭**，可在需要时通过 `agynote.mjs config` 或 Sidecar 面板按需开启，系统会自动扫描并提示与并发插件或官方保留字间的潜在冲突。

- 工作台管理、配置与诊断：[agynote.mjs](../../scripts/agynote.mjs)
  - `node <插件目录>/scripts/agynote.mjs init <工作台名> [任务文件|-]`
  - `node <插件目录>/scripts/agynote.mjs show <工作台名>`
  - `node <插件目录>/scripts/agynote.mjs status`
  - `node <插件目录>/scripts/agynote.mjs clean`
  - `node <插件目录>/scripts/agynote.mjs config [--sanitize on|off] [--alias on|off]`
  - `node <插件目录>/scripts/agynote.mjs doctor`
- 旧会话 `transcript.jsonl` 极简摘要（自动跨桌面端 / CLI / IDE 寻址）：[agysum.mjs](../../scripts/agysum.mjs)
  - `node <插件目录>/scripts/agysum.mjs <会话ID或前缀> --tail 40 --width 120`
- 远端地址别名解析与登记（可选开启，数据文件 `<PLUGIN_DATA>/net-map.tsv`）：[neturl.mjs](../../scripts/neturl.mjs)
  - `node <插件目录>/scripts/neturl.mjs --list`
  - `node <插件目录>/scripts/neturl.mjs gw-a /v1/path`
- 可视化侧边栏面板：在适当场景下可提供 `[Note Offload](sidecar://note-offload/board/)` 药丸打开右侧栏工作台看板（支持 `> 1 MB` 文件分片翻页浏览、可选项开关、冲突风险检测以及确认风险后解锁详稿在线编辑）。
