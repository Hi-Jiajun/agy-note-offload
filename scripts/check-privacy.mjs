#!/usr/bin/env node
/**
 * 仓库隐私、冗余文件与安全红线门禁扫描。
 * 拦截：被 git 跟踪的 .agents/、__pycache__/*.pyc、个人主目录绝对路径、私有网段、密钥及危险删除命令。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SKIP_DIRS = new Set(['.git', '.agents', 'dist', 'node_modules']);
const TEXT_EXTS = new Set([
  '.mjs', '.js', '.json', '.md', '.sh', '.yml', '.yaml', '.css', '.html', '.svg', '.example', '',
]);

const HOME_PATH_RE = new RegExp(`(?:${'/'}(?:home|Users)/[A-Za-z0-9._-]+/)`, 'g');
const PRIVATE_IP_RE = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
const SECRET_RE = new RegExp(
  `(?:${'sk'}-[A-Za-z0-9]{20,}|${'ghp'}_[A-Za-z0-9]{20,}|${'AIza'}[0-9A-Za-z_-]{25,})`,
  'g',
);
const DANGEROUS_RM_RE = new RegExp(`\\b${'rm'}\\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\\b`, 'g');

function checkGitTracked(issues) {
  if (!existsSync(join(ROOT, '.git'))) return;
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' });
    for (const rel of out.split(/\r?\n/)) {
      if (!rel) continue;
      if (rel === '.agents' || rel.startsWith('.agents/')) {
        issues.push(`严禁 git 跟踪本地工作区文件: ${rel}`);
      }
      if (rel.includes('__pycache__') || rel.endsWith('.pyc')) {
        issues.push(`严禁 git 跟踪字节码文件: ${rel}`);
      }
      if (rel.endsWith('net-map.tsv') || rel.endsWith('.filter-retry-state.json') || rel.endsWith('hook-invocations.log')) {
        issues.push(`严禁 git 跟踪个人运行时文件: ${rel}`);
      }
    }
  } catch {
    // 非 git 归档解压环境忽略 git ls-files
  }
}

function walk(dir, issues) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    const rel = relative(ROOT, full).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (ent.name === '__pycache__') {
        issues.push(`工作区残留 __pycache__ 目录: ${rel}`);
        continue;
      }
      walk(full, issues);
      continue;
    }

    if (ent.name.endsWith('.pyc') || ent.name === 'net-map.tsv' || ent.name === '.filter-retry-state.json') {
      issues.push(`工作区残留敏感或运行时文件: ${rel}`);
      continue;
    }

    const dotIdx = ent.name.lastIndexOf('.');
    const ext = dotIdx >= 0 ? ent.name.slice(dotIdx) : '';
    if (!TEXT_EXTS.has(ext) && ent.name !== 'LICENSE') continue;

    let content = '';
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (rel === 'AGENTS.md' && line.includes('严禁')) continue;
      if (rel === 'scripts/check-privacy.mjs') continue;

      const homeHits = line.match(HOME_PATH_RE);
      if (homeHits) {
        issues.push(`${rel}:${i + 1} 含个人主目录绝对路径: ${homeHits[0]}`);
      }
      const ipHits = line.match(PRIVATE_IP_RE);
      if (ipHits) {
        issues.push(`${rel}:${i + 1} 含私有内网 IP 字面量: ${ipHits[0]}`);
      }
      const secHits = line.match(SECRET_RE);
      if (secHits) {
        issues.push(`${rel}:${i + 1} 疑似包含密钥前缀`);
      }
      if (DANGEROUS_RM_RE.test(line)) {
        DANGEROUS_RM_RE.lastIndex = 0;
        issues.push(`${rel}:${i + 1} 含危险递归删除命令`);
      }
    }
  }
}

function main() {
  const issues = [];
  checkGitTracked(issues);
  walk(ROOT, issues);

  if (issues.length > 0) {
    for (const msg of issues) {
      process.stderr.write(`PRIVACY CHECK FAIL: ${msg}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('隐私与安全红线门禁扫描通过\n');
}

main();
