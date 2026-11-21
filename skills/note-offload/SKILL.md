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

## 1. 双向文件通道约定

支持两种目录形态（若用户指定了 `~/agy-notes/<工作台名>/` 则优先使用该目录，否则默认使用 `~/agy-notes/<当前会话ID前8位>/`）：

- **输入文件 `task.md`**：存放长篇背景、目标、待办阶段与约束（可用 `~/.gemini/config/scripts/agynote init <名称>` 创建，用户也可随时编辑 `task.md` 追加下一轮指示）。
- **状态看板 `status.md`**：存放当前进度勾选、最新结论摘要与最新 `turn-N.md` 路径。换模型或新开会话时，只需读取 `task.md` + `status.md` 即可无损接力。
- **阶段详稿 `turn-<序号>.md`**：存放每阶段的完整分析、表格、代码输出与返回码。

## 2. 四条硬执行纪律

1. **阶段即落盘（严禁攒到最后一步才写文件）**：
   - 首轮读取完输入后（不超过 5 步工具调用），必须先用 `write_file` 创建或更新 `status.md` / `turn-1.md` 落好初始锚点；
   - 每推进一个子阶段就立即写入 `turn-N.md` 并同步更新 `status.md`，防止多步任务尾步中断时目录为空。
2. **脚本输出直写文件、终端 `stdout` 仅打摘要**：
   - 自写 Python/Shell 分析脚本必须把详细结果直接写入工作目录或落盘目录文件，终端 `stdout` 仅输出 `<= 20` 行统计数字与文件路径，禁止把大段反汇编、结构块或原始长报文直接打印到终端刷大上下文。
3. **工具链静默 + 聊天框单行指针**：
   - 调用工具的中间步骤**不输出伴随工具调用的进度解说文字**；
   - 每轮收尾在聊天框严格只回复 **1 行、120 字以内**：`结论摘要 + 关键数值/返回码 + status.md/turn-N.md 路径`。
4. **分片读取**：
   - 读取大日志或历史详稿时用 `grep` 定位加 `sed` 或 `read_file` 分片读取，禁止整份 `cat`。

## 3. 配套辅助命令

```bash
# 初始化双向工作台并生成聊天框短句
~/.gemini/config/scripts/agynote init <工作台名> [任务文件|-]
~/.gemini/config/scripts/agynote show <工作台名>

# 接续无笔记的旧会话时，提取末尾要点替代整份读取 transcript.jsonl
~/.gemini/config/scripts/agysum <会话ID或前缀> --tail 40 --width 120

# 远端地址别名查询与追加（真值保存在 ~/.gemini/config/scripts/net-map.tsv）
~/.gemini/config/scripts/neturl --list
~/.gemini/config/scripts/neturl gw-a /v1/path
```
