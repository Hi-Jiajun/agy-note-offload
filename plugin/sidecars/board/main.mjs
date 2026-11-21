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
import { loadConfig, saveConfig } from '../../lib/config.mjs';
import { detectConflicts } from '../../lib/conflicts.mjs';
import { atomicWriteSync } from '../../lib/lock.mjs';
import { getDataDir, getNoteRoot, shortPath } from '../../lib/paths.mjs';
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
  resolveWorkspaceDir,
  resolveWorkspaceFile,
  sortWorkspaceFiles,
  statusTemplate,
  taskTemplate,
  WS_NAME_RE,
  wsNameFromEntry,
} from '../../lib/workspace.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FULL_LOAD_DEFAULT_BYTES = 1024 * 1024;
const FULL_LOAD_MAX_BYTES = 5 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

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

function buildSnapshot(activeConvId) {
  const nowSec = Date.now() / 1000;
  const noteRoot = getNoteRoot();
  const noteRootShort = shortPath(noteRoot);
  const state = loadState();
  const cfg = loadConfig(process.env);
  const hasRealAliases = hasConfiguredAliases(process.env);
  const conflicts = detectConflicts({ env: process.env, convId: activeConvId, config: cfg });
  const byWs = new Map();
  const trackedSessions = [];

  for (const [cid, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== 'object' || IGNORED_CONV_IDS.has(cid)) continue;
    const nd = typeof entry.note_dir === 'string' ? entry.note_dir : '';
    const wsName = wsNameFromEntry(cid, entry);
    if (!byWs.has(wsName)) byWs.set(wsName, []);
    byWs.get(wsName).push({ cid, entry });

    const health = sessionHealth(entry, nowSec);
    trackedSessions.push({
      convId: cid,
      convShort: cid.slice(0, 8),
      noteDir: nd || `${noteRootShort}/${cid.slice(0, 8)}`,
      health,
      dead: health.startsWith('DEAD'),
      deadReason: entry.dead_reason || '',
      tries: Number(entry.tries || 0),
      step: entry.step ?? null,
      offloadMode: Boolean(entry.offload_mode),
      updatedAtMs: entry.ts ? Math.round(Number(entry.ts) * 1000) : 0,
    });
  }
  trackedSessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  const workspaces = [];
  if (existsSync(noteRoot)) {
    for (const ent of readdirSync(noteRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || !WS_RE_CHECK(ent.name)) continue;
      const wsDir = join(noteRoot, ent.name);
      let stat;
      try {
        if (lstatSync(wsDir).isSymbolicLink()) continue;
        stat = statSync(wsDir);
      } catch {
        continue;
      }

      let rawFiles = [];
      try {
        rawFiles = readdirSync(wsDir, { withFileTypes: true })
          .filter((f) => f.isFile() && FILE_NAME_RE.test(f.name))
          .map((f) => f.name);
      } catch {
        rawFiles = [];
      }

      const files = sortWorkspaceFiles(rawFiles);
      let latestMtimeMs = stat.mtimeMs;
      for (const f of files) {
        try {
          const mst = statSync(join(wsDir, f)).mtimeMs;
          if (mst > latestMtimeMs) latestMtimeMs = mst;
        } catch {
          // 忽略瞬时读写误差
        }
      }

      const binds = byWs.get(ent.name) || [];
      let bound = null;
      if (binds.length > 0) {
        binds.sort((a, b) => Number(b.entry.ts || 0) - Number(a.entry.ts || 0));
        bound = binds[0];
      }

      workspaces.push({
        name: ent.name,
        shortPath: shortPath(wsDir),
        absPath: wsDir,
        fileCount: files.length,
        files,
        hasTask: files.includes('task.md'),
        hasStatus: files.includes('status.md'),
        updatedAtMs: Math.round(latestMtimeMs),
        boundConvId: bound ? bound.cid : '',
        boundConvShort: bound ? bound.cid.slice(0, 8) : '',
        health: bound ? sessionHealth(bound.entry, nowSec) : '-',
        step: bound?.entry?.step ?? null,
        summary: readStatusSummary(wsDir, 120),
      });
    }
  }
  workspaces.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    activeConversationId: activeConvId || '',
    noteRoot: noteRootShort,
    dataDir: shortPath(getDataDir()),
    config: cfg,
    hasRealAliases,
    conflicts,
    workspaces,
    trackedSessions,
    aliases: readAliases(process.env, { fallbackExample: true }),
    logs: readLogs(40),
  };
}

function WS_RE_CHECK(name) {
  return WS_NAME_RE.test(name);
}

const app = new SidecarApp();

function jsonApi(path, handler, method = 'POST') {
  app.api(path, async (data) => {
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new HttpError(400, '请求参数必须为 JSON 对象');
      }
      return await handler(data);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return new Response(JSON.stringify({ error: err?.message || 'internal error' }), {
        status,
        contentType: 'application/json; charset=utf-8',
      });
    }
  }, method);
}

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api('/styles.css', () => new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
  contentType: 'text/css; charset=utf-8',
}), 'GET');

app.api('/app.js', () => new Response(readFileSync(join(__dirname, 'app.js'), 'utf-8'), {
  contentType: 'application/javascript; charset=utf-8',
}), 'GET');

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
  return {
    ok: true,
    workspace: wsName,
    file: fileName,
    updatedAtMs: Date.now(),
  };
}, 'POST');

jsonApi('/api/workspace/clean', () => {
  const res = cleanEmptyWorkspaces();
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
  const patch = {};
  if (Object.hasOwn(data, 'sanitizeEnabled')) {
    if (typeof data.sanitizeEnabled !== 'boolean') {
      throw new HttpError(400, 'sanitizeEnabled 必须为布尔值');
    }
    patch.sanitizeEnabled = data.sanitizeEnabled;
  }
  if (Object.hasOwn(data, 'aliasEnabled')) {
    if (typeof data.aliasEnabled !== 'boolean') {
      throw new HttpError(400, 'aliasEnabled 必须为布尔值');
    }
    patch.aliasEnabled = data.aliasEnabled;
  }
  const config = saveConfig(patch);
  const conv = data?.conversationId || app.config?.conversationId || '';
  return {
    ok: true,
    config,
    conflicts: detectConflicts({ env: process.env, convId: conv, config }),
  };
}, 'POST');

await app.run();
