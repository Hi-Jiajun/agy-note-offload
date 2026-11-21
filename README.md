# agy-note-offload

一套面向 **Google Antigravity** 的「**轻重构 Hook（被动兜底） + 薄 Skill（主动接续）**」混合套件：在底层系统移植、驱动调试、大日志分析等高频长输出场景下，用 **落盘模式（`note-offload`）** 与 **无痕 2 档熔断 Hook** 稳定化解上游内容校验误拦、上下文锁死与空转消耗。

## 核心设计理念

- **平时零干扰**：`SessionStart` 只预建本会话落盘目录 `~/agy-notes/<conv8>/`，不强行限制日常回答字数，也不注入任何“内容校验/被替换”元描述。
- **被动兜底留给 Hook（0 额外轮次）**：一旦触发 `blocked by Gemini` 替换，由 `Stop` Hook 直接下发纯任务态无痕指令，不依赖模型在临界态再去读 Skill。
- **主动接续与工具链交给 `note-offload` Skill**：把落盘纪律、旧会话摘要（`agysum`）与远端地址别名（`neturl` + `net-map.tsv`）封装为按需加载的 Skill，新会话一句话即可接续。

## 架构一览

```text
SessionStart  ──▶ provider-filter-guardrail.py
                    预建 ~/agy-notes/<conv8>/，约定大块产物优先落盘

Stop          ──▶ provider-filter-retry.py
                    ├─ 短回答 + 小上下文 (<120k) 首拦  ──▶ 1 档 [重写]（无痕简述）
                    ├─ 长回答 (>=800 out) / 大上下文 (>=120k input+cache) / 二拦
                    │                                   ──▶ 2 档 [落盘]（写 turn-N.md，正文留 1 行）
                    └─ 超 2 档 或 连续 2 次零输出预检拦截 ──▶ 立即停机标 dead（context_locked / max_retry）

PreInvocation ──▶ provider-filter-notice.py
                    ├─ 切入落盘模式后：仅补注 1 次精简持续规则（分片读 + neturl 别名）
                    └─ 已熔断 (dead)：
                         ├─ 极短催促词（「继续」「continue」等）──▶ terminate 拦下空转 + 弹断点就绪卡片
                         └─ 具体新指令                          ──▶ 仅弹 1 次断点就绪卡片（user_markdown，零模型污染）并放行

Skill         ──▶ skills/note-offload/SKILL.md
                    主动开启落盘模式、用 agysum 低噪接续旧会话、用 neturl 管理 net-map.tsv 别名
```

## 目录结构

```text
agy-note-offload/
├── install.sh                         # 一键安装（合并写入 ~/.gemini/config/hooks.json）
├── uninstall.sh                       # 干净卸载（保留其他 hook、net-map.tsv 与 ~/agy-notes/）
├── hooks.json.example                 # Hook 注册参考配置
├── scripts/
│   ├── hooklib.py                     # 自轮转日志、7 天 TTL 状态、~/agy-notes/ 目录与最新笔记定位
│   ├── sanitize.py                    # 集中脱敏与拉丁词残留自检闸门
│   ├── provider-filter-guardrail.py   # SessionStart hook
│   ├── provider-filter-retry.py       # Stop hook
│   ├── provider-filter-notice.py      # PreInvocation hook
│   ├── agynote                        # 双向文件工作台管理（task.md ↔ status.md / turn-N.md）
│   ├── agysum                         # 旧会话 transcript.jsonl 极简要点摘要工具
│   ├── neturl                         # 远端地址别名查询 / 追加工具
│   ├── net-map.tsv.example            # 脱敏示例别名表（本机真实表放在 ~/.gemini/config/scripts/net-map.tsv）
│   ├── file-mode-prompt.md            # 手动落盘模式备用首句模板
│   └── selftest.sh                    # 33 项端到端自动化自检
└── skills/
    └── note-offload/
        └── SKILL.md                   # 全局 note-offload Skill
```

