# Changelog

## [2.1.0] - 2026-11-24

### Added
- **五环自进化工程基座**：
  - Ring 1：新增零依赖脱敏轮转黑匣子飞行记录仪 `plugin/lib/logger.mjs`（`<PLUGIN_DATA>/logs/offload-flight.jsonl`，2 MB x 3 轮转，自动脱敏主目录、私有网段与凭据），并在 Sidecar 监控页接入黑匣子飞行诊断抽屉与一键清空；
  - Ring 2：新增只读遥测矿机 `scripts/offload-miner.mjs`（`npm run mine`）；
  - Ring 3：新增 5 份脱敏真实故障回放夹具 `tests/replays/*.replay.json` 与回放器 `scripts/offload-replay.mjs`（`npm run replay`）；
  - Ring 4：抽离 Sidecar 纯前端逻辑 `plugin/sidecars/board/ui-logic.mjs` 与 L1 单测 `tests/ui-logic.test.mjs`，新增零依赖无头 Chrome CDP 真浏览器 Aux Pane 冒烟测试 `scripts/offload-ui-smoke.mjs`（`npm run test:ui`）与 L4 技能提示词行为契约评测 `scripts/offload-skill-eval.mjs`（`npm run test:eval`）；
  - Ring 5：新增实装前快照与秒级回滚工具 `scripts/offload-release.mjs`（`<PLUGIN_DATA>/releases/` 保留最近 3 份）及运行态体检探针 `scripts/offload-doctor.mjs`（`npm run doctor`）。
- **架构蓝图与多平台发布流水线**：新增 `docs/ARCHITECTURE-ROADMAP.md`、GitHub Actions `ubuntu-latest` + `macos-latest` CI 矩阵及 `v*` Release Tag 自动构建发布流水线 `.github/workflows/release.yml`。

### Changed
- **Sidecar UI 交互与视觉升级**：新增任务勾选进度统计、工作台状态筛选与排序、Markdown 表格与 Diff 富渲染、未保存防丢稿守卫、编辑态外部文件变更检测、可折叠设置抽屉与冲突条、`Cache-Control: no-store` 与资源版本戳防缓存。
- **Release ZIP 真压缩**：`scripts/build-release.mjs` 升级使用 Node 内置 `zlib.deflateRawSync` 压缩打包并增加无损解压单测校验。

### Fixed
- **修复独立普通文件误绑工作台**：`extractNoteDir` / `wsNameFromEntry` / `toAbsNoteDir` 新增 `isWorkspaceFileCandidate` 校验，拦截 `~/agy-notes/` 根目录下 `.md` 等独立文件与 `_archive` 目录被误绑为 `note_dir`。
- **消除高频噪声日志与冗余 `Stop` 触发**：`hook-retry.mjs` 早期跳过 `TERMINAL_CUSTOM_HOOK` 与 `INJECTED_RESPONSE`，`hook-notice.mjs` 与 `hook-retry.mjs` 不再在每轮 `skip_ct_controller` / `skip=unmanaged` / 正常回合刷屏写入 `hook-invocations.log` 与抢锁，并消除静默 `catch {}`。
- **加固文件锁超时可观测性**：`plugin/lib/lock.mjs` 新增 `onTimeout` 告警回调与 `strict` 严格抛错模式（`ELOCKTIMEOUT`），并在状态锁/日志锁超时时向黑匣子记录警告。

## [2.0.0] - 2026-11-22

### Changed
- **目录结构规范化**：工程开发文件与运行态插件包 `plugin/` 物理分离，`agy plugin validate ./plugin --strict` 零警告通过。
- **纯 Node.js ESM 零依赖共享内核**：彻底淘汰 Python + Bash + Node 三栈重复代码，收敛为 `plugin/lib/*.mjs` 统一内核（`paths` / `lock` / `config` / `sanitize` / `workspace` / `state` / `aliases` / `conflicts`），Hooks、CLI 与 Sidecar 共用排他文件锁，优先兼容官方 `PLUGIN_DATA` 多端隔离。
- **普通会话纯按需零污染与退出开关**：`SessionStart` 仅静默清理同会话残留状态，不再向日常会话注入全局约束；`Stop` 钩子收敛为仅服务已开启 `/note-offload` 或已绑定命名工作台的会话；支持 `/note-offload off`（及 `[退出落盘]`）同会话恢复常规详答。
- **`Orchestrator` 无损规划适配与首次确认**：首次在 `Orchestrator` 下显式启用 `/note-offload` 时由 `PreInvocation` 零配额弹卡确认并暂存原指令（回复「确认/继续」自动补发）；平时解除 `exit_plan_mode` 15 行纯路径限制以保留完整决策传递，仅在异常中断时才精简脱困；统一连续递增 `turn-N.md` 编号并修复跨轮 `Plan Mode` 识别。
- **`control-tower` 总控隔离与规则版本号升级（`RULE_REV`）**：精确对齐 `control-tower` 真实 `SESSION-REGISTRY.md` 与 `@plugin_data` 托管台账，现役总控会话单提子任务路径时不静默误绑、不进 `Stop` 托管（显式开启 `/note-offload` 时合并零配额确认）；新增 `RULE_REV=2` 自动为存量活跃落盘会话刷新新版无损规则。
- **熔断与防空转体验升级**：`/compact` 自动清除熔断计数；熔断卡片优先指向 `task.md` + `status.md` + 最新 `turn-N.md` 并区分原生「分支会话」与跨会话接力。
- **可选脱敏、冲突检测与 Sidecar 分片无拒读**：词表中性化与远端别名提示改为默认关闭的可选项（`agynote.mjs config` / Sidecar 开关 + `agynote.mjs doctor` 冲突扫描），保留常规工程术语；Sidecar 扩充支持 `.csv`/`.tsv`/`.yaml`/`.yml`/`.diff`/`.patch`，支持 `> 1 MB` 文件 `256 KB` 分片翻页预览（零 413 拒读）、`knownSig` 去重以及风险确认后解锁详稿在线编辑。
- **单包自包含 CLI 与数据目录统一**：CLI 迁入 `plugin/scripts/*.mjs`，通过 `SKILL.md` 相对路径与 `PLUGIN_ROOT` 调用，默认不再向 `~/.local/bin` 投放外部软链（保留 `--link-cli` 可选参数）；持久化数据自动平滑迁移旧版 `~/.local/share/agy-note-offload`。
- **跨端 `agysum` 寻址与工程化质量门禁**：支持跨三端 `brain/` 自动定位旧会话，引入 `sync-meta.mjs`、`check-privacy.mjs`、`build-release.mjs`、模块化 `node --test` 测试套件与 GitHub Actions CI。

## [1.0.1] - 2026-11-21

- 强化 `/note-offload` 独立词精准触发与静默工作台绑定、`AGY_NOTE_ROOT` 全局隔离、状态文件排他锁以及 Sidecar 接口鉴权与请求校验。
