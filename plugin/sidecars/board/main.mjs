import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { deleteAlias, hasConfiguredAliases, readAliases, upsertAlias } from '../../lib/aliases.mjs';
import { archiveWorkspace, loadArchivedMap, unarchiveWorkspace } from '../../lib/archive.mjs';
import { loadConfig, resetConfig, saveConfig } from '../../lib/config.mjs';
import { detectConflicts } from '../../lib/conflicts.mjs';
import { atomicWriteSync } from '../../lib/lock.mjs';
import {
  appendFlightEvent,
  clearFlightLogs,
  readFlightEvents,
  readHookHeartbeat,
  SLOW_OP_THRESHOLD_MS,
  summarizeFlightEvents,
} from '../../lib/logger.mjs';
import { getDataDir, getNoteRoot, getPluginRoot, shortPath } from '../../lib/paths.mjs';
import {
  IGNORED_CONV_IDS,
  loadState,
  readLogs,
  resetConvState,
  sessionHealth,
} from '../../lib/state.mjs';
import {
  cleanEmptyWorkspaces,
  EDITABLE_FILES,
  FILE_NAME_RE,
  formatNow,
  isConfirmEditableFile,
  readStatusSummary,
  RESERVED_WS_NAMES,
  resolveWorkspaceDir,
  resolveWorkspaceFile,
  sortWorkspaceFiles,
  statusTemplate,
  stripMarkdownCode,
  taskTemplate,
  WS_NAME_RE,
  wsNameFromEntry,
} from '../../lib/workspace.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FULL_LOAD_DEFAULT_BYTES = 1024 * 1024;
const FULL_LOAD_MAX_BYTES = 5 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const TASK_PROGRESS_MAX_BYTES = 256 * 1024;
const NO_STORE_HEADERS = Object.freeze({ 'Cache-Control': 'no-store, no-cache, must-revalidate' });

function assetStamp(fileName) {
  try {
    return String(Math.floor(statSync(join(__dirname, fileName)).mtimeMs));
  } catch {
    return '0';
  }
}

function readPluginVersion() {
  try {
    const meta = JSON.parse(readFileSync(join(getPluginRoot(), 'plugin.json'), 'utf-8'));
    return String(meta?.version || '');
  } catch {
    return '';
  }
}

const PLUGIN_VERSION = readPluginVersion();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readChunkUtf8(filePath, offset, length) {
  let fd = -1;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buf, 0, length, offset);
    const content = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, bytesRead));
    return { content, bytesRead };
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

function readTaskProgress(wsDir) {
  const taskPath = join(wsDir, 'task.md');
  try {
    if (!existsSync(taskPath)) return { done: 0, total: 0 };
    const st = statSync(taskPath);
    if (!st.isFile() || st.size > TASK_PROGRESS_MAX_BYTES) {
      return { done: 0, total: 0 };
    }
    const raw = readFileSync(taskPath, 'utf-8');
    const plain = stripMarkdownCode(raw, { stripInline: false });
    const re = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+/gm;
    let done = 0;
    let total = 0;
    let match;
    while ((match = re.exec(plain)) !== null) {
      total += 1;
      if (match[1].toLowerCase() === 'x') done += 1;
    }
    return { done, total };
  } catch {
    return { done: 0, total: 0 };
  }
}

function summarizeTurns(files) {
  let turnCount = 0;
  let latestTurn = null;
  let latestTurnFile = '';
  for (const name of files) {
    const m = /^turn-(\d+)\.md$/.exec(name);
    if (!m) continue;
    turnCount += 1;
    const num = Number.parseInt(m[1], 10);
    if (Number.isInteger(num) && (latestTurn === null || num > latestTurn)) {
      latestTurn = num;
      latestTurnFile = name;
    }
  }
  return { turnCount, latestTurn, latestTurnFile };
}

