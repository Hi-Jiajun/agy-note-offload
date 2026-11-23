import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteSync } from './lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IGNORED_MIGRATE_KEYS = new Set(['probe', 'selftest', 'None', 'unknown']);

/**
 * 获取当前有效用户主目录，支持测试沙箱通过 env.HOME 覆盖。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getHomeDir(env = process.env) {
  return env.HOME ? resolve(env.HOME) : homedir();
}

/**
 * 展开以 ~ 或 ~/ 开头的路径。
 * @param {string} targetPath
 * @param {string} [home]
 * @returns {string}
 */
export function expandHome(targetPath, home = homedir()) {
  const raw = String(targetPath || '');
  if (!raw) return raw;
  const absHome = resolve(home);
  if (raw === '~') return absHome;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return join(absHome, raw.slice(2));
  }
  return raw;
}

/**
 * 若路径位于主目录下则压缩为 ~/...，否则返回规范化绝对路径。
 * @param {string} targetPath
 * @param {string | NodeJS.ProcessEnv} [homeOrEnv]
 * @returns {string}
 */
export function shortPath(targetPath, homeOrEnv = process.env) {
  const home = typeof homeOrEnv === 'string' ? resolve(homeOrEnv) : getHomeDir(homeOrEnv);
  const absPath = resolve(expandHome(targetPath, home));
  if (absPath === home) return '~';
  if (absPath.startsWith(home + sep)) {
    const rel = absPath.slice(home.length).split(sep).join('/');
    return `~${rel.startsWith('/') ? rel : `/${rel}`}`;
  }
  return absPath;
}

function isOwnedPluginRoot(dirPath) {
  if (basename(dirPath) === 'note-offload') return true;
  try {
    const pj = join(dirPath, 'plugin.json');
    if (existsSync(pj)) {
      const parsed = JSON.parse(readFileSync(pj, 'utf-8'));
      if (parsed && parsed.name === 'note-offload') return true;
    }
  } catch {
    // 忽略清单读取失败
  }
  return false;
}

/**
 * 解析插件根目录（仅当 PLUGIN_ROOT 确认归属 note-offload 时采信，否则回退物理路径）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getPluginRoot(env = process.env) {
  if (env.PLUGIN_ROOT) {
    const cand = resolve(expandHome(env.PLUGIN_ROOT, getHomeDir(env)));
    if (isOwnedPluginRoot(cand)) {
      return cand;
    }
  }
  return resolve(__dirname, '..');
}

/**
 * 解析落盘工作台根目录（默认 ~/agy-notes，支持 AGY_NOTE_ROOT 覆盖）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getNoteRoot(env = process.env) {
  const home = getHomeDir(env);
  return resolve(expandHome(env.AGY_NOTE_ROOT || '~/agy-notes', home));
}

/**
 * 返回当前生效落盘根目录的短展示路径。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function noteRootDisplay(env = process.env) {
  return shortPath(getNoteRoot(env), env);
}

/**
 * 解析插件持久化数据目录。
 * 优先级：AGY_OFFLOAD_DATA_DIR > 归属 note-offload 的 PLUGIN_DATA > hintPath 识别表面 > 默认 antigravity surface。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [hintPath]
 * @returns {string}
 */
