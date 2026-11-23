# `note-offload` 架构蓝图与自进化演进路线图

> **定位**：面向 Google Antigravity 原生插件 `note-offload` 的 L1 北极星架构契约与 5 环自进化工程基座说明。本文档仅驻留源码仓 `docs/`，不打入运行态 `plugin/` 包。

## 一、核心架构不变量（Architectural Invariants）

1. **纯净运行态与工程期物理分离**
   - 运行态资产严格收敛在 `plugin/`，零第三方依赖纯 Node.js ESM，满足 `agy plugin validate ./plugin --strict --json` 零告警。
   - 工程期门禁、挖矿、回放、真浏览器冒烟、发布快照与回滚脚本全部驻留仓库根 `scripts/` 与 `tests/`。
2. **普通会话零污染（On-Demand Zero Pollution）**
   - `SessionStart` 仅清理同会话残留状态，绝不预建工作台目录、绝不向未启用会话注入系统指令。
   - 仅在显式触发 `/note-offload`、`[落盘模式]`、`[文件模式]` 或绑定有效命名工作台目录后才接管；支持同会话 `/note-offload off` 即时退出。
3. **单一目标目录与无损规划交接**
   - 命名工作台与当前会话一一映射，严禁向 `~/agy-notes/<name>/` 与 `~/agy-notes/<conv8>/` 双写；且严禁将 `~/agy-notes/` 根目录下的独立普通文件误绑为工作台目录。
   - 处于 `Plan Mode` / `Orchestrator` 只读规划阶段时，绝不通过 15 行硬上限阉割规划详度，允许 `exit_plan_mode` 完整交接结论、改动方案、验证命令与 `Re-plan if` 条件；仅当 `Stop` 异常中断时才降级为 5~10 行脱困交接。
4. **总控与多插件共治安全边界**
   - 自动识别 `control-tower` 现役总控会话（兼容 `.agents/SESSION-REGISTRY.md` 与 `@plugin_data/workspaces/<hash>/SESSION-REGISTRY.md`），总控会话免静默误绑，显式启用始终按会话级零配额确认。
   - 严格校验 `PLUGIN_ROOT` / `PLUGIN_DATA` 归属（`basename === 'note-offload'`），杜绝受其他并发插件环境变量污染。
5. **公开仓库隐私与格式红线**
   - 严禁提交个人主目录绝对路径、私有网段、密钥令牌、`.agents/` 或运行时数据；所有界面、文档、测试与回复严禁使用间隔号字符。

## 二、明确非目标（Non-Goals）

- 不在 Sidecar 中调用会触发模型降级的 `startConversation`，也不使用阻塞式 `window.confirm` / `window.alert`。
- 不在未获显式开关的情况下擅自改写用户工程术语或注入远端别名工具。
- 不越界读写 `~/agy-notes/` 与 `<PLUGIN_DATA>` 之外的用户代码仓文件。

## 三、五环自进化插件工厂（5-Ring Self-Evolving Foundry）

| 环位 | 名称 | 核心组件 | 职责 |
| --- | --- | --- | --- |
| Ring 1 | 无侵入黑匣子飞行记录仪 | `plugin/lib/logger.mjs` + Sidecar 飞行诊断抽屉 | `<PLUGIN_DATA>/logs/offload-flight.jsonl`（2 MB x 3 轮转），自动脱敏主目录/私网 IP/密钥，捕获错误、慢操作（`>= 100ms`）、锁超时与关键调度事件，消除静默吞错与高频噪声日志。 |
| Ring 2 | 只读遥测挖矿与改进提案引擎 | `scripts/offload-miner.mjs` (`npm run mine`) | 只读汇总近端会话 `transcript.jsonl`、飞行日志与 `~/agy-notes/` 工作台健康度，自动产出脱敏的量化改进提案。 |
| Ring 3 | 真实故障脱敏回放库 | `tests/replays/*.replay.json` + `scripts/offload-replay.mjs` (`npm run replay`) | 将线上真实踩坑固化为可重复执行的脱敏夹具，确保历史缺陷永不回归。 |
| Ring 4 | 四维自动化门禁（L1-L4） | L1 单测（含 `ui-logic.mjs`） / L2 回放回归 / L3 无头 Chrome CDP 真浏览器 Aux Pane 冒烟（`scripts/offload-ui-smoke.mjs`）/ L4 技能与提示词契约评测（`scripts/offload-skill-eval.mjs`） | 覆盖内核、契约、窄宽栏亮暗主题渲染零溢出与行为边界。 |
| Ring 5 | 实装前快照、一键回滚与运行态体检 | `scripts/offload-release.mjs` + `scripts/offload-doctor.mjs` (`npm run doctor`) | 实装前自动备份最近 3 份运行态快照至 `<PLUGIN_DATA>/releases/`，支持秒级回滚并联动运行态版本/残留/进程/黑匣子体检。 |

## 四、演进路线图

- **`v2.0.0`（已完成基线）**：零第三方依赖纯 Node.js ESM 原生插件重构、按需零污染、Orchestrator 无损交接与零配额确认、Sidecar 大文件分片与风险确认编辑、外源 `PLUGIN_DATA` 隔离与 `control-tower` 现役总控共治。
- **`v2.1.0`（稳定性、工程基座与 Sidecar 体验收口）**：
  - 修复独立文件误绑工作台、`Stop` 对 `TERMINAL_CUSTOM_HOOK` / `INJECTED_RESPONSE` 冗余触发、`skip_ct_controller` 日志刷屏与文件锁超时静默放行；
  - 落地 5 环自进化基座（黑匣子日志、遥测矿机、5 份真实故障回放夹具、L1-L4 门禁、快照回滚与 Doctor）；
  - 收口 Sidecar 视觉与交互重构（防丢稿、外部变更同步、任务进度与筛选、飞行诊断抽屉）；
  - 升级 `build-release.mjs` 为内置 `zlib.deflateRawSync` 真压缩 ZIP，补齐多平台 CI 矩阵与 Release Tag 自动发布流。
- **`v2.2.0`（可编辑配置中心、百级工作台性能与 CLI 强化）**：
  - 扩展 `config.json` 与 Sidecar 设置中心（含一键重置默认），`Orchestrator` 确认默认收敛为首启一次性 `once`（可切 `per_session` / `off`），总控确认坚持会话级安全门；
  - 升级规则自动刷新为插件版本感知（`<version>#<rev>`），后续发版自动平滑刷新存量活跃落盘会话；
  - Sidecar 引入基于 `mtimeMs` 的增量扫描缓存、逻辑归档（默认不断历史链接）与可选 `--move` 物理归档、单工作台多会话历史关联；
  - 升级 `agysum.mjs`（尾部分块读取、默认修改文件清单页脚、`--tools` / `--search` / `--json`）与 `agynote.mjs`（`reset` / `archive` / `unarchive` / `status` 过滤与 JSON 输出 / 完整 `config`）。