function isDirEmpty(dirPath) {
  try {
    return readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

const wsScanCache = new Map();

function fileSig(filePath) {
  try {
    const st = statSync(filePath);
    return st.isFile() ? `${Math.round(st.mtimeMs)}:${st.size}` : '';
  } catch {
    return '';
  }
}

function scanWorkspaceCached(wsDir, dirStat) {
  const dirMtimeMs = Math.round(dirStat.mtimeMs);
  const cached = wsScanCache.get(wsDir);

  let files;
  let empty;
  let turnInfo;
  let cacheHit = false;

  if (cached && cached.dirMtimeMs === dirMtimeMs) {
    files = cached.files;
    empty = cached.empty;
    turnInfo = cached.turnInfo;
    cacheHit = true;
  } else {
    empty = isDirEmpty(wsDir);
    let rawFiles = [];
    try {
      rawFiles = readdirSync(wsDir, { withFileTypes: true })
        .filter((f) => f.isFile() && FILE_NAME_RE.test(f.name))
        .map((f) => f.name);
    } catch {
      rawFiles = [];
    }
    files = sortWorkspaceFiles(rawFiles);
    turnInfo = summarizeTurns(files);
  }

  const hasTask = files.includes('task.md');
  const hasStatus = files.includes('status.md');
  const taskSig = hasTask ? fileSig(join(wsDir, 'task.md')) : '';
  const statusSig = hasStatus ? fileSig(join(wsDir, 'status.md')) : '';

  const taskProgress = (cacheHit && cached.taskSig === taskSig)
    ? cached.taskProgress
    : (hasTask ? readTaskProgress(wsDir) : { done: 0, total: 0 });
  const summary = (cacheHit && cached.statusSig === statusSig)
    ? cached.summary
    : (hasStatus ? readStatusSummary(wsDir, 120) : '');

  let latestMtimeMs = dirStat.mtimeMs;
  if (cacheHit && cached.taskSig === taskSig && cached.statusSig === statusSig) {
    latestMtimeMs = cached.latestMtimeMs;
    if (turnInfo.latestTurnFile) {
      try {
        const tm = statSync(join(wsDir, turnInfo.latestTurnFile)).mtimeMs;
        if (tm > latestMtimeMs) latestMtimeMs = tm;
      } catch {
        // 忽略瞬时读写误差
      }
    }
  } else {
    for (const f of files) {
      try {
        const mst = statSync(join(wsDir, f)).mtimeMs;
        if (mst > latestMtimeMs) latestMtimeMs = mst;
      } catch {
        // 忽略瞬时读写误差
      }
    }
  }

  const record = {
    dirMtimeMs,
    files,
    empty,
    hasTask,
    hasStatus,
    turnInfo,
    taskSig,
    statusSig,
    taskProgress,
    summary,
    latestMtimeMs,
  };
  wsScanCache.set(wsDir, record);
  return { ...record, cacheHit };
}

function buildSnapshot(activeConvId) {
  const nowSec = Date.now() / 1000;
  const noteRoot = getNoteRoot();
  const noteRootShort = shortPath(noteRoot);
  const state = loadState();
  const cfg = loadConfig(process.env);
  const retryWindowSec = cfg.retryWindowMin * 60;
  const archivedMap = loadArchivedMap(process.env);
  const hasRealAliases = hasConfiguredAliases(process.env);
  const aliases = readAliases(process.env, { fallbackExample: true });
  const conflicts = detectConflicts({ env: process.env, convId: activeConvId, config: cfg });
  const byWs = new Map();
  const trackedSessions = [];

  for (const [cid, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== 'object' || IGNORED_CONV_IDS.has(cid)) continue;
    const nd = typeof entry.note_dir === 'string' ? entry.note_dir : '';
    const wsName = wsNameFromEntry(cid, entry);
    if (!byWs.has(wsName)) byWs.set(wsName, []);
    byWs.get(wsName).push({ cid, entry });

    const health = sessionHealth(entry, nowSec, retryWindowSec);
    const ts = Number(entry.ts || 0);
    trackedSessions.push({
      convId: cid,
      convShort: cid.slice(0, 8),
      wsName,
      noteDir: nd || `${noteRootShort}/${cid.slice(0, 8)}`,
      health,
      dead: health.startsWith('DEAD'),
      deadReason: entry.dead_reason || '',
      tries: Number(entry.tries || 0),
      step: entry.step ?? null,
      offloadMode: Boolean(entry.offload_mode),
      withinWindow: Boolean(ts && (nowSec - ts <= retryWindowSec)),
      updatedAtMs: ts ? Math.round(ts * 1000) : 0,
    });
  }
  trackedSessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  const workspaces = [];
  const seenWsDirs = new Set();
  let emptyWorkspaceCount = 0;
  let archivedCount = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  if (existsSync(noteRoot)) {
    for (const ent of readdirSync(noteRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || RESERVED_WS_NAMES.has(ent.name.toLowerCase())) continue;
      const wsDir = join(noteRoot, ent.name);
      let stat;
      try {
        if (lstatSync(wsDir).isSymbolicLink()) continue;
        stat = statSync(wsDir);
      } catch {
        continue;
      }

      seenWsDirs.add(wsDir);
      if (!WS_RE_CHECK(ent.name)) {
        if (isDirEmpty(wsDir)) emptyWorkspaceCount += 1;
        continue;
      }

      const scanned = scanWorkspaceCached(wsDir, stat);
      if (scanned.cacheHit) cacheHits += 1;
      else cacheMisses += 1;

      const archInfo = archivedMap[ent.name] || null;
      const isArchived = Boolean(archInfo);
      if (isArchived) archivedCount += 1;
      if (scanned.empty && !isArchived) emptyWorkspaceCount += 1;

      const binds = byWs.get(ent.name) || [];
      binds.sort((a, b) => Number(b.entry.ts || 0) - Number(a.entry.ts || 0));
      const bound = binds.length > 0 ? binds[0] : null;
      const boundSessions = binds.map(({ cid, entry }) => {
        const h = sessionHealth(entry, nowSec, retryWindowSec);
        const ts = Number(entry.ts || 0);
        return {
          convId: cid,
          convShort: cid.slice(0, 8),
          health: h,
          dead: h.startsWith('DEAD'),
          step: entry.step ?? null,
          offloadMode: Boolean(entry.offload_mode),
          updatedAtMs: ts ? Math.round(ts * 1000) : 0,
        };
      });

      workspaces.push({
        name: ent.name,
        shortPath: shortPath(wsDir),
        absPath: wsDir,
        fileCount: scanned.files.length,
        files: scanned.files,
        hasTask: scanned.hasTask,
        hasStatus: scanned.hasStatus,
        taskProgress: scanned.taskProgress,
        turnCount: scanned.turnInfo.turnCount,
        latestTurn: scanned.turnInfo.latestTurn,
        latestTurnFile: scanned.turnInfo.latestTurnFile,
        isEmpty: scanned.empty,
        archived: isArchived,
        archivedAt: archInfo?.archivedAt || '',
        updatedAtMs: Math.round(scanned.latestMtimeMs),
        boundConvId: bound ? bound.cid : '',
        boundConvShort: bound ? bound.cid.slice(0, 8) : '',
        boundSessions,
        sessionCount: boundSessions.length,
        health: bound ? sessionHealth(bound.entry, nowSec, retryWindowSec) : '-',
        step: bound?.entry?.step ?? null,
        summary: scanned.summary,
      });
    }
  }
  for (const cachedDir of wsScanCache.keys()) {
    if (!seenWsDirs.has(cachedDir)) {
      wsScanCache.delete(cachedDir);
    }
  }
  workspaces.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    version: PLUGIN_VERSION,
    activeConversationId: activeConvId || '',
    noteRoot: noteRootShort,
    dataDir: shortPath(getDataDir()),
    config: cfg,
    hasRealAliases,
    aliasesIsExample: !hasRealAliases && aliases.length > 0,
    emptyWorkspaceCount,
    archivedCount,
    cacheStats: { hits: cacheHits, misses: cacheMisses },
    conflicts,
    workspaces,
    trackedSessions,
    aliases,
    logs: readLogs(40),
    flightSummary: summarizeFlightEvents(process.env),
    heartbeat: readHookHeartbeat(process.env),
  };
}

function WS_RE_CHECK(name) {
  return WS_NAME_RE.test(name);
}

const app = new SidecarApp();

function jsonApi(path, handler, method = 'POST') {
  app.api(path, async (data) => {
    const t0 = Date.now();
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new HttpError(400, '请求参数必须为 JSON 对象');
      }
      const result = await handler(data);
      const durationMs = Date.now() - t0;
      if (durationMs >= SLOW_OP_THRESHOLD_MS && !path.startsWith('/api/diagnostics/')) {
        appendFlightEvent(process.env, {
          level: 'warn',
          source: 'sidecar',
          event: 'slow_api',
          durationMs,
          message: `Sidecar API ${path} 响应较慢 (${durationMs}ms)`,
        });
      }
      return result;
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      const durationMs = Date.now() - t0;
      if (status >= 500 || (status >= 400 && status !== 401 && !path.startsWith('/api/diagnostics/'))) {
        appendFlightEvent(process.env, {
          level: status >= 500 ? 'error' : 'warn',
          source: 'sidecar',
          event: 'api_error',
          ok: false,
          durationMs,
          message: `${path} -> HTTP ${status}: ${err?.message || 'internal error'}`,
        });
      }
      return new Response(JSON.stringify({ error: err?.message || 'internal error' }), {
        status,
        contentType: 'application/json; charset=utf-8',
      });
    }
  }, method);
}

