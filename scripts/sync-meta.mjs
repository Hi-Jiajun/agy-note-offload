#!/usr/bin/env node
/**
 * 同步或校验单一版本源（根 package.json）与共享文档（LICENSE / README.md）至 plugin/。
 * 用法：
 *   node ./scripts/sync-meta.mjs          # 同步写入
 *   node ./scripts/sync-meta.mjs --check  # 仅校验，不一致则非零退出
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const checkOnly = process.argv.includes('--check');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function syncTextFile(srcRel, dstRel, diffs) {
  const srcPath = join(ROOT, srcRel);
  const dstPath = join(ROOT, dstRel);
  const expected = readFileSync(srcPath, 'utf-8');
  const actual = existsSync(dstPath) ? readFileSync(dstPath, 'utf-8') : null;
  if (actual !== expected) {
    if (checkOnly) {
      diffs.push(`${dstRel} 与 ${srcRel} 内容不一致`);
    } else {
      writeFileSync(dstPath, expected, 'utf-8');
    }
  }
}

function syncJsonVersion(relPath, version, diffs) {
  const full = join(ROOT, relPath);
  const obj = readJson(full);
  if (obj.version !== version) {
    if (checkOnly) {
      diffs.push(`${relPath} 版本 (${obj.version}) 与根 package.json (${version}) 不一致`);
    } else {
      obj.version = version;
      writeFileSync(full, `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
    }
  }
}

function main() {
  const rootPkg = readJson(join(ROOT, 'package.json'));
  const version = String(rootPkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    process.stderr.write(`根 package.json 版本号非法: ${version}\n`);
    process.exit(1);
  }

  const diffs = [];
  syncJsonVersion('plugin/plugin.json', version, diffs);
  syncJsonVersion('plugin/sidecars/board/package.json', version, diffs);
  syncTextFile('LICENSE', 'plugin/LICENSE', diffs);
  syncTextFile('README.md', 'plugin/README.md', diffs);

  if (diffs.length > 0) {
    for (const d of diffs) {
      process.stderr.write(`SYNC CHECK FAIL: ${d}\n`);
    }
    process.stderr.write('请运行 `node ./scripts/sync-meta.mjs` 同步元数据。\n');
    process.exit(1);
  }

  process.stdout.write(
    checkOnly
      ? `元数据同步校验通过（version=${version}）\n`
      : `已完成元数据同步（version=${version}）\n`,
  );
}

main();
