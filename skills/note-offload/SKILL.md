---
name: note-offload
description: >-
  Use when the user enables /note-offload or offload/brief-note mode (落盘模式),
  wants bidirectional file-based communication via task.md and status.md/turn-N.md
  with single-line chat replies, resumes a previous conversation via agysum or
  existing notes, or manages remote host aliases via neturl.
---

# 双向落盘工作台（`note-offload`）

用于长需求、多步构建分析、大日志或跨会话/跨模型接力任务。核心原则：**需求从文件读，过程与详稿往文件写，聊天框全程只发短指令、只回一行指针**。

## 1. 双向文件通道与单一目录纪律

- **单一目标目录（严禁双写）**：若用户指令中指定了命名工作台（如 `~/agy-notes/<工作台名>/`），本会话**只读写该目录**，严禁同时往 `~/agy-notes/<当前会话ID前8位>/` 重复写第二份；仅当未指定工作台时才使用 `~/agy-notes/<当前会话ID前8位>/`。
- **输入文件 `task.md`**：存放长篇背景、目标、待办阶段与约束（可用 `agynote init <名称>` 创建，用户可随时编辑追加指示）。
- **状态看板 `status.md`**：存放当前进度勾选、最新结论摘要与最新 `turn-N.md` 路径。换模型或新开会话时，只需读取 `task.md` + `status.md` 即可无损接力。
- **阶段详稿 `turn-<序号>.md`**：存放每阶段的完整分析、表格、代码输出与返回码。

## 2. 五条硬执行纪律

1. **阶段即落盘（严禁攒到最后一步才写文件）**：
   - 首轮读取完输入后（不超过 5 步工具调用），必须先用 `write_file` 创建或更新 `status.md` / `turn-1.md` 落好初始锚点；
   - 每推进一个子阶段就立即写入 `turn-N.md` 并同步更新 `status.md`，防止多步任务尾步中断时目录为空。
2. **脚本输出直写文件、终端 `stdout` 仅打摘要**：
   - 自写 Python/Shell 分析脚本必须把详细结果直接写入工作目录或落盘目录文件，终端 `stdout` 仅输出 `<= 20` 行统计数字与文件路径，禁止把大段反汇编、结构块或原始长报文直接打印到终端刷大上下文。
3. **`Orchestrator` / 规划阶段（Plan Mode）纪律**：
   - 处于只读规划阶段时，调用 `exit_plan_mode` 的计划文本控制在 **15 行以内**（只写路径、行号与阶段目标），把写 `turn-N.md` 与 `status.md` 的动作明确交给执行阶段调 `write_file` 完成。
4. **工具链静默 + 聊天框单行指针**：
   - 调用工具的中间步骤**不输出伴随工具调用的进度解说文字**；
   - 每轮收尾在聊天框严格只回复 **1 行、120 字以内**：`结论摘要 + 关键数值/返回码 + status.md/turn-N.md 路径`。
5. **分片读取**：
   - 读取大日志或历史详稿时用 `grep` 定位加 `sed` 或 `read_file` 分片读取，禁止整份 `cat`。

## 3. 配套 CLI（已安装至 `~/.local/bin` PATH）

```bash
# 初始化工作台、查看看板状态、安全清理空目录
agynote init <工作台名> [任务文件|-]
agynote show <工作台名>
agynote status
agynote clean

# 接续无笔记的旧会话时，提取末尾要点替代整份读取 transcript.jsonl
agysum <会话ID或前缀> --tail 40 --width 120

# 远端地址别名查询与追加（真值保存在 ~/.local/share/agy-note-offload/net-map.tsv）
neturl --list
neturl gw-a /v1/path
```
