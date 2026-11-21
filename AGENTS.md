# agy-note-offload 独立工作区协作规则

本仓库为 Google Antigravity 原生插件 `note-offload`（`agy-note-offload`）的独立开发源码仓，遵循工程根目录与运行态插件包 `plugin/` 物理分离规范。所有通用约束均与公开仓库安全红线保持一致：全程中文技术交流、先核查再改写、严禁 `rm -rf`、禁止将本地会话私有信息带入仓库提交。

## 仓库架构与目录职责

| 路径 | 职责说明 |
| --- | --- |
| `package.json` | 工程根配置与单一版本源（`2.0.0`） |
| `plugin/` | 纯净运行态 Antigravity 原生插件包（`agy plugin validate ./plugin --strict` 零告警，支持整目录同步与 Release ZIP 分发） |
| `plugin/plugin.json` | Antigravity 原生插件清单 |
| `plugin/hooks.json` | 插件相对路径声明的 `SessionStart` / `Stop` / `PreInvocation` 生命周期钩子 |
| `plugin/lib/` | 零第三方依赖 Node.js ESM 共享内核（`paths.mjs`、`lock.mjs`、`config.mjs`、`sanitize.mjs`、`workspace.mjs`、`state.mjs`、`aliases.mjs`、`conflicts.mjs`） |
| `plugin/scripts/` | 插件内聚 Hook 与 CLI 入口（`hook-*.mjs`、`agynote.mjs`、`agysum.mjs`、`neturl.mjs`、`net-map.tsv.example`） |
| `plugin/skills/note-offload/SKILL.md` | `note-offload` 技能规程与相对路径工具引用 |
| `plugin/sidecars/board/` | 零第三方依赖的侧边栏 Aux Pane Sidecar Web UI（纯正接入 `sidecar_sdk`） |
| `plugin/assets/logo.svg` | 插件图标 |
| `scripts/` | 工程期脚本（`selftest.sh`、`sync-meta.mjs`、`check-privacy.mjs`、`build-release.mjs`、`install.mjs`、`uninstall.mjs`） |
| `tests/` | 基于 `node --test` 的隔离沙箱模块化测试套件与 `tests/helpers/` 测试桩 |
| `install.sh` / `uninstall.sh` | 本地源码同步至 `~/.gemini/config/plugins/note-offload/` 的轻量安装/卸载包装 |

## 开发态与运行态严格隔离（核心红线）

1. **只在源码仓修改，严禁直接编辑运行态**：日常开发只修改本仓库内文件；严禁直接编辑 `~/.gemini/config/plugins/note-offload/`、`~/.gemini/config/scripts/` 或 `~/.local/bin/` 下已安装文件。
2. **仅使用隔离沙箱自检**：改动完成后必须运行 `bash scripts/selftest.sh`。该脚本使用临时 `AGY_OFFLOAD_DATA_DIR` 与 `AGY_NOTE_ROOT` 隔离执行元数据同步检查、隐私门禁扫描、`node --test` 测试套件、ZIP 打包与官方 `agy plugin validate ./plugin --strict`，严禁将测试写入真实 `~/.gemini/antigravity/plugin_data/note-offload/` 或 `~/.local/share/agy-note-offload/`。
3. **发布门禁控制**：未经用户明确授权获取实装发布许可前，严禁擅自执行 `./install.sh`、`./uninstall.sh`、`node scripts/install.mjs` 或 `node scripts/uninstall.mjs` 覆写本机运行态插件。
4. **验证标准**：涉及内核、Hook、CLI 或 Sidecar 改动时，必须实跑 `bash scripts/selftest.sh` 并确认全部条目通过、退出码为 `0` 且 `agy plugin validate ./plugin --strict` 零告警。

## 公开仓库隐私与公私分离红线

1. **禁止在本仓库保留或提交 `.agents/`**：包含本地绝对路径、会话 ID（UUID）或调度台账的个人治理文件严禁进入本仓库；`.agents/` 已列入 `.gitignore`。
2. **严禁提交个人隐私与敏感信息**：不得写入个人主目录绝对路径、内网 IP、域名凭据、Token、API Key、个人 `net-map.tsv`、`.filter-retry-state.json`、`hook-invocations.log`、`dist/` 或 `__pycache__/`。
3. **提交前必检**：每次 `git commit` 前核查 `git status -s` 与 `git diff`，并确保 `node ./scripts/check-privacy.mjs` 与 `node ./scripts/sync-meta.mjs --check` 通过。

## Git 与工作流纪律

- **仅本地提交**：日常开发只执行本地 `git add` / `git commit`，未经用户明确指令不得执行 `git push`。
- **模型路由建议**：常规功能迭代与问题排查推荐使用 `Orchestrator (Neon)`；纯批量只读检索使用 `Hydrogen (Low / Medium)`；严禁使用 `Argon` 与 `Gemini 3.8` 及更早系列模型。
