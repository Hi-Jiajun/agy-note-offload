# agy-note-offload

面向 **Google Antigravity** 的原生插件（**Note Offload** `v2.2.3`）：集成了**按需双向文件工作台（`task.md` / `status.md` / 连续递增 `turn-N.md`）**、**可编辑配置中心与新版双阶段 `Orchestrator` 兼容**、**落盘会话动态阈值自愈续跑与版本感知规则自动刷新**、**百级工作台增量缓存与逻辑/物理归档**、**黑匣子飞行诊断、快路径剪枝与节流钩子心跳**、以及**可视化侧边栏 Aux Pane 面板**。

## 核心能力

- **100% 符合 Antigravity 原生插件规范**：纯净插件包置于 `plugin/`（零警告通过 `agy plugin validate ./plugin --strict`），纯 Node.js ESM 零第三方依赖共享内核（`plugin/lib/*.mjs`），优先兼容官方 `PLUGIN_DATA` 多端数据隔离与无外部软链开箱运行。
- **按需零污染与双向开关**：普通日常会话 `SessionStart` 仅静默清理旧状态，**零注入零干扰**；仅在显式发送 `/note-offload`（或 `[落盘模式]`/`[文件模式]`）时开启落盘纪律，支持随时发送 `/note-offload off`（或 `[退出落盘]`）同会话恢复常规详答。
- **可视化侧边栏面板（`扩展 > Note Offload`）**：基于官方 `sidecar_sdk` 构建 Aux Pane Web UI，内置基于 `mtimeMs` 的百级工作台增量缓存、默认不断历史链接的逻辑归档与一键恢复、单工作台多会话历史展示、全量可编辑设置中心（含一键恢复默认）、任务勾选进度、状态筛选/排序、Markdown 表格与 Diff 富预览、防丢稿保护与黑匣子飞行诊断抽屉。
- **双向文件交流（`agynote.mjs`）**：长篇需求放进 `task.md`，阶段进展同步更新 `status.md` 与按目录已有最大序号 `+ 1` 连续递增的 `turn-N.md`；支持 `archive [--move]` / `unarchive` / `reset` / `status --archived --dead --filter --json` 与完整 `config --reset`；每轮收尾控制在 1~3 行（`<= 150` 字结论正文 + 可点击 `file://` 路径链接），中间工具调用仅保留极简单句里程碑。
- **`Orchestrator` 双阶段全兼容、首启一次性确认与版本感知刷新**：同时识别新版无 `orchestrator` 字样的双阶段模型（`gemini-4-neon-*`/`gemini-4-carbon-*` 规划 + `gemini-4-hydrogen-*` 执行、`exit_plan_mode` 与 `enter_plan_mode`、每轮新用户输入自动回到 Plan Mode）与经典模型；启用确认默认采用**首启一次性（`once`）**，首次确认后全局记住（可随时在配置中心切换 `per_session` / `off` 或恢复默认；`control-tower` 现役总控与换届接班首轮始终坚持严格安全保护）；平时解除 `exit_plan_mode` 15 行限制，规则版本绑定 `plugin.json` 版本号（`<version>#<rev>`），后续发版自动为存量活跃落盘会话刷新规则。
- **收敛范围的 `Stop` 续跑与 `/compact` 解锁**：`Stop` 仅介入已开启落盘或已绑定命名工作台的会话（普通会话绝不被动建目录），所有重试与熔断阈值（`maxRetry` / `retryWindowMin` / `zeroOutLimit` / `longAnswerTokens` / `bigContextTokens`）均可动态配置；熔断后拦下短催促与原样重发，`/compact` 自动解除熔断状态。
- **可选项词表中性化/别名注入与冲突检测**：`sanitize` 与 `neturl` 自动提示**默认关闭**，保留 `JSON`/`IPv4`/`sha256` 等常规工程术语；可通过 `agynote.mjs config` 或 Sidecar 面板按需启用，并配合 `agynote.mjs doctor` 自动扫描与 `control-tower`、MCP 服务名、多插件同事件 Hook 及 `PATH` 同名命令的冲突风险。
- **跨端会话检索（`agysum.mjs`）**：自动跨桌面端（`antigravity`）、CLI（`antigravity-cli`）与 IDE（`antigravity-ide`）三端 `brain/` 目录检索旧会话 `transcript.jsonl`，大日志采用尾部分块快读，默认附带修改文件清单页脚，支持 `--tools`、`--search <kw>`、`--full` 与 `--json`。

## 仓库结构

