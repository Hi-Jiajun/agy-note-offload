# agy-note-offload

面向 **Google Antigravity** 的原生插件（**Note Offload**）：集成了**双向文件工作台（`task.md` / `status.md` / `turn-N.md`）**、**无痕 2 档续跑与 `Plan Mode` 分流 Hook**、**上下文锁定熔断**、以及**断点防空转卡片**。

## 核心能力

- **原生插件形态**：标准 `plugin.json` + `hooks.json` + `skills/note-offload/` + `sidecars/board/`，放进 `~/.gemini/config/plugins/note-offload/` 即被 Antigravity 自动发现，支持在扩展侧边栏与插件页一键使用及启停。
- **可视化侧边栏面板（`扩展 > Note Offload`）**：内置零外部依赖 Sidecar Web UI，可直接在右侧栏浏览工作台健康度、在线编辑保存 `task.md`/`status.md`、一键复制启动词/新开接力会话、管理脱敏别名表以及手动解除熔断。
- **双向文件交流（`agynote`）**：长篇需求放进 `task.md`，阶段进展同步更新 `status.md` 与 `turn-N.md`；聊天框全程只发 1 句短指令、只回 1 行指针，换模型或开新会话直接读看板无损接力。
- **自动工作台绑定与惰性目录**：自动从指令中识别 `~/agy-notes/<工作台名>/` 绑定到当前会话，消除与 `<conv8>` 的双写分裂；普通对话不再提前创建空目录，配合 `agynote clean` 一键清理历史空文件夹。
- **`Plan Mode` / `Orchestrator` 专用分流**：检测到处于只读规划阶段（禁用 `write_file`）时，自动引导 `exit_plan_mode` 传 5 行内纯路径计划交给执行模型，避免死锁。
- **升级防空转 + 数据目录隔离**：熔断后拦下“继续”等短催促以及原样重复重发的新消息（直接省配额，放行 `/compact`）；个人 `net-map.tsv`、状态与日志隔离存放在 `~/.local/share/agy-note-offload/`，不污染插件仓库。

## 插件结构

```text
note-offload/
├── plugin.json                        # Antigravity 原生插件清单
├── hooks.json                         # 插件相对路径生命周期注册
├── assets/logo.svg                    # 插件图标
├── install.sh                         # 一键安装为原生插件 + 平滑迁移旧配置 + CLI 软链
├── uninstall.sh                       # 干净卸载（保留 ~/.local/share/agy-note-offload 与 ~/agy-notes）
├── sidecars/
│   └── board/                         # 右侧栏 Aux Pane Sidecar Web UI（零第三方依赖）
│       ├── sidecar.json               # 声明 SIDECAR_UI_ENTRYPOINT_AUX_PANE
│       ├── package.json
│       ├── main.mjs
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── scripts/
│   ├── hooklib.py                     # DATA_DIR 隔离、工作台提取绑定、惰性目录与状态管理
│   ├── sanitize.py                    # 集中脱敏与拉丁词残留校验
│   ├── provider-filter-guardrail.py   # SessionStart hook（惰性提示 + 清旧态）
│   ├── provider-filter-retry.py       # Stop hook（2 档续跑 + Plan Mode 分流 + 撤回识别）
│   ├── provider-filter-notice.py      # PreInvocation hook（绑定 + 错峰补注 + 重复/催促防空转）
│   ├── agynote                        # 双向工作台管理与会话健康看板（init/show/status/clean）
│   ├── agysum                         # 旧会话 transcript.jsonl 极简要点摘要工具
│   ├── neturl                         # 远端地址别名解析与登记工具
│   ├── net-map.tsv.example            # 脱敏示例别名表
│   ├── file-mode-prompt.md            # 手动备用短句参考
│   └── selftest.sh                    # 隔离 DATA_DIR 全自动自检套件
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

`install.sh` 会自动完成：
1. 安装至 `~/.gemini/config/plugins/note-offload/`；
2. 将个人 `net-map.tsv`、状态文件与日志隔离存放（并平滑迁移旧散装配置）；
3. 清理旧 `~/.gemini/config/hooks.json` 与 `~/.gemini/config/skills/note-offload/` 防双倍触发；
4. 将 `agynote`、`agysum`、`neturl` 软链到 `~/.local/bin/`（并保留旧路径兼容软链），随后运行 `selftest.sh`。

卸载（保留个人 `net-map.tsv` 与 `~/agy-notes/` 笔记）：

```bash
bash uninstall.sh
```

## 日常用法

```bash
# 1. 初始化双向工作台（支持从文件或标准输入导入任务说明）
agynote init my-task ./spec.md

# 2. 在聊天框只需发一行短句
# /note-offload 读取 ~/agy-notes/my-task/task.md 与 status.md，执行下一未完成阶段并落盘汇报。

# 3. 随时查看所有工作台与绑定会话的健康状态（OK / RETRY / DEAD）
agynote status
agynote show my-task
agynote clean        # 清理 0 文件空目录

# 4. 摘要旧会话或管理远端地址别名
agysum <会话ID或前缀> --tail 40 --width 120
neturl --list
neturl --set gw-c https://api-c.example.com 示例服务
```

### 环境变量

- `AGY_NOTE_ROOT`：覆盖落盘工作台根目录（默认为 `~/agy-notes`），Hooks、`agynote` 与 Sidecar 统一读写该目录。
- `AGY_OFFLOAD_DATA_DIR`：覆盖运行时状态、调用日志与 `net-map.tsv` 的数据目录（默认为 `~/.local/share/agy-note-offload`）。

## 与其他 Plugin / Skill / MCP 的兼容性

- **`agy-powertools`**：同事件 Hook 按序合并执行，前者 `PreInvocation` 仅做只读遥测并返回 `{}`，与本插件完全互补；同时本插件可与会话分支功能搭配使用。
- **`swarm` / `run_workflow` / `subagents`**：状态按 `conversationId` 隔离，并发子会话互不干扰。
- **总控与文档类 Skill / MCP Servers**：不挂载 `PreToolUse` / `PostToolUse`，不阻断任何 MCP 工具调用；`agynote status` 与 `agysum` 可直接辅助总控巡检与接力调度。

## License

[MIT](./LICENSE)
