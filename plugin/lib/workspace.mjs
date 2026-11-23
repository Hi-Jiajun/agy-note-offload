import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { getNoteRoot, noteRootDisplay, shortPath } from './paths.mjs';

export const WS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.(md|txt|json|log|csv|tsv|yaml|yml|diff|patch)$/;
export const EDITABLE_FILES = new Set(['task.md', 'status.md']);
export const WORKSPACE_FILE_EXT_RE = /\.(?:md|markdown|txt|json|jsonl|log|csv|tsv|yaml|yml|diff|patch|sh|bash|py|mjs|cjs|js|ts|tsx|jsx|png|jpg|jpeg|gif|webp|svg|pdf|zip|tar|gz|tgz|html|htm|css|xml|ini|conf|toml|lock)$/i;
export const RESERVED_WS_NAMES = new Set(['_archive']);

const NOTE_DIR_RE = /(?:~|\/[^\s"'`<>]+)?\/agy-notes\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;
const FENCED_CODE_RE = /(`{3,}|~{3,})[\s\S]*?\1/g;
const INLINE_CODE_RE = /`+[^`\n]*?`+/g;
const EXPLICIT_CMD_RE = /(?<![A-Za-z0-9._~/-])\/note-offload(?![A-Za-z0-9._/-])/;
const EXPLICIT_OFF_CMD_RE = /(?<![A-Za-z0-9._~/-])\/note-offload\s+(?:off|disable|stop|exit|关闭|退出)(?![A-Za-z0-9._/-])/i;
const PLACEHOLDERS = new Set(['name', 'task', 'work', 'dir', 'conv', 'conv8', 'session', 'workspace', 'example', '_archive']);

/**
 * 判断候选名称是否为 ~/agy-notes/ 根目录下的独立普通文件（严禁绑定为工作台目录）。
 * @param {string} name
 * @param {{ noteRoot?: string, followedBySlash?: boolean }} [options]
 * @returns {boolean}
 */
export function isWorkspaceFileCandidate(name, { noteRoot = '', followedBySlash = false } = {}) {
  if (!name || typeof name !== 'string') return true;
  if (RESERVED_WS_NAMES.has(name.toLowerCase())) return true;
  if (noteRoot) {
    try {
      const full = join(noteRoot, name);
      if (existsSync(full)) {
        const st = statSync(full);
        if (st.isFile()) return true;
        if (st.isDirectory()) return false;
      }
    } catch {
      // 忽略磁盘探查失败，继续走后缀判定
    }
  }
  if (WORKSPACE_FILE_EXT_RE.test(name)) {
    return true;
  }
  if (!followedBySlash && noteRoot) {
    return false;
  }
  return false;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function taskTemplate(name) {
  return `# 任务单（${name}）

## 目标
- 在此填写本阶段唯一工程目标与验收判据。

## 待办阶段
- [ ] 阶段 1：
- [ ] 阶段 2：

## 约束与参考路径
- 参考文件：
- 注意事项：脚本大输出请直接写文件，不要直接刷终端。
`;
}

export function statusTemplate(name, nowStr = formatNow()) {
  return `# 进度看板（${name}）

- 更新时间：${nowStr}
- 当前状态：待启动
- 最新详稿：暂无

## 阶段进展
- 尚未开始执行，请读取同目录 \`task.md\` 推进第一项未完成阶段。
`;
}

/**
 * 判断文件是否为需要二次确认风险后才能在线编辑的工作台产物。
 * @param {string} fileName
 * @returns {boolean}
 */
export function isConfirmEditableFile(fileName) {
  return typeof fileName === 'string' && FILE_NAME_RE.test(fileName) && !EDITABLE_FILES.has(fileName);
}

/**
 * 剥离围栏代码块（可选剥离行内代码），防止示例文本误触发工作台绑定或模式开关。
 * @param {string} text
 * @param {{ stripInline?: boolean }} [options]
 * @returns {string}
 */
export function stripMarkdownCode(text, { stripInline = true } = {}) {
  if (!text) return '';
  let cleaned = String(text).replace(FENCED_CODE_RE, ' ');
  if (stripInline) {
    cleaned = cleaned.replace(INLINE_CODE_RE, ' ');
  }
  return cleaned;
}

/**
 * 判断非代码文本是否显式要求关闭落盘模式（/note-offload off 或 [退出落盘]）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasExplicitOffloadOff(text) {
  const plain = stripMarkdownCode(text, { stripInline: true });
  if (
    plain.includes('[退出落盘]') ||
    plain.includes('[退出落盘模式]') ||
    plain.includes('[关闭落盘模式]')
  ) {
    return true;
  }
  return EXPLICIT_OFF_CMD_RE.test(plain);
}

/**
 * 仅当非代码文本出现独立命令词 /note-offload 或 [落盘模式]/[文件模式]（且非显式退出指令）时返回 true。
 * @param {string} text
 * @returns {boolean}
 */
export function hasExplicitOffload(text) {
  if (hasExplicitOffloadOff(text)) return false;
  const plain = stripMarkdownCode(text, { stripInline: true });
  if (plain.includes('[落盘模式]') || plain.includes('[文件模式]')) {
    return true;
  }
  return EXPLICIT_CMD_RE.test(plain);
}

/**
 * 从非围栏代码文本中提取显式指定的命名工作台路径。
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function extractNoteDir(text, env = process.env) {
  if (!text) return '';
  const cleaned = stripMarkdownCode(text, { stripInline: false });
  const patterns = [new RegExp(NOTE_DIR_RE.source, 'g')];
  const noteRoot = getNoteRoot(env);
  const rootDisp = noteRootDisplay(env);

  for (const base of new Set([noteRoot.replace(/\/+$/, ''), rootDisp.replace(/\/+$/, '')])) {
    if (base && !base.endsWith('/agy-notes')) {
      patterns.push(
        new RegExp(`${escapeRegex(base)}/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?![A-Za-z0-9._-])`, 'g'),
      );
    }
  }

  const candidates = [];
  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(cleaned)) !== null) {
      const endIdx = match.index + match[0].length;
      const followedBySlash = cleaned[endIdx] === '/';
      candidates.push([match.index, match[1], followedBySlash]);
    }
  }
  candidates.sort((a, b) => a[0] - b[0]);

  for (const [, rawName, followedBySlash] of candidates) {
    const name = rawName.replace(/\.+$/, '');
    if (!name || name.includes('..') || !WS_NAME_RE.test(name) || PLACEHOLDERS.has(name.toLowerCase())) {
      continue;
    }
    if (isWorkspaceFileCandidate(name, { noteRoot, followedBySlash })) {
      continue;
    }
    return `${rootDisp}/${name}`;
  }
  return '';
}

/**
 * 从状态条目提取工作台短名，未绑定或为单文件误绑时回退会话 ID 前 8 位。
 * @param {string} conv
 * @param {Record<string, any> | null | undefined} entry
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function wsNameFromEntry(conv, entry, env = process.env) {
  const nd = entry && typeof entry === 'object' ? entry.note_dir : '';
  if (typeof nd === 'string' && nd) {
    const noteRoot = getNoteRoot(env);
    const rootDisp = noteRootDisplay(env);
    const prefixes = [
      '~/agy-notes/',
      `${rootDisp.replace(/\/+$/, '')}/`,
      `${noteRoot.replace(/\/+$/, '')}/`,
    ];
    for (const pfx of prefixes) {
      if (nd.startsWith(pfx)) {
        const rel = nd.slice(pfx.length).replace(/\/+$/, '');
        if (
          rel &&
          !rel.includes('/') &&
          !rel.includes('..') &&
          WS_NAME_RE.test(rel) &&
          !isWorkspaceFileCandidate(rel, { noteRoot })
        ) {
          return rel;
        }
      }
    }
  }
  return String(conv || 'misc').slice(0, 8);
}

/**
 * 解析工作台绝对目录路径（优先使用已绑定的命名工作台，自动忽略单文件误绑残留）。
 * @param {string} conv
 * @param {Record<string, any> | null | undefined} [entry]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function toAbsNoteDir(conv, entry = null, env = process.env) {
  const noteRoot = getNoteRoot(env);
  if (entry && typeof entry === 'object') {
    const nd = entry.note_dir || '';
    if (typeof nd === 'string' && nd) {
      const rootDisp = noteRootDisplay(env);
      const prefixes = [
        '~/agy-notes/',
        `${rootDisp.replace(/\/+$/, '')}/`,
        `${noteRoot.replace(/\/+$/, '')}/`,
      ];
      let rel = '';
      for (const pfx of prefixes) {
        if (nd.startsWith(pfx)) {
          rel = nd.slice(pfx.length).replace(/\/+$/, '');
          break;
        }
      }
      if (
        rel &&
        !rel.includes('/') &&
        !rel.includes('..') &&
        WS_NAME_RE.test(rel) &&
        !isWorkspaceFileCandidate(rel, { noteRoot })
      ) {
        return join(noteRoot, rel);
      }
    }
  }

  const rawKey = String(conv || 'misc').slice(0, 8);
  let safeKey = rawKey.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'misc';
  if (safeKey.includes('..')) {
    safeKey = 'misc';
  }
  return join(noteRoot, safeKey);
}

/**
 * 解析本会话目标落盘目录（默认惰性不创建空目录）。
 * @param {string} conv
 * @param {Record<string, any> | null | undefined} [entry]
 * @param {{ create?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function resolveNoteDir(conv, entry = null, { create = false, env = process.env } = {}) {
  const dirPath = toAbsNoteDir(conv, entry, env);
  if (create) {
    try {
      mkdirSync(dirPath, { recursive: true });
    } catch {
      // 忽略权限等建目录异常
    }
  }
  return shortPath(dirPath, env);
}

/**
 * 计算工作台目录中下一个连续递增的 turn-N.md 序号（无既有详稿时返回 1）。
 * @param {string} conv
 * @param {Record<string, any> | null | undefined} [entry]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function nextTurnIndex(conv, entry = null, env = process.env) {
  const dirPath = toAbsNoteDir(conv, entry, env);
  if (!existsSync(dirPath)) return 1;
  let maxNum = 0;
  try {
    for (const ent of readdirSync(dirPath, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const m = /^turn-(\d+)\.md$/.exec(ent.name);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isInteger(n) && n > maxNum) {
          maxNum = n;
        }
      }
    }
  } catch {
    return 1;
  }
  return maxNum + 1;
}

/**
 * 在工作台目录中查找最新输出笔记（优先 turn-*.md，其次 status.md，跳过 task.md）。
 * @param {string} conv
 * @param {Record<string, any> | null | undefined} [entry]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function latestNote(conv, entry = null, env = process.env) {
  const dirPath = toAbsNoteDir(conv, entry, env);
  if (!existsSync(dirPath)) return '';

  let bestTurn = { mtime: -1, num: -1, path: '' };
  let statusPath = '';
  try {
    for (const ent of readdirSync(dirPath, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const full = join(dirPath, ent.name);
      if (ent.name.startsWith('turn-') && ent.name.endsWith('.md')) {
        const mtime = statSync(full).mtimeMs;
        const m = /^turn-(\d+)\.md$/.exec(ent.name);
        const num = m ? Number.parseInt(m[1], 10) : 0;
        if (mtime > bestTurn.mtime || (mtime === bestTurn.mtime && num > bestTurn.num)) {
          bestTurn = { mtime, num, path: full };
        }
      } else if (ent.name === 'status.md') {
        statusPath = full;
      }
    }
  } catch {
    return '';
  }

  const picked = bestTurn.path || statusPath;
  return picked ? shortPath(picked, env) : '';
}

/**
 * 生成接续提示词：存在任务文件时优先关联 task.md + status.md + 最新 turn-N.md，否则回退 agysum。
 * @param {string} conv
 * @param {Record<string, any> | null | undefined} [entry]
 * @param {string} [agysumScript]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ noteDir: string, latest: string, files: string[], prompt: string }}
 */
export function buildWorkspaceRelayPrompt(conv, entry = null, agysumScript = '', env = process.env) {
  const conv8 = String(conv || 'misc').slice(0, 8);
  const dirPath = toAbsNoteDir(conv, entry, env);
  const noteDir = resolveNoteDir(conv, entry, { create: false, env });
  const latest = latestNote(conv, entry, env);

  const files = [];
  if (existsSync(join(dirPath, 'task.md'))) {
    files.push(`${noteDir}/task.md`);
  }
  if (existsSync(join(dirPath, 'status.md'))) {
    files.push(`${noteDir}/status.md`);
  }
  if (latest && !files.includes(latest)) {
    files.push(latest);
  }

  const agysumRef = agysumScript ? `node ${agysumScript} ${conv8}` : `agysum.mjs ${conv8}`;
  let prompt;
  if (files.length > 0) {
    const agysumPart = agysumScript ? `，需要历史再跑 ${agysumRef}` : '';
    prompt = `/note-offload 接续会话 ${conv8}（先读 ${files.join('、')}${agysumPart}），继续下一未完成阶段并落盘汇报`;
  } else {
    prompt = `/note-offload 接续会话 ${conv8}（先用 ${agysumRef} 提炼要点），继续下一步`;
  }

  return { noteDir, latest, files, prompt };
}

/**
 * 读取工作台 status.md 中的简短状态摘要。
 * @param {string} wsDir
 * @param {number} [maxLen]
 * @returns {string}
 */
export function readStatusSummary(wsDir, maxLen = 120) {
  const sf = join(wsDir, 'status.md');
  if (!existsSync(sf)) return '';
  let lines;
  try {
    lines = readFileSync(sf, 'utf-8').split(/\r?\n/);
  } catch {
    return '';
  }
  for (const ln of lines) {
    const s = ln.trim();
    if (s.startsWith('- 当前状态：') || s.startsWith('- 状态：')) {
      const val = s.slice(s.indexOf('：') + 1).trim();
      return val.length <= maxLen ? val : `${val.slice(0, maxLen - 1)}…`;
    }
  }
  for (const ln of lines) {
    const s = ln.trim();
    if (s && !s.startsWith('#') && !s.startsWith('- 更新时间')) {
      return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
    }
  }
  return '';
}

/**
 * 安全清理工作台根目录下的 0 文件空目录（跳过符号链接）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ removed: string[], kept: number, exists: boolean }}
 */
export function cleanEmptyWorkspaces(env = process.env) {
  const noteRoot = getNoteRoot(env);
  if (!existsSync(noteRoot)) {
    return { removed: [], kept: 0, exists: false };
  }
  const removed = [];
  let kept = 0;
  const entries = readdirSync(noteRoot, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    if (RESERVED_WS_NAMES.has(ent.name.toLowerCase())) {
      continue;
    }
    const full = join(noteRoot, ent.name);
    try {
      if (lstatSync(full).isSymbolicLink() || !ent.isDirectory()) {
        continue;
      }
      if (readdirSync(full).length === 0) {
        rmdirSync(full);
        removed.push(ent.name);
      } else {
        kept += 1;
      }
    } catch {
      kept += 1;
    }
  }
  return { removed, kept, exists: true };
}

/**
 * 将用户输入规整后生成 12 位 SHA-1 指纹，用于识别原样重复重发。
 * @param {string} text
 * @returns {string}
 */
export function inputSig(text) {
  const norm = String(text || '').trim().split(/\s+/).filter(Boolean).join(' ');
  if (!norm) return '';
  return createHash('sha1').update(norm, 'utf-8').digest('hex').slice(0, 12);
}

/**
 * 校验目标路径是否严格位于根目录内部且非符号链接，防止目录穿越。
 * @param {string} rootDir
 * @param {string} targetPath
 * @returns {string}
 */
export function assertOwnedSubpath(rootDir, targetPath) {
  const absRoot = resolve(rootDir);
  const absTarget = resolve(targetPath);
  const rel = relative(absRoot, absTarget);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || absTarget === absRoot) {
    const err = new Error('路径越界被拒绝');
    err.status = 403;
    throw err;
  }
  if (existsSync(absTarget) && lstatSync(absTarget).isSymbolicLink()) {
    const err = new Error('拒绝访问符号链接');
    err.status = 403;
    throw err;
  }
  return absTarget;
}

/**
 * 校验工作台名称并解析其绝对路径。
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveWorkspaceDir(name, env = process.env) {
  if (typeof name !== 'string' || !WS_NAME_RE.test(name) || RESERVED_WS_NAMES.has(name.toLowerCase())) {
    const err = new Error('工作台名称非法（仅支持字母、数字及 . _ -，且不可使用保留名）');
    err.status = 400;
    throw err;
  }
  const noteRoot = getNoteRoot(env);
  return assertOwnedSubpath(noteRoot, join(noteRoot, name));
}

/**
 * 校验工作台名与文件名，并返回两者绝对路径。
 * @param {string} wsName
 * @param {string} fileName
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ wsDir: string, filePath: string }}
 */
export function resolveWorkspaceFile(wsName, fileName, env = process.env) {
  if (typeof fileName !== 'string' || !FILE_NAME_RE.test(fileName)) {
    const err = new Error('文件名非法（仅支持 .md/.txt/.json/.log/.csv/.tsv/.yaml/.yml/.diff/.patch）');
    err.status = 400;
    throw err;
  }
  const wsDir = resolveWorkspaceDir(wsName, env);
  return {
    wsDir,
    filePath: assertOwnedSubpath(wsDir, join(wsDir, fileName)),
  };
}

/**
 * 对工作台内文件按 status.md -> task.md -> turn-N.md(降序) -> 其余文件排序。
 * @param {string[]} files
 * @returns {string[]}
 */
export function sortWorkspaceFiles(files) {
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