```text
note-offload/
├── package.json                       # 单一版本源（2.2.3）与五环工程脚本
├── AGENTS.md                          # 工程工作区协作与安全隔离规则
├── CHANGELOG.md                       # 版本变更记录
├── docs/ARCHITECTURE-ROADMAP.md       # L1 架构蓝图与五环自进化路线图
├── install.sh / uninstall.sh          # 本地开发源码安装与卸载包装
├── scripts/                           # 工程门禁与发布脚本（selftest / mine / replay / ui-smoke / skill-eval / doctor / release / build-release）
├── tests/                             # 基于 node --test 的沙箱化 L1/L2 测试套件与真实故障回放夹具
└── plugin/                            # 纯净运行态 Antigravity 原生插件包
    ├── plugin.json                    # Antigravity 原生插件清单
    ├── hooks.json                     # 插件相对路径生命周期注册
    ├── assets/logo.svg                # 插件图标
    ├── lib/                           # 共享 ESM 内核（paths / lock / logger / config / archive / sanitize / aliases / conflicts / workspace / state）
    ├── scripts/                       # 内聚 Hook 与 CLI（hook-*.mjs / agynote.mjs / agysum.mjs / neturl.mjs）
    ├── sidecars/board/                # 官方 sidecar_sdk Aux Pane Web UI（含 ui-logic.mjs 纯逻辑模块）
    └── skills/note-offload/SKILL.md   # 全局 note-offload Skill
```

## 快速安装与卸载

### 方式一：使用 Antigravity 官方 CLI 安装（推荐）

```bash
git clone https://github.com/Hi-Jiajun/agy-note-offload.git
cd agy-note-offload
agy plugin install ./plugin
```

或下载 GitHub Release 中的 `note-offload-v2.2.3.zip` 解压后运行 `agy plugin install <解压目录>`。

### 方式二：使用本地安装器（含旧版本数据迁移与可选 CLI 软链）

```bash
bash install.sh              # 默认单包自包含安装（自动迁移旧数据并清理历史遗留软链）
bash install.sh --link-cli   # 可选：同时在 ~/.local/bin 建立 agynote/agysum/neturl 软链
bash uninstall.sh            # 干净卸载（保留 plugin_data 与 ~/agy-notes/）
```

## 日常用法

```bash
# 1. 初始化双向工作台（支持从文件或标准输入导入任务说明）
node plugin/scripts/agynote.mjs init my-task ./spec.md

# 2. 在聊天框显式开启或退出落盘模式
# /note-offload 读取 ~/agy-notes/my-task/task.md 与 status.md，执行下一未完成阶段并落盘汇报。
# /note-offload off   # 同会话随时恢复常规详细回复

# 3. 查看工作台健康看板、归档恢复、重置会话或调整配置中心
node plugin/scripts/agynote.mjs status --dead --filter my-task --json
node plugin/scripts/agynote.mjs show my-task
node plugin/scripts/agynote.mjs archive my-task           # 默认逻辑归档（不移目录不断链；加 --move 可移入 _archive/）
node plugin/scripts/agynote.mjs unarchive my-task
node plugin/scripts/agynote.mjs reset <会话ID或前缀>
node plugin/scripts/agynote.mjs clean
node plugin/scripts/agynote.mjs config --orch-confirm once --max-retry 2 --retry-window 15
node plugin/scripts/agynote.mjs config --reset            # 一键恢复内置默认配置
node plugin/scripts/agynote.mjs doctor

# 4. 摘要旧会话（尾部分块快读 + 修改文件页脚 + 检索）或管理可选远端地址别名
node plugin/scripts/agysum.mjs <会话ID或前缀> --tail 40 --tools --search 关键字 --json
node plugin/scripts/neturl.mjs --list
node plugin/scripts/neturl.mjs --set gw-c https://api-c.example.com 示例服务
```

### 环境变量

- `AGY_NOTE_ROOT`：覆盖落盘工作台根目录（默认为 `~/agy-notes`），Hooks、`agynote.mjs` 与 Sidecar 统一读写该目录。
- `AGY_OFFLOAD_DATA_DIR`：最高优先级覆盖运行时数据目录；未设置时依次回退官方 `PLUGIN_DATA`、会话目录表面识别与默认 `~/.gemini/antigravity/plugin_data/note-offload`。
- `AGY_OFFLOAD_SANITIZE` / `AGY_OFFLOAD_ALIAS` / `AGY_OFFLOAD_ORCH_CONFIRM`：按环境变量临时覆盖对应开关或 `Orchestrator` 确认策略（`once`/`per_session`/`off`）。
- `AGY_BRAIN_ROOT`：覆盖 `agysum.mjs` 扫描的 `brain` 目录列表（支持路径分隔符拼接多个目录）。

## 本地开发门禁与五环工具

```bash
bash scripts/selftest.sh     # L1/L2 单测回放 + L4 契约评测 + L3 无头 Chrome 冒烟 + 隐私与压缩包校验
npm run mine                 # 只读遥测矿机（输出脱敏改进提案）
npm run doctor               # 运行态版本、残留、进程与黑匣子体检
npm run release:snapshot     # 实装前快照备份（最多保留 3 份，支持 npm run release:rollback 回滚）
```

## License

[MIT](./LICENSE)