## 快速安装与卸载

```bash
git clone https://github.com/Hi-Jiajun/agy-note-offload.git
cd agy-note-offload
bash install.sh
```

`install.sh` 会自动：
1. 将本套件的 3 个 Hook **合并**写入 `~/.gemini/config/hooks.json`（保留你原有的其他 Hook）；
2. 安装脚本至 `~/.gemini/config/scripts/`、安装 Skill 至 `~/.gemini/config/skills/note-offload/`；
3. 首次安装时从 `net-map.tsv.example` 初始化 `net-map.tsv`（已有个人配置则原样保留）；
4. 自动运行 `selftest.sh` 完成 33 项校验。

卸载（保留个人 `net-map.tsv`、其他 Hook 与 `~/agy-notes/` 笔记）：

```bash
bash uninstall.sh
```

## 日常用法（双向文件工作台）

- **1. 初始化双向任务工作台（长需求放文件，聊天框只发短指令）**：
  ```bash
  # 创建 ~/agy-notes/my-task/{task.md,status.md}（可直接管道喂入任务文档）
  ~/.gemini/config/scripts/agynote init my-task ./spec.md
  ```
  随后在聊天框只需发送 1 行短句：
  ```text
  /note-offload 读取 ~/agy-notes/my-task/task.md 与 status.md，执行下一未完成阶段并落盘汇报。
  ```
  模型会在执行过程中直接更新 `status.md` 与 `turn-N.md`（中间工具链静默，脚本大输出直写文件不刷终端），收尾仅回 1 行指针；切换模型、撤回重跑或新开会话时直接读同一目录无损接力。
- **2. 查看工作台进度**：
  ```bash
  ~/.gemini/config/scripts/agynote ls
  ~/.gemini/config/scripts/agynote show my-task
  ```
- **3. 手动摘要旧会话**：
  ```bash
  ~/.gemini/config/scripts/agysum <会话ID或前缀> --tail 40 --width 120
  ```
- **管理远端地址别名**：
  ```bash
  ~/.gemini/config/scripts/neturl --list
  ~/.gemini/config/scripts/neturl --set gw-c https://api-c.example.com 示例服务
  ~/.gemini/config/scripts/neturl gw-c /v1/status
  ```

## 与其他 Plugin / Skill / MCP 的兼容性

| 扩展类型 | 典型示例 | 兼容性 | 说明 |
| --- | --- | --- | --- |
| **Plugin（含 Hook）** | `agy-powertools` | **兼容 / 互补** | Antigravity 会按顺序合并同事件 Hook。`agy-powertools` 的 `PreInvocation` 仅做只读遥测并返回 `{}`，与本套件无冲突；其「分支会话」功能可与 `note-offload` 互补。注：极少数旧版 Antigravity（如 `2.31.0`）若存在 `metadata` map 兼容异常，需留意 `user_markdown` 渲染表现。 |
| **多 Agent / 子代理** | `swarm`、`run_workflow`、`subagents` | **兼容** | 状态文件严格按 `conversationId` 隔离，落盘目录按 `<conv8>` 分开，互不踩踏。熔断防空转只拦极短催促词，不拦带具体内容的 `@mention` 或任务派单。 |
| **全局 / 项目 Skill** | `control-tower`、文档沉淀类 Skill | **兼容 / 强协同** | `agysum` 天然契合总控类 Skill 的“严禁整本通读旧 transcript”约束；与项目内长期 ADR/架构文档 Skill 职责正交（前者临时落盘到 `~/agy-notes/`，后者沉淀在仓库内）。 |
| **MCP Servers** | GitHub、浏览器、搜索、Memory 等 | **完全兼容** | 本套件不挂载 `PreToolUse` / `PostToolUse`，不拦截或改写任何 MCP 工具调用；反而可借助 120k 总上下文判定缓解 MCP 大返回体引发的误拦。 |

## License

[MIT](./LICENSE)
