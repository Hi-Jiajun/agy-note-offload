# agy-note-offload

面向 **Google Antigravity** 的原生插件（**Note Offload** `v2.1.0`）：集成了**按需双向文件工作台（`task.md` / `status.md` / 连续递增 `turn-N.md`）**、**`Orchestrator` 无损规划交接与首次确认**、**落盘会话 2 档自愈续跑**、**熔断防空转与 `/compact` 自动解锁**、**黑匣子飞行诊断与五环自进化门禁**、以及**可视化侧边栏 Aux Pane 面板**。

## 核心能力

- **100% 符合 Antigravity 原生插件规范**：纯净插件包置于 `plugin/`（零警告通过 `agy plugin validate ./plugin --strict`），纯 Node.js ESM 零第三方依赖共享内核（`plugin/lib/*.mjs`），优先兼容官方 `PLUGIN_DATA` 多端数据隔离与无外部软链开箱运行。
- **按需零污染与双向开关**：普通日常会话 `SessionStart` 仅静默清理旧状态，**零注入零干扰**；仅在显式发送 `/note-offload`（或 `[落盘模式]`/`[文件模式]`）时开启落盘纪律，支持随时发送 `/note-offload off`（或 `[退出落盘]`）同会话恢复常规详答。
- **可视化侧边栏面板（`扩展 > Note Offload`）**：基于官方 `sidecar_sdk` 构建 Aux Pane Web UI，支持任务勾选进度、状态筛选/排序、Markdown 表格与 Diff 富预览、防丢稿未保存保护与外部变更感知、`> 1 MB` 大文件 `256 KB` 分片翻页浏览、风险确认后解锁详稿在线编辑、可选项配置开关以及黑匣子飞行诊断抽屉。
- **双向文件交流（`agynote.mjs`）**：长篇需求放进 `task.md`，阶段进展同步更新 `status.md` 与按目录已有最大序号 `+ 1` 连续递增的 `turn-N.md`；每轮收尾控制在 1~3 行（`<= 150` 字结论正文 + 可点击 `file://` 路径链接），中间工具调用仅保留极简单句里程碑。
- **`Orchestrator` 无损适配与首次零配额确认**：首次在 `Orchestrator` 下启用 `/note-offload` 时由 `PreInvocation` 零配额弹卡确认并暂存原指令，回复「确认/继续」后自动补发原指令；平时解除 `exit_plan_mode` 15 行纯路径限制（完整传递结论、改法、验证命令与 `Re-plan if`），仅在 `Stop` 异常中断时才精简脱困。
- **收敛范围的 `Stop` 续跑与 `/compact` 解锁**：`Stop` 仅介入已开启落盘或已绑定命名工作台的会话（普通会话绝不被动建目录），保留「跨轮 `Plan Mode` 分流 + 1 档精简重述 + 2 档写递增 `turn-N.md`」；熔断后拦下短催促与原样重发，` /compact` 自动解除熔断状态，接力卡片优先关联 `task.md` + `status.md` + 最新 `turn-N.md` 并提示原生「分支会话」。
- **可选项词表中性化/别名注入与冲突检测**：`sanitize` 与 `neturl` 自动提示**默认关闭**，保留 `JSON`/`IPv4`/`sha256` 等常规工程术语；可通过 `agynote.mjs config` 或 Sidecar 面板按需启用，并配合 `agynote.mjs doctor` 自动扫描与 `control-tower`、MCP 服务名、多插件同事件 Hook 及 `PATH` 同名命令的冲突风险。
- **跨端会话检索（`agysum.mjs`）**：自动跨桌面端（`antigravity`）、CLI（`antigravity-cli`）与 IDE（`antigravity-ide`）三端 `brain/` 目录检索旧会话 `transcript.jsonl` 并提炼极简要点。

## 仓库结构

```text
note-offload/
├── package.json                       # 单一版本源（2.1.0）与五环工程脚本
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
    ├── lib/                           # 共享 ESM 内核（paths / lock / logger / config / sanitize / aliases / conflicts / workspace / state）
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

或下载 GitHub Release 中的 `note-offload-v2.1.0.zip` 解压后运行 `agy plugin install <解压目录>`。

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

# 3. 查看工作台健康看板、调整可选项或诊断冲突
node plugin/scripts/agynote.mjs status
node plugin/scripts/agynote.mjs show my-task
node plugin/scripts/agynote.mjs clean
node plugin/scripts/agynote.mjs config --sanitize off --alias on
node plugin/scripts/agynote.mjs doctor

# 4. 摘要旧会话或管理可选远端地址别名
node plugin/scripts/agysum.mjs <会话ID或前缀> --tail 40 --width 120
node plugin/scripts/neturl.mjs --list
node plugin/scripts/neturl.mjs --set gw-c https://api-c.example.com 示例服务
```

### 环境变量

- `AGY_NOTE_ROOT`：覆盖落盘工作台根目录（默认为 `~/agy-notes`），Hooks、`agynote.mjs` 与 Sidecar 统一读写该目录。
- `AGY_OFFLOAD_DATA_DIR`：最高优先级覆盖运行时数据目录；未设置时依次回退官方 `PLUGIN_DATA`、会话目录表面识别与默认 `~/.gemini/antigravity/plugin_data/note-offload`。
- `AGY_OFFLOAD_SANITIZE` / `AGY_OFFLOAD_ALIAS`：按环境变量临时覆盖可选项开关（`on`/`off`/`true`/`false`/`1`/`0`）。
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
