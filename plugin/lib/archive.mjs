import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSync, withFileLockSync } from './lock.mjs';
import { appendFlightEvent } from './logger.mjs';
import { ensureDataDir, getArchiveLockPath, getArchivePath, getNoteRoot, shortPath } from './paths.mjs';
import { assertOwnedSubpath, RESERVED_WS_NAMES, WS_NAME_RE } from './workspace.mjs';

export const ARCHIVE_DIR_NAME = '_archive';

function validateArchiveName(name) {
  const clean = String(name || '').trim();
  if (!clean || !WS_NAME_RE.test(clean) || RESERVED_WS_NAMES.has(clean.toLowerCase())) {
    const err = new Error('工作台名称非法（仅支持字母、数字及 . _ -，且不可使用保留名）');
    err.status = 400;
    throw err;
  }
  return clean;
}

function readRawArchiveMap(env = process.env) {
  const p = getArchivePath(env);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!WS_NAME_RE.test(k) || RESERVED_WS_NAMES.has(k.toLowerCase())) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = {
          archivedAt: typeof v.archivedAt === 'string' ? v.archivedAt : '',
          moved: Boolean(v.moved),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function withArchiveLock(fn, env = process.env) {
  ensureDataDir(env);
  return withFileLockSync(getArchiveLockPath(env), fn, {
    onTimeout(info) {
      appendFlightEvent(env, {
        level: 'warn',
        source: 'archive',
        event: 'lock_timeout',
        ok: false,
        message: `归档锁获取超时 (${info.timeoutMs}ms, reason=${info.reason})`,
      });
    },
  });
}

/**
 * 读取逻辑归档映射表（叠加物理 _archive 目录中的工作台）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, { archivedAt: string, moved: boolean }>}
 */
export function loadArchivedMap(env = process.env) {
  const map = readRawArchiveMap(env);
  const archiveDir = join(getNoteRoot(env), ARCHIVE_DIR_NAME);
  if (existsSync(archiveDir)) {
    try {
      for (const ent of readdirSync(archiveDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !WS_NAME_RE.test(ent.name)) continue;
        const full = join(archiveDir, ent.name);
        try {
          if (lstatSync(full).isSymbolicLink()) continue;
          const mtimeIso = new Date(statSync(full).mtimeMs).toISOString();
          if (!map[ent.name]) {
            map[ent.name] = { archivedAt: mtimeIso, moved: true };
          } else {
            map[ent.name].moved = true;
          }
        } catch {
          // 忽略瞬时访问错误
        }
      }
    } catch {
      // 忽略目录不可读
    }
  }
  return map;
}

/**
 * 归档指定工作台：默认仅逻辑归档（不移动磁盘目录，保证历史会话 file:// 链接不断裂）；
 * 显式传 move: true 时才移动至 ~/agy-notes/_archive/<name>/。
 * @param {string} name
 * @param {{ move?: boolean, env?: NodeJS.ProcessEnv }} [options]
 */
export function archiveWorkspace(name, { move = false, env = process.env } = {}) {
  const wsName = validateArchiveName(name);
  const noteRoot = getNoteRoot(env);
  const srcDir = assertOwnedSubpath(noteRoot, join(noteRoot, wsName));
  const archiveRoot = assertOwnedSubpath(noteRoot, join(noteRoot, ARCHIVE_DIR_NAME));
  const movedDir = assertOwnedSubpath(archiveRoot, join(archiveRoot, wsName));

  const srcExists = existsSync(srcDir) && statSync(srcDir).isDirectory();
  const movedExists = existsSync(movedDir) && statSync(movedDir).isDirectory();
  if (!srcExists && !movedExists) {
    const err = new Error(`工作台目录不存在: ${wsName}`);
    err.status = 404;
    throw err;
  }

  let didMove = movedExists;
  if (move && srcExists) {
    if (movedExists) {
      const err = new Error(`物理归档目标已存在同名目录: ${ARCHIVE_DIR_NAME}/${wsName}`);
      err.status = 409;
      throw err;
    }
    mkdirSync(archiveRoot, { recursive: true });
    renameSync(srcDir, movedDir);
    didMove = true;
  }

  const archivedAt = new Date().toISOString();
  withArchiveLock(() => {
    const map = readRawArchiveMap(env);
    map[wsName] = { archivedAt, moved: didMove };
    atomicWriteSync(getArchivePath(env), `${JSON.stringify(map, null, 2)}\n`);
  }, env);

  const finalPath = didMove ? movedDir : srcDir;
  return {
    ok: true,
    name: wsName,
    archived: true,
    moved: didMove,
    archivedAt,
    path: shortPath(finalPath, env),
  };
}

/**
 * 取消归档工作台：若为物理归档则自动移回 ~/agy-notes/<name>/，同时清除逻辑归档标记。
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export function unarchiveWorkspace(name, { env = process.env } = {}) {
  const wsName = validateArchiveName(name);
  const noteRoot = getNoteRoot(env);
  const dstDir = assertOwnedSubpath(noteRoot, join(noteRoot, wsName));
  const archiveRoot = assertOwnedSubpath(noteRoot, join(noteRoot, ARCHIVE_DIR_NAME));
  const movedDir = assertOwnedSubpath(archiveRoot, join(archiveRoot, wsName));

  let restoredFromMove = false;
  if (existsSync(movedDir) && statSync(movedDir).isDirectory()) {
    if (existsSync(dstDir)) {
      const err = new Error(`工作台根目录已存在同名目录，无法恢复物理归档: ${wsName}`);
      err.status = 409;
      throw err;
    }
    renameSync(movedDir, dstDir);
    restoredFromMove = true;
  }

  withArchiveLock(() => {
    const map = readRawArchiveMap(env);
    if (Object.hasOwn(map, wsName)) {
      delete map[wsName];
      atomicWriteSync(getArchivePath(env), `${JSON.stringify(map, null, 2)}\n`);
    }
  }, env);

  return {
    ok: true,
    name: wsName,
    archived: false,
    restoredFromMove,
    path: shortPath(dstDir, env),
  };
}