export function getDataDir(env = process.env, hintPath = '') {
  const home = getHomeDir(env);
  if (env.AGY_OFFLOAD_DATA_DIR) {
    return resolve(expandHome(env.AGY_OFFLOAD_DATA_DIR, home));
  }
  if (env.PLUGIN_DATA) {
    const cand = resolve(expandHome(env.PLUGIN_DATA, home));
    if (basename(cand) === 'note-offload') {
      return cand;
    }
  }
  if (hintPath) {
    const match = String(hintPath).match(/\/\.gemini\/(antigravity(?:-cli|-ide)?)\//);
    if (match) {
      return join(home, '.gemini', match[1], 'plugin_data', 'note-offload');
    }
  }
  return join(home, '.gemini', 'antigravity', 'plugin_data', 'note-offload');
}

/**
 * 解析可选项配置文件路径。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getConfigPath(env = process.env) {
  return join(getDataDir(env), 'config.json');
}

/**
 * 解析可选项配置文件锁路径。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getConfigLockPath(env = process.env) {
  return join(getDataDir(env), 'config.json.lock');
}

/**
 * 解析全局 ~/.gemini/config 目录（支持 AGY_CONFIG_DIR 覆盖）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getGlobalConfigDir(env = process.env) {
  const home = getHomeDir(env);
  if (env.AGY_CONFIG_DIR) {
    return resolve(expandHome(env.AGY_CONFIG_DIR, home));
  }
  return join(home, '.gemini', 'config');
}

function migrateStateFile(srcPath, destPath) {
  try {
    const raw = JSON.parse(readFileSync(srcPath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const cleaned = {};
    for (const [cid, entry] of Object.entries(raw)) {
      if (!IGNORED_MIGRATE_KEYS.has(cid) && entry && typeof entry === 'object' && !Array.isArray(entry)) {
        cleaned[cid] = entry;
      }
    }
    atomicWriteSync(destPath, JSON.stringify(cleaned));
  } catch {
    // 旧状态损坏则跳过迁移，避免影响新目录初始化
  }
}

function migrateTextFile(srcPath, destPath) {
  try {
    const content = readFileSync(srcPath);
    atomicWriteSync(destPath, content);
  } catch {
    try {
      copyFileSync(srcPath, destPath);
    } catch {
      // 忽略旧数据读取失败
    }
  }
}

/**
 * 确保数据目录存在；在真实运行态或显式指定 AGY_LEGACY_DATA_DIR 时平滑迁移旧散装数据。
 * 若沙箱设置了 AGY_OFFLOAD_DATA_DIR 且未设 AGY_LEGACY_DATA_DIR，则绝不触碰宿主机旧目录。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function ensureDataDir(env = process.env) {
  const dataDir = getDataDir(env);
  mkdirSync(dataDir, { recursive: true });

  const home = getHomeDir(env);
  let legacyDir = '';
  if (env.AGY_LEGACY_DATA_DIR) {
    legacyDir = resolve(expandHome(env.AGY_LEGACY_DATA_DIR, home));
  } else if (!env.AGY_OFFLOAD_DATA_DIR) {
    legacyDir = join(home, '.local', 'share', 'agy-note-offload');
  }

  if (legacyDir && legacyDir !== dataDir && existsSync(legacyDir)) {
    const legacyState = join(legacyDir, '.filter-retry-state.json');
    const targetState = join(dataDir, '.filter-retry-state.json');
    if (existsSync(legacyState) && !existsSync(targetState)) {
      migrateStateFile(legacyState, targetState);
    }
    for (const fname of ['net-map.tsv', 'hook-invocations.log']) {
      const src = join(legacyDir, fname);
      const dst = join(dataDir, fname);
      if (existsSync(src) && !existsSync(dst)) {
        migrateTextFile(src, dst);
      }
    }
  }

  return dataDir;
}

/**
 * 返回跨端 Antigravity brain 会话根目录列表（antigravity / antigravity-cli / antigravity-ide）。
 * 支持 AGY_BRAIN_ROOT 环境变量覆盖（单路径或路径分隔符列表）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function getBrainDirs(env = process.env) {
  const home = getHomeDir(env);
  let candidates;
  if (env.AGY_BRAIN_ROOT) {
    candidates = env.AGY_BRAIN_ROOT
      .split(delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => resolve(expandHome(item, home)));
  } else {
    candidates = [
      join(home, '.gemini', 'antigravity', 'brain'),
      join(home, '.gemini', 'antigravity-cli', 'brain'),
      join(home, '.gemini', 'antigravity-ide', 'brain'),
    ];
  }
  const unique = [...new Set(candidates)];
  return unique.filter((dirPath) => isAbsolute(dirPath) && existsSync(dirPath));
}

export function getStatePath(env = process.env) {
  return join(getDataDir(env), '.filter-retry-state.json');
}

export function getStateLockPath(env = process.env) {
  return join(getDataDir(env), '.filter-retry-state.lock');
}

export function getLogPath(env = process.env) {
  return join(getDataDir(env), 'hook-invocations.log');
}

export function getLogLockPath(env = process.env) {
  return join(getDataDir(env), 'hook-invocations.log.lock');
}

export function getMapPath(env = process.env) {
  return join(getDataDir(env), 'net-map.tsv');
}

export function getMapLockPath(env = process.env) {
  return join(getDataDir(env), 'net-map.tsv.lock');
}

export function getArchivePath(env = process.env) {
  return join(getDataDir(env), 'archived.json');
}

export function getArchiveLockPath(env = process.env) {
  return join(getDataDir(env), 'archived.json.lock');
}

export function getExampleMapPath(env = process.env) {
  return join(getPluginRoot(env), 'scripts', 'net-map.tsv.example');
}
