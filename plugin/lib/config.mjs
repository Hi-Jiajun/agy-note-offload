import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteSync, withFileLockSync } from './lock.mjs';
import { appendFlightEvent } from './logger.mjs';
import { ensureDataDir, getConfigLockPath, getConfigPath } from './paths.mjs';

export const VALID_ORCH_CONFIRM = Object.freeze(['once', 'per_session', 'off']);

export const CONFIG_BOUNDS = Object.freeze({
  maxRetry: Object.freeze({ min: 1, max: 5, default: 2 }),
  retryWindowMin: Object.freeze({ min: 1, max: 120, default: 15 }),
  zeroOutLimit: Object.freeze({ min: 1, max: 5, default: 2 }),
  longAnswerTokens: Object.freeze({ min: 200, max: 8000, default: 800 }),
  bigContextTokens: Object.freeze({ min: 20_000, max: 1_000_000, default: 120_000 }),
});

export const DEFAULT_CONFIG = Object.freeze({
  sanitizeEnabled: false,
  aliasEnabled: false,
  orchestratorConfirm: 'once',
  orchestratorConfirmedOnce: false,
  maxRetry: CONFIG_BOUNDS.maxRetry.default,
  retryWindowMin: CONFIG_BOUNDS.retryWindowMin.default,
  zeroOutLimit: CONFIG_BOUNDS.zeroOutLimit.default,
  longAnswerTokens: CONFIG_BOUNDS.longAnswerTokens.default,
  bigContextTokens: CONFIG_BOUNDS.bigContextTokens.default,
});

/**
 * 解析环境变量或文本布尔值。
 * @param {unknown} val
 * @returns {boolean | undefined}
 */
export function parseEnvBool(val) {
  if (typeof val === 'boolean') return val;
  const norm = String(val ?? '').trim().toLowerCase();
  if (norm === '1' || norm === 'true' || norm === 'on') return true;
  if (norm === '0' || norm === 'false' || norm === 'off') return false;
  return undefined;
}

/**
 * 解析 Orchestrator 确认策略（once | per_session | off）。
 * @param {unknown} val
 * @returns {'once' | 'per_session' | 'off' | undefined}
 */
export function parseOrchConfirmMode(val) {
  const norm = String(val ?? '').trim().toLowerCase();
  if (norm === 'once' || norm === 'per_session' || norm === 'off') {
    return norm;
  }
  return undefined;
}

function clampInt(val, { min, max, default: def }) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  const i = Math.round(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function readRawFileConfig(env) {
  const cfgPath = getConfigPath(env);
  if (!existsSync(cfgPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const orchMode = parseOrchConfirmMode(src.orchestratorConfirm) || DEFAULT_CONFIG.orchestratorConfirm;
  return {
    sanitizeEnabled: Boolean(src.sanitizeEnabled ?? DEFAULT_CONFIG.sanitizeEnabled),
    aliasEnabled: Boolean(src.aliasEnabled ?? DEFAULT_CONFIG.aliasEnabled),
    orchestratorConfirm: orchMode,
    orchestratorConfirmedOnce: Boolean(src.orchestratorConfirmedOnce ?? DEFAULT_CONFIG.orchestratorConfirmedOnce),
    maxRetry: clampInt(src.maxRetry, CONFIG_BOUNDS.maxRetry),
    retryWindowMin: clampInt(src.retryWindowMin, CONFIG_BOUNDS.retryWindowMin),
    zeroOutLimit: clampInt(src.zeroOutLimit, CONFIG_BOUNDS.zeroOutLimit),
    longAnswerTokens: clampInt(src.longAnswerTokens, CONFIG_BOUNDS.longAnswerTokens),
    bigContextTokens: clampInt(src.bigContextTokens, CONFIG_BOUNDS.bigContextTokens),
  };
}

/**
 * 严格校验配置补丁对象，非法取值抛出带 HTTP status=400 的异常。
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
export function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    const err = new Error('配置参数必须为对象');
    err.status = 400;
    throw err;
  }
  const out = {};

  for (const boolKey of ['sanitizeEnabled', 'aliasEnabled', 'orchestratorConfirmedOnce']) {
    if (Object.hasOwn(patch, boolKey)) {
      if (typeof patch[boolKey] !== 'boolean') {
        const err = new Error(`${boolKey} 必须为布尔值`);
        err.status = 400;
        throw err;
      }
      out[boolKey] = patch[boolKey];
    }
  }

  if (Object.hasOwn(patch, 'orchestratorConfirm')) {
    const mode = parseOrchConfirmMode(patch.orchestratorConfirm);
    if (!mode) {
      const err = new Error(`orchestratorConfirm 取值非法（需为 ${VALID_ORCH_CONFIRM.join(' / ')}）`);
      err.status = 400;
      throw err;
    }
    out.orchestratorConfirm = mode;
  }

  for (const [numKey, bounds] of Object.entries(CONFIG_BOUNDS)) {
    if (Object.hasOwn(patch, numKey)) {
      const n = Number(patch[numKey]);
      if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
        const err = new Error(`${numKey} 必须为 ${bounds.min} 到 ${bounds.max} 之间的整数`);
        err.status = 400;
        throw err;
      }
      out[numKey] = n;
    }
  }

  return out;
}

/**
 * 读取插件完整配置中心参数，优先叠加环境变量 AGY_OFFLOAD_SANITIZE / AGY_OFFLOAD_ALIAS / AGY_OFFLOAD_ORCH_CONFIRM。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const base = normalizeConfig(readRawFileConfig(env));
  const envSanitize = parseEnvBool(env.AGY_OFFLOAD_SANITIZE);
  const envAlias = parseEnvBool(env.AGY_OFFLOAD_ALIAS);
  const envOrch = parseOrchConfirmMode(env.AGY_OFFLOAD_ORCH_CONFIRM);

  return {
    ...base,
    sanitizeEnabled: envSanitize !== undefined ? envSanitize : base.sanitizeEnabled,
    aliasEnabled: envAlias !== undefined ? envAlias : base.aliasEnabled,
    orchestratorConfirm: envOrch !== undefined ? envOrch : base.orchestratorConfirm,
  };
}

function withConfigLock(fn, env) {
  ensureDataDir(env);
  return withFileLockSync(getConfigLockPath(env), fn, {
    onTimeout(info) {
      appendFlightEvent(env, {
        level: 'warn',
        source: 'config',
        event: 'lock_timeout',
        ok: false,
        message: `配置锁获取超时 (${info.timeoutMs}ms, reason=${info.reason})`,
      });
    },
  });
}

/**
 * 带文件锁合并校验更新并原子写入 config.json。
 * @param {Record<string, unknown>} [patch]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function saveConfig(patch = {}, env = process.env) {
  const validated = validateConfigPatch(patch);
  return withConfigLock(() => {
    const prev = normalizeConfig(readRawFileConfig(env));
    const next = normalizeConfig({ ...prev, ...validated });
    atomicWriteSync(getConfigPath(env), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }, env);
}

/**
 * 一键恢复全部内置默认配置并原子写入 config.json。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resetConfig(env = process.env) {
  return withConfigLock(() => {
    const next = { ...DEFAULT_CONFIG };
    atomicWriteSync(getConfigPath(env), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }, env);
}
