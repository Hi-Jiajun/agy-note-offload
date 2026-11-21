#!/usr/bin/env node
/**
 * Antigravity SessionStart hook: 普通会话零污染——仅清理同会话残留状态，不提前建目录、不注入额外指令。
 */
import { readFileSync } from 'node:fs';
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
    process.stdout.write('{}\n');
    return;
  }

  const conv = payload.conversationId || '';
  if (conv) {
    withStateLock(() => {
      const state = loadState();
      if (Object.hasOwn(state, conv)) {
        delete state[conv];
        saveState(state);
      }
    });
  }

  appendLog(`sessionstart conv=${conv || 'None'} mode=clean_only`);
  process.stdout.write('{}\n');
}

try {
  main();
} catch {
  process.stdout.write('{}\n');
}
