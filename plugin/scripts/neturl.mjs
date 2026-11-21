#!/usr/bin/env node
/**
 * neturl: 上游脱敏别名解析器（基于数据目录 net-map.tsv，支持文件锁与原子写入）。
 *
 * 用法：
 *   node neturl.mjs gw-a                    打印真值
 *   node neturl.mjs gw-a /v1/das/devices    打印拼接后的完整地址
 *   node neturl.mjs --set gw-c https://h/p [备注]   追加一条
 *   node neturl.mjs --list                  列出全部别名与备注
 */
import { existsSync } from 'node:fs';
import { addAliasStrict, readAliases, resolveAlias } from '../lib/aliases.mjs';
import { getMapPath } from '../lib/paths.mjs';

const USAGE =
  '用法:\n' +
  '  neturl.mjs <别名> [路径后缀]\n' +
  '  neturl.mjs --set <别名> <真值> [备注]\n' +
  '  neturl.mjs --list';

function main() {
  const args = process.argv.slice(2);
  const first = args[0] || '';

  if (!first || first === '-h' || first === '--help') {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  if (first === '--list') {
    const mapPath = getMapPath();
    if (!existsSync(mapPath)) {
      process.stderr.write(`尚无别名表: ${mapPath}（可用 neturl.mjs --set 初始化）\n`);
      process.exit(1);
    }
    const rows = readAliases(process.env, { fallbackExample: false });
    const maxKeyLen = rows.reduce((m, r) => Math.max(m, r.key.length), 0);
    for (const r of rows) {
      const note = r.note || '';
      const line = note ? `${r.key.padEnd(maxKeyLen)}  ${note}` : r.key;
      process.stdout.write(`${line}\n`);
    }
    return;
  }

  if (first === '--set') {
    if (args.length < 3) {
      process.stderr.write('用法: neturl.mjs --set 别名 真值 [备注]\n');
      process.exit(1);
    }
    try {
      addAliasStrict(args[1], args[2], args[3] || '');
      process.stdout.write(`已追加 ${args[1]}\n`);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  const res = resolveAlias(first, args[1] || '');
  if (!res.ok) {
    process.stderr.write(`${res.error}\n`);
    process.exit(res.code || 2);
  }
  process.stdout.write(`${res.url}\n`);
}

main();
