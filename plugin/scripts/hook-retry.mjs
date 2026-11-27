#!/usr/bin/env node
/**
 * Antigravity Stop hook: 仅管理已开启落盘或非总控绑定会话，2 档续跑 + 跨轮 Plan Mode 分流 + 连续递增 turn-N + 快速熔断。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { loadConfig } from '../lib/config.mjs';
import { isActiveControlTowerController } from '../lib/conflicts.mjs';
import { appendFlightEvent, SLOW_OP_THRESHOLD_MS, touchHookHeartbeat } from '../lib/logger.mjs';
import { applySanitizeIfEnabled } from '../lib/sanitize.mjs';
import {
  appendLog,
  housekeeping,
  loadState,
  saveState,
  withStateLock,
} from '../lib/state.mjs';
import {
  extractNoteDir,
  hasExplicitOffload,
  hasExplicitOffloadOff,
  inputSig,
  nextTurnIndex,
  resolveNoteDir,
} from '../lib/workspace.mjs';

const EXPECTED = 'Stop';
const MARKER = 'blocked by Gemini';
const SKIP_REASONS = new Set([
  'user_canceled',
  'user_cancelled',
  'terminal_custom_hook',
  'injected_response',
]);

const REWORD =
  '[重写] 请换平实简短的中文重述本轮结论、错误码与下一步，先给结论再分条，控制在 5 行内。';

const OFFLOAD_MODE =
  '[落盘] 本步仅调用 write_file 将目前已查实的结论、数据与下一步写入 {dir}/turn-{n}.md ' +
  '并同步更新 {dir}/status.md（不要再调 run_command 执行新命令）；写完后正文控制在 1~3 行（150 字内结论与可点击路径链接）。';

const PLAN_OFFLOAD_MODE =
  '[规划精简] 当前处于只读规划阶段（不可直接写文件）。若仍有待执行步骤，请调用 exit_plan_mode ' +
  '且计划参数控制在 5~10 行内（简明写出核心结论、目标文件路径、行号与验证判据，将写入 {dir}/turn-{n}.md 与 status.md 交给执行阶段）；' +
  '若已全部完工，正文只回 1~3 行结论与 {dir}/status.md 链接。';

const USER_REQ_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;
const FAST_TAIL_BYTES = 16_384;
const TAIL_BYTES = 262_144;
const EXIT_PLAN_TOOLS = new Set(['exit_plan_mode']);
const ENTER_PLAN_TOOLS = new Set(['enter_plan_mode']);
const DUAL_PHASE_TOOLS = new Set(['exit_plan_mode', 'enter_plan_mode']);

function hasToolCall(rec, names) {
  const calls = Array.isArray(rec?.tool_calls) ? rec.tool_calls : [];
  for (const c of calls) {
    const name = String(
      typeof c === 'string' ? c : (c?.name || c?.tool_name || c?.function?.name || ''),
    ).toLowerCase();
    if (name && names.has(name)) return true;
  }
  return false;
}

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

function readLastRecordFast(transcriptPath) {
  let fd = -1;
  try {
    const size = statSync(transcriptPath).size;
    if (size <= 0) return { rec: null, needsFull: false };
    const start = Math.max(0, size - FAST_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(transcriptPath, 'r');
    const bytesRead = readSync(fd, buf, 0, len, start);
    const lines = buf.subarray(0, bytesRead).toString('utf-8').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith('{')) {
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
            return { rec, needsFull: false };
          }
        } catch {
          // 末尾单条记录超过 16 KB 被截断或损坏时回退全窗解析
        }
      }
      return { rec: null, needsFull: size > FAST_TAIL_BYTES };
    }
    return { rec: null, needsFull: false };
  } catch {
    return { rec: null, needsFull: false };
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

function tailRecords(transcriptPath) {
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
        // 截断首行或损坏记录直接跳过
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

function extractLastUserInfo(recs) {
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const r = recs[i];
    if (r.type !== 'USER_INPUT') continue;
    const raw = typeof r.content === 'string' ? r.content : '';
    const match = USER_REQ_RE.exec(raw);
    const body = match ? match[1].trim() : raw.trim();
    return {
      sig: inputSig(body),
      dir: extractNoteDir(body),
      body,
      explicitOn: hasExplicitOffload(body),
      explicitOff: hasExplicitOffloadOff(body),
    };
  }
  return { sig: '', dir: '', body: '', explicitOn: false, explicitOff: false };
}

function isDualPhaseSession(recs) {
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    const r = recs[i];
    if (r.type === 'SYSTEM_MESSAGE') {
      const c = String(r.content || '');
      if (c.includes('Plan mode is off:') || c.includes('Plan mode is on:') || c.includes('[plan review]')) {
        return true;
      }
    } else if (r.type === 'PLANNER_RESPONSE') {
      if (hasToolCall(r, DUAL_PHASE_TOOLS)) return true;
      if (r.model) {
        const m = String(r.model).toLowerCase();
        if (m.includes('orchestrator') || m.includes('worker')) return true;
      }
    }
  }
  return false;
}

function scanPlanSlice(recs, fromIdx, toIdx, lastIdx = recs.length - 1) {
  for (let i = fromIdx; i >= toIdx; i -= 1) {
    const r = recs[i];
    if (r.type === 'SYSTEM_MESSAGE') {
      const c = String(r.content || '');
      if (c.includes('Plan mode is off:')) return false;
      if (c.includes('Plan mode is on:') || c.includes('[plan review]')) return true;
    } else if (r.type === 'PLANNER_RESPONSE') {
      if (i < lastIdx) {
        if (hasToolCall(r, ENTER_PLAN_TOOLS)) return true;
        if (hasToolCall(r, EXIT_PLAN_TOOLS)) return false;
      }
      if (r.model) {
        const m = String(r.model).toLowerCase();
        if (m.includes('orchestrator')) return true;
        if (m.includes('worker')) return false;
      }
    }
  }
  return null;
}

function isPlanMode(rec, recs) {
  const curModel = String(rec.model || '').toLowerCase();
  if (curModel.includes('orchestrator')) return true;
  if (curModel.includes('worker')) return false;

  let lastUserIdx = -1;
  for (let i = recs.length - 1; i >= 0; i -= 1) {
    if (recs[i].type === 'USER_INPUT') {
      lastUserIdx = i;
      break;
    }
  }

  const curTurn = scanPlanSlice(recs, recs.length - 1, lastUserIdx + 1, recs.length - 1);
  if (curTurn !== null) return curTurn;

  if (!isDualPhaseSession(recs)) return false;

  if (lastUserIdx >= 0) {
    // 新版双阶段 Orchestrator 每次新 USER_INPUT 自动回到 Plan Mode（不再重复发 Plan mode is on:），
    // 绝不跨过 lastUserIdx 继承上一轮的 Plan mode is off:
    return !curModel.includes('hydrogen');
  }

  return false;
}

function isZeroOutputBlock(rec) {
  const outTokens = rec.output_tokens;
  const thinking = String(rec.thinking || '').trim();
  const toolCalls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
  return (outTokens === null || outTokens === undefined) && !thinking && toolCalls.length === 0;
}

const PERSISTED_KEYS = [
  'alias_injected',
  'offload_mode',
  'note_dir',
  'orch_confirmed',
  'ct_confirmed',
  'conflict_warned',
  'pending_orch_prompt',
  'offload_step',
  'rule_inject_step',
  'bind_step',
  'rule_rev',
  'rule_version',
];

const SEMANTIC_PERSISTED_KEYS = [
  'alias_injected',
  'offload_mode',
  'note_dir',
  'orch_confirmed',
  'ct_confirmed',
  'pending_orch_prompt',
  'rule_rev',
  'rule_version',
];

const RETRY_RESET_KEYS = ['tries', 'zero_streak', 'dead', 'dead_reason', 'notified', 'defer_alias'];

function copyPersistedKeys(entry, extraKeys = []) {
  const out = {};
  for (const k of [...PERSISTED_KEYS, ...extraKeys]) {
    if (k.endsWith('_step')) {
      if (Number.isInteger(entry[k])) out[k] = entry[k];
    } else if (entry[k]) {
      out[k] = entry[k];
    }
  }
  return out;
}

function applyStopRewind(entry, curStep) {
  const offloadStep = Number.isInteger(entry.offload_step) ? entry.offload_step : 0;
  const ruleInjectStep = Number.isInteger(entry.rule_inject_step) ? entry.rule_inject_step : offloadStep;
  const bindStep = Number.isInteger(entry.bind_step) ? entry.bind_step : offloadStep;
  const rewoundPastOffload = Boolean(entry.offload_mode) && curStep < offloadStep;
  const rewoundPastRule = Boolean(entry.alias_injected) && curStep < ruleInjectStep;

  const next = copyPersistedKeys(entry);
  if (rewoundPastOffload) {
    delete next.offload_mode;
    delete next.offload_step;
    delete next.alias_injected;
    delete next.rule_rev;
    delete next.rule_version;
    delete next.rule_inject_step;
  } else if (rewoundPastRule) {
    delete next.alias_injected;
    delete next.rule_rev;
    delete next.rule_version;
    delete next.rule_inject_step;
  }

  const rewoundPastBind = Boolean(next.note_dir) && !next.offload_mode && curStep < bindStep;
  if (rewoundPastBind) {
    delete next.note_dir;
    delete next.bind_step;
  }

  return {
    next,
    scope: rewoundPastOffload || rewoundPastBind ? 'full' : 'retry_only',
  };
}

function finishHook({ t0, conv, decisionPayload, logLine, flightEvent }) {
  const durationMs = Date.now() - t0;
  if (logLine) {
    appendLog(logLine);
  }
  if (flightEvent) {
    appendFlightEvent(process.env, { ...flightEvent, durationMs });
  } else if (durationMs >= SLOW_OP_THRESHOLD_MS) {
    appendFlightEvent(process.env, {
      level: 'warn',
      source: 'hook-retry',
      event: 'slow_hook',
      conv,
      durationMs,
      message: `Stop hook 执行较慢 (${durationMs}ms)`,
    });
  }
  if (!decisionPayload) {
    process.stdout.write('{}\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(decisionPayload)}\n`);
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
      source: 'hook-retry',
      event: 'event_mismatch',
      ok: false,
      message: `${EXPECTED} 事件不匹配 hookEventName=${ev}`,
    });
    process.stdout.write('{}\n');
    return;
  }

  touchHookHeartbeat(process.env, { event: EXPECTED, hook: 'hook-retry' });

  const conv = payload.conversationId || 'unknown';
  const reasonTag = String(payload.terminationReason || '');
  if (SKIP_REASONS.has(reasonTag.toLowerCase())) {
    process.stdout.write('{}\n');
    return;
  }

  housekeeping();

  const transcript = payload.transcriptPath || '';
  if (!transcript || !existsSync(transcript)) {
    process.stdout.write('{}\n');
    return;
  }

  const fast = readLastRecordFast(transcript);
  let recs = null;
  let rec = fast.rec;
  if (fast.needsFull) {
    recs = tailRecords(transcript);
    rec = recs.length ? recs[recs.length - 1] : null;
  }
  if (!rec) {
    process.stdout.write('{}\n');
    return;
  }

  const now = Date.now() / 1000;
  const curStep = rec.step_index;
  const body = typeof rec.content === 'string' ? rec.content : '';
  const isBlocked = body.includes(MARKER) && body.length <= 600;

  if (!isBlocked) {
    const preState = loadState();
    if (!Object.hasOwn(preState, conv)) {
      finishHook({ t0, conv, decisionPayload: null, logLine: '', flightEvent: null });
      return;
    }

    withStateLock(() => {
      const state = loadState();
      if (!Object.hasOwn(state, conv)) return;
      const entry = state[conv] && typeof state[conv] === 'object' ? state[conv] : {};
      const prevStep = entry.step;
      const rewound = Number.isInteger(curStep) && Number.isInteger(prevStep) && curStep < prevStep;
      let next;
      if (rewound) {
        const res = applyStopRewind(entry, curStep);
        next = res.next;
        appendLog(`stop conv=${conv} rewind_reset prev_step=${prevStep} cur_step=${curStep} scope=${res.scope}`);
        appendFlightEvent(process.env, {
          level: 'info',
          source: 'hook-retry',
          event: 'rewind_reset',
          conv,
          message: `检测到步数回退 (${prevStep} -> ${curStep})，${res.scope === 'full' ? '已重置落盘态' : '已重置重试计数并保留落盘态'}`,
          detail: { prevStep, curStep, scope: res.scope },
        });
      } else {
        next = { ...entry };
        for (const k of RETRY_RESET_KEYS) {
          delete next[k];
        }
      }
      next.step = curStep;
      next.ts = now;
      if (SEMANTIC_PERSISTED_KEYS.some((k) => Boolean(next[k]))) {
        state[conv] = next;
      } else {
        delete state[conv];
      }
      saveState(state);
    });

    finishHook({ t0, conv, decisionPayload: null, logLine: '', flightEvent: null });
    return;
  }

  if (!recs) {
    recs = tailRecords(transcript);
    if (!recs.length) {
      finishHook({ t0, conv, decisionPayload: null, logLine: '', flightEvent: null });
      return;
    }
    rec = recs[recs.length - 1];
  }

  const cfg = loadConfig(process.env);
  const retryWindowSec = cfg.retryWindowMin * 60;
  const maxRetry = cfg.maxRetry;
  const zeroOutLimit = cfg.zeroOutLimit;
  const longAnswerThreshold = cfg.longAnswerTokens;
  const bigContextThreshold = cfg.bigContextTokens;
  const uInfo = extractLastUserInfo(recs);
  const wsPaths = [
    ...new Set(
      [
        ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
        ...(payload.cwd ? [payload.cwd] : []),
      ].filter((p) => typeof p === 'string' && p.trim()),
    ),
  ];
  const isCtController = isActiveControlTowerController({
    convId: conv,
    workspacePaths: wsPaths,
    env: process.env,
    hintPath: transcript,
    lastUserInput: uInfo.body,
  });

  let decisionPayload = null;
  let logLine = '';
  let flightEvent = null;

  withStateLock(() => {
    const state = loadState();
    let entry = state[conv] && typeof state[conv] === 'object' ? state[conv] : {};
    const prevStep = entry.step;

    const rewound = Number.isInteger(curStep) && Number.isInteger(prevStep) && curStep < prevStep;
    if (rewound) {
      const res = applyStopRewind(entry, curStep);
      appendLog(`stop conv=${conv} rewind_reset prev_step=${prevStep} cur_step=${curStep} scope=${res.scope}`);
      appendFlightEvent(process.env, {
        level: 'info',
        source: 'hook-retry',
        event: 'rewind_reset',
        conv,
        message: `检测到步数回退 (${prevStep} -> ${curStep})，${res.scope === 'full' ? '已重置落盘态' : '已重置重试计数并保留落盘态'}`,
        detail: { prevStep, curStep, scope: res.scope },
      });
      entry = res.next;
    }

    if (isCtController && !(entry.offload_mode && entry.ct_confirmed)) {
      return;
    }

    const managed =
      !uInfo.explicitOff &&
      (Boolean(entry.offload_mode) || Boolean(entry.note_dir) || Boolean(uInfo.dir) || Boolean(uInfo.explicitOn));

    if (!managed) {
      if (Object.hasOwn(state, conv)) {
        const keep = { ...entry };
        for (const k of RETRY_RESET_KEYS) {
          delete keep[k];
        }
        if (keep.offload_mode || keep.note_dir) {
          keep.step = curStep;
          keep.ts = now;
          state[conv] = keep;
        } else {
          delete state[conv];
        }
        saveState(state);
      }
      return;
    }

    const withinWindow = !rewound && (now - Number(entry.ts || 0) <= retryWindowSec);
    const zeroOut = isZeroOutputBlock(rec);
    let tries;
    let zeroStreak;
    if (withinWindow) {
      tries = Number(entry.tries || 0) + 1;
      zeroStreak = zeroOut ? Number(entry.zero_streak || 0) + 1 : 0;
    } else {
      tries = 1;
      zeroStreak = zeroOut ? 1 : 0;
    }

    const preserved = copyPersistedKeys(entry, ['last_input_sig']);

    entry = withinWindow ? { ...entry } : preserved;

    if (uInfo.sig && !entry.last_input_sig) entry.last_input_sig = uInfo.sig;
    if (uInfo.dir && !entry.note_dir) entry.note_dir = uInfo.dir;
    if (uInfo.explicitOn) {
      entry.offload_mode = true;
      if (!Number.isInteger(entry.offload_step)) entry.offload_step = 0;
    }

    entry.step = curStep;
    entry.tries = tries;
    entry.zero_streak = zeroStreak;
    entry.ts = now;

    if (zeroStreak >= zeroOutLimit) {
      delete entry.defer_alias;
      entry.dead = true;
      entry.dead_reason = 'context_locked';
      state[conv] = entry;
      saveState(state);
      logLine = `stop conv=${conv} ladder=dead reason=context_locked tries=${tries} zero_streak=${zeroStreak}`;
      flightEvent = {
        level: 'error',
        source: 'hook-retry',
        event: 'circuit_breaker',
        ok: false,
        conv,
        message: `连续零输出熔断 (tries=${tries}, zero_streak=${zeroStreak})`,
        detail: { reason: 'context_locked', tries, zeroStreak },
      };
      return;
    }

    if (tries > maxRetry) {
      delete entry.defer_alias;
      entry.dead = true;
      entry.dead_reason = 'max_retry';
      state[conv] = entry;
      saveState(state);
      logLine = `stop conv=${conv} ladder=dead reason=max_retry tries=${tries}`;
      flightEvent = {
        level: 'error',
        source: 'hook-retry',
        event: 'circuit_breaker',
        ok: false,
        conv,
        message: `达到重试上限熔断 (tries=${tries})`,
        detail: { reason: 'max_retry', tries },
      };
      return;
    }

    const planMode = isPlanMode(rec, recs);
    const longAnswer = Number(rec.output_tokens || 0) >= longAnswerThreshold;
    const totalCtx = Number(rec.input_tokens || 0) + Number(rec.cache_read_tokens || 0);
    const bigCtx = totalCtx >= bigContextThreshold;

    let tier;
    let reasonTpl;
    let noteDir;
    if (planMode) {
      tier = 'plan';
      reasonTpl = PLAN_OFFLOAD_MODE;
      entry.offload_mode = true;
      entry.defer_alias = true;
      noteDir = resolveNoteDir(conv, entry, { create: false });
    } else if (tries === 1 && !longAnswer && !bigCtx) {
      tier = 1;
      reasonTpl = REWORD;
      delete entry.defer_alias;
      noteDir = resolveNoteDir(conv, entry, { create: false });
    } else {
      tier = 2;
      reasonTpl = OFFLOAD_MODE;
      entry.offload_mode = true;
      entry.defer_alias = true;
      noteDir = resolveNoteDir(conv, entry, { create: true });
    }

    const turnNum = nextTurnIndex(conv, entry, process.env);

    state[conv] = entry;
    saveState(state);

    const reasonRaw = reasonTpl
      .replaceAll('{dir}', noteDir)
      .replaceAll('{n}', String(turnNum));
    const reason = applySanitizeIfEnabled(reasonRaw, process.env);
    logLine =
      `stop conv=${conv} tier=${tier} plan=${Number(planMode)} ` +
      `long=${Number(longAnswer)} big=${Number(bigCtx)} ctx=${totalCtx} zero_out=${Number(zeroOut)} turn=${turnNum} dir=${noteDir}`;
    flightEvent = {
      level: 'warn',
      source: 'hook-retry',
      event: 'stop_retry',
      conv,
      message: `触发分级续跑 tier=${tier} turn=${turnNum}`,
      detail: { tier, planMode, longAnswer, bigCtx, totalCtx, zeroOut, turnNum, noteDir },
    };
    decisionPayload = { decision: 'continue', reason };
  });

  finishHook({ t0, conv, decisionPayload, logLine, flightEvent });
}

try {
  main();
} catch (err) {
  appendFlightEvent(process.env, {
    level: 'error',
    source: 'hook-retry',
    event: 'uncaught_error',
    ok: false,
    message: err?.message || String(err),
  });
  process.stdout.write('{}\n');
}
