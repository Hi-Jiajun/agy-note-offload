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
const TAIL_BYTES = 262_144;

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
      explicitOn: hasExplicitOffload(body),
      explicitOff: hasExplicitOffloadOff(body),
    };
  }
  return { sig: '', dir: '', explicitOn: false, explicitOff: false };
}

function scanPlanSlice(recs, fromIdx, toIdx) {
  for (let i = fromIdx; i >= toIdx; i -= 1) {
    const r = recs[i];
    if (r.type === 'SYSTEM_MESSAGE') {
      const c = String(r.content || '');
      if (c.includes('Plan mode is off:')) return false;
      if (c.includes('Plan mode is on:') || c.includes('[plan review]')) return true;
    } else if (r.type === 'PLANNER_RESPONSE' && r.model) {
      const m = String(r.model).toLowerCase();
      if (m.includes('orchestrator')) return true;
      if (m.includes('worker')) return false;
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

  const curTurn = scanPlanSlice(recs, recs.length - 1, lastUserIdx + 1);
  if (curTurn !== null) return curTurn;

  if (lastUserIdx > 0) {
    const prevTurn = scanPlanSlice(recs, lastUserIdx - 1, 0);
    if (prevTurn !== null) return prevTurn;
  }

  return false;
}

function isZeroOutputBlock(rec) {
  const outTokens = rec.output_tokens;
  const thinking = String(rec.thinking || '').trim();
  const toolCalls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
  return (outTokens === null || outTokens === undefined) && !thinking && toolCalls.length === 0;
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

  const recs = tailRecords(transcript);
  if (!recs.length) {
    process.stdout.write('{}\n');
    return;
  }

  const rec = recs[recs.length - 1];
  const now = Date.now() / 1000;
  const cfg = loadConfig(process.env);
  const retryWindowSec = cfg.retryWindowMin * 60;
  const maxRetry = cfg.maxRetry;
  const zeroOutLimit = cfg.zeroOutLimit;
  const longAnswerThreshold = cfg.longAnswerTokens;
  const bigContextThreshold = cfg.bigContextTokens;
  const curStep = rec.step_index;
  const body = typeof rec.content === 'string' ? rec.content : '';
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
      appendLog(`stop conv=${conv} rewind_reset prev_step=${prevStep} cur_step=${curStep}`);
      appendFlightEvent(process.env, {
        level: 'info',
        source: 'hook-retry',
        event: 'rewind_reset',
        conv,
        message: `检测到步数回退 (${prevStep} -> ${curStep})，已重置重试计数`,
      });
      const kept = {};
      for (const k of ['alias_injected', 'offload_mode', 'note_dir', 'orch_confirmed', 'ct_confirmed', 'conflict_warned', 'rule_rev', 'rule_version']) {
        if (entry[k]) kept[k] = entry[k];
      }
      entry = kept;
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
        for (const k of ['tries', 'zero_streak', 'dead', 'dead_reason', 'notified', 'defer_alias']) {
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

    if (!body.includes(MARKER) || body.length > 600) {
      if (Object.hasOwn(state, conv)) {
        const entryKeep = rewound ? {} : { ...state[conv] };
        for (const k of ['tries', 'zero_streak', 'dead', 'dead_reason', 'notified', 'defer_alias']) {
          delete entryKeep[k];
        }
        entryKeep.step = curStep;
        entryKeep.ts = now;
        if (entryKeep.alias_injected || entryKeep.offload_mode || entryKeep.note_dir || entryKeep.orch_confirmed || entryKeep.ct_confirmed || entryKeep.rule_rev || entryKeep.rule_version) {
          state[conv] = entryKeep;
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

    const preserved = {};
    for (const k of ['alias_injected', 'offload_mode', 'note_dir', 'last_input_sig', 'orch_confirmed', 'ct_confirmed', 'conflict_warned', 'rule_rev', 'rule_version']) {
      if (entry[k]) preserved[k] = entry[k];
    }

    entry = withinWindow ? { ...entry } : preserved;

    if (uInfo.sig && !entry.last_input_sig) entry.last_input_sig = uInfo.sig;
    if (uInfo.dir && !entry.note_dir) entry.note_dir = uInfo.dir;
    if (uInfo.explicitOn) entry.offload_mode = true;

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
