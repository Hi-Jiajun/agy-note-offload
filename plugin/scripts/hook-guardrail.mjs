#!/usr/bin/env node
/**
 * Antigravity SessionStart hook: 普通会话零污染——仅清理同会话残留状态，不提前建目录、不注入额外指令。
 */
import { readFileSync } from 'node:fs';
import { appendFlightEvent, touchHookHeartbeat } from '../lib/logger.mjs';
import { appendLog, loadState, saveState, withStateLock } from '../lib/state.mjs';

const EXPECTED = 'SessionStart';

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function main() {
  const payload = readStdinJson();
  const ev = String(payload.hookEventName || '');
  if (ev && ev !== EXPECTED) {
    appendLog(`${EXPECTED} 事件不匹配 hookEventName=${ev}`);
    appendFlightEvent(process.env, {
      level: 'warn',
      source: 'hook-guardrail',
      event: 'event_mismatch',
      ok: false,
      message: `${EXPECTED} 事件不匹配 hookEventName=${ev}`,
    });
    process.stdout.write('{}\n');
    return;
  }

  touchHookHeartbeat(process.env, { event: EXPECTED, hook: 'hook-guardrail' });

  const conv = payload.conversationId || '';
  let cleaned = false;
  if (conv) {
    withStateLock(() => {
      const state = loadState();
      if (Object.hasOwn(state, conv)) {
        delete state[conv];
        saveState(state);
        cleaned = true;
      }
    });
  }

  if (cleaned) {
    appendLog(`sessionstart conv=${conv} mode=cleaned_stale`);
    appendFlightEvent(process.env, {
      level: 'info',
      source: 'hook-guardrail',
      event: 'session_clean',
      conv,
      message: 'SessionStart 清理同会话残留状态',
    });
  }
  process.stdout.write('{}\n');
}

try {
  main();
} catch (err) {
  appendFlightEvent(process.env, {
    level: 'error',
    source: 'hook-guardrail',
    event: 'uncaught_error',
    ok: false,
    message: err?.message || String(err),
  });
  process.stdout.write('{}\n');
}
