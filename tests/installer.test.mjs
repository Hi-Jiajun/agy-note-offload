import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createSandbox } from './helpers/sandbox.mjs';

const INSTALLER = resolve('scripts', 'install.mjs');
const UNINSTALLER = resolve('scripts', 'uninstall.mjs');
const BUILDER = resolve('scripts', 'build-release.mjs');

const sandboxes = [];

function newSandbox() {
  const sb = createSandbox();
  sandboxes.push(sb);
  return sb;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    sandboxes.pop().cleanup();
  }
});

describe('安装器、卸载器与 Release ZIP 打包', () => {
  it('install.mjs 默认模式清旧软链、迁移旧数据并整目录同步纯净插件；--link-cli 可选建链；uninstall.mjs 干净卸载', () => {
    const sb = newSandbox();
    const env = { ...sb.env, AGY_LEGACY_DATA_DIR: sb.legacyDataDir };

    // 构造旧散装痕迹与旧软链
    mkdirSync(join(sb.configDir, 'scripts'), { recursive: true });
    mkdirSync(join(sb.configDir, 'skills', 'note-offload'), { recursive: true });
    writeFileSync(join(sb.configDir, 'skills', 'note-offload', 'SKILL.md'), 'old');
    writeFileSync(
      join(sb.configDir, 'hooks.json'),
      JSON.stringify({ 'note-offload-retry': {}, 'other-plugin': {} }),
    );
    mkdirSync(sb.legacyDataDir, { recursive: true });
    writeFileSync(join(sb.legacyDataDir, 'net-map.tsv'), 'gw-mig\thttps://mig.example.com\tmig\n');
    symlinkSync('/tmp/plugins/note-offload/scripts/agynote', join(sb.binDir, 'agynote'));

    // 1. 默认安装（不写外部软链且清旧软链）
    execFileSync(process.execPath, [INSTALLER], { env, encoding: 'utf-8' });

    const installedPlugin = join(sb.configDir, 'plugins', 'note-offload');
    assert.equal(existsSync(join(installedPlugin, 'plugin.json')), true);
    assert.equal(existsSync(join(installedPlugin, 'lib', 'paths.mjs')), true);
    assert.equal(existsSync(join(sb.configDir, 'skills', 'note-offload')), false);
    assert.equal(existsSync(join(sb.binDir, 'agynote')), false);

    const hooksLeft = JSON.parse(readFileSync(join(sb.configDir, 'hooks.json'), 'utf-8'));
    assert.equal(Object.hasOwn(hooksLeft, 'note-offload-retry'), false);
    assert.equal(Object.hasOwn(hooksLeft, 'other-plugin'), true);
    assert.match(readFileSync(join(sb.dataDir, 'net-map.tsv'), 'utf-8'), /gw-mig/);

    // 2. --link-cli 安装建立新 .mjs 软链并可执行
    execFileSync(process.execPath, [INSTALLER, '--link-cli'], { env, encoding: 'utf-8' });
    assert.equal(lstatSync(join(sb.binDir, 'agynote')).isSymbolicLink(), true);
    const out = execFileSync(join(sb.binDir, 'agynote'), ['status'], { env, encoding: 'utf-8' });
    assert.match(out, /工作台/);

    // 3. 卸载后保留数据目录与笔记目录，清插件与软链
    writeFileSync(join(sb.noteRoot, 'keep.txt'), 'keep');
    execFileSync(process.execPath, [UNINSTALLER], { env, encoding: 'utf-8' });
    assert.equal(existsSync(installedPlugin), false);
    assert.equal(existsSync(join(sb.binDir, 'agynote')), false);
    assert.equal(existsSync(join(sb.dataDir, 'net-map.tsv')), true);
    assert.equal(existsSync(join(sb.noteRoot, 'keep.txt')), true);
  });

  it('build-release.mjs 生成含完整 plugin 资产的 ZIP 与校验文件', () => {
    const sb = newSandbox();
    const outDir = join(sb.root, 'dist');
    const summaryRaw = execFileSync(process.execPath, [BUILDER, outDir], { env: sb.env, encoding: 'utf-8' });
    const summary = JSON.parse(summaryRaw);
    const zipPath = join(outDir, summary.zip);
    const shaPath = `${zipPath}.sha256`;

    assert.equal(existsSync(zipPath), true);
    assert.equal(existsSync(shaPath), true);
    const zipBytes = readFileSync(zipPath);
    assert.equal(zipBytes.includes(Buffer.from('plugin.json')), true);
    assert.equal(zipBytes.includes(Buffer.from('hooks.json')), true);
    assert.equal(zipBytes.includes(Buffer.from('lib/paths.mjs')), true);
    assert.match(readFileSync(shaPath, 'utf-8'), new RegExp(`^${summary.sha256}\\s+${summary.zip}`));
  });
});
