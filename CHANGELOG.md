# Changelog

## [2.0.0] - 2026-11-22

### Changed
- **目录结构规范化**：工程开发文件与运行态插件包 `plugin/` 物理分离，`agy plugin validate ./plugin --strict` 零警告通过。
- **纯 Node.js ESM 零依赖共享内核**：彻底淘汰 Python + Bash + Node 三栈重复代码，收敛为 `plugin/lib/*.mjs` 统一内核（`paths` / `lock` / `config` / `sanitize` / `workspace` / `state` / `aliases` / `conflicts`），Hooks、CLI 与 Sidecar 共用排他文件锁，优先兼容官方 `PLUGIN_DATA` 多端隔离。
- **普通会话纯按需零污染与退出开关**：`SessionStart` 仅静默清理同会话残留状态，不再向日常会话注入全局约束；`Stop` 钩子收敛为仅服务已开启 `/note-offload` 或已绑定命名工作台的会话；支持 `/note-offload off`（及 `[退出落盘]`）同会话恢复常规详答。
- **`Orchestrator` 无损规划适配与首次确认**：首次在 `Orchestrator` 下显式启用 `/note-offload` 时由 `PreInvocation` 零配额弹卡确认并暂存原指令（回复「确认/继续」自动补发）；平时解除 `exit_plan_mode` 15 行纯路径限制以保留完整决策传递，仅在异常中断时才精简脱困；统一连续递增 `turn-N.md` 编号并修复跨轮 `Plan Mode` 识别。
- **熔断与防空转体验升级**：`/compact` 自动清除熔断计数；熔断卡片优先指向 `task.md` + `status.md` + 最新 `turn-N.md` 并区分原生「分支会话」与跨会话接力。
- **可选脱敏、冲突检测与 Sidecar 分片无拒读**：词表中性化与远端别名提示改为默认关闭的可选项（`agynote.mjs config` / Sidecar 开关 + `agynote.mjs doctor` 冲突扫描），保留常规工程术语；Sidecar 扩充支持 `.csv`/`.tsv`/`.yaml`/`.yml`/`.diff`/`.patch`，支持 `> 1 MB` 文件 `256 KB` 分片翻页预览（零 413 拒读）、`knownSig` 去重以及风险确认后解锁详稿在线编辑。
- **单包自包含 CLI 与数据目录统一**：CLI 迁入 `plugin/scripts/*.mjs`，通过 `SKILL.md` 相对路径与 `PLUGIN_ROOT` 调用，默认不再向 `~/.local/bin` 投放外部软链（保留 `--link-cli` 可选参数）；持久化数据自动平滑迁移旧版 `~/.local/share/agy-note-offload`。
- **跨端 `agysum` 寻址与工程化质量门禁**：支持跨三端 `brain/` 自动定位旧会话，引入 `sync-meta.mjs`、`check-privacy.mjs`、`build-release.mjs`、模块化 `node --test` 测试套件与 GitHub Actions CI。

## [1.0.1] - 2026-11-21

- 强化 `/note-offload` 独立词精准触发与静默工作台绑定、`AGY_NOTE_ROOT` 全局隔离、状态文件排他锁以及 Sidecar 接口鉴权与请求校验。
