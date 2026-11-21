#!/usr/bin/env node
/**
 * agynote: 双向文件工作台管理、会话健康看板、可选项配置与冲突诊断 CLI。
 *
 * 用法：
 *   node agynote.mjs init <工作台名> [任务文件路径 | -]   创建工作台 {task.md,status.md} 并打印启动短句
 *   node agynote.mjs show <工作台名或前缀>                查看当前 status.md 与笔记列表
 *   node agynote.mjs status [all]                        显示活跃工作台与会话健康看板（OK / RETRY / DEAD）
 *   node agynote.mjs ls                                  同 status 的简要视图
 *   node agynote.mjs clean                               安全清理 0 文件的空目录
 *   node agynote.mjs config [--sanitize on|off] [--alias on|off]  查看或修改可选项配置
 *   node agynote.mjs doctor                              诊断路径、可选项、别名与插件冲突
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasConfiguredAliases, readAliases } from '../lib/aliases.mjs';
import { loadConfig, parseEnvBool, saveConfig } from '../lib/config.mjs';
import { detectConflicts } from '../lib/conflicts.mjs';
import { atomicWriteSync } from '../lib/lock.mjs';
import {
  expandHome,
  getConfigPath,
  getDataDir,
  getHomeDir,
  getNoteRoot,
  shortPath,
} from '../lib/paths.mjs';
import { IGNORED_CONV_IDS, loadState, sessionHealth } from '../lib/state.mjs';
import {
  cleanEmptyWorkspaces,
  formatNow,
  readStatusSummary,
  statusTemplate,
  taskTemplate,
  WS_NAME_RE,
  wsNameFromEntry,
} from '../lib/workspace.mjs';

const USAGE =
  '用法:\n' +
  '  agynote.mjs init <工作台名> [任务文件路径 | -]\n' +
  '  agynote.mjs show <工作台名或前缀>\n' +
  '  agynote.mjs status [all]\n' +
  '  agynote.mjs ls\n' +
  '  agynote.mjs clean\n' +
  '  agynote.mjs config [--sanitize on|off] [--alias on|off]\n' +
  '  agynote.mjs doctor';

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
      .filter((ent) => ent.isDirectory() && ent.name.startsWith(prefix))
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
  if (!WS_NAME_RE.test(name) || name.includes('..')) {
    fail('工作台名称非法（仅支持字母、数字及 . _ -，长度 1-64）');
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
  const wsDisp = shortPath(wsDir);
  process.stdout.write(`=== 工作台: ${wsDisp} ===\n`);
  const statusFile = join(wsDir, 'status.md');
  if (existsSync(statusFile)) {
    process.stdout.write(`${readFileSync(statusFile, 'utf-8').replace(/\s+$/, '')}\n`);
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
  const showAll = args[0] === 'all';
  const nowSec = Date.now() / 1000;
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
      .filter((ent) => ent.isDirectory())
      .map((ent) => {
        const full = join(noteRoot, ent.name);
        return { name: ent.name, full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  const list = showAll ? dirs : dirs.slice(0, 20);
  process.stdout.write(
    `${'工作台'.padEnd(22)} | ${'文件'.padStart(4)} | ${'绑定会话'.padEnd(10)} | ${'状态'.padEnd(20)} | ${'步数'.padStart(5)} | ${'更新时间'.padEnd(11)} | 看板摘要\n`,
  );
  process.stdout.write(`${'-'.repeat(115)}\n`);

  const seenDirs = new Set();
  for (const d of list) {
    seenDirs.add(d.name);
    let nFiles = 0;
    try {
      nFiles = readdirSync(d.full, { withFileTypes: true }).filter((e) => e.isFile()).length;
    } catch {
      nFiles = 0;
    }
    const mtimeStr = formatMonthDayTime(d.mtime);
    const binds = byWs.get(d.name) || [];
    let cid8 = '-';
    let health = '-';
    let step = '-';
    if (binds.length > 0) {
      binds.sort((a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0));
      const [cid, entry] = binds[0];
      cid8 = cid.slice(0, 8);
      health = sessionHealth(entry, nowSec);
      step = entry.step !== null && entry.step !== undefined ? String(entry.step) : '-';
    }
    const summary = readStatusSummary(d.full, 44) || '-';
    process.stdout.write(
      `${d.name.padEnd(22)} | ${String(nFiles).padStart(4)} | ${cid8.padEnd(10)} | ${health.padEnd(20)} | ${step.padStart(5)} | ${mtimeStr.padEnd(11)} | ${summary}\n`,
    );
  }

  const unmapped = [];
  for (const [wsName, binds] of byWs.entries()) {
    if (seenDirs.has(wsName)) continue;
    binds.sort((a, b) => Number(b[1].ts || 0) - Number(a[1].ts || 0));
    const [cid, entry] = binds[0];
    const health = sessionHealth(entry, nowSec);
    const step = entry.step !== null && entry.step !== undefined ? String(entry.step) : '-';
    const tsStr = entry.ts ? formatMonthDayTime(Number(entry.ts) * 1000) : '-';
    unmapped.push([wsName, cid.slice(0, 8), health, step, tsStr]);
  }

  if (unmapped.length > 0) {
    process.stdout.write('\n[无落盘文件的追踪会话]\n');
    for (const [wsName, cid8, health, step, tsStr] of unmapped) {
      process.stdout.write(
        `${wsName.padEnd(22)} |    0 | ${cid8.padEnd(10)} | ${health.padEnd(20)} | ${step.padStart(5)} | ${tsStr.padEnd(11)} | -\n`,
      );
    }
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

function cmdConfig(args) {
  const patch = {};
  let hasPatch = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write('用法: agynote.mjs config [--sanitize on|off] [--alias on|off]\n');
      return;
    }
    if (a === '--sanitize' || a.startsWith('--sanitize=')) {
      const val = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      const parsed = parseEnvBool(val);
      if (parsed === undefined) fail(`--sanitize 取值非法（需为 on/off/true/false）: ${val}`);
      patch.sanitizeEnabled = parsed;
      hasPatch = true;
    } else if (a === '--alias' || a.startsWith('--alias=')) {
      const val = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
      const parsed = parseEnvBool(val);
      if (parsed === undefined) fail(`--alias 取值非法（需为 on/off/true/false）: ${val}`);
      patch.aliasEnabled = parsed;
      hasPatch = true;
    } else {
      fail(`未知参数: ${a}`);
    }
  }

  const cfg = hasPatch ? saveConfig(patch) : loadConfig();
  process.stdout.write(`配置文件: ${shortPath(getConfigPath())}\n`);
  process.stdout.write(
    `可选项状态: sanitizeEnabled=${cfg.sanitizeEnabled ? 'on' : 'off'}, aliasEnabled=${cfg.aliasEnabled ? 'on' : 'off'}\n`,
  );
  const conflicts = detectConflicts({ env: process.env, config: cfg, workspacePaths: [process.cwd()] });
  printConflicts(conflicts);
}

function cmdDoctor() {
  const cfg = loadConfig();
  const realAliasCount = hasConfiguredAliases() ? readAliases(process.env, { fallbackExample: false }).length : 0;
  const conflicts = detectConflicts({ env: process.env, config: cfg, workspacePaths: [process.cwd()] });

  process.stdout.write(`数据目录: ${shortPath(getDataDir())}\n`);
  process.stdout.write(`笔记目录: ${shortPath(getNoteRoot())}\n`);
  process.stdout.write(
    `可选项配置: sanitizeEnabled=${cfg.sanitizeEnabled ? 'on' : 'off'}, aliasEnabled=${cfg.aliasEnabled ? 'on' : 'off'}\n`,
  );
  process.stdout.write(`已配置真实别名数: ${realAliasCount}\n`);
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
  } else if (cmd === 'clean') {
    cmdClean();
  } else if (cmd === 'config') {
    cmdConfig(rest);
  } else if (cmd === 'doctor') {
    cmdDoctor();
  } else {
    fail(USAGE);
  }
}

main();
