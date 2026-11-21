#!/usr/bin/env node
/**
 * Antigravity PreInvocation hook: 工作台绑定 + Orchestrator 首次确认 + 退出开关 + /compact 解锁 + 防空转 + 按需别名/冲突检测。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasConfiguredAliases } from '../lib/aliases.mjs';
import { loadConfig } from '../lib/config.mjs';
import { detectConflicts } from '../lib/conflicts.mjs';
import { getMapPath, getPluginRoot, shortPath } from '../lib/paths.mjs';
import { applySanitizeIfEnabled } from '../lib/sanitize.mjs';
import {
  appendLog,
  loadState,
  RETRY_WINDOW_SEC,
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
  return Boolean(cleaned) && CONFIRM_WORDS.has(cleaned);
}

function buildOrchRiskCard(conv, entry) {
  const noteDir = resolveNoteDir(conv, entry, { create: false });
  return (
    '> **Orchestrator 模式启用落盘提醒（零配额确认）**：\n' +
    `> 检测到当前会话运行在 \`Orchestrator\` 双阶段模型，目标工作台为 \`${noteDir}\`。\n` +
    '> - 规划阶段只读不可直接写盘，落盘与状态同步会移交执行模型多走一轮；\n' +
    '> - 本插件已采用无损规划交接策略，不会压缩您的规划推理、改法与回退条件；\n' +
    '> - 回复 **`确认`** 或 **`继续`** 将自动带原指令开启落盘模式；如需放弃或切换非 Orchestrator 模型，请直接发新指令。'
  );
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
  const payload = readStdinJson();
  if (!payload) {
    process.stdout.write('{}\n');
    return;
  }

  const ev = String(payload.hookEventName || '');
  if (ev && ev !== EXPECTED) {
    appendLog(`${EXPECTED} 事件不匹配 hookEventName=${ev}`);
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
    }
    process.stdout.write('{}\n');
    return;
  }

  const wsDir = extractNoteDir(lastRaw);
  const explicitOff = hasExplicitOffloadOff(lastRaw);
  const explicitOffload = hasExplicitOffload(lastRaw);
  const curSig = hasInputField ? inputSig(lastRaw) : '';

  let output = null;
  const pendingLogs = [];

  withStateLock(() => {
    const state = loadState();
    let entry = state[conv];
    const now = Date.now() / 1000;

    if (explicitOff) {
      const next = entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry } : {};
      next.offload_mode = false;
      next.ts = now;
      if (wsDir) next.note_dir = wsDir;
      if (curSig) next.last_input_sig = curSig;
      delete next.alias_injected;
      delete next.pending_orch_prompt;
      delete next.defer_alias;
      delete next.conflict_warned;
      state[conv] = next;
      saveState(state);
      const offMsg = applySanitizeIfEnabled(OFFLOAD_OFF_RULE, process.env, cfg);
      pendingLogs.push(`preinvocation offload_off conv=${conv}`);
      output = { injectSteps: [{ systemMessage: { systemMessage: offMsg } }] };
      return;
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
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
        return;
      }
    } else {
      entry = { ...entry };
    }

    const initSteps = payload.initialNumSteps;
    const prevStep = entry.step;
    if (Number.isInteger(initSteps) && Number.isInteger(prevStep) && initSteps <= prevStep) {
      pendingLogs.push(`preinvocation rewind_reset conv=${conv} prev_step=${prevStep} init_steps=${initSteps}`);
      if (explicitOffload || wsDir) {
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

    if (wsDir && entry.note_dir !== wsDir) {
      entry.note_dir = wsDir;
    }

    const steps = [];
    let replayedSavedPrompt = false;

    if (entry.pending_orch_prompt) {
      if ((hasInputField && isConfirmWord(lastRaw)) || explicitOffload) {
        const savedPrompt = entry.pending_orch_prompt;
        delete entry.pending_orch_prompt;
        entry.orch_confirmed = true;
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
        pendingLogs.push(`preinvocation orch_confirmed conv=${conv}`);
      } else {
        delete entry.pending_orch_prompt;
      }
    }

    if (explicitOffload && !entry.orch_confirmed && isOrchestratorSession(payload)) {
      entry.pending_orch_prompt = lastRaw;
      entry.ts = now;
      if (curSig) entry.last_input_sig = curSig;
      state[conv] = entry;
      saveState(state);
      const card = buildOrchRiskCard(conv, entry);
      pendingLogs.push(`preinvocation orch_confirm_prompt conv=${conv}`);
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

    if (explicitOffload) {
      entry.offload_mode = true;
    }

    const withinWindow = now - Number(entry.ts || 0) <= RETRY_WINDOW_SEC;
    const dead = withinWindow && (Boolean(entry.dead) || Number(entry.tries || 0) > 2);
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
    if (offloadMode && !entry.alias_injected) {
      entry.alias_injected = true;
      const noteDir = resolveNoteDir(conv, entry, { create: false });
      let ruleTpl = OFFLOAD_RULE;
      if (cfg.aliasEnabled && hasConfiguredAliases(process.env)) {
        const neturlPath = shortPath(join(getPluginRoot(), 'scripts', 'neturl.mjs'));
        const mapPath = shortPath(getMapPath());
        ruleTpl += ` 涉及已登记的远端地址时按需用 node ${neturlPath} <别名> 解析（映射表 ${mapPath}）。`;
      }
      const rule = applySanitizeIfEnabled(ruleTpl.replaceAll('{dir}', noteDir), process.env, cfg);
      steps.push({ systemMessage: { systemMessage: rule } });
      pendingLogs.push(`preinvocation alias conv=${conv} dir=${noteDir}`);
    }

    if (offloadMode && !entry.conflict_warned) {
      const wsPaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
      if (cfg.sanitizeEnabled || cfg.aliasEnabled || wsPaths.length > 0) {
        const conflicts = detectConflicts({
          env: process.env,
          convId: conv,
          workspacePaths: wsPaths,
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
        }
      }
    }

    state[conv] = entry;
    saveState(state);
    if (steps.length > 0) {
      output = { injectSteps: steps };
    }
  });

  for (const line of pendingLogs) {
    appendLog(line);
  }
  process.stdout.write(`${JSON.stringify(output || {})}\n`);
}

try {
  main();
} catch {
  process.stdout.write('{}\n');
}