app.page('/', () => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf-8')
    .replace(/\/styles\.css(?:\?v=[^"']+)?/, `/styles.css?v=${assetStamp('styles.css')}`)
    .replace(/\/app\.js(?:\?v=[^"']+)?/, `/app.js?v=${assetStamp('app.js')}`);
  return new Response(html, {
    contentType: 'text/html; charset=utf-8',
    headers: NO_STORE_HEADERS,
  });
});

app.api('/styles.css', () => new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
  contentType: 'text/css; charset=utf-8',
  headers: NO_STORE_HEADERS,
}), 'GET');

app.api('/ui-logic.mjs', () => new Response(readFileSync(join(__dirname, 'ui-logic.mjs'), 'utf-8'), {
  contentType: 'application/javascript; charset=utf-8',
  headers: NO_STORE_HEADERS,
}), 'GET');

app.api('/app.js', () => {
  const js = readFileSync(join(__dirname, 'app.js'), 'utf-8')
    .replace(/\.\/ui-logic\.mjs(?:\?v=[^"']+)?/, `./ui-logic.mjs?v=${assetStamp('ui-logic.mjs')}`);
  return new Response(js, {
    contentType: 'application/javascript; charset=utf-8',
    headers: NO_STORE_HEADERS,
  });
}, 'GET');

jsonApi('/api/snapshot', (data) => {
  const conv = data?.conversationId || app.config?.conversationId || '';
  return buildSnapshot(conv);
}, 'POST');

jsonApi('/api/file', (data) => {
  const wsName = data?.workspace || '';
  const fileName = data?.file || '';
  const { filePath } = resolveWorkspaceFile(wsName, fileName);
  if (!existsSync(filePath)) {
    throw new HttpError(404, '文件不存在');
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new HttpError(400, '目标不是普通文件');
  }

  const updatedAtMs = Math.round(st.mtimeMs);
  const sig = `${updatedAtMs}:${st.size}`;
  if (data.knownSig && String(data.knownSig) === sig) {
    return {
      unchanged: true,
      workspace: wsName,
      file: fileName,
      sig,
      size: st.size,
      updatedAtMs,
    };
  }

  const mode = data.mode === 'full' ? 'full' : 'auto';
  const canForceFull = st.size <= FULL_LOAD_MAX_BYTES;
  const loadFull = st.size <= FULL_LOAD_DEFAULT_BYTES || (mode === 'full' && canForceFull);

  if (loadFull) {
    const directEditable = EDITABLE_FILES.has(fileName);
    const confirmEditable = isConfirmEditableFile(fileName);
    return {
      unchanged: false,
      workspace: wsName,
      file: fileName,
      absPath: filePath,
      shortPath: shortPath(filePath),
      chunked: false,
      directEditable,
      confirmEditable,
      editable: directEditable,
      canForceFull,
      offset: 0,
      length: st.size,
      totalBytes: st.size,
      hasPrev: false,
      hasNext: false,
      sig,
      content: readFileSync(filePath, 'utf-8'),
      size: st.size,
      updatedAtMs,
    };
  }

  const maxOffset = Math.max(0, st.size - 1);
  let offset = Number(data.offset);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  offset = Math.min(Math.floor(offset), maxOffset);
  const readLen = Math.min(CHUNK_BYTES, Math.max(0, st.size - offset));
  const { content, bytesRead } = readChunkUtf8(filePath, offset, readLen);

  return {
    unchanged: false,
    workspace: wsName,
    file: fileName,
    absPath: filePath,
    shortPath: shortPath(filePath),
    chunked: true,
    directEditable: false,
    confirmEditable: false,
    editable: false,
    canForceFull,
    offset,
    length: bytesRead,
    totalBytes: st.size,
    hasPrev: offset > 0,
    hasNext: offset + bytesRead < st.size,
    sig,
    content,
    size: st.size,
    updatedAtMs,
  };
}, 'POST');

jsonApi('/api/workspace/init', (data) => {
  const name = String(data?.name || '').trim();
  const wsDir = resolveWorkspaceDir(name);
  mkdirSync(wsDir, { recursive: true });

  const taskPath = join(wsDir, 'task.md');
  const statusPath = join(wsDir, 'status.md');
  const taskContent = typeof data?.taskContent === 'string' ? data.taskContent : '';

  if (Buffer.byteLength(taskContent, 'utf-8') > MAX_WRITE_BYTES) {
    throw new HttpError(413, '任务内容超过 5 MB 上限');
  }

  if (taskContent.trim()) {
    atomicWriteSync(taskPath, taskContent.endsWith('\n') ? taskContent : `${taskContent}\n`);
  } else if (!existsSync(taskPath)) {
    atomicWriteSync(taskPath, taskTemplate(name));
  }

  if (!existsSync(statusPath)) {
    atomicWriteSync(statusPath, statusTemplate(name, formatNow()));
  }

  const dispPath = shortPath(wsDir);
  return {
    ok: true,
    name,
    shortPath: dispPath,
    launchPrompt: `/note-offload 读取 ${dispPath}/task.md 与 status.md，执行下一未完成阶段并落盘汇报。`,
  };
}, 'POST');

jsonApi('/api/workspace/save', (data) => {
  const wsName = String(data?.workspace || '').trim();
  const fileName = String(data?.file || '').trim();
  if (data?.chunked === true) {
    throw new HttpError(400, '分片浏览状态下禁止保存，以防截断原文件');
  }
  const { wsDir, filePath } = resolveWorkspaceFile(wsName, fileName);
  if (!EDITABLE_FILES.has(fileName)) {
    if (!isConfirmEditableFile(fileName)) {
      throw new HttpError(403, '该文件类型不允许在线保存');
    }
    if (data?.confirmRisk !== true) {
      throw new HttpError(403, '修改阶段详稿或数据产物需确认风险后解锁（confirmRisk: true）');
    }
  }
  if (!existsSync(wsDir)) {
    throw new HttpError(404, '工作台目录不存在');
  }
  const content = typeof data?.content === 'string' ? data.content : '';
  if (Buffer.byteLength(content, 'utf-8') > MAX_WRITE_BYTES) {
    throw new HttpError(413, '文件内容超过 5 MB 上限');
  }
  atomicWriteSync(filePath, content);
  wsScanCache.delete(wsDir);
  return {
    ok: true,
    workspace: wsName,
    file: fileName,
    updatedAtMs: Date.now(),
  };
}, 'POST');

jsonApi('/api/workspace/archive', (data) => {
  const wsName = String(data?.workspace || '').trim();
  const archived = data?.archived !== false;
  const move = data?.move === true;
  const res = archived
    ? archiveWorkspace(wsName, { move })
    : unarchiveWorkspace(wsName);
  wsScanCache.clear();
  return res;
}, 'POST');

jsonApi('/api/workspace/clean', () => {
  const res = cleanEmptyWorkspaces();
  wsScanCache.clear();
  return {
    ok: true,
    removedCount: res.removed.length,
    removed: res.removed,
  };
}, 'POST');

jsonApi('/api/alias/upsert', (data) => {
  const rows = upsertAlias(data?.key, data?.value, data?.note || '');
  return { ok: true, aliases: rows };
}, 'POST');

jsonApi('/api/alias/delete', (data) => {
  const rows = deleteAlias(data?.key);
  return { ok: true, aliases: rows };
}, 'POST');

jsonApi('/api/state/reset', (data) => {
  const convId = String(data?.conversationId || '').trim();
  if (!convId || !/^[A-Za-z0-9_-]{4,128}$/.test(convId)) {
    throw new HttpError(400, '会话 ID 非法');
  }
  resetConvState(convId);
  return { ok: true, conversationId: convId };
}, 'POST');

jsonApi('/api/config/update', (data) => {
  const patch = { ...data };
  delete patch.conversationId;
  const config = saveConfig(patch);
  const conv = data?.conversationId || app.config?.conversationId || '';
  return {
    ok: true,
    config,
    conflicts: detectConflicts({ env: process.env, convId: conv, config }),
  };
}, 'POST');

jsonApi('/api/config/reset', (data) => {
  const config = resetConfig();
  const conv = data?.conversationId || app.config?.conversationId || '';
  return {
    ok: true,
    config,
    conflicts: detectConflicts({ env: process.env, convId: conv, config }),
  };
}, 'POST');

jsonApi('/api/diagnostics/logs', (data) => {
  const limit = Number.isFinite(Number(data?.limit)) ? Number(data.limit) : 80;
  const level = typeof data?.level === 'string' ? data.level : '';
  const source = typeof data?.source === 'string' ? data.source : '';
  return {
    ok: true,
    summary: summarizeFlightEvents(process.env),
    events: readFlightEvents(process.env, { limit, level, source }),
  };
}, 'POST');

jsonApi('/api/diagnostics/clear', () => {
  clearFlightLogs(process.env);
  return {
    ok: true,
    summary: summarizeFlightEvents(process.env),
  };
}, 'POST');

await app.run();
