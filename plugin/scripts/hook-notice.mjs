#!/usr/bin/env node
/**
 * Antigravity PreInvocation hook: 总控免静默误绑 + 工作台绑定 + Orchestrator/总控合并确认 + 退出开关 + /compact 解锁 + 防空转 + RULE_REV 自动刷新 + 按需别名/冲突检测。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasConfiguredAliases } from '../lib/aliases.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';
import { detectConflicts, isActiveControlTowerController } from '../lib/conflicts.mjs';
import { appendFlightEvent, SLOW_OP_THRESHOLD_MS } from '../lib/logger.mjs';
import { getMapPath, getPluginRoot, shortPath } from '../lib/paths.mjs';
import { applySanitizeIfEnabled } from '../lib/sanitize.mjs';
import {
  appendLog,
  loadState,
  saveState,
  withStateLock,
} from '../lib/state.mjs';
import {
  buildWorkspaceRelayPrompt,
  extractNoteDir,
  hasExplicitOffload,
  hasExplicitOffloadOff,
  inputSig,
  resolveNoteDir,
} from '../lib/workspace.mjs';

const EXPECTED = 'PreInvocation';
const TAIL_BYTES = 131_072;
const RULE_REV = 2;

function getPluginRuleMeta(env = process.env) {
  let pluginVersion = '2.0.0';
  try {
    const meta = JSON.parse(readFileSync(join(getPluginRoot(env), 'plugin.json'), 'utf-8'));
    if (meta && typeof meta.version === 'string' && meta.version.trim()) {
      pluginVersion = meta.version.trim();
    }
  } catch {
    // 忽略清单读取失败，使用兜底版本号
  }
  return {
    pluginVersion,
    ruleVersion: `${pluginVersion}#${RULE_REV}`,
  };
}

const OFFLOAD_RULE =
  '[落盘模式] 本会话采用双向文件工作流：单一目标目录为 {dir}（严禁同时往多个落盘目录双写）；' +
  '若处于规划阶段（Plan Mode / Orchestrator），保持只读调研不直接写文件，调用 exit_plan_mode 时完整传递核心分析结论、' +
  '精确改动方案、验证命令与 Re-plan if 回退条件（仅禁止直接粘贴原始长日志或大段反汇编文本），由执行阶段写入 {dir}/turn-<递增序号>.md ' +
  '并同步更新 {dir}/status.md（复核回合若已落盘完毕则直接精简收尾）；执行阶段按目录内现有最大序号 +1 连续写入 turn-N.md 并更新 status.md，' +
  '脚本详细输出直写文件（终端 stdout <= 20 行摘要），读大文件用 read_file 分片读取；' +
  '中间调用工具仅保留极简单句里程碑、禁刷长文；每轮收尾控制在 1~3 行（结论正文 <= 150 字，附可点击 [文件名](file://<绝对路径>) 链接，链接路径长度不计入字数）；' +
  '如需恢复常规详答可发 /note-offload off。';

const OFFLOAD_OFF_RULE =
  '[退出落盘模式] 本会话已关闭落盘精简限制，后续回复请恢复常规详细作答，无需限制收尾行数。';

const NUDGE_WORDS = new Set([
  '', '继续', '继续吧', '继续做', '继续执行', '接着', '接着做', '重试', '再试', '再试一次',
  '再来', '再来一次', '嗯', '好', '好的', '行', '可以', '收到', 'go', 'go on',
  'continue', 'resume', 'retry', 'next', 'ok', 'okay', 'yes', 'y',
]);

const CONFIRM_WORDS = new Set([
  '确认', '确认继续', '同意', '同意继续', '继续', '继续执行',
  '好', '好的', '行', '可以', 'yes', 'y', 'ok', 'okay', 'confirm', 'continue',
]);

const PERMANENT_CONFIRM_WORDS = new Set([
  '永久确认', '记住', '记住选择', '以后不再提示', '不再提示', 'always', 'remember',
]);

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

function tailTranscriptRecords(transcriptPath) {
  let fd = -1;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(transcriptPath, 'r');
    const bytesRead = readSync(fd, buf, 0, len, start);
    const text = buf.subarray(0, bytesRead).toString('utf-8');
    const recs = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('{')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
          recs.push(rec);
        }
      } catch {
        // 忽略截断首行
      }
    }
    return recs;
  } catch {
    return [];
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭异常
      }
    }
  }
}

function isOrchestratorSession(payload) {
  const modelName = String(payload.modelName || '').toLowerCase();
  if (modelName.includes('orchestrator')) return true;

  const transcriptPath = payload.transcriptPath || '';
  if (!transcriptPath || !existsSync(transcriptPath)) return false;

  const recs = tailTranscriptRecords(transcriptPath);
  let sawWorker = false;
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const r = recs[i];
    if (r.type === 'PLANNER_RESPONSE' && r.model) {
      const m = String(r.model).toLowerCase();
      if (m.includes('orchestrator')) return true;
      if (m.includes('worker')) {
        sawWorker = true;
        continue;
      }
      return false;
    }
    if (r.type === 'USER_INPUT' && typeof r.content === 'string') {
      if (r.content.includes('<USER_SETTINGS_CHANGE>') && r.content.includes('Model Selection')) {
        return r.content.includes('Orchestrator');
      }
    }
    if (!sawWorker && r.type === 'SYSTEM_MESSAGE' && typeof r.content === 'string') {
      if (r.content.includes('Plan mode is on:') || r.content.includes('[plan review]')) {
        return true;
      }
    }
  }
  return false;
}

function normalizeShortPhrase(text) {
  return String(text || '')
    .trim()
    .replace(/[\s。，、！？!?,.;:：~～…\-_]+/g, ' ')
    .trim()
    .toLowerCase();
}

function isShortNudge(text) {
  const cleaned = normalizeShortPhrase(text);
  return !cleaned || NUDGE_WORDS.has(cleaned);
}

function isConfirmWord(text) {
  const cleaned = normalizeShortPhrase(text);
  return Boolean(cleaned) && (CONFIRM_WORDS.has(cleaned) || PERMANENT_CONFIRM_WORDS.has(cleaned));
}

function isPermanentConfirmWord(text) {
  const cleaned = normalizeShortPhrase(text);
  return Boolean(cleaned) && PERMANENT_CONFIRM_WORDS.has(cleaned);
}

function buildRiskConfirmCard(conv, entry, { needsOrchConfirm, needsCtConfirm, orchMode = 'once' }) {
  const noteDir = resolveNoteDir(conv, entry, { create: false });
  const lines = [];
  if (needsOrchConfirm && needsCtConfirm) {
    lines.push('> **Orchestrator 模式启用落盘提醒（含 control-tower 现役总控冲突提示，零配额确认）**：');
  } else if (needsOrchConfirm) {
    lines.push('> **Orchestrator 模式启用落盘提醒（零配额确认）**：');
  } else {
    lines.push('> **control-tower 现役总控启用落盘提醒（零配额确认）**：');
  }
  lines.push(`> 目标工作台目录预览：\`${noteDir}\`。`);
  if (needsOrchConfirm) {
    lines.push('> - 当前会话运行在 `Orchestrator` 双阶段模型，规划阶段只读不可直接写盘，落盘与状态同步会移交执行模型多走一轮；');
    lines.push('> - 本插件已采用无损规划交接策略，不会压缩您的规划推理、改法与回退条件；');
    if (orchMode === 'once') {
      lines.push('> - 当前确认策略为 **首启一次性（`once`）**：本次确认后将全局记住，后续 `Orchestrator` 会话不再重复弹窗（可在 Sidecar 设置中心或 `agynote config` 随时调整）；');
    } else if (orchMode === 'per_session') {
      lines.push('> - 当前确认策略为 **每会话确认（`per_session`）**：回复 `确认` 仅放行本会话，回复 **`永久确认`** 可切换为全局记住；');
    }
  }
  if (needsCtConfirm) {
    lines.push('> - 当前会话为 `control-tower` 现役总控会话（始终按会话级确认），开启落盘或熔断拦截可能影响总控轮询与裸会话 ID 摄入，建议总控独立保留全局台账调度，不复用子任务落盘目录；');
  }
  lines.push('> - 回复 **`确认`** 或 **`继续`** 将自动带原指令开启落盘模式；如需放弃或切换会话/模型，请直接发新指令。');
  return lines.join('\n');
}

function buildDeadCard(conv, entry, deadReason, blockKind) {
  const agysumScript = shortPath(join(getPluginRoot(), 'scripts', 'agysum.mjs'));
  const relay = buildWorkspaceRelayPrompt(conv, entry, agysumScript);

  const cause = deadReason === 'context_locked' ? '连续零输出上下文锁定' : '连续受限并达重试上限';
  let action;
  if (blockKind === 'repeat') {
    action = '已拦下重复重发的原指令以省配额；若确需在本会话重试，请换一条具体新指令。';
  } else if (blockKind === 'nudge') {
    action = '已拦下空转催促以省配额；若确需在本会话重试，请发具体新指令。';
  } else {
    action = '已放行本次新指令；若仍失败建议开新会话接续。';
  }

  let locLine;
  if (relay.files.length > 0) {
    const refText = relay.files.map((f) => `\`${f}\``).join('、');
    locLine = `> 优先文件：${refText}（目录 \`${relay.noteDir}\`）`;
  } else {
    const conv8 = String(conv || 'misc').slice(0, 8);
    locLine = `> 落盘目录：\`${relay.noteDir}\`（暂未生成笔记，可用 \`node ${agysumScript} ${conv8}\` 提炼要点）`;
  }

  return (
    `> **会话已熔断（${cause}）**：${action}\n` +
    `${locLine}\n` +
    '> 分支与接续建议：若需保留完整历史上下文，请使用会话菜单的原生「分支会话」；若开新会话轻量接力，可复制下方指令：\n' +
    `> \`${relay.prompt}\``
  );
}

function buildConflictMarkdown(conflicts) {
  const lines = ['> **note-offload 兼容性与配置风险提示**：'];
  for (const item of conflicts) {
    lines.push(`> - [${item.code}] ${item.message}`);
  }
  return lines.join('\n');
}

function main() {
  const t0 = Date.now();
  const payload = readStdinJson();
  if (!payload) {
    process.stdout.write('{}\n');
    return;
  }

  const ev = String(payload.hookEventName || '');
  if (ev && ev !== EXPECTED) {
    appendLog(`${EXPECTED} 事件不匹配 hookEventName=${ev}`);
    appendFlightEvent(process.env, {
      level: 'warn',
      source: 'hook-notice',
      event: 'event_mismatch',
      ok: false,
      message: `${EXPECTED} 事件不匹配 hookEventName=${ev}`,
    });
    process.stdout.write('{}\n');
    return;
  }

  const conv = payload.conversationId || '';
  if (!conv) {
    process.stdout.write('{}\n');
    return;
  }

  const hasInputField = Object.hasOwn(payload, 'lastUserInput') && payload.lastUserInput !== null && payload.lastUserInput !== undefined;
  const lastRaw = String(payload.lastUserInput || '');
  const cfg = loadConfig(process.env);
  const retryWindowSec = cfg.retryWindowMin * 60;
  const maxRetry = cfg.maxRetry;
  const { pluginVersion, ruleVersion } = getPluginRuleMeta(process.env);
  const wsPaths = [
    ...new Set(
      [
        ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
        ...(payload.cwd ? [payload.cwd] : []),
      ].filter((p) => typeof p === 'string' && p.trim()),
    ),
  ];
  const hintPath = String(payload.transcriptPath || payload.artifactDirectoryPath || '');
  const isCtController = isActiveControlTowerController({
    convId: conv,
    workspacePaths: wsPaths,
    env: process.env,
    hintPath,
  });

  if (lastRaw.trimStart().startsWith('/compact')) {
    let unlocked = false;
    withStateLock(() => {
      const state = loadState();
      if (Object.hasOwn(state, conv) && state[conv] && typeof state[conv] === 'object') {
        const entry = { ...state[conv] };
        for (const k of ['tries', 'zero_streak', 'dead', 'dead_reason', 'notified', 'defer_alias']) {
          delete entry[k];
        }
        entry.ts = Date.now() / 1000;
        state[conv] = entry;
        saveState(state);
        unlocked = true;
      }
    });
    if (unlocked) {
      appendLog(`preinvocation compact_unlock conv=${conv}`);
      appendFlightEvent(process.env, {
        level: 'info',
        source: 'hook-notice',
        event: 'compact_unlock',
        conv,
        durationMs: Date.now() - t0,
        message: '用户执行 /compact，已解除重试与熔断标记',
      });
    }
    process.stdout.write('{}\n');
    return;
  }

  const wsDir = extractNoteDir(lastRaw);
  const explicitOff = hasExplicitOffloadOff(lastRaw);
  const explicitOffload = hasExplicitOffload(lastRaw);
  const curSig = hasInputField ? inputSig(lastRaw) : '';

  let output = null;
  let pendingConfigPatch = null;
  const pendingLogs = [];
  const pendingFlight = [];

  withStateLock(() => {
    const state = loadState();
    const rawExisting = state[conv];
    const existingEntry = rawExisting && typeof rawExisting === 'object' && !Array.isArray(rawExisting) ? rawExisting : null;
    const now = Date.now() / 1000;

    if (explicitOff) {
      const next = existingEntry ? { ...existingEntry } : {};
      next.offload_mode = false;
      next.ts = now;
      if (wsDir && !isCtController) next.note_dir = wsDir;
      if (curSig) next.last_input_sig = curSig;
      delete next.alias_injected;
      delete next.rule_rev;
      delete next.rule_version;
      delete next.pending_orch_prompt;
      delete next.pending_confirm_reasons;
      delete next.defer_alias;
      delete next.conflict_warned;
      state[conv] = next;
      saveState(state);
      const offMsg = applySanitizeIfEnabled(OFFLOAD_OFF_RULE, process.env, cfg);
      pendingLogs.push(`preinvocation offload_off conv=${conv}`);
      pendingFlight.push({ level: 'info', event: 'offload_off', message: '会话显式关闭落盘模式' });
      output = { injectSteps: [{ systemMessage: { systemMessage: offMsg } }] };
      return;
    }

    if (isCtController && !explicitOffload && !existingEntry?.pending_orch_prompt && !(existingEntry?.offload_mode && existingEntry?.ct_confirmed)) {
      return;
    }

    let entry = existingEntry;
    if (!entry) {
      if (!explicitOffload && !wsDir) {
        return;
      }
      entry = { ts: now };
      if (wsDir) entry.note_dir = wsDir;
      if (curSig) entry.last_input_sig = curSig;
      if (!explicitOffload) {
        state[conv] = entry;
        saveState(state);
        pendingLogs.push(`preinvocation bind_silent conv=${conv} dir=${wsDir}`);
        pendingFlight.push({ level: 'info', event: 'bind_silent', message: `静默绑定工作台 ${wsDir}`, detail: { noteDir: wsDir } });
        return;
      }
    } else {
      entry = { ...entry };
    }

    const initSteps = payload.initialNumSteps;
    const prevStep = entry.step;
    if (Number.isInteger(initSteps) && Number.isInteger(prevStep) && initSteps <= prevStep) {
      pendingLogs.push(`preinvocation rewind_reset conv=${conv} prev_step=${prevStep} init_steps=${initSteps}`);
      pendingFlight.push({ level: 'info', event: 'rewind_reset', message: `步数回退 (${prevStep} -> ${initSteps})，重置会话状态` });
      if ((explicitOffload || wsDir) && (!isCtController || explicitOffload)) {
        const keptDir = wsDir || entry.note_dir;
        entry = { ts: now };
        if (keptDir) entry.note_dir = keptDir;
        if (curSig) entry.last_input_sig = curSig;
        if (!explicitOffload) {
          state[conv] = entry;
          saveState(state);
          return;
        }
      } else {
        delete state[conv];
        saveState(state);
        return;
      }
    }

    if (wsDir && entry.note_dir !== wsDir && (!isCtController || explicitOffload || entry.ct_confirmed)) {
      entry.note_dir = wsDir;
    }

    const steps = [];
    let replayedSavedPrompt = false;

    if (entry.pending_orch_prompt) {
      if ((hasInputField && isConfirmWord(lastRaw)) || explicitOffload) {
        const savedPrompt = entry.pending_orch_prompt;
        const reasons = Array.isArray(entry.pending_confirm_reasons) ? entry.pending_confirm_reasons : ['orchestrator'];
        const permanentConfirm = hasInputField && isPermanentConfirmWord(lastRaw);
        delete entry.pending_orch_prompt;
        delete entry.pending_confirm_reasons;
        if (reasons.includes('orchestrator') || isOrchestratorSession(payload)) {
          entry.orch_confirmed = true;
          if (permanentConfirm) {
            pendingConfigPatch = { orchestratorConfirm: 'once', orchestratorConfirmedOnce: true };
          } else if (cfg.orchestratorConfirm === 'once' && !cfg.orchestratorConfirmedOnce) {
            pendingConfigPatch = { orchestratorConfirmedOnce: true };
          }
        }
        if (reasons.includes('control_tower') || isCtController) {
          entry.ct_confirmed = true;
        }
        entry.offload_mode = true;
        entry.ts = now;
        const savedWs = extractNoteDir(savedPrompt);
        if (savedWs && !entry.note_dir) {
          entry.note_dir = savedWs;
        }
        if (!explicitOffload) {
          steps.push({ userMessage: savedPrompt });
          const savedSig = inputSig(savedPrompt);
          if (savedSig) entry.last_input_sig = savedSig;
          replayedSavedPrompt = true;
        }
        pendingLogs.push(`preinvocation confirm_accepted conv=${conv} reasons=${reasons.join(',')}${permanentConfirm ? ' permanent=1' : ''}`);
        pendingFlight.push({
          level: 'info',
          event: 'confirm_accepted',
          message: `确认开启落盘 (${reasons.join(',')})`,
          detail: { reasons, permanentConfirm, orchMode: cfg.orchestratorConfirm },
        });
      } else {
        delete entry.pending_orch_prompt;
        delete entry.pending_confirm_reasons;
        if (isCtController && !(entry.offload_mode && entry.ct_confirmed)) {
          state[conv] = entry;
          saveState(state);
          pendingLogs.push(`preinvocation confirm_declined_ct conv=${conv}`);
          pendingFlight.push({ level: 'info', event: 'confirm_declined_ct', message: '总控会话放弃开启落盘' });
          return;
        }
      }
    }

    if (explicitOffload) {
      const isOrch = isOrchestratorSession(payload);
      let needsOrchConfirm = false;
      if (isOrch && !entry.orch_confirmed) {
        if (cfg.orchestratorConfirm === 'per_session') {
          needsOrchConfirm = true;
        } else if (cfg.orchestratorConfirm === 'once') {
          needsOrchConfirm = !cfg.orchestratorConfirmedOnce;
        }
      }
      const needsCtConfirm = !entry.ct_confirmed && isCtController;
      if (needsOrchConfirm || needsCtConfirm) {
        const reasons = [];
        if (needsOrchConfirm) reasons.push('orchestrator');
        if (needsCtConfirm) reasons.push('control_tower');
        entry.pending_orch_prompt = lastRaw;
        entry.pending_confirm_reasons = reasons;
        entry.ts = now;
        if (curSig) entry.last_input_sig = curSig;
        state[conv] = entry;
        saveState(state);
        const card = buildRiskConfirmCard(conv, entry, {
          needsOrchConfirm,
          needsCtConfirm,
          orchMode: cfg.orchestratorConfirm,
        });
        pendingLogs.push(`preinvocation confirm_prompt conv=${conv} reasons=${reasons.join(',')}`);
        pendingFlight.push({ level: 'info', event: 'confirm_prompt', message: `弹出零配额风险确认卡 (${reasons.join(',')})`, detail: { reasons, orchMode: cfg.orchestratorConfirm } });
        output = {
          injectSteps: [
            {
              systemMessage: {
                systemMessage: '',
                metadata: { user_markdown: card },
              },
            },
          ],
          terminationBehavior: 'terminate',
        };
        return;
      }
      if (isOrch && !entry.orch_confirmed) {
        entry.orch_confirmed = true;
      }
      entry.offload_mode = true;
    }

    const withinWindow = now - Number(entry.ts || 0) <= retryWindowSec;
    const dead = withinWindow && (Boolean(entry.dead) || Number(entry.tries || 0) > maxRetry);
    const deadReason = entry.dead_reason || 'max_retry';

    if (dead && !replayedSavedPrompt) {
      const nudge = hasInputField && isShortNudge(lastRaw);
      const repeat = hasInputField && Boolean(curSig) && curSig === entry.last_input_sig;
      if (nudge || repeat) {
        const blockKind = repeat && !nudge ? 'repeat' : 'nudge';
        entry.notified = true;
        state[conv] = entry;
        saveState(state);
        const card = buildDeadCard(conv, entry, deadReason, blockKind);
        steps.push({
          systemMessage: {
            systemMessage: '',
            metadata: { user_markdown: card },
          },
        });
        pendingLogs.push(`preinvocation block_${blockKind} conv=${conv} reason=${deadReason}`);
        pendingFlight.push({
          level: 'warn',
          event: `block_${blockKind}`,
          message: `拦截熔断会话空转 (${blockKind}, reason=${deadReason})`,
          detail: { blockKind, deadReason },
        });
        output = { injectSteps: steps, terminationBehavior: 'terminate' };
        return;
      }

      if (curSig) {
        entry.last_input_sig = curSig;
      }
      if (!entry.notified) {
        entry.notified = true;
        const card = buildDeadCard(conv, entry, deadReason, 'pass');
        steps.push({
          systemMessage: {
            systemMessage: '',
            metadata: { user_markdown: card },
          },
        });
        pendingLogs.push(`preinvocation notice conv=${conv} reason=${deadReason}`);
        pendingFlight.push({ level: 'warn', event: 'dead_notice_pass', message: `熔断会话放行全新指令 (reason=${deadReason})` });
      }
    } else if (!replayedSavedPrompt) {
      if (curSig) {
        entry.last_input_sig = curSig;
      }
      entry.ts = now;
    }

    if (withinWindow && entry.defer_alias) {
      delete entry.defer_alias;
      state[conv] = entry;
      saveState(state);
      if (steps.length > 0) {
        output = { injectSteps: steps };
      }
      return;
    }

    const offloadMode = Boolean(entry.offload_mode) || (withinWindow && Number(entry.tries || 0) >= 2);
    const needsRuleInject =
      !entry.alias_injected ||
      Number(entry.rule_rev || 0) < RULE_REV ||
      entry.rule_version !== ruleVersion;
    if (offloadMode && needsRuleInject) {
      const isUpgradeRefresh = Boolean(entry.alias_injected);
      entry.alias_injected = true;
      entry.rule_rev = RULE_REV;
      entry.rule_version = ruleVersion;
      const noteDir = resolveNoteDir(conv, entry, { create: false });
      let ruleTpl = isUpgradeRefresh
        ? `[落盘模式规则已升级 v${pluginVersion}] 请以以下新版规则替代本会话历史消息中的旧版落盘限制：\n${OFFLOAD_RULE}`
        : OFFLOAD_RULE;
      if (cfg.aliasEnabled && hasConfiguredAliases(process.env)) {
        const neturlPath = shortPath(join(getPluginRoot(), 'scripts', 'neturl.mjs'));
        const mapPath = shortPath(getMapPath());
        ruleTpl += ` 涉及已登记的远端地址时按需用 node ${neturlPath} <别名> 解析（映射表 ${mapPath}）。`;
      }
      const rule = applySanitizeIfEnabled(ruleTpl.replaceAll('{dir}', noteDir), process.env, cfg);
      steps.push({ systemMessage: { systemMessage: rule } });
      pendingLogs.push(`preinvocation ${isUpgradeRefresh ? 'rule_refresh' : 'alias'} conv=${conv} ver=${ruleVersion} dir=${noteDir}`);
      pendingFlight.push({
        level: 'info',
        event: isUpgradeRefresh ? 'rule_refresh' : 'rule_inject',
        message: `${isUpgradeRefresh ? '升级刷新' : '注入'}落盘规则 (${ruleVersion}) -> ${noteDir}`,
        detail: { noteDir, ruleRev: RULE_REV, ruleVersion },
      });
    }

    if (offloadMode && !entry.conflict_warned) {
      if (cfg.sanitizeEnabled || cfg.aliasEnabled || wsPaths.length > 0) {
        const conflicts = detectConflicts({
          env: process.env,
          convId: conv,
          workspacePaths: wsPaths,
          hintPath,
          config: cfg,
        });
        if (conflicts.length > 0) {
          entry.conflict_warned = true;
          steps.push({
            systemMessage: {
              systemMessage: '',
              metadata: { user_markdown: buildConflictMarkdown(conflicts) },
            },
          });
          pendingLogs.push(`preinvocation conflict_warn conv=${conv} count=${conflicts.length}`);
          pendingFlight.push({
            level: 'warn',
            event: 'conflict_warn',
            message: `检测到 ${conflicts.length} 条兼容性冲突提示`,
            detail: { codes: conflicts.map((c) => c.code) },
          });
        }
      }
    }

    state[conv] = entry;
    saveState(state);
    if (steps.length > 0) {
      output = { injectSteps: steps };
    }
  });

  if (pendingConfigPatch) {
    try {
      saveConfig(pendingConfigPatch, process.env);
    } catch (err) {
      appendFlightEvent(process.env, {
        level: 'warn',
        source: 'hook-notice',
        event: 'config_persist_warn',
        conv,
        message: err?.message || '持久化确认配置失败',
      });
    }
  }

  const durationMs = Date.now() - t0;
  for (const line of pendingLogs) {
    appendLog(line);
  }
  for (const evItem of pendingFlight) {
    appendFlightEvent(process.env, {
      ...evItem,
      source: 'hook-notice',
      conv,
      durationMs,
    });
  }
  if (!pendingFlight.length && durationMs >= SLOW_OP_THRESHOLD_MS) {
    appendFlightEvent(process.env, {
      level: 'warn',
      source: 'hook-notice',
      event: 'slow_hook',
      conv,
      durationMs,
      message: `PreInvocation hook 执行较慢 (${durationMs}ms)`,
    });
  }
  process.stdout.write(`${JSON.stringify(output || {})}\n`);
}

try {
  main();
} catch (err) {
  appendFlightEvent(process.env, {
    level: 'error',
    source: 'hook-notice',
    event: 'uncaught_error',
    ok: false,
    message: err?.message || String(err),
  });
  process.stdout.write('{}\n');
}
