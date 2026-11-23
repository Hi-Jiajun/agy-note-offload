#!/usr/bin/env node
/**
 * agysum: 把 Antigravity 的 transcript.jsonl 压成要点，接续旧会话时用它代替整份转储。
 * 支持自动跨桌面端 / CLI / IDE 的 brain 目录检索会话 ID 或前缀、尾部分块读取、修改文件页脚与结构化检索。
 *
 * 用法：
 *   node agysum.mjs <transcript.jsonl | 会话ID | 前缀> [--tail 40] [--width 120] [--full] [--tools] [--search <kw>] [--json]
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getBrainDirs, shortPath } from '../lib/paths.mjs';

const USAGE =
  '用法:\n' +
  '  agysum.mjs <transcript.jsonl | 会话ID | 前缀> [--tail 40] [--width 120] [--full] [--tools] [--search <kw>] [--json]';

const INITIAL_TAIL_CHUNK_BYTES = 512 * 1024;
const MAX_MODIFIED_FILES = 15;
const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function parsePositiveInt(val, flag) {
  if (!/^\d+$/.test(String(val))) {
    fail(`${flag} 必须为正整数: ${val}`);
  }
  const n = Number.parseInt(val, 10);
  if (!Number.isInteger(n) || n < 1) {
    fail(`${flag} 必须 >= 1: ${val}`);
  }
  return n;
}

function parseArgs(argv) {
  let target = '';
  let tail = 40;
  let width = 120;
  let full = false;
  let tools = false;
  let search = '';
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--full') {
      full = true;
    } else if (a === '--tools') {
      tools = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--search') {
      if (i + 1 >= argv.length) fail('缺少 --search 参数值');
      search = String(argv[++i]);
    } else if (a.startsWith('--search=')) {
      search = a.slice(9);
    } else if (a === '--tail') {
      if (i + 1 >= argv.length) fail('缺少 --tail 参数值');
      tail = parsePositiveInt(argv[++i], '--tail');
    } else if (a.startsWith('--tail=')) {
      tail = parsePositiveInt(a.slice(7), '--tail');
    } else if (a === '--width') {
      if (i + 1 >= argv.length) fail('缺少 --width 参数值');
      width = parsePositiveInt(argv[++i], '--width');
    } else if (a.startsWith('--width=')) {
      width = parsePositiveInt(a.slice(8), '--width');
    } else if (a.startsWith('-')) {
      fail(`未知参数: ${a}`);
    } else if (!target) {
      target = a;
    } else {
      fail(`多余的参数: ${a}`);
    }
  }

  if (!target) {
    fail(USAGE);
  }
  return { target, tail, width, full, tools, search, json };
}

function resolveTranscript(arg) {
  if (existsSync(arg)) {
    try {
      if (statSync(arg).isFile()) return arg;
    } catch {
      // 回退到 brain 查找
    }
  }

  const brainDirs = getBrainDirs();
  for (const brain of brainDirs) {
    const exact = join(brain, arg, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(exact)) return exact;
  }

  const prefixHits = [];
  for (const brain of brainDirs) {
    let entries = [];
    try {
      entries = readdirSync(brain, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith(arg)) continue;
      const cand = join(brain, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(cand)) {
        try {
          prefixHits.push({ path: cand, mtime: statSync(cand).mtimeMs });
        } catch {
          // 忽略不可访问文件
        }
      }
    }
  }

  if (prefixHits.length > 0) {
    prefixHits.sort((a, b) => b.mtime - a.mtime);
    return prefixHits[0].path;
  }

  fail(`找不到 transcript: ${arg}`);
}

function parseJsonlText(raw, skipFirstLine = false) {
  const lines = raw.split(/\r?\n/);
  const startIdx = skipFirstLine ? 1 : 0;
  const rows = [];
  let badLines = 0;
  for (let i = startIdx; i < lines.length; i += 1) {
    const s = lines[i].trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        badLines += 1;
        continue;
      }
      rows.push(rec);
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines };
}

function readTranscriptRecords(filePath, { full = false, needCount = 40 } = {}) {
  const size = statSync(filePath).size;
  if (full || size <= INITIAL_TAIL_CHUNK_BYTES) {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parseJsonlText(raw, false);
    return { ...parsed, partialRead: false, fileBytes: size };
  }

  let chunkBytes = INITIAL_TAIL_CHUNK_BYTES;
  let fd = -1;
  try {
    fd = openSync(filePath, 'r');
    while (true) {
      const start = Math.max(0, size - chunkBytes);
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      const n = readSync(fd, buf, 0, len, start);
      const raw = buf.subarray(0, n).toString('utf-8');
      const parsed = parseJsonlText(raw, start > 0);
      if (start === 0 || parsed.rows.length >= needCount) {
        return {
          ...parsed,
          partialRead: start > 0,
          fileBytes: size,
        };
      }
      chunkBytes *= 2;
    }
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

function flat(text, width) {
  const out = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .replaceAll('<USER_REQUEST>', '')
    .replaceAll('</USER_REQUEST>', '');
  return out.length <= width ? out : `${out.slice(0, width)}…`;
}

function normalizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const name = String(tc.name || tc.tool_name || tc.function?.name || '').trim();
  if (!name) return null;
  let args = tc.arguments ?? tc.args ?? tc.function?.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { raw: args };
    }
  }
  if (!args || typeof args !== 'object') args = {};
  return { name, args };
}

function summarizeToolCall(tc, width = 80) {
  const norm = normalizeToolCall(tc);
  if (!norm) return '';
  const { name, args } = norm;
  const targetPath = args.Path || args.path || args.TargetFile || args.file_path || args.target_file || '';
  if (targetPath) {
    return `${name}(${shortPath(String(targetPath))})`;
  }
  const cmd = args.CommandLine || args.command || args.cmd || '';
  if (cmd) {
    return `${name}(${flat(cmd, width)})`;
  }
  const query = args.query || args.Query || args.Pattern || '';
  if (query) {
    return `${name}(${flat(query, width)})`;
  }
  return name;
}

function extractModifiedFiles(rows, maxFiles = MAX_MODIFIED_FILES) {
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
    for (const tc of calls) {
      const norm = normalizeToolCall(tc);
      if (!norm) continue;
      const baseName = norm.name.split(':').pop();
      if (!FILE_WRITE_TOOLS.has(baseName)) continue;
      const rawPath = norm.args.Path || norm.args.path || norm.args.TargetFile || norm.args.file_path || norm.args.target_file || '';
      if (!rawPath) continue;
      const disp = shortPath(String(rawPath));
      if (!seen.has(disp)) {
        seen.add(disp);
        unique.push(disp);
      }
    }
  }
  return {
    files: unique.slice(0, maxFiles),
    totalUnique: unique.length,
  };
}

function formatStepContent(r) {
  const rawC = r.content;
  let c;
  if (typeof rawC === 'string') {
    c = rawC;
  } else if (rawC === null || rawC === undefined) {
    c = '';
  } else {
    c = JSON.stringify(rawC);
  }
  if (c.includes('blocked by Gemini')) {
    c = '[被拦]';
  }
  return c;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = resolveTranscript(args.target);
  const needFullRead = args.full || Boolean(args.search);
  const { rows, badLines, partialRead, fileBytes } = readTranscriptRecords(path, {
    full: needFullRead,
    needCount: Math.max(args.tail * 2, 80),
  });

  const kw = args.search.trim().toLowerCase();
  const visibleRows = [];
  for (const r of rows) {
    const kind = String(r.type || '');
    const who = kind === 'USER_INPUT' ? 'U' : (kind.startsWith('SYSTEM') ? 'S' : 'M');
    if (who === 'S') continue;
    const text = formatStepContent(r);
    const toolSummaries = (Array.isArray(r.tool_calls) ? r.tool_calls : [])
      .map((tc) => summarizeToolCall(tc, Math.max(40, Math.floor(args.width * 0.7))))
      .filter(Boolean);
    if (kw) {
      const hay = `${text}\n${toolSummaries.join(' ')}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    visibleRows.push({
      step: r.step_index ?? null,
      who,
      type: kind,
      text: flat(text, args.width),
      tools: toolSummaries,
    });
  }

  const picked = (args.full || kw) ? visibleRows : visibleRows.slice(-args.tail);
  const blocked = rows.filter(
    (r) => typeof r.content === 'string' && r.content.includes('blocked by Gemini'),
  ).length;
  const mod = extractModifiedFiles(rows, MAX_MODIFIED_FILES);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      path,
      fileBytes,
      partialRead,
      scannedSteps: rows.length,
      matchedSteps: visibleRows.length,
      returnedSteps: picked.length,
      blocked,
      badLines,
      search: args.search || '',
      modifiedFiles: mod.files,
      modifiedFilesTotal: mod.totalUnique,
      steps: picked.map((s) => (args.tools ? s : { step: s.step, who: s.who, type: s.type, text: s.text })),
    }, null, 2)}\n`);
    return;
  }

  const badNote = badLines ? `（跳过 ${badLines} 行损坏记录）` : '';
  const partialNote = partialRead ? '（尾部快读窗口）' : '';
  const sliceLabel = kw
    ? `匹配 "${args.search}" 共 ${picked.length} 步`
    : (args.full ? '全部' : `最后 ${picked.length} 步`);

  process.stdout.write(`# ${path}\n`);
  process.stdout.write(`# 共 ${rows.length} 步${partialNote}，其中被拦 ${blocked} 次${badNote}；下面取 ${sliceLabel}\n`);

  for (const s of picked) {
    process.stdout.write(`${s.who}${s.step}: ${s.text}\n`);
    if (args.tools && s.tools.length > 0) {
      process.stdout.write(`  [tools] ${s.tools.join(' ; ')}\n`);
    }
  }

  if (mod.files.length > 0) {
    const capNote = mod.totalUnique > mod.files.length ? `, 仅展示前 ${mod.files.length}` : '';
    process.stdout.write(`# 修改文件 (${mod.totalUnique} 项${capNote}): ${mod.files.join(', ')}\n`);
  }
}

main();
