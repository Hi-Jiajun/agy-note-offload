#!/usr/bin/env node
/**
 * Note Offload Ring 5: Release Snapshot, Safe Install Pipeline & Instant Rollback
 * 在 <PLUGIN_DATA>/releases/ 中保留最近 3 份运行态快照，支持受控实装与秒级回滚。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFlightEvent } from '../plugin/lib/logger.mjs';
import { getDataDir, getGlobalConfigDir } from '../plugin/lib/paths.mjs';
import { runDoctor } from './offload-doctor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const INSTALL_SCRIPT = join(REPO_ROOT, 'scripts', 'install.mjs');
export const MAX_RELEASE_SNAPSHOTS = 3;

function readJsonSafe(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function getReleasesDir(dataDir) {
  return join(resolve(dataDir), 'releases');
}

function countFiles(dir) {
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) n += countFiles(full);
    else if (ent.isFile()) n += 1;
  }
  return n;
}

export function listSnapshots({ env = process.env, dataDir = '' } = {}) {
  const resolvedDataDir = dataDir ? resolve(dataDir) : getDataDir(env);
  const relDir = getReleasesDir(resolvedDataDir);
  if (!existsSync(relDir)) return [];
  return readdirSync(relDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(relDir, e.name);
      const manifest = readJsonSafe(join(dir, 'manifest.json'), {});
      const pluginJson = readJsonSafe(join(dir, 'plugin', 'plugin.json'), {});
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      const createdAtMs = Number.isFinite(manifest.createdAtMs)
        ? manifest.createdAtMs
        : (Date.parse(manifest.createdAt || '') || mtimeMs);
      return {
        name: e.name,
        dir,
        pluginDir: join(dir, 'plugin'),
        version: manifest.version || pluginJson.version || 'unknown',
        createdAt: manifest.createdAt || '',
        createdAtMs,
        fileCount: manifest.fileCount || 0,
      };
    })
    .sort((a, b) => (b.createdAtMs - a.createdAtMs) || b.name.localeCompare(a.name));
}

export function pruneSnapshots({ env = process.env, dataDir = '', keep = MAX_RELEASE_SNAPSHOTS, protectName = '' } = {}) {
  const snaps = listSnapshots({ env, dataDir });
  const cap = Math.max(1, keep);
  const kept = [];
  const toRemove = [];
  for (const s of snaps) {
    if (protectName && s.name === protectName) {
      kept.push(s);
    }
  }
  for (const s of snaps) {
    if (protectName && s.name === protectName) continue;
    if (kept.length < cap) kept.push(s);
    else toRemove.push(s);
  }
  const removed = [];
  for (const old of toRemove) {
    rmSync(old.dir, { recursive: true, force: true });
    removed.push(old.name);
  }
  return removed;
}

export function createSnapshot({
  env = process.env,
  configDir = '',
  dataDir = '',
  keep = MAX_RELEASE_SNAPSHOTS,
  tagSuffix = '',
} = {}) {
  const cfgDir = configDir ? resolve(configDir) : getGlobalConfigDir(env);
  const resolvedDataDir = dataDir ? resolve(dataDir) : getDataDir(env);
  const installedDir = join(cfgDir, 'plugins', 'note-offload');
  const installedMeta = readJsonSafe(join(installedDir, 'plugin.json'), null);
  if (!installedMeta) {
    return { created: false, reason: '当前未检测到已安装的 note-offload 插件，无需备份快照' };
  }

  const version = String(installedMeta.version || '0.0.0').replace(/[^0-9A-Za-z._-]/g, '');
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const stamp = createdAt.replace(/[-:.]/g, '');
  const unique = tagSuffix ? `-${String(tagSuffix).replace(/[^0-9A-Za-z_-]/g, '')}` : `-${Math.random().toString(16).slice(2, 6)}`;
  const snapName = `${stamp}-v${version}${unique}`;
  const snapDir = join(getReleasesDir(resolvedDataDir), snapName);
  const snapPluginDir = join(snapDir, 'plugin');

  mkdirSync(snapPluginDir, { recursive: true });
  cpSync(installedDir, snapPluginDir, { recursive: true });
  const fileCount = countFiles(snapPluginDir);
  const manifest = {
    name: snapName,
    version,
    createdAt,
    createdAtMs: nowMs,
    fileCount,
  };
  writeFileSync(join(snapDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  const pruned = pruneSnapshots({ env, dataDir: resolvedDataDir, keep, protectName: snapName });
  appendFlightEvent(resolvedDataDir, {
    level: 'info',
    source: 'release',
    event: 'release_snapshot_created',
    message: `已创建实装前快照 ${snapName} (${fileCount} files)`,
    detail: { version, fileCount, prunedCount: pruned.length },
  });

  return {
    created: true,
    snapshot: { ...manifest, dir: snapDir, pluginDir: snapPluginDir },
    pruned,
  };
}

export function rollbackToSnapshot({
  snapshotName = '',
  env = process.env,
  configDir = '',
  dataDir = '',
  checkAgyCli = false,
  checkProcesses = false,
} = {}) {
  const cfgDir = configDir ? resolve(configDir) : getGlobalConfigDir(env);
  const resolvedDataDir = dataDir ? resolve(dataDir) : getDataDir(env);
  const snaps = listSnapshots({ env, dataDir: resolvedDataDir });
  if (snaps.length === 0) {
    throw new Error('没有可用的发布快照可供回滚');
  }
  const target = snapshotName
    ? snaps.find((s) => s.name === snapshotName || s.version === snapshotName)
    : snaps[0];
  if (!target) {
    throw new Error(`未找到匹配快照: ${snapshotName}`);
  }
  if (!existsSync(join(target.pluginDir, 'plugin.json'))) {
    throw new Error(`快照目录损坏，缺少 plugin.json: ${target.name}`);
  }

  const installedDir = join(cfgDir, 'plugins', 'note-offload');
  mkdirSync(join(cfgDir, 'plugins'), { recursive: true });
  if (existsSync(installedDir)) {
    rmSync(installedDir, { recursive: true, force: true });
  }
  cpSync(target.pluginDir, installedDir, { recursive: true, force: true });

  const scriptsDir = join(installedDir, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const ent of readdirSync(scriptsDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.mjs')) {
        chmodSync(join(scriptsDir, ent.name), 0o755);
      }
    }
  }

  appendFlightEvent(resolvedDataDir, {
    level: 'warn',
    source: 'release',
    event: 'release_rollback_executed',
    message: `已回滚 note-offload 至快照 ${target.name} (v${target.version})`,
    detail: { snapshot: target.name, version: target.version },
  });

  const doctor = runDoctor({
    env,
    configDir: cfgDir,
    dataDir: resolvedDataDir,
    pluginRoot: target.pluginDir,
    checkAgyCli,
    checkProcesses,
  });

  return { ok: doctor.ok, target, doctor };
}

export function safeInstallRelease({
  confirm = false,
  env = process.env,
  configDir = '',
  dataDir = '',
  pluginRoot = join(REPO_ROOT, 'plugin'),
  checkAgyCli = true,
  checkProcesses = false,
} = {}) {
  if (!confirm) {
    throw new Error('安全门禁：执行实装发布必须显式传入 --confirm 标志（并获用户授权）。');
  }
  const absPlugin = resolve(pluginRoot);
  if (checkAgyCli) {
    const which = spawnSync('which', ['agy'], { encoding: 'utf-8' });
    if (which.status === 0) {
      execFileSync('agy', ['plugin', 'validate', absPlugin, '--strict'], { env, encoding: 'utf-8' });
    }
  }

  const cfgDir = configDir ? resolve(configDir) : getGlobalConfigDir(env);
  const resolvedDataDir = dataDir ? resolve(dataDir) : getDataDir(env);
  const snapshotRes = createSnapshot({ env, configDir: cfgDir, dataDir: resolvedDataDir });

  const installEnv = {
    ...env,
    AGY_CONFIG_DIR: cfgDir,
    AGY_OFFLOAD_DATA_DIR: resolvedDataDir,
  };
  execFileSync(process.execPath, [INSTALL_SCRIPT], { env: installEnv, encoding: 'utf-8' });
  const newMeta = readJsonSafe(join(absPlugin, 'plugin.json'), {});

  appendFlightEvent(resolvedDataDir, {
    level: 'info',
    source: 'release',
    event: 'release_installed',
    message: `已安全实装 note-offload v${newMeta?.version || 'unknown'}`,
    detail: { version: newMeta?.version || '', snapshotCreated: snapshotRes.created },
  });

  const doctor = runDoctor({
    env: installEnv,
    configDir: cfgDir,
    dataDir: resolvedDataDir,
    pluginRoot: absPlugin,
    checkAgyCli,
    checkProcesses,
  });

  return { ok: doctor.ok, version: newMeta?.version || '', snapshot: snapshotRes, doctor };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'list';
  const jsonMode = args.includes('--json');
  const confirm = args.includes('--confirm');
  const cfgArg = args.find((a) => a.startsWith('--config-dir='));
  const dataArg = args.find((a) => a.startsWith('--data-dir='));
  const common = {
    configDir: cfgArg ? cfgArg.slice('--config-dir='.length) : '',
    dataDir: dataArg ? dataArg.slice('--data-dir='.length) : '',
  };

  try {
    if (cmd === 'list') {
      const snaps = listSnapshots(common);
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify(snaps, null, 2)}\n`);
      } else if (snaps.length === 0) {
        process.stdout.write('暂无发布快照。\n');
      } else {
        for (const s of snaps) {
          process.stdout.write(`${s.name} | v${s.version} | ${s.fileCount} files | ${s.createdAt}\n`);
        }
      }
      process.exit(0);
    }

    if (cmd === 'snapshot') {
      const res = createSnapshot(common);
      if (jsonMode) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      else process.stdout.write(res.created ? `OK: 已创建快照 ${res.snapshot.name}\n` : `SKIP: ${res.reason}\n`);
      process.exit(0);
    }

    if (cmd === 'rollback') {
      const targetArg = args[1] && !args[1].startsWith('--') ? args[1] : '';
      const res = rollbackToSnapshot({ ...common, snapshotName: targetArg, checkAgyCli: true, checkProcesses: true });
      if (jsonMode) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      else process.stdout.write(`OK: 已回滚至 ${res.target.name} (v${res.target.version}), doctor=${res.doctor.ok ? 'HEALTHY' : 'UNHEALTHY'}\n`);
      process.exit(res.ok ? 0 : 1);
    }

    if (cmd === 'install') {
      const res = safeInstallRelease({ ...common, confirm, checkProcesses: true });
      if (jsonMode) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      else process.stdout.write(`OK: 已安全实装 v${res.version}, doctor=${res.doctor.ok ? 'HEALTHY' : 'UNHEALTHY'}\n`);
      process.exit(res.ok ? 0 : 1);
    }

    process.stderr.write(`未知子命令: ${cmd} (支持: list | snapshot | install --confirm | rollback [name])\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(`FAIL: ${err?.message || err}\n`);
    process.exit(1);
  }
}
