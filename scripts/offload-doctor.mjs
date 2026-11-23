#!/usr/bin/env node
/**
 * Note Offload Ring 5: Read-Only Live Installation Health Probe (Doctor)
 * 核查源码仓与已安装运行态版本对齐、无旧版散装残留、Antigravity 插件注册、
 * Sidecar 进程目录健康、近 24h 黑匣子事件摘要与发布回滚快照库存。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeFlightEvents } from '../plugin/lib/logger.mjs';
import { getDataDir, getGlobalConfigDir, getNoteRoot } from '../plugin/lib/paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const LEGACY_HOOK_KEYS = [
  'gemini-filter-guardrail',
  'gemini-filter-retry',
  'gemini-filter-notice',
  'note-offload-guardrail',
  'note-offload-retry',
  'note-offload-notice',
];

function readJsonSafe(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function inspectRunningSidecars() {
  if (process.platform !== 'linux' || !existsSync('/proc')) {
    return { supported: false, running: [], stale: [] };
  }
  const running = [];
  const stale = [];
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return { supported: false, running: [], stale: [] };
  }
  for (const pid of pids) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\u0000/g, ' ').trim();
      if (!cmdline.includes('note-offload') || !cmdline.includes('sidecars/board/main.mjs')) continue;
      let cwd = '';
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        cwd = '';
      }
      const entry = { pid: Number(pid), deletedCwd: cwd.includes('(deleted)') };
      running.push(entry);
      if (entry.deletedCwd) stale.push(entry);
    } catch {
      // 忽略瞬时退出进程
    }
  }
  return { supported: true, running, stale };
}

function listReleaseSnapshotDirs(dataDir) {
  const relDir = join(resolve(dataDir), 'releases');
  if (!existsSync(relDir)) return [];
  try {
    return readdirSync(relDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function runDoctor({
  env = process.env,
  configDir = '',
  dataDir = '',
  pluginRoot = join(REPO_ROOT, 'plugin'),
  checkAgyCli = true,
  checkProcesses = true,
} = {}) {
  const cfgDir = configDir ? resolve(configDir) : getGlobalConfigDir(env);
  const resolvedDataDir = dataDir ? resolve(dataDir) : getDataDir(env);
  const repoMeta = readJsonSafe(join(resolve(pluginRoot), 'plugin.json'), {});
  const repoVersion = String(repoMeta?.version || '');

  const installedDir = join(cfgDir, 'plugins', 'note-offload');
  const installedMeta = readJsonSafe(join(installedDir, 'plugin.json'), null);
  const installedVersion = String(installedMeta?.version || '');

  const checks = [];

  // 1) 运行态安装与版本一致性
  if (!installedMeta) {
    checks.push({
      id: 'installed_plugin',
      status: 'fail',
      detail: `未检测到已安装的 note-offload 插件 (源码仓版本 v${repoVersion})`,
    });
  } else if (repoVersion && installedVersion !== repoVersion) {
    checks.push({
      id: 'installed_plugin',
      status: 'warn',
      detail: `已安装版本 v${installedVersion} 与源码仓 v${repoVersion} 不一致`,
    });
  } else {
    checks.push({
      id: 'installed_plugin',
      status: 'pass',
      detail: `已安装版本 v${installedVersion} 与源码仓一致`,
    });
  }

  // 2) 旧版散装技能与全局 hooks.json 残留检查
  const legacyIssues = [];
  if (existsSync(join(cfgDir, 'skills', 'note-offload'))) {
    legacyIssues.push('skills/note-offload');
  }
  const legacyHooks = readJsonSafe(join(cfgDir, 'hooks.json'), null);
  if (legacyHooks && typeof legacyHooks === 'object') {
    const hitKeys = LEGACY_HOOK_KEYS.filter((k) => Object.hasOwn(legacyHooks, k));
    if (hitKeys.length > 0) {
      legacyIssues.push(`hooks.json(${hitKeys.join(',')})`);
    }
  }
  if (legacyIssues.length > 0) {
    checks.push({
      id: 'legacy_cleanliness',
      status: 'fail',
      detail: `检测到旧版散装残留: ${legacyIssues.join(', ')}`,
    });
  } else {
    checks.push({
      id: 'legacy_cleanliness',
      status: 'pass',
      detail: '无旧版散装技能或全局 hooks.json 残留',
    });
  }

  // 3) 官方 agy plugin list 注册核验
  if (checkAgyCli) {
    const which = spawnSync('which', ['agy'], { encoding: 'utf-8' });
    if (which.status === 0) {
      const listed = spawnSync('agy', ['plugin', 'list', '--json'], { encoding: 'utf-8', env });
      if (listed.status === 0) {
        try {
          const parsed = JSON.parse(listed.stdout || '[]');
          const arr = Array.isArray(parsed) ? parsed : parsed.plugins || [];
          const hit = arr.find((p) => p?.name === 'note-offload');
          if (hit && hit.enabled !== false) {
            checks.push({
              id: 'agy_registry',
              status: 'pass',
              detail: `agy plugin list 已启用 note-offload (v${hit.version || installedVersion})`,
            });
          } else if (hit) {
            checks.push({
              id: 'agy_registry',
              status: 'warn',
              detail: 'note-offload 已安装但当前处于禁用状态',
            });
          } else {
            checks.push({
              id: 'agy_registry',
              status: 'fail',
              detail: 'agy plugin list 未发现 note-offload',
            });
          }
        } catch {
          checks.push({
            id: 'agy_registry',
            status: 'warn',
            detail: 'agy plugin list --json 输出解析异常',
          });
        }
      } else {
        checks.push({
          id: 'agy_registry',
          status: 'warn',
          detail: 'agy plugin list 执行返回非零状态',
        });
      }
    }
  }

  // 4) 运行中 Sidecar 进程 CWD 失效检测
  if (checkProcesses) {
    const procInfo = inspectRunningSidecars();
    if (procInfo.supported) {
      if (procInfo.stale.length > 0) {
        checks.push({
          id: 'sidecar_process',
          status: 'warn',
          detail: `发现 ${procInfo.stale.length} 个失效目录 Sidecar 进程 (PID: ${procInfo.stale.map((p) => p.pid).join(', ')})，建议重开侧边栏面板`,
        });
      } else {
        checks.push({
          id: 'sidecar_process',
          status: 'pass',
          detail:
            procInfo.running.length > 0
              ? `运行中 Sidecar 进程 ${procInfo.running.length} 个，目录健康`
              : '当前无常驻 Sidecar 进程（按需拉起正常）',
        });
      }
    }
  }

  // 5) 近 24h 黑匣子飞行日志健康度
  const flight = summarizeFlightEvents(resolvedDataDir);
  if ((flight.byLevel?.error || 0) > 0) {
    checks.push({
      id: 'flight_logs',
      status: 'warn',
      detail: `近 24h 黑匣子捕获 ${flight.byLevel.error} 条错误 / ${flight.byLevel.warn} 条警告 (慢调用 ${flight.slowCount}, 锁超时 ${flight.lockTimeoutCount})`,
    });
  } else {
    checks.push({
      id: 'flight_logs',
      status: 'pass',
      detail: `近 24h 黑匣子 0 错误 (${flight.total} 条事件, ${flight.byLevel.warn} 条警告, ${flight.slowCount} 次慢调用)`,
    });
  }

  // 6) 工作台根目录存在性检查
  const noteRoot = getNoteRoot(env);
  checks.push({
    id: 'workspace_root',
    status: 'pass',
    detail: existsSync(noteRoot) ? '落盘工作台根目录可访问' : '落盘工作台根目录尚未创建（按需惰性创建）',
  });

  // 7) 可回滚发布快照库存
  const snapshots = listReleaseSnapshotDirs(resolvedDataDir);
  checks.push({
    id: 'release_snapshots',
    status: 'pass',
    detail:
      snapshots.length > 0
        ? `可回滚发布快照 ${snapshots.length} 份 (最新: ${snapshots[0]})`
        : '尚无发布快照（使用 offload-release snapshot/install 时自动生成）',
  });

  const failedCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  return {
    ok: failedCount === 0,
    failedCount,
    warnCount,
    repoVersion,
    installedVersion,
    snapshots,
    checks,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const noProc = args.includes('--no-proc');
  const cfgArg = args.find((a) => a.startsWith('--config-dir='));
  const dataArg = args.find((a) => a.startsWith('--data-dir='));

  const res = runDoctor({
    configDir: cfgArg ? cfgArg.slice('--config-dir='.length) : '',
    dataDir: dataArg ? dataArg.slice('--data-dir='.length) : '',
    checkProcesses: !noProc,
  });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    for (const c of res.checks) {
      const icon = c.status === 'pass' ? 'PASS' : (c.status === 'warn' ? 'WARN' : 'FAIL');
      process.stdout.write(`[${icon}] ${c.id}: ${c.detail}\n`);
    }
    process.stdout.write(`----\nDoctor: ${res.ok ? 'HEALTHY' : 'UNHEALTHY'} (fail=${res.failedCount}, warn=${res.warnCount})\n`);
  }
  process.exit(res.ok ? 0 : 1);
}
