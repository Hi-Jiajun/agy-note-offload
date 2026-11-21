import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteSync, withFileLockSync } from './lock.mjs';
import {
  ensureDataDir,
  getExampleMapPath,
  getMapLockPath,
  getMapPath,
} from './paths.mjs';

export const ALIAS_KEY_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const HEX8_CONV_RE = /^[0-9a-f]{8}$/i;
export const RESERVED_ALIAS_KEYS = new Set([
  'http', 'https', 'file', 'sidecar', 'conversation', 'localhost',
  'agy', 'agynote', 'agysum', 'neturl', 'compact', 'plan', 'boost',
  'swarm', 'teamwork', 'goal',
]);

function validateAliasInput(key, value, note) {
  const cleanKey = String(key || '').trim();
  const cleanVal = String(value || '').trim();
  const cleanNote = String(note || '').trim().replace(/[\r\n\t]+/g, ' ');

  if (!ALIAS_KEY_RE.test(cleanKey)) {
    const err = new Error('别名非法（仅支持 1 到 32 位字母、数字、点、下划线或连字符）');
    err.status = 400;
    throw err;
  }
  if (RESERVED_ALIAS_KEYS.has(cleanKey.toLowerCase())) {
    const err = new Error('别名与官方协议或保留命令冲突');
    err.status = 400;
    throw err;
  }
  if (!cleanVal || /[\r\n\t]/.test(cleanVal)) {
    const err = new Error('真值不能为空且不得包含换行或制表符');
    err.status = 400;
    throw err;
  }
  return { key: cleanKey, value: cleanVal, note: cleanNote };
}

function parseMapText(raw) {
  const rows = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = line.split('\t');
    const key = (parts[0] || '').trim();
    const value = (parts[1] || '').trim();
    const note = (parts[2] || '').trim();
    if (key && value) {
      rows.push({ key, value, note });
    }
  }
  return rows;
}

function writeAliasesRaw(rows, env) {
  const mapPath = getMapPath(env);
  const header = '# 别名\t真值\t备注\n';
  const body = rows.map((r) => `${r.key}\t${r.value}\t${r.note || ''}`).join('\n');
  atomicWriteSync(mapPath, header + (body ? `${body}\n` : ''));
}

function loadRowsForMutation(env) {
  ensureDataDir(env);
  const mapPath = getMapPath(env);
  if (existsSync(mapPath)) {
    return parseMapText(readFileSync(mapPath, 'utf-8'));
  }
  const exPath = getExampleMapPath(env);
  if (existsSync(exPath)) {
    return parseMapText(readFileSync(exPath, 'utf-8'));
  }
  return [];
}

/**
 * 读取别名映射列表（数据目录尚无 net-map.tsv 时可选回退读取示例表）。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fallbackExample?: boolean }} [options]
 * @returns {Array<{ key: string, value: string, note: string }>}
 */
export function readAliases(env = process.env, { fallbackExample = true } = {}) {
  ensureDataDir(env);
  const mapPath = getMapPath(env);
  const exPath = getExampleMapPath(env);
  const target = existsSync(mapPath) ? mapPath : (fallbackExample && existsSync(exPath) ? exPath : '');
  if (!target) return [];
  try {
    return parseMapText(readFileSync(target, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * 检查用户数据目录是否已配置真实且非空的 net-map.tsv。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function hasConfiguredAliases(env = process.env) {
  const mapPath = getMapPath(env);
  if (!existsSync(mapPath)) return false;
  return readAliases(env, { fallbackExample: false }).length > 0;
}

/**
 * 严格新增别名：在文件锁内检查重名，若已存在则抛错（供 neturl --set 使用）。
 * @param {string} key
 * @param {string} value
 * @param {string} [note]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ key: string, value: string, note: string }>}
 */
export function addAliasStrict(key, value, note = '', env = process.env) {
  const item = validateAliasInput(key, value, note);
  ensureDataDir(env);
  return withFileLockSync(getMapLockPath(env), () => {
    const rows = loadRowsForMutation(env);
    if (rows.some((r) => r.key === item.key)) {
      const err = new Error(`别名已存在: ${item.key}`);
      err.status = 409;
      throw err;
    }
    rows.push(item);
    writeAliasesRaw(rows, env);
    return rows;
  });
}

/**
 * 幂等写入或更新别名（带文件锁，供 Sidecar 使用）。
 * @param {string} key
 * @param {string} value
 * @param {string} [note]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ key: string, value: string, note: string }>}
 */
export function upsertAlias(key, value, note = '', env = process.env) {
  const item = validateAliasInput(key, value, note);
  ensureDataDir(env);
  return withFileLockSync(getMapLockPath(env), () => {
    const rows = loadRowsForMutation(env);
    const idx = rows.findIndex((r) => r.key === item.key);
    if (idx >= 0) {
      rows[idx] = item;
    } else {
      rows.push(item);
    }
    writeAliasesRaw(rows, env);
    return rows;
  });
}

/**
 * 带文件锁删除别名。
 * @param {string} key
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ key: string, value: string, note: string }>}
 */
export function deleteAlias(key, env = process.env) {
  const cleanKey = String(key || '').trim();
  if (!ALIAS_KEY_RE.test(cleanKey)) {
    const err = new Error('别名非法');
    err.status = 400;
    throw err;
  }
  ensureDataDir(env);
  return withFileLockSync(getMapLockPath(env), () => {
    const rows = loadRowsForMutation(env).filter((r) => r.key !== cleanKey);
    writeAliasesRaw(rows, env);
    return rows;
  });
}

/**
 * 解析别名并拼接可选路径后缀（严格仅读实际 net-map.tsv，不把示例表当真实数据）。
 * @param {string} key
 * @param {string} [suffix]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean, url?: string, code?: number, error?: string }}
 */
export function resolveAlias(key, suffix = '', env = process.env) {
  ensureDataDir(env);
  const mapPath = getMapPath(env);
  if (!existsSync(mapPath)) {
    return { ok: false, code: 2, error: `尚无别名表: ${mapPath}` };
  }
  const rows = parseMapText(readFileSync(mapPath, 'utf-8'));
  const hit = rows.find((r) => r.key === key);
  if (!hit) {
    return { ok: false, code: 2, error: `未知别名: ${key}（用 --list 看已有）` };
  }
  return { ok: true, url: `${hit.value}${suffix || ''}` };
}
