#!/usr/bin/env node
/**
 * Note Offload Ring 2: Read-Only Telemetry Mining & Improvement Proposal Engine
 * 只读聚合近端黑匣子飞行日志、hook-invocations.log、状态库、工作台健康度与近端 transcript，
 * 产出完全脱敏的量化遥测摘要与可落地改进提案（支持 --json）。
 */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFlightEvents, sanitizeLogString, summarizeFlightEvents } from '../plugin/lib/logger.mjs';
import { getBrainDirs, getDataDir, getLogPath, getNoteRoot, getStatePath } from '../plugin/lib/paths.mjs';
import { IGNORED_CONV_IDS } from '../plugin/lib/state.mjs';
import { isWorkspaceFileCandidate, wsNameFromEntry } from '../plugin/lib/workspace.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAIL_BYTES = 262_144;
const LARGE_FILE_BYTES = 512 * 1024;
const MAX_TRANSCRIPTS = 25;

function readTailText(filePath, maxBytes = TAIL_BYTES) {
  let fd = -1;
  try {
    const size = statSync(filePath).size;
    if (size <= 0) return '';
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(filePath, 'r');
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function scanHookLog(logPath) {
  if (!existsSync(logPath)) {
    return { lines: 0, ctSkipLines: 0, unmanagedSkipLines: 0, deadLines: 0, retryLines: 0, confirmPromptLines: 0 };
  }
  const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/).filter(Boolean);
  let ctSkipLines = 0;
  let unmanagedSkipLines = 0;
  let deadLines = 0;
  let retryLines = 0;
  let confirmPromptLines = 0;
  for (const ln of lines) {
    if (ln.includes('skip_ct_controller') || ln.includes('skip=ct_controller')) ctSkipLines += 1;
    if (ln.includes('skip=unmanaged')) unmanagedSkipLines += 1;
    if (ln.includes('ladder=dead')) deadLines += 1;
    if (ln.includes(' tier=')) retryLines += 1;
    if (ln.includes('confirm_prompt')) confirmPromptLines += 1;
  }
  return {
    lines: lines.length,
    ctSkipLines,
    unmanagedSkipLines,
    deadLines,
    retryLines,
    confirmPromptLines,
  };
}

function scanState(statePath, env) {
  if (!existsSync(statePath)) {
    return {
      totalEntries: 0,
      offloadActive: 0,
      deadCount: 0,
      orchConfirmedCount: 0,
      fileNoteDirAnomalies: 0,
      multiSessionWorkspaces: 0,
      maxSessionsPerWorkspace: 0,
    };
  }
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return {
      totalEntries: 0,
      offloadActive: 0,
      deadCount: 0,
      orchConfirmedCount: 0,
      fileNoteDirAnomalies: 0,
      multiSessionWorkspaces: 0,
      maxSessionsPerWorkspace: 0,
    };
  }
  const noteRoot = getNoteRoot(env);
  const wsCounts = new Map();
  let totalEntries = 0;
  let offloadActive = 0;
  let deadCount = 0;
  let orchConfirmedCount = 0;
  let fileNoteDirAnomalies = 0;

  for (const [cid, entry] of Object.entries(raw || {})) {
    if (!entry || typeof entry !== 'object' || IGNORED_CONV_IDS.has(cid)) continue;
    totalEntries += 1;
    if (entry.offload_mode) offloadActive += 1;
    if (entry.dead) deadCount += 1;
    if (entry.orch_confirmed) orchConfirmedCount += 1;
    const nd = String(entry.note_dir || '');
    if (nd) {
      const seg = nd.replace(/\/+$/, '').split('/').pop() || '';
      if (isWorkspaceFileCandidate(seg, { noteRoot })) {
        fileNoteDirAnomalies += 1;
      }
    }
    const wsName = wsNameFromEntry(cid, entry, env);
    wsCounts.set(wsName, (wsCounts.get(wsName) || 0) + 1);
  }

  let multiSessionWorkspaces = 0;
  let maxSessionsPerWorkspace = 0;
  for (const count of wsCounts.values()) {
    if (count > 1) multiSessionWorkspaces += 1;
    if (count > maxSessionsPerWorkspace) maxSessionsPerWorkspace = count;
  }

  return {
    totalEntries,
    offloadActive,
    deadCount,
    orchConfirmedCount,
    fileNoteDirAnomalies,
    multiSessionWorkspaces,
    maxSessionsPerWorkspace,
  };
}

