import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTE_ROOT = resolve(process.env.AGY_NOTE_ROOT || join(homedir(), 'agy-notes'));
const DATA_DIR = resolve(process.env.AGY_OFFLOAD_DATA_DIR || join(homedir(), '.local', 'share', 'agy-note-offload'));
const STATE_PATH = join(DATA_DIR, '.filter-retry-state.json');
const LOG_PATH = join(DATA_DIR, 'hook-invocations.log');
const MAP_PATH = join(DATA_DIR, 'net-map.tsv');
const EXAMPLE_MAP_PATH = resolve(join(__dirname, '..', '..', 'scripts', 'net-map.tsv.example'));

const RETRY_WINDOW_SEC = 15 * 60;
const MAX_READ_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(md|txt|json|log)$/;
const EDITABLE_FILES = new Set(['task.md', 'status.md']);
const ALIAS_KEY_RE = /^[A-Za-z0-9._-]{1,32}$/;

const TASK_TEMPLATE = (name) => `# 任务单（${name}）

## 目标
- 在此填写本阶段唯一工程目标与验收判据。

## 待办阶段
- [ ] 阶段 1：
- [ ] 阶段 2：

## 约束与参考路径
- 参考文件：
- 注意事项：脚本大输出请直接写文件，不要直接刷终端。
`;

const STATUS_TEMPLATE = (name, now) => `# 进度看板（${name}）

- 更新时间：${now}
- 当前状态：待启动
- 最新详稿：暂无

## 阶段进展
- 尚未开始执行，请读取同目录 \`task.md\` 推进第一项未完成阶段。
`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class MiniResponse {
  constructor(body, { contentType = 'text/plain; charset=utf-8', status = 200, headers } = {}) {
    this.body = body;
    this.contentType = contentType;
    this.status = status;
    this.headers = headers;
  }
}

function findPreloadJs() {
  const candidates = [
    process.env.ANTIGRAVITY_APP_DATA_DIR &&
      join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, 'utf-8');
      } catch {}
    }
  }
  return '';
}

class MiniSidecarApp {
  #port;
  #token;
  #pages = new Map();
  #apis = new Map();
  #server = null;

