# agy-note-offload 独立工作区协作规则

本仓库为 Google Antigravity 原生插件 `note-offload`（`agy-note-offload`）的独立开发源码仓，支持作为单独工作区直接打开维护。所有通用约束均与公开仓库安全红线保持一致：全程中文技术交流、先核查再改写、严禁 `rm -rf`、禁止将本地会话私有信息带入仓库提交。

## 仓库架构与目录职责

| 路径 | 职责说明 |
| --- | --- |
| `plugin.json` | Antigravity 原生插件清单（元数据、入口与建议提示词） |
| `hooks.json` | 插件相对路径声明的 `SessionStart` / `Stop` / `PreInvocation` 生命周期钩子 |
| `skills/note-offload/SKILL.md` | `note-offload` 技能规程与触发说明 |
| `scripts/` | 核心脚本（`hooklib.py`、`sanitize.py`、`provider-filter-*.py`、`agynote`、`agysum`、`neturl`、`selftest.sh` 等） |
| `sidecars/board/` | 零第三方依赖的侧边栏 Aux Pane Sidecar Web UI（`sidecar.json`、`main.mjs`、前端文件） |
| `assets/logo.svg` | 插件图标 |
| `install.sh` / `uninstall.sh` | 发布安装至 `~/.gemini/config/plugins/note-offload/`、清理旧配置与 CLI 软链脚本 |

## 开发态与运行态严格隔离（核心红线）

1. **只在源码仓修改，严禁直接编辑运行态**：日常开发只修改本仓库内文件；严禁直接编辑 `~/.gemini/config/plugins/note-offload/`、`~/.gemini/config/scripts/` 或 `~/.local/bin/` 下已安装文件。
2. **仅使用隔离沙箱自检**：改动完成后必须运行 `bash scripts/selftest.sh`。该脚本自动使用临时 `AGY_OFFLOAD_DATA_DIR` 隔离运行全量校验，严禁将测试写入真实 `~/.local/share/agy-note-offload/` 状态或日志。
3. **发布门禁控制**：未经用户明确授权获取实装发布许可前，严禁擅自执行 `./install.sh` 或 `./uninstall.sh` 覆写本机运行态插件。
4. **验证标准**：涉及脚本或 Sidecar 改动时，必须实跑 `bash scripts/selftest.sh` 并确认退出码 `0` 与全部条目 `PASS`，不得跳过失败项或仅凭静态阅读宣称通过。

## 公开仓库隐私与公私分离红线

1. **禁止在本仓库保留或提交 `.agents/`**：包含本地绝对路径、会话 ID（UUID）或调度台账的个人治理文件严禁进入本仓库；`.agents/` 已列入 `.gitignore`。
2. **严禁提交个人隐私与敏感信息**：不得写入个人主目录绝对路径、内网 IP、域名凭据、Token、API Key、个人 `net-map.tsv`、`.filter-retry-state.json`、`hook-invocations.log` 或 `__pycache__/`。
3. **提交前必检**：每次 `git commit` 前核查 `git status -s` 与 `git diff`，确认无个人路径、无敏感字面量、无多余临时文件。

## Git 与工作流纪律

- **仅本地提交**：日常开发只执行本地 `git add` / `git commit`，未经用户明确指令不得执行 `git push`。
- **模型路由建议**：常规功能迭代与问题排查推荐使用 `Orchestrator (Neon)`；纯批量只读检索使用 `Hydrogen (Low / Medium)`；严禁使用 `Argon` 与 `Gemini 3.8` 及更早系列模型。
