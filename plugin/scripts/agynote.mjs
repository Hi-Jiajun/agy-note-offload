#!/usr/bin/env node
/**
 * agynote: 双向文件工作台管理、归档恢复、会话健康看板、配置中心与冲突诊断 CLI。
 *
 * 用法：
 *   node agynote.mjs init <工作台名> [任务文件路径 | -]
 *   node agynote.mjs show <工作台名或前缀>
 *   node agynote.mjs status [all] [--archived] [--dead] [--filter <kw>] [--json]
 *   node agynote.mjs ls
 *   node agynote.mjs archive <工作台名> [--move] [--json]
 *   node agynote.mjs unarchive <工作台名> [--json]
 *   node agynote.mjs reset <会话ID或前缀> [--json]
 *   node agynote.mjs clean
 *   node agynote.mjs config [--sanitize on|off] [--alias on|off] [--orch-confirm once|per_session|off]
 *                           [--reset-orch-once] [--max-retry N] [--retry-window N] [--zero-limit N]
 *                           [--long-tokens N] [--big-ctx N] [--reset] [--json]
 *   node agynote.mjs doctor [--json]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hasConfiguredAliases, readAliases } from '../lib/aliases.mjs';
import { archiveWorkspace, loadArchivedMap, unarchiveWorkspace } from '../lib/archive.mjs';
import {
  loadConfig,
  parseEnvBool,
  parseOrchConfirmMode,
  resetConfig,
  saveConfig,
} from '../lib/config.mjs';
import { detectConflicts } from '../lib/conflicts.mjs';
import { atomicWriteSync } from '../lib/lock.mjs';
import { readHookHeartbeat } from '../lib/logger.mjs';
import {
  expandHome,
  getConfigPath,
  getDataDir,
  getHomeDir,
  getNoteRoot,
  shortPath,
} from '../lib/paths.mjs';
import { IGNORED_CONV_IDS, loadState, resetConvState, sessionHealth } from '../lib/state.mjs';
import {
  cleanEmptyWorkspaces,
  formatNow,
  readStatusSummary,
  RESERVED_WS_NAMES,
  statusTemplate,
  taskTemplate,
  WS_NAME_RE,
  wsNameFromEntry,
} from '../lib/workspace.mjs';

const USAGE =
  '用法:\n' +
  '  agynote.mjs init <工作台名> [任务文件路径 | -]\n' +
  '  agynote.mjs show <工作台名或前缀>\n' +
  '  agynote.mjs status [all] [--archived] [--dead] [--filter <kw>] [--json]\n' +
  '  agynote.mjs ls\n' +
  '  agynote.mjs archive <工作台名> [--move] [--json]\n' +
  '  agynote.mjs unarchive <工作台名> [--json]\n' +
  '  agynote.mjs reset <会话ID或前缀> [--json]\n' +
  '  agynote.mjs clean\n' +
  '  agynote.mjs config [--sanitize on|off] [--alias on|off] [--orch-confirm once|per_session|off]\n' +
  '                     [--reset-orch-once] [--max-retry N] [--retry-window N] [--zero-limit N]\n' +
  '                     [--long-tokens N] [--big-ctx N] [--reset] [--json]\n' +
  '  agynote.mjs doctor [--json]';

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function formatMonthDayTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resolveWsPrefix(prefix) {
  if (!prefix || prefix.includes('/') || prefix.includes('..') || !/^[A-Za-z0-9._-]+$/.test(prefix)) {
    fail(`工作台名称或前缀非法: ${prefix}`);
  }
  const noteRoot = getNoteRoot();
  const exact = join(noteRoot, prefix);
  if (existsSync(exact) && statSync(exact).isDirectory()) {
    return exact;
  }
  if (existsSync(noteRoot)) {
    const matches = readdirSync(noteRoot, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && !RESERVED_WS_NAMES.has(ent.name.toLowerCase()) && ent.name.startsWith(prefix))
      .map((ent) => {
        const full = join(noteRoot, ent.name);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (matches.length > 0) {
      return matches[0].full;
    }
  }
  fail(`未找到工作台目录: ${join(noteRoot, prefix)}`);
}

function cmdInit(args) {
  if (!args.length) {
    fail('用法: agynote.mjs init <工作台名> [任务文件路径 | -]');
  }
  const name = args[0].replace(/^\/+|\/+$/g, '');
  if (!WS_NAME_RE.test(name) || name.includes('..') || RESERVED_WS_NAMES.has(name.toLowerCase())) {
    fail('工作台名称非法（仅支持字母、数字及 . _ -，长度 1-64，且不可使用保留名）');
  }
  const noteRoot = getNoteRoot();
  const wsDir = join(noteRoot, name);
  mkdirSync(wsDir, { recursive: true });

  const taskFile = join(wsDir, 'task.md');
  const statusFile = join(wsDir, 'status.md');
  const now = formatNow();

  if (args.length >= 2) {
    const src = args[1];
    let content;
    if (src === '-') {
      content = readFileSync(0, 'utf-8');
    } else {
      content = readFileSync(expandHome(src, getHomeDir()), 'utf-8');
    }
    atomicWriteSync(taskFile, content);
  } else if (!existsSync(taskFile)) {
    atomicWriteSync(taskFile, taskTemplate(name));
  }

  if (!existsSync(statusFile)) {
    atomicWriteSync(statusFile, statusTemplate(name, now));
  }

  const shortWs = shortPath(wsDir);
  process.stdout.write(`已就绪: ${shortWs}/ (task.md, status.md)\n`);
  process.stdout.write('复制到聊天框直接发送：\n');
  process.stdout.write(`/note-offload 读取 ${shortWs}/task.md 与 status.md，执行下一未完成阶段并落盘汇报。\n`);
}

function cmdShow(args) {
  if (!args.length) {
    fail('用法: agynote.mjs show <工作台名或前缀>');
  }
  const wsDir = resolveWsPrefix(args[0]);
  const wsName = basename(wsDir);
  const wsDisp = shortPath(wsDir);
  const archivedMap = loadArchivedMap();
  const cfg = loadConfig();
  const retryWindowSec = cfg.retryWindowMin * 60;
  const nowSec = Date.now() / 1000;
  const state = loadState();

  const boundSessions = [];
  for (const [cid, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== 'object' || IGNORED_CONV_IDS.has(cid)) continue;
    if (wsNameFromEntry(cid, entry) === wsName) {
      boundSessions.push({
        convId: cid,
        convShort: cid.slice(0, 8),
        health: sessionHealth(entry, nowSec, retryWindowSec),
        step: entry.step ?? null,
        ts: Number(entry.ts || 0),
      });
    }
  }
  boundSessions.sort((a, b) => b.ts - a.ts);

  const archTag = archivedMap[wsName] ? ' [已归档]' : '';
  process.stdout.write(`=== 工作台: ${wsDisp}${archTag} ===\n`);

  const statusFile = join(wsDir, 'status.md');
  if (existsSync(statusFile)) {
    process.stdout.write(`${readFileSync(statusFile, 'utf-8').replace(/\s+$/, '')}\n`);
  }

  if (boundSessions.length > 0) {
    process.stdout.write(`\n=== 关联会话 (${boundSessions.length}) ===\n`);
    for (const s of boundSessions) {
      const stepStr = s.step !== null ? `step=${s.step}` : 'step=-';
      const tsStr = s.ts ? formatMonthDayTime(s.ts * 1000) : '-';
      process.stdout.write(`- ${s.convShort} (${s.convId}) | ${s.health} | ${stepStr} | ${tsStr}\n`);
    }
  }

  const turns = readdirSync(wsDir, { withFileTypes: true })
    .filter((ent) => ent.isFile() && /^turn-.*\.md$/.test(ent.name))
    .map((ent) => {
      const full = join(wsDir, ent.name);
      const st = statSync(full);
      return { name: ent.name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);

  if (turns.length > 0) {
    process.stdout.write('\n=== 已落盘详稿 ===\n');
    for (const t of turns.slice(-10)) {
      process.stdout.write(`- ${wsDisp}/${t.name} (${t.size} B)\n`);
    }
  }
}

function cmdStatus(args) {
  let showAll = false;
  let includeArchived = false;
  let deadOnly = false;
  let filterKw = '';
  let jsonMode = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === 'all' || a === '--all') {
      showAll = true;
    } else if (a === '--archived') {
      includeArchived = true;
    } else if (a === '--dead') {
      deadOnly = true;
    } else if (a === '--json') {
      jsonMode = true;
    } else if (a === '--filter') {
      if (i + 1 >= args.length) fail('缺少 --filter 参数值');
      filterKw = String(args[++i]).trim().toLowerCase();
    } else if (a.startsWith('--filter=')) {
      filterKw = a.slice(9).trim().toLowerCase();
    } else {
      fail(`status 未知参数: ${a}`);
    }
  }

  const nowSec = Date.now() / 1000;
  const cfg = loadConfig();
  const retryWindowSec = cfg.retryWindowMin * 60;
  const archivedMap = loadArchivedMap();
  const state = loadState();

  const byWs = new Map();
  for (const [cid, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== 'object' || IGNORED_CONV_IDS.has(cid)) continue;
    const wsName = wsNameFromEntry(cid, entry);
    if (!byWs.has(wsName)) byWs.set(wsName, []);
    byWs.get(wsName).push([cid, entry]);
  }

  const noteRoot = getNoteRoot();
  let dirs = [];
  if (existsSync(noteRoot)) {
    dirs = readdirSync(noteRoot, { withFileTypes: true })
      .filter((ent) => ent.isDirectory() && !RESERVED_WS_NAMES.has(ent.name.toLowerCase()))
      .map((ent) => {
        const full = join(noteRoot, ent.name);
        return { name: ent.name, full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  let hiddenArchivedCount = 0;
  const rows = [];
  const seenDirs = new Set();

  for (const d of dirs) {
    const isArch = Boolean(archivedMap[d.name]);
    if (isArch && !includeArchived) {
      hiddenArchivedCount += 1;
      seenDirs.add(d.name);
      continue;
    }
    seenDirs.add(d.name);

    let nFiles = 0;
    try {
      nFiles = readdirSync(d.full, { withFileTypes: true }).filter((e) => e.isFile()).length;
    } catch {
      nFiles = 0;
    }
    const binds = byWs.get(d.name) || [];
    binds.sort((a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0));
    let cid8 = '-';
    let health = '-';
    let step = '-';
    const boundSessions = binds.map(([cid, entry]) => ({
      convId: cid,
      convShort: cid.slice(0, 8),
      health: sessionHealth(entry, nowSec, retryWindowSec),
      step: entry.step ?? null,
    }));
    if (boundSessions.length > 0) {
      cid8 = boundSessions.length > 1
        ? `${boundSessions[0].convShort}+${boundSessions.length - 1}`
        : boundSessions[0].convShort;
      health = boundSessions[0].health;
      step = boundSessions[0].step !== null ? String(boundSessions[0].step) : '-';
    }
    const summary = readStatusSummary(d.full, 44) || '-';

    if (deadOnly && !health.startsWith('DEAD')) continue;
    if (filterKw) {
      const hay = `${d.name} ${summary} ${boundSessions.map((s) => s.convId).join(' ')}`.toLowerCase();
      if (!hay.includes(filterKw)) continue;
    }

    rows.push({
      name: d.name,
      fileCount: nFiles,
      cidDisplay: cid8,
      boundSessions,
      health,
      step,
      updatedAtMs: Math.round(d.mtime),
      summary,
      archived: isArch,
    });
  }

  const list = (showAll || filterKw || deadOnly || includeArchived) ? rows : rows.slice(0, 20);

  const unmapped = [];
  for (const [wsName, binds] of byWs.entries()) {
    if (seenDirs.has(wsName)) continue;
    binds.sort((a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0));
    const [cid, entry] = binds[0];
    const health = sessionHealth(entry, nowSec, retryWindowSec);
    if (deadOnly && !health.startsWith('DEAD')) continue;
    if (filterKw && !`${wsName} ${cid}`.toLowerCase().includes(filterKw)) continue;
    const step = entry.step !== null && entry.step !== undefined ? String(entry.step) : '-';
    unmapped.push({
      wsName,
      convId: cid,
      convShort: cid.slice(0, 8),
      health,
      step,
      updatedAtMs: entry.ts ? Math.round(Number(entry.ts) * 1000) : 0,
    });
  }

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      noteRoot: shortPath(noteRoot),
      totalWorkspaces: rows.length,
      hiddenArchivedCount,
      workspaces: list,
      unmappedSessions: unmapped,
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${'工作台'.padEnd(22)} | ${'文件'.padStart(4)} | ${'绑定会话'.padEnd(11)} | ${'状态'.padEnd(20)} | ${'步数'.padStart(5)} | ${'更新时间'.padEnd(11)} | 看板摘要\n`,
  );
  process.stdout.write(`${'-'.repeat(116)}\n`);

  for (const r of list) {
    const nameDisp = r.archived ? `${r.name}[归档]` : r.name;
    process.stdout.write(
      `${nameDisp.padEnd(22)} | ${String(r.fileCount).padStart(4)} | ${r.cidDisplay.padEnd(11)} | ${r.health.padEnd(20)} | ${r.step.padStart(5)} | ${formatMonthDayTime(r.updatedAtMs).padEnd(11)} | ${r.summary}\n`,
    );
  }

  if (hiddenArchivedCount > 0) {
    process.stdout.write(`\n（已隐藏 ${hiddenArchivedCount} 个归档工作台，加 --archived 可查看）\n`);
  }

  if (unmapped.length > 0) {
    process.stdout.write('\n[无落盘文件的追踪会话]\n');
    for (const u of unmapped) {
      process.stdout.write(
        `${u.wsName.padEnd(22)} |    0 | ${u.convShort.padEnd(11)} | ${u.health.padEnd(20)} | ${u.step.padStart(5)} | ${formatMonthDayTime(u.updatedAtMs).padEnd(11)} | -\n`,
      );
    }
  }
}

function cmdArchive(args) {
  let name = '';
  let move = false;
  let jsonMode = false;
  for (const a of args) {
    if (a === '--move') move = true;
    else if (a === '--json') jsonMode = true;
    else if (a.startsWith('-')) fail(`archive 未知参数: ${a}`);
    else if (!name) name = a;
    else fail(`archive 多余参数: ${a}`);
  }
  if (!name) fail('用法: agynote.mjs archive <工作台名> [--move] [--json]');
  try {
    const res = archiveWorkspace(name, { move });
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      const modeStr = res.moved ? '物理移动归档' : '逻辑归档（保留原路径不断链）';
      process.stdout.write(`已归档 ${res.name} [${modeStr}] -> ${res.path}\n`);
    }
  } catch (err) {
    fail(err?.message || String(err));
  }
}

function cmdUnarchive(args) {
  let name = '';
  let jsonMode = false;
  for (const a of args) {
    if (a === '--json') jsonMode = true;
    else if (a.startsWith('-')) fail(`unarchive 未知参数: ${a}`);
    else if (!name) name = a;
    else fail(`unarchive 多余参数: ${a}`);
  }
  if (!name) fail('用法: agynote.mjs unarchive <工作台名> [--json]');
  try {
    const res = unarchiveWorkspace(name);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      const moveNote = res.restoredFromMove ? '（已从 _archive 移回根目录）' : '';
      process.stdout.write(`已恢复归档工作台 ${res.name}${moveNote} -> ${res.path}\n`);
    }
  } catch (err) {
    fail(err?.message || String(err));
  }
}

function cmdReset(args) {
  let target = '';
  let jsonMode = false;
  for (const a of args) {
    if (a === '--json') jsonMode = true;
    else if (a.startsWith('-')) fail(`reset 未知参数: ${a}`);
    else if (!target) target = a;
    else fail(`reset 多余参数: ${a}`);
  }
  if (!target) fail('用法: agynote.mjs reset <会话ID或前缀> [--json]');

  const state = loadState();
  const keys = Object.keys(state).filter((k) => !IGNORED_CONV_IDS.has(k));
  let matched = keys.includes(target) ? target : '';
  if (!matched) {
    const prefixHits = keys.filter((k) => k.startsWith(target));
    if (prefixHits.length === 1) {
      matched = prefixHits[0];
    } else if (prefixHits.length > 1) {
      fail(`会话前缀 "${target}" 匹配到多个会话，请提供更长前缀: ${prefixHits.map((k) => k.slice(0, 12)).join(', ')}`);
    } else {
      fail(`状态库中未找到匹配会话: ${target}`);
    }
  }

  const ok = resetConvState(matched);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok, conversationId: matched }, null, 2)}\n`);
  } else {
    process.stdout.write(`已重置会话 ${matched} 的重试与熔断状态（保留工作台绑定）\n`);
  }
}

function cmdClean() {
  const rootDisp = shortPath(getNoteRoot());
  const res = cleanEmptyWorkspaces();
  if (!res.exists) {
    process.stdout.write(`${rootDisp} 不存在，无需清理\n`);
    return;
  }
  process.stdout.write(`清理完成：删除 ${res.removed.length} 个空目录，保留 ${res.kept} 个有效目录\n`);
  if (res.removed.length > 0) {
    process.stdout.write(`已清理: ${res.removed.join(', ')}\n`);
  }
}

function printConflicts(conflicts) {
  if (!conflicts.length) {
    process.stdout.write('冲突检测: 无\n');
    return;
  }
  process.stdout.write(`冲突检测: 发现 ${conflicts.length} 项风险\n`);
  for (const c of conflicts) {
    process.stdout.write(`- [${c.level}][${c.code}] ${c.message}\n`);
  }
}

function parseIntFlag(val, flag) {
  if (!/^-?\d+$/.test(String(val ?? ''))) {
    fail(`${flag} 必须为整数: ${val}`);
  }
  return Number.parseInt(String(val), 10);
}

function cmdConfig(args) {
  const patch = {};
  let hasPatch = false;
  let doReset = false;
  let jsonMode = false;

  const takeVal = (a, idx) => (a.includes('=') ? [a.slice(a.indexOf('=') + 1), idx] : [args[idx + 1], idx + 1]);

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(
        '用法: agynote.mjs config [--sanitize on|off] [--alias on|off] [--orch-confirm once|per_session|off] ' +
        '[--reset-orch-once] [--max-retry N] [--retry-window N] [--zero-limit N] [--long-tokens N] [--big-ctx N] [--reset] [--json]\n',
      );
      return;
    }
    if (a === '--reset') {
      doReset = true;
    } else if (a === '--json') {
      jsonMode = true;
    } else if (a === '--reset-orch-once') {
      patch.orchestratorConfirmedOnce = false;
      hasPatch = true;
    } else if (a === '--sanitize' || a.startsWith('--sanitize=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      const parsed = parseEnvBool(val);
      if (parsed === undefined) fail(`--sanitize 取值非法（需为 on/off/true/false）: ${val}`);
      patch.sanitizeEnabled = parsed;
      hasPatch = true;
    } else if (a === '--alias' || a.startsWith('--alias=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      const parsed = parseEnvBool(val);
      if (parsed === undefined) fail(`--alias 取值非法（需为 on/off/true/false）: ${val}`);
      patch.aliasEnabled = parsed;
      hasPatch = true;
    } else if (a === '--orch-confirm' || a.startsWith('--orch-confirm=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      const parsed = parseOrchConfirmMode(val);
      if (!parsed) fail(`--orch-confirm 取值非法（需为 once/per_session/off）: ${val}`);
      patch.orchestratorConfirm = parsed;
      hasPatch = true;
    } else if (a === '--max-retry' || a.startsWith('--max-retry=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      patch.maxRetry = parseIntFlag(val, '--max-retry');
      hasPatch = true;
    } else if (a === '--retry-window' || a.startsWith('--retry-window=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      patch.retryWindowMin = parseIntFlag(val, '--retry-window');
      hasPatch = true;
    } else if (a === '--zero-limit' || a.startsWith('--zero-limit=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      patch.zeroOutLimit = parseIntFlag(val, '--zero-limit');
      hasPatch = true;
    } else if (a === '--long-tokens' || a.startsWith('--long-tokens=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      patch.longAnswerTokens = parseIntFlag(val, '--long-tokens');
      hasPatch = true;
    } else if (a === '--big-ctx' || a.startsWith('--big-ctx=')) {
      const [val, nextI] = takeVal(a, i);
      i = nextI;
      patch.bigContextTokens = parseIntFlag(val, '--big-ctx');
      hasPatch = true;
    } else {
      fail(`未知参数: ${a}`);
    }
  }

  let cfg;
  try {
    if (doReset) {
      cfg = resetConfig();
      if (hasPatch) cfg = saveConfig(patch);
    } else {
      cfg = hasPatch ? saveConfig(patch) : loadConfig();
    }
  } catch (err) {
    fail(err?.message || String(err));
  }

  const conflicts = detectConflicts({ env: process.env, config: cfg, workspacePaths: [process.cwd()] });
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ configPath: shortPath(getConfigPath()), config: cfg, conflicts }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`配置文件: ${shortPath(getConfigPath())}\n`);
  process.stdout.write(
    `可选项状态: sanitizeEnabled=${cfg.sanitizeEnabled ? 'on' : 'off'}, aliasEnabled=${cfg.aliasEnabled ? 'on' : 'off'}\n`,
  );
  process.stdout.write(
    `确认策略: orchestratorConfirm=${cfg.orchestratorConfirm} (confirmedOnce=${cfg.orchestratorConfirmedOnce ? 'yes' : 'no'})\n`,
  );
  process.stdout.write(
    `重试阈值: maxRetry=${cfg.maxRetry}, retryWindowMin=${cfg.retryWindowMin}, zeroOutLimit=${cfg.zeroOutLimit}, ` +
    `longAnswerTokens=${cfg.longAnswerTokens}, bigContextTokens=${cfg.bigContextTokens}\n`,
  );
  printConflicts(conflicts);
}

function cmdDoctor(args) {
  const jsonMode = args.includes('--json');
  const cfg = loadConfig();
  const realAliasCount = hasConfiguredAliases() ? readAliases(process.env, { fallbackExample: false }).length : 0;
  const archivedCount = Object.keys(loadArchivedMap()).length;
  const heartbeat = readHookHeartbeat(process.env);
  const conflicts = detectConflicts({ env: process.env, config: cfg, workspacePaths: [process.cwd()] });

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      dataDir: shortPath(getDataDir()),
      noteRoot: shortPath(getNoteRoot()),
      config: cfg,
      realAliasCount,
      archivedCount,
      heartbeat,
      conflicts,
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`数据目录: ${shortPath(getDataDir())}\n`);
  process.stdout.write(`笔记目录: ${shortPath(getNoteRoot())}\n`);
  process.stdout.write(
    `可选项配置: sanitizeEnabled=${cfg.sanitizeEnabled ? 'on' : 'off'}, aliasEnabled=${cfg.aliasEnabled ? 'on' : 'off'}, orchestratorConfirm=${cfg.orchestratorConfirm}\n`,
  );
  process.stdout.write(`已配置真实别名数: ${realAliasCount}\n`);
  process.stdout.write(`已归档工作台数: ${archivedCount}\n`);
  process.stdout.write(
    heartbeat
      ? `Hook 心跳: 最近拉起 ${formatMonthDayTime(heartbeat.tsMs)} (event=${heartbeat.event || 'unknown'})\n`
      : 'Hook 心跳: 尚无记录（首次触发宿主 Hook 后写入）\n',
  );
  printConflicts(conflicts);
}

function main() {
  const cmd = process.argv[2] || 'status';
  const rest = process.argv.slice(3);
  if (cmd === 'init') {
    cmdInit(rest);
  } else if (cmd === 'show') {
    cmdShow(rest);
  } else if (cmd === 'status' || cmd === 'ls' || cmd === 'list') {
    cmdStatus(rest);
  } else if (cmd === 'archive') {
    cmdArchive(rest);
  } else if (cmd === 'unarchive') {
    cmdUnarchive(rest);
  } else if (cmd === 'reset') {
    cmdReset(rest);
  } else if (cmd === 'clean') {
    cmdClean();
  } else if (cmd === 'config') {
    cmdConfig(rest);
  } else if (cmd === 'doctor') {
    cmdDoctor(rest);
  } else {
    fail(USAGE);
  }
}

main();