  constructor() {
    this.#port = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '0', 10);
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65535) {
      throw new Error('Invalid ANTIGRAVITY_SIDECAR_WEB_PORT');
    }
    this.#token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
  }

  get config() {
    return {
      projectId: process.env.ANTIGRAVITY_PROJECT_ID || '',
      conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
    };
  }

  page(path, handler) {
    this.#pages.set(path, handler);
  }

  api(path, handler, method = 'POST') {
    if (!this.#apis.has(path)) {
      this.#apis.set(path, new Map());
    }
    this.#apis.get(path).set(method.toUpperCase(), handler);
  }

  #validateToken(req, url) {
    if (!this.#token) return true;
    const raw = req.headers['x-sidecar-token'] ?? url.searchParams.get('token') ?? '';
    const provided = Array.isArray(raw) ? raw[0] : String(raw);
    const a = Buffer.from(provided, 'utf-8');
    const b = Buffer.from(this.#token, 'utf-8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  run() {
    const preloadJs = findPreloadJs();
    this.#pages.set('/preload.js', () => preloadJs);

    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      const requiresAuth = req.method !== 'GET' || url.pathname.startsWith('/api/');
      if (requiresAuth && !this.#validateToken(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (req.method === 'GET' && this.#pages.has(url.pathname)) {
        try {
          const content = await this.#pages.get(url.pathname)();
          if (content && typeof content === 'object' && content.body !== undefined) {
            res.writeHead(content.status || 200, {
              'Content-Type': content.contentType || 'text/plain; charset=utf-8',
              ...content.headers,
            });
            res.end(content.body);
            return;
          }
          const isJs = url.pathname.endsWith('.js');
          res.writeHead(200, {
            'Content-Type': isJs ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8',
          });
          res.end(content);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (this.#apis.has(url.pathname)) {
        const methodMap = this.#apis.get(url.pathname);
        if (!methodMap.has(req.method)) {
          res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }
        const handler = methodMap.get(req.method);
        const chunks = [];
        let totalBytes = 0;
        let tooLarge = false;
        req.on('error', () => {});
        req.on('data', (chunk) => {
          if (tooLarge) return;
          totalBytes += chunk.length;
          if (totalBytes > MAX_BODY_BYTES) {
            tooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: '请求体过大（上限 2 MB）' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', async () => {
          if (tooLarge) return;
          try {
            const data = {};
            if (url.searchParams.size > 0) {
              for (const [k, v] of url.searchParams.entries()) {
                if (k.toLowerCase() !== 'token') data[k] = v;
              }
            }
            const body = chunks.length ? Buffer.concat(chunks).toString('utf-8') : '';
            if (body) {
              let parsed;
              try {
                parsed = JSON.parse(body);
              } catch {
                throw new HttpError(400, '请求体 JSON 格式非法');
              }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new HttpError(400, '请求体必须为 JSON 对象');
              }
              Object.assign(data, parsed);
            }
            const result = await handler(data);
            if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
              const respBody = typeof result.body === 'string' ? result.body : Buffer.from(result.body);
              res.writeHead(result.status || 200, {
                'Content-Type': result.contentType,
                ...result.headers,
              });
              res.end(respBody);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
          } catch (err) {
            const status = Number.isInteger(err?.status) ? err.status : 500;
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });

    return new Promise((resolveReady, rejectReady) => {
      server.once('error', rejectReady);
      this.#server = server.listen(this.#port, '127.0.0.1', () => {
        console.log(`[sidecar] listening on 127.0.0.1:${server.address().port}`);
        resolveReady(server);
      });
    });
  }

  close() {
    return new Promise((done) => (this.#server ? this.#server.close(() => done()) : done()));
  }
}

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toShortPath(absPath) {
  const home = homedir();
  if (absPath === home) return '~';
  return absPath.startsWith(home + sep) ? '~' + absPath.slice(home.length) : absPath;
}

const NOTE_ROOT_SHORT = toShortPath(NOTE_ROOT);

function extractWsName(nd, cid) {
  if (typeof nd === 'string' && nd) {
    const prefixes = [
      '~/agy-notes/',
      `${NOTE_ROOT_SHORT.replace(/\/+$/, '')}/`,
      `${NOTE_ROOT.replace(/\/+$/, '')}/`,
    ];
    for (const pfx of prefixes) {
      if (nd.startsWith(pfx)) {
        const rel = nd.slice(pfx.length).replace(/\/+$/, '');
        if (rel && !rel.includes('/') && !rel.includes('..') && WS_RE.test(rel)) {
          return rel;
        }
      }
    }
  }
  return cid.slice(0, 8);
}

function assertOwnedSubpath(rootDir, targetPath) {
  const rel = relative(rootDir, targetPath);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || targetPath === rootDir) {
    throw new HttpError(403, '路径越界被拒绝');
  }
  const abs = resolve(targetPath);
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) {
    throw new HttpError(403, '拒绝访问符号链接');
  }
  return abs;
}

function resolveWorkspaceDir(name) {
  if (typeof name !== 'string' || !WS_RE.test(name)) {
    throw new HttpError(400, '工作台名称非法（仅支持字母、数字及 . _ -）');
  }
  return assertOwnedSubpath(NOTE_ROOT, join(NOTE_ROOT, name));
}

function resolveWorkspaceFile(wsName, fileName) {
  if (typeof fileName !== 'string' || !FILE_RE.test(fileName)) {
    throw new HttpError(400, '文件名非法（仅允许常见文本或 md 后缀）');
  }
  const wsDir = resolveWorkspaceDir(wsName);
  return { wsDir, filePath: assertOwnedSubpath(wsDir, join(wsDir, fileName)) };
}

function atomicWrite(targetPath, text) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = join(dirname(targetPath), `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(tmp, text, 'utf-8');
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function sessionHealth(entry, nowSec) {
  if (!entry || typeof entry !== 'object') return 'NONE';
  const ts = Number(entry.ts || 0);
  const within = nowSec - ts <= RETRY_WINDOW_SEC;
  const tries = Number(entry.tries || 0);
  if (entry.dead && within) return `DEAD(${entry.dead_reason || 'locked'})`;
  if (tries > 0 && within) return `RETRY(${tries})`;
  if (entry.offload_mode) return 'OK(offload)';
  return 'OK';
}

function readStatusSummary(wsDir) {
  const sf = join(wsDir, 'status.md');
  if (!existsSync(sf)) return '';
  try {
    const lines = readFileSync(sf, 'utf-8').split(/\r?\n/);
    for (const ln of lines) {
      const s = ln.trim();
      if (s.startsWith('- 当前状态：') || s.startsWith('- 状态：')) {
        return s.slice(s.indexOf('：') + 1).trim().slice(0, 120);
      }
    }
    for (const ln of lines) {
      const s = ln.trim();
      if (s && !s.startsWith('#') && !s.startsWith('- 更新时间')) {
        return s.slice(0, 120);
      }
    }
  } catch {}
  return '';
}

function sortWorkspaceFiles(files) {
  const rank = (f) => {
    if (f === 'status.md') return 0;
    if (f === 'task.md') return 1;
    if (/^turn-(\d+)\.md$/.test(f)) return 2;
    return 3;
  };
  return [...files].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 2) {
      const na = Number(a.match(/^turn-(\d+)\.md$/)?.[1] || 0);
      const nb = Number(b.match(/^turn-(\d+)\.md$/)?.[1] || 0);
      return nb - na;
    }
    return a.localeCompare(b);
  });
}

function readAliases() {
  const target = existsSync(MAP_PATH) ? MAP_PATH : EXAMPLE_MAP_PATH;
  if (!existsSync(target)) return [];
  const rows = [];
  const lines = readFileSync(target, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = line.split('\t');
    const key = (parts[0] || '').trim();
    const value = (parts[1] || '').trim();
    const note = (parts[2] || '').trim();
    if (key && value) rows.push({ key, value, note });
  }
  return rows;
}

function writeAliases(rows) {
  mkdirSync(DATA_DIR, { recursive: true });
  const header = '# 别名\t真值\t备注\n';
  const body = rows.map((r) => `${r.key}\t${r.value}\t${r.note || ''}`).join('\n');
  atomicWrite(MAP_PATH, header + (body ? body + '\n' : ''));
}

function readLogs(limit = 40) {
  if (!existsSync(LOG_PATH)) return [];
  try {
    const lines = readFileSync(LOG_PATH, 'utf-8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function buildSnapshot(activeConvId) {
  const nowSec = Date.now() / 1000;
  const state = readState();
  const byWs = new Map();
  const trackedSessions = [];

  for (const [cid, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== 'object') continue;
    if (['probe', 'selftest', 'None', 'unknown'].includes(cid)) continue;
    const nd = typeof entry.note_dir === 'string' ? entry.note_dir : '';
    const wsName = extractWsName(nd, cid);
    if (!byWs.has(wsName)) byWs.set(wsName, []);
    byWs.get(wsName).push({ cid, entry });

    const health = sessionHealth(entry, nowSec);
    trackedSessions.push({
      convId: cid,
      convShort: cid.slice(0, 8),
      noteDir: nd || `${NOTE_ROOT_SHORT}/${cid.slice(0, 8)}`,
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
  if (existsSync(NOTE_ROOT)) {
    for (const ent of readdirSync(NOTE_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory() || !WS_RE.test(ent.name)) continue;
      const wsDir = join(NOTE_ROOT, ent.name);
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
          .filter((f) => f.isFile() && FILE_RE.test(f.name))
          .map((f) => f.name);
      } catch {}

      const files = sortWorkspaceFiles(rawFiles);
      let latestMtimeMs = stat.mtimeMs;
      for (const f of files) {
        try {
          const mst = statSync(join(wsDir, f)).mtimeMs;
          if (mst > latestMtimeMs) latestMtimeMs = mst;
        } catch {}
      }

      const binds = byWs.get(ent.name) || [];
      let bound = null;
      if (binds.length) {
        binds.sort((a, b) => Number(b.entry.ts || 0) - Number(a.entry.ts || 0));
        bound = binds[0];
      }

      workspaces.push({
        name: ent.name,
        shortPath: toShortPath(wsDir),
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
        summary: readStatusSummary(wsDir),
      });
    }
  }
  workspaces.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  return {
    activeConversationId: activeConvId || '',
    noteRoot: NOTE_ROOT_SHORT,
    dataDir: toShortPath(DATA_DIR),
    workspaces,
    trackedSessions,
    aliases: readAliases(),
    logs: readLogs(40),
  };
}

let sdk = null;
const useOfficialSdk = Boolean(
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
);
if (useOfficialSdk) {
  sdk = await import('sidecar_sdk').catch(() => null);
}

const AppClass = sdk?.SidecarApp || MiniSidecarApp;
const RespClass = sdk?.Response || MiniResponse;
const app = new AppClass();

function jsonApi(path, handler, method = 'POST') {
  app.api(path, async (data) => {
    try {
      return await handler(data);
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      return new RespClass(JSON.stringify({ error: err?.message || 'internal error' }), {
        status,
        contentType: 'application/json; charset=utf-8',
      });
    }
  }, method);
}

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api('/styles.css', () => new RespClass(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
  contentType: 'text/css; charset=utf-8',
}), 'GET');

app.api('/app.js', () => new RespClass(readFileSync(join(__dirname, 'app.js'), 'utf-8'), {
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
  if (st.size > MAX_READ_BYTES) {
    throw new HttpError(413, '文件超过 256 KB 预览上限，请在编辑器查看');
  }
  return {
    workspace: wsName,
    file: fileName,
    absPath: filePath,
    shortPath: toShortPath(filePath),
    editable: EDITABLE_FILES.has(fileName),
    content: readFileSync(filePath, 'utf-8'),
    size: st.size,
    updatedAtMs: Math.round(st.mtimeMs),
  };
}, 'POST');

jsonApi('/api/workspace/init', (data) => {
  const name = String(data?.name || '').trim();
  const wsDir = resolveWorkspaceDir(name);
  mkdirSync(wsDir, { recursive: true });

  const taskPath = join(wsDir, 'task.md');
  const statusPath = join(wsDir, 'status.md');
  const taskContent = typeof data?.taskContent === 'string' ? data.taskContent : '';

  if (taskContent.trim()) {
    atomicWrite(taskPath, taskContent.endsWith('\n') ? taskContent : taskContent + '\n');
  } else if (!existsSync(taskPath)) {
    atomicWrite(taskPath, TASK_TEMPLATE(name));
  }

  if (!existsSync(statusPath)) {
    atomicWrite(statusPath, STATUS_TEMPLATE(name, nowText()));
  }

  const shortPath = toShortPath(wsDir);
  return {
    ok: true,
    name,
    shortPath,
    launchPrompt: `/note-offload 读取 ${shortPath}/task.md 与 status.md，执行下一未完成阶段并落盘汇报。`,
  };
}, 'POST');

jsonApi('/api/workspace/save', (data) => {
  const wsName = String(data?.workspace || '').trim();
  const fileName = String(data?.file || '').trim();
  if (!EDITABLE_FILES.has(fileName)) {
    throw new HttpError(403, '仅允许在线修改 task.md 或 status.md，历史详稿保持只读');
  }
  const { wsDir, filePath } = resolveWorkspaceFile(wsName, fileName);
  if (!existsSync(wsDir)) {
    throw new HttpError(404, '工作台目录不存在');
  }
  const content = typeof data?.content === 'string' ? data.content : '';
  atomicWrite(filePath, content);
  return {
    ok: true,
    workspace: wsName,
    file: fileName,
    updatedAtMs: Date.now(),
  };
}, 'POST');

jsonApi('/api/workspace/clean', () => {
  if (!existsSync(NOTE_ROOT)) {
    return { ok: true, removedCount: 0, removed: [] };
  }
  const removed = [];
  for (const ent of readdirSync(NOTE_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const full = join(NOTE_ROOT, ent.name);
    try {
      if (lstatSync(full).isSymbolicLink()) continue;
      if (readdirSync(full).length === 0) {
        rmdirSync(full);
        removed.push(ent.name);
      }
    } catch {}
  }
  return { ok: true, removedCount: removed.length, removed };
}, 'POST');

jsonApi('/api/alias/upsert', (data) => {
  const key = String(data?.key || '').trim();
  const value = String(data?.value || '').trim();
  const note = String(data?.note || '').trim().replace(/[\r\n\t]+/g, ' ');
  if (!ALIAS_KEY_RE.test(key)) {
    throw new HttpError(400, '别名仅支持 1 到 32 位字母、数字、点、下划线或连字符');
  }
  if (!value || /[\r\n\t]/.test(value)) {
    throw new HttpError(400, '真值不能为空且不得包含换行或制表符');
  }
  const rows = readAliases();
  const idx = rows.findIndex((r) => r.key === key);
  if (idx >= 0) {
    rows[idx] = { key, value, note };
  } else {
    rows.push({ key, value, note });
  }
  writeAliases(rows);
  return { ok: true, aliases: rows };
}, 'POST');

jsonApi('/api/alias/delete', (data) => {
  const key = String(data?.key || '').trim();
  if (!ALIAS_KEY_RE.test(key)) {
    throw new HttpError(400, '别名非法');
  }
  const rows = readAliases().filter((r) => r.key !== key);
  writeAliases(rows);
  return { ok: true, aliases: rows };
}, 'POST');

jsonApi('/api/state/reset', (data) => {
  const convId = String(data?.conversationId || '').trim();
  if (!convId || !/^[A-Za-z0-9_-]{4,128}$/.test(convId)) {
    throw new HttpError(400, '会话 ID 非法');
  }
  const state = readState();
  if (state[convId] && typeof state[convId] === 'object') {
    const entry = { ...state[convId] };
    for (const k of ['tries', 'zero_streak', 'dead', 'dead_reason', 'notified', 'defer_alias']) {
      delete entry[k];
    }
    entry.ts = Date.now() / 1000;
    state[convId] = entry;
    mkdirSync(DATA_DIR, { recursive: true });
    atomicWrite(STATE_PATH, JSON.stringify(state));
  }
  return { ok: true, conversationId: convId };
}, 'POST');

await app.run();
