---
name: note-offload
description: >-
  Use when the user asks to enable offload/brief-note mode (落盘模式), keep chat
  replies to a single pointer line with full details saved under ~/agy-notes/,
  resume a previous conversation concisely via agysum instead of reading the
  full transcript, or manage remote host aliases via neturl and net-map.tsv.
---

# 落盘模式（`note-offload`）

用于需要产出大段日志、反汇编、对比表、或接续超长历史会话的工程任务。核心原则：**详情全部落盘，聊天正文只做一行指针**。

## 1. 落盘与回复纪律

- **落盘目录**：`~/agy-notes/<当前会话ID前8位>/turn-<序号>.md`（不存在则自动创建）。
- **正文上限**：每轮回复正文仅留 **1 行、120 字以内**，格式：`结论摘要 + 关键返回码/数值 + 文件路径`。
- **完整内容落盘**：表格、命令输出、反汇编片段、对照清单与下一步计划全部用工具写入当轮 `turn-<序号>.md`。
- **分片读取**：回看旧笔记或大日志时，使用 `grep` 定位或 `read_file` 分片读取，禁止整份 `cat` 刷进上下文。
- **单步收窄**：每次聚焦一个函数、接口或子任务，命令大输出优先重定向到落盘目录后再提炼。

## 2. 接续旧会话（使用 `agysum`）

接续历史会话时，**不要**整份读取旧 `transcript.jsonl`，先用摘要脚本提取要点：

```bash
~/.gemini/config/scripts/agysum <会话ID或前缀> --tail 40 --width 120
```

若旧会话已有 `~/agy-notes/<旧会话ID前8位>/` 目录，直接用 `read_file` 读取其最新结论文件即可。

## 3. 远端地址别名化（使用 `neturl`）

涉及线上接口或内网主机时，正文与笔记中只写短别名（如 `https://gw-a/v1/...`），实际地址维护在 `~/.gemini/config/scripts/net-map.tsv`：

```bash
# 查看已有别名
~/.gemini/config/scripts/neturl --list

# 取完整地址用于命令执行
~/.gemini/config/scripts/neturl gw-a /v1/path

# 新增别名映射
~/.gemini/config/scripts/neturl --set gw-c https://api-c.example.com 备注说明
```
