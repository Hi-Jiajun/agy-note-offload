import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { atomicWriteSync, withFileLockSync } from './lock.mjs';
import { appendFlightEvent } from './logger.mjs';
import {
  ensureDataDir,
  getLogLockPath,
  getLogPath,
  getStateLockPath,
  getStatePath,
} from './paths.mjs';

export const RETRY_WINDOW_SEC = 15 * 60;
export const TTL_SEC = 7 * 24 * 3600;
export const MAX_LOG_BYTES = 200_000;
export const KEEP_LOG_LINES = 300;
export const IGNORED_CONV_IDS = new Set(['probe', 'selftest', 'None', 'unknown']);

const RESET_KEYS = ['tries', 'zero_streak', 'dead', 'dead_reason', 'notified', 'defer_alias'];

function formatLogTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 获取状态文件排他事务锁，保证 Hooks 与 Sidecar 并发读改写不丢更新。
 * @template T
 * @param {() => T} fn
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {T}
 */
export function withStateLock(fn, env = process.env, options = {}) {
  ensureDataDir(env);
  return withFileLockSync(getStateLockPath(env), fn, {
    ...options,
    onTimeout(info) {
      appendFlightEvent(env, {
        level: 'warn',
        source: 'state',
        event: 'lock_timeout',
        ok: false,
        message: `状态锁获取超时 (${info.timeoutMs}ms, reason=${info.reason})`,
        detail: { lock: 'state', timeoutMs: info.timeoutMs, strict: info.strict },
      });
      if (typeof options.onTimeout === 'function') {
        options.onTimeout(info);
      }
    },
  });
}

/**
 * 读取会话状态文件并自动剔除已过 TTL_SEC 的旧条目。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, any>}
 */
export function loadState(env = process.env) {
  ensureDataDir(env);
  const statePath = getStatePath(env);
  if (!existsSync(statePath)) return {};

  let raw;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const now = Date.now() / 1000;
  const result = {};
  for (const [conv, entry] of Object.entries(raw)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const ts = Number(entry.ts || 0);
      if (now - ts < TTL_SEC) {
        result[conv] = entry;
      }
    }
  }
  return result;
}

/**
 * 原子写入会话状态文件。
 * @param {Record<string, any>} state
 * @param {NodeJS.ProcessEnv} [env]
 */
export function saveState(state, env = process.env) {
  ensureDataDir(env);
  try {
    atomicWriteSync(getStatePath(env), JSON.stringify(state));
  } catch (err) {
    appendFlightEvent(env, {
      level: 'error',
      source: 'state',
      event: 'state_write_error',
      ok: false,
      message: err?.message || '状态文件写入失败',
    });
  }
}

/**
 * 在状态锁保护下执行读-改-写事务；若回调返回 undefined 则不落盘。
 * @template T
 * @param {(state: Record<string, any>) => T} fn
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {T}
 */
export function mutateState(fn, env = process.env) {
  return withStateLock(() => {
    const state = loadState(env);
    const out = fn(state);
    saveState(state, env);
    return out;
  }, env);
}

/**
 * 清除指定会话的重试计数与熔断标记（保留 note_dir 等工作台绑定信息）。
 * @param {string} convId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function resetConvState(convId, env = process.env) {
  return mutateState((state) => {
    const existing = state[convId];
    if (!existing || typeof existing !== 'object') {
      return false;
    }
    const entry = { ...existing };
    for (const k of RESET_KEYS) {
      delete entry[k];
    }
    entry.ts = Date.now() / 1000;
    state[convId] = entry;
    return true;
  }, env);
}

/**
 * 状态文件超过一天未被更新时执行一次过期条目清理。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function housekeeping(env = process.env) {
  const statePath = getStatePath(env);
  const thresholdMs = Date.now() - 86400 * 1000;
  try {
    if (!existsSync(statePath) || statSync(statePath).mtimeMs >= thresholdMs) {
      return;
    }
  } catch {
    return;
  }

  withStateLock(() => {
    try {
      if (existsSync(statePath) && statSync(statePath).mtimeMs < Date.now() - 86400 * 1000) {
        saveState(loadState(env), env);
      }
    } catch {
      // 忽略清理异常
    }
  }, env);
}

/**
 * 计算单会话健康状态标签（OK / OK(offload) / RETRY(N) / DEAD(...)）。
 * @param {Record<string, any> | null | undefined} entry
 * @param {number} [nowSec]
 * @param {number} [retryWindowSec]
 * @returns {string}
 */
export function sessionHealth(entry, nowSec = Date.now() / 1000, retryWindowSec = RETRY_WINDOW_SEC) {
  if (!entry || typeof entry !== 'object') return 'NONE';
  const ts = Number(entry.ts || 0);
  const within = nowSec - ts <= retryWindowSec;
  const tries = Number(entry.tries || 0);
  if (entry.dead && within) {
    return `DEAD(${entry.dead_reason || 'locked'})`;
  }
  if (tries > 0 && within) {
    return `RETRY(${tries})`;
  }
  if (entry.offload_mode) {
    return 'OK(offload)';
  }
  return 'OK';
}

/**
 * 带文件锁追加一行调用日志，超限时自动原子截断保留尾部 KEEP_LOG_LINES 行。
 * @param {string} line
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ maxBytes?: number, keepLines?: number }} [limits]
 */
export function appendLog(line, env = process.env, { maxBytes = MAX_LOG_BYTES, keepLines = KEEP_LOG_LINES } = {}) {
  ensureDataDir(env);
  const logPath = getLogPath(env);
  withFileLockSync(getLogLockPath(env), () => {
    try {
      if (existsSync(logPath) && statSync(logPath).size > maxBytes) {
        const tail = readFileSync(logPath, 'utf-8').split(/\r?\n/).filter(Boolean).slice(-keepLines);
        atomicWriteSync(logPath, tail.length ? `${tail.join('\n')}\n` : '');
      }
      appendFileSync(logPath, `${formatLogTimestamp()} ${line}\n`, 'utf-8');
    } catch (err) {
      appendFlightEvent(env, {
        level: 'error',
        source: 'state',
        event: 'log_write_error',
        ok: false,
        message: err?.message || '调用日志写入失败',
      });
    }
  }, {
    timeoutMs: 1500,
    onTimeout(info) {
      appendFlightEvent(env, {
        level: 'warn',
        source: 'state',
        event: 'lock_timeout',
        ok: false,
        message: `日志锁获取超时 (${info.timeoutMs}ms, reason=${info.reason})`,
        detail: { lock: 'log', timeoutMs: info.timeoutMs },
      });
    },
  });
}

/**
 * 倒序读取最近的调用日志行。
 * @param {number} [limit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function readLogs(limit = 40, env = process.env) {
  ensureDataDir(env);
  const logPath = getLogPath(env);
  if (!existsSync(logPath)) return [];
  try {
    return readFileSync(logPath, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}
