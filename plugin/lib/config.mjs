import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteSync, withFileLockSync } from './lock.mjs';
import { ensureDataDir, getConfigLockPath, getConfigPath } from './paths.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  sanitizeEnabled: false,
  aliasEnabled: false,
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

/**
 * 读取插件可选项配置，优先叠加环境变量 AGY_OFFLOAD_SANITIZE / AGY_OFFLOAD_ALIAS。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ sanitizeEnabled: boolean, aliasEnabled: boolean }}
 */
export function loadConfig(env = process.env) {
  const raw = readRawFileConfig(env);
  const envSanitize = parseEnvBool(env.AGY_OFFLOAD_SANITIZE);
  const envAlias = parseEnvBool(env.AGY_OFFLOAD_ALIAS);

  return {
    sanitizeEnabled: envSanitize !== undefined ? envSanitize : Boolean(raw.sanitizeEnabled ?? DEFAULT_CONFIG.sanitizeEnabled),
    aliasEnabled: envAlias !== undefined ? envAlias : Boolean(raw.aliasEnabled ?? DEFAULT_CONFIG.aliasEnabled),
  };
}

/**
 * 带文件锁合并更新并原子写入 config.json。
 * @param {{ sanitizeEnabled?: boolean, aliasEnabled?: boolean }} [patch]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ sanitizeEnabled: boolean, aliasEnabled: boolean }}
 */
export function saveConfig(patch = {}, env = process.env) {
  ensureDataDir(env);
  return withFileLockSync(getConfigLockPath(env), () => {
    const prev = readRawFileConfig(env);
    const next = {
      sanitizeEnabled: Boolean(prev.sanitizeEnabled ?? DEFAULT_CONFIG.sanitizeEnabled),
      aliasEnabled: Boolean(prev.aliasEnabled ?? DEFAULT_CONFIG.aliasEnabled),
    };
    if (patch && typeof patch === 'object') {
      if (Object.hasOwn(patch, 'sanitizeEnabled') && typeof patch.sanitizeEnabled === 'boolean') {
        next.sanitizeEnabled = patch.sanitizeEnabled;
      }
      if (Object.hasOwn(patch, 'aliasEnabled') && typeof patch.aliasEnabled === 'boolean') {
        next.aliasEnabled = patch.aliasEnabled;
      }
    }
    atomicWriteSync(getConfigPath(env), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