function scanNoteRoot(noteRoot) {
  if (!existsSync(noteRoot)) {
    return {
      workspaceDirs: 0,
      emptyDirs: 0,
      missingStatusDirs: 0,
      largeFiles: 0,
      standaloneRootFiles: 0,
    };
  }
  let workspaceDirs = 0;
  let emptyDirs = 0;
  let missingStatusDirs = 0;
  let largeFiles = 0;
  let standaloneRootFiles = 0;

  for (const ent of readdirSync(noteRoot, { withFileTypes: true })) {
    const full = join(noteRoot, ent.name);
    let lst;
    try {
      lst = lstatSync(full);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) continue;
    if (ent.isFile()) {
      standaloneRootFiles += 1;
      continue;
    }
    if (!ent.isDirectory() || ent.name === '_archive') continue;
    workspaceDirs += 1;
    let items = [];
    try {
      items = readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    if (items.length === 0) {
      emptyDirs += 1;
      continue;
    }
    let hasStatus = false;
    for (const f of items) {
      if (!f.isFile()) continue;
      if (f.name === 'status.md') hasStatus = true;
      try {
        if (statSync(join(full, f.name)).size > LARGE_FILE_BYTES) {
          largeFiles += 1;
        }
      } catch {
        // ignore
      }
    }
    if (!hasStatus) missingStatusDirs += 1;
  }

  return {
    workspaceDirs,
    emptyDirs,
    missingStatusDirs,
    largeFiles,
    standaloneRootFiles,
  };
}

function scanRecentTranscripts(env, days = 7) {
  const sinceMs = Date.now() - Math.max(1, days) * 24 * 3600 * 1000;
  const candidates = [];
  for (const brain of getBrainDirs(env)) {
    let entries = [];
    try {
      entries = readdirSync(brain, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const tPath = join(brain, ent.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(tPath)) continue;
      try {
        const st = statSync(tPath);
        if (st.mtimeMs >= sinceMs) {
          candidates.push({ path: tPath, mtimeMs: st.mtimeMs });
        }
      } catch {
        // ignore
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const picked = candidates.slice(0, MAX_TRANSCRIPTS);

  let sessionsScanned = 0;
  let offloadSessions = 0;
  let filterBlockSteps = 0;
  for (const item of picked) {
    const raw = readTailText(item.path, TAIL_BYTES);
    if (!raw) continue;
    sessionsScanned += 1;
    let sawOffload = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      if (line.includes('/note-offload') || line.includes('[落盘模式]')) sawOffload = true;
      if (line.includes('blocked by Gemini')) filterBlockSteps += 1;
    }
    if (sawOffload) offloadSessions += 1;
  }

  return {
    sessionsScanned,
    offloadSessions,
    filterBlockSteps,
  };
}

export function runMiner({ env = process.env, dataDir = '', noteRoot = '', days = 7 } = {}) {
  const effectiveEnv = {
    ...env,
    ...(dataDir ? { AGY_OFFLOAD_DATA_DIR: resolve(dataDir) } : {}),
    ...(noteRoot ? { AGY_NOTE_ROOT: resolve(noteRoot) } : {}),
  };
  const resolvedDataDir = getDataDir(effectiveEnv);
  const resolvedNoteRoot = getNoteRoot(effectiveEnv);

  const flight = summarizeFlightEvents(resolvedDataDir, { windowMs: days * 24 * 3600 * 1000 });
  const recentFlight = readFlightEvents(resolvedDataDir, { limit: 200, sinceMs: Date.now() - days * 24 * 3600 * 1000 });
  const hookLog = scanHookLog(getLogPath(effectiveEnv));
  const state = scanState(getStatePath(effectiveEnv), effectiveEnv);
  const workspaces = scanNoteRoot(resolvedNoteRoot);
  const transcripts = scanRecentTranscripts(effectiveEnv, days);

  const proposals = [];
  if (flight.byLevel.error > 0) {
    proposals.push({
      priority: 'P0',
      code: 'flight_errors_detected',
      summary: `近 ${days} 天黑匣子记录 ${flight.byLevel.error} 条错误事件，建议优先核查最近错误详情并补入回归回放夹具`,
      metric: flight.byLevel.error,
    });
  }
  if (flight.lockTimeoutCount > 0) {
    proposals.push({
      priority: 'P0',
      code: 'lock_contention_timeout',
      summary: `检测到 ${flight.lockTimeoutCount} 次文件锁等待超时，建议检查并发 Hook 写入热路径`,
      metric: flight.lockTimeoutCount,
    });
  }
  if (state.fileNoteDirAnomalies > 0) {
    proposals.push({
      priority: 'P1',
      code: 'legacy_file_note_dir',
      summary: `状态库中仍有 ${state.fileNoteDirAnomalies} 条历史单文件 note_dir 记录（已由内核自动回退保护），可按需清理`,
      metric: state.fileNoteDirAnomalies,
    });
  }
  if (hookLog.lines > 0 && (hookLog.ctSkipLines + hookLog.unmanagedSkipLines) / hookLog.lines > 0.35) {
    const pct = Math.round(((hookLog.ctSkipLines + hookLog.unmanagedSkipLines) / hookLog.lines) * 100);
    proposals.push({
      priority: 'P1',
      code: 'hook_log_noise_high',
      summary: `历史 hook-invocations.log 中跳过类噪声占比 ${pct}%（升级去噪版后随轮转自动消退）`,
      metric: pct,
    });
  }
  if (workspaces.emptyDirs > 0) {
    proposals.push({
      priority: 'P2',
      code: 'empty_workspaces',
      summary: `工作台根目录存在 ${workspaces.emptyDirs} 个 0 文件空目录，可运行 agynote clean 或在 Sidecar 一键清理`,
      metric: workspaces.emptyDirs,
    });
  }
  if (workspaces.workspaceDirs >= 80) {
    proposals.push({
      priority: 'P1',
      code: 'large_workspace_scale',
      summary: `当前工作台目录规模达 ${workspaces.workspaceDirs} 个，建议归档历史工作台并启用 Sidecar 增量缓存`,
      metric: workspaces.workspaceDirs,
    });
  }
  if (state.multiSessionWorkspaces > 0) {
    proposals.push({
      priority: 'P2',
      code: 'multi_session_workspaces',
      summary: `有 ${state.multiSessionWorkspaces} 个工作台关联了多个会话（最高 ${state.maxSessionsPerWorkspace} 个），建议在详情页查看完整会话历史`,
      metric: state.multiSessionWorkspaces,
    });
  }
  if (flight.slowCount > 0) {
    proposals.push({
      priority: 'P1',
      code: 'slow_operations',
      summary: `近 ${days} 天捕获 ${flight.slowCount} 次慢操作 (>= 100ms)，建议核查慢点来源`,
      metric: flight.slowCount,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    flight: {
      total: flight.total,
      byLevel: flight.byLevel,
      bySource: flight.bySource,
      slowCount: flight.slowCount,
      lockTimeoutCount: flight.lockTimeoutCount,
      blockedCount: flight.blockedCount,
      recentEventsSampled: recentFlight.length,
    },
    hookLog,
    state,
    workspaces,
    transcripts,
    proposals: proposals.map((p) => ({
      ...p,
      summary: sanitizeLogString(p.summary, 300),
    })),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const daysArg = args.find((a) => a.startsWith('--days='));
  const dataArg = args.find((a) => a.startsWith('--data-dir='));
  const noteArg = args.find((a) => a.startsWith('--note-root='));
  const days = daysArg ? Math.max(1, Number.parseInt(daysArg.slice(7), 10) || 7) : 7;

  const report = runMiner({
    days,
    dataDir: dataArg ? dataArg.slice('--data-dir='.length) : '',
    noteRoot: noteArg ? noteArg.slice('--note-root='.length) : '',
  });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`=== Note Offload 遥测矿机报告 (近 ${report.windowDays} 天) ===\n`);
    process.stdout.write(
      `黑匣子事件: total=${report.flight.total}, err=${report.flight.byLevel.error}, warn=${report.flight.byLevel.warn}, slow=${report.flight.slowCount}, lockTimeout=${report.flight.lockTimeoutCount}\n`,
    );
    process.stdout.write(
      `追踪状态: entries=${report.state.totalEntries}, activeOffload=${report.state.offloadActive}, dead=${report.state.deadCount}, multiSessionWs=${report.state.multiSessionWorkspaces}\n`,
    );
    process.stdout.write(
      `工作台健康: dirs=${report.workspaces.workspaceDirs}, empty=${report.workspaces.emptyDirs}, missingStatus=${report.workspaces.missingStatusDirs}, largeFiles=${report.workspaces.largeFiles}, rootFiles=${report.workspaces.standaloneRootFiles}\n`,
    );
    process.stdout.write(
      `近端会话抽样: scanned=${report.transcripts.sessionsScanned}, offload=${report.transcripts.offloadSessions}, filterBlocks=${report.transcripts.filterBlockSteps}\n`,
    );
    if (report.proposals.length === 0) {
      process.stdout.write('改进提案: 当前运行健康，无待处理异常提案。\n');
    } else {
      process.stdout.write(`改进提案 (${report.proposals.length}):\n`);
      for (const p of report.proposals) {
        process.stdout.write(`- [${p.priority}][${p.code}] ${p.summary}\n`);
      }
    }
  }
}
