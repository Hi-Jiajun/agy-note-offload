#!/usr/bin/env node
/**
 * agysum: 把 Antigravity 的 transcript.jsonl 压成要点，接续旧会话时用它代替整份转储。
 * 支持自动跨桌面端 / CLI / IDE 的 brain 目录检索会话 ID 或前缀。
 *
 * 用法：
 *   node agysum.mjs <transcript.jsonl | 会话ID | 前缀> [--tail 40] [--width 120] [--full]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getBrainDirs } from '../lib/paths.mjs';

const USAGE =
  '用法:\n' +
  '  agysum.mjs <transcript.jsonl | 会话ID | 前缀> [--tail 40] [--width 120] [--full]';

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

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--full') {
      full = true;
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
  return { target, tail, width, full };
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = resolveTranscript(args.target);
  const raw = readFileSync(path, 'utf-8');

  const rows = [];
  let badLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
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

  const picked = args.full ? rows : rows.slice(-args.tail);
  const blocked = rows.filter(
    (r) => typeof r.content === 'string' && r.content.includes('blocked by Gemini'),
  ).length;
  const badNote = badLines ? `（跳过 ${badLines} 行损坏记录）` : '';
  const sliceLabel = args.full ? '全部' : `最后 ${picked.length} 步`;

  process.stdout.write(`# ${path}\n`);
  process.stdout.write(`# 共 ${rows.length} 步，其中被拦 ${blocked} 次${badNote}；下面取 ${sliceLabel}\n`);

  for (const r of picked) {
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
    const kind = String(r.type || '');
    const who = kind === 'USER_INPUT' ? 'U' : (kind.startsWith('SYSTEM') ? 'S' : 'M');
    if (who === 'S') continue;
    process.stdout.write(`${who}${r.step_index}: ${flat(c, args.width)}\n`);
  }
}

main();
