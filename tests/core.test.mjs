import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { addAliasStrict, hasConfiguredAliases, upsertAlias } from '../plugin/lib/aliases.mjs';
import { loadConfig, saveConfig } from '../plugin/lib/config.mjs';
import { detectConflicts, isActiveControlTowerController } from '../plugin/lib/conflicts.mjs';
import { withFileLockSync } from '../plugin/lib/lock.mjs';
import { ensureDataDir, getDataDir, getPluginRoot, getStatePath, shortPath } from '../plugin/lib/paths.mjs';
import { applySanitizeIfEnabled, clean, latinLeftovers } from '../plugin/lib/sanitize.mjs';
import { appendLog, loadState, resetConvState, saveState } from '../plugin/lib/state.mjs';
import {
  buildWorkspaceRelayPrompt,
  extractNoteDir,
  hasExplicitOffload,
  hasExplicitOffloadOff,
  nextTurnIndex,
} from '../plugin/lib/workspace.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const execFileAsync = promisify(execFile);
const PLUGIN_DIR = resolve('plugin');
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

describe('core 共享内核：路径隔离、配置可选项、冲突检测、脱敏与工作台辅助', () => {
  it('支持 AGY_OFFLOAD_DATA_DIR > PLUGIN_DATA > hintPath 多端数据目录解析', () => {
    const sb = newSandbox();
    const defaultEnv = { HOME: sb.homeDir };
    assert.equal(
      getDataDir(defaultEnv),
      join(sb.homeDir, '.gemini', 'antigravity', 'plugin_data', 'note-offload'),
    );
    assert.equal(
      getDataDir(defaultEnv, join(sb.homeDir, '.gemini', 'antigravity-cli', 'brain', 'abc', 'transcript.jsonl')),
      join(sb.homeDir, '.gemini', 'antigravity-cli', 'plugin_data', 'note-offload'),
    );
    const pluginDataDir = join(sb.root, 'pdata', 'note-offload');
    assert.equal(getDataDir({ HOME: sb.homeDir, PLUGIN_DATA: pluginDataDir }), pluginDataDir);
    const foreignEnv = {
      HOME: sb.homeDir,
      PLUGIN_DATA: join(sb.root, 'pdata', 'agy-powertools'),
      PLUGIN_ROOT: join(sb.root, 'plugins', 'agy-powertools'),
    };
    assert.equal(
      getDataDir(foreignEnv),
      join(sb.homeDir, '.gemini', 'antigravity', 'plugin_data', 'note-offload'),
    );
    assert.equal(getPluginRoot(foreignEnv), PLUGIN_DIR);
    assert.equal(getDataDir(sb.env), sb.dataDir);
    assert.equal(shortPath(join(sb.homeDir, 'agy-notes', 'ws1'), sb.env), '~/agy-notes/ws1');
  });

  it('沙箱设置了 AGY_OFFLOAD_DATA_DIR 时不读取未指定的旧目录；显式 AGY_LEGACY_DATA_DIR 可平滑迁移并洗脏键', () => {
    const sb = newSandbox();
    mkdirSync(sb.legacyDataDir, { recursive: true });
    writeFileSync(join(sb.legacyDataDir, 'net-map.tsv'), 'gw-old\thttps://old.example.com\told\n', 'utf-8');
    writeFileSync(
      join(sb.legacyDataDir, '.filter-retry-state.json'),
      JSON.stringify({
        probe: { ts: Date.now() / 1000 },
        selftest: { ts: Date.now() / 1000 },
        realconv1: { note_dir: '~/agy-notes/ws1', ts: Date.now() / 1000 },
      }),
      'utf-8',
    );

    ensureDataDir(sb.env);
    assert.equal(existsSync(join(sb.dataDir, 'net-map.tsv')), false);

    const migEnv = { ...sb.env, AGY_LEGACY_DATA_DIR: sb.legacyDataDir };
    ensureDataDir(migEnv);
    assert.equal(existsSync(join(sb.dataDir, 'net-map.tsv')), true);
    const st = JSON.parse(readFileSync(getStatePath(migEnv), 'utf-8'));
    assert.equal(Object.hasOwn(st, 'probe'), false);
    assert.equal(Object.hasOwn(st, 'selftest'), false);
    assert.equal(st.realconv1?.note_dir, '~/agy-notes/ws1');
  });

  it('config.mjs 默认关闭可选项，支持锁写入及环境变量覆盖', () => {
    const sb = newSandbox();
    assert.deepEqual(loadConfig(sb.env), { sanitizeEnabled: false, aliasEnabled: false });

    const saved = saveConfig({ aliasEnabled: true }, sb.env);
    assert.deepEqual(saved, { sanitizeEnabled: false, aliasEnabled: true });
    assert.deepEqual(loadConfig(sb.env), { sanitizeEnabled: false, aliasEnabled: true });

    const overridden = loadConfig({ ...sb.env, AGY_OFFLOAD_SANITIZE: 'on', AGY_OFFLOAD_ALIAS: 'off' });
    assert.deepEqual(overridden, { sanitizeEnabled: true, aliasEnabled: false });
  });

  it('文件锁自动清理已退出 PID 的死锁残留', () => {
    const sb = newSandbox();
    const lockPath = join(sb.dataDir, 'dead.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, token: 'dead', ts: Date.now() }), 'utf-8');
    const out = withFileLockSync(lockPath, () => 'acquired');
    assert.equal(out, 'acquired');
    assert.equal(existsSync(lockPath), false);
  });

  it('12 进程并发写入 state 无丢更新、JSON 完整且无临时文件残留', async () => {
    const sb = newSandbox();
    const scriptPath = join(PLUGIN_DIR, 'scripts', 'hook-notice.mjs');

    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const child = execFileAsync(process.execPath, [scriptPath], { env: sb.env, timeout: 10000 });
        child.child.stdin.end(
          JSON.stringify({
            conversationId: `conc-${i}`,
            lastUserInput: `/note-offload 并发任务 ${i}`,
          }),
        );
        const { stdout } = await child;
        assert.match(stdout, /\[落盘模式\]/);
      }),
    );

    const st = loadState(sb.env);
    for (let i = 0; i < 12; i += 1) {
      assert.equal(Boolean(st[`conc-${i}`]), true, `missing conc-${i}`);
    }
    const leftover = readdirSync(sb.dataDir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftover, []);
  });

  it('多并发 upsertAlias、保留字拦截、hasConfiguredAliases 与 resetConvState 正常', async () => {
    const sb = newSandbox();
    assert.equal(hasConfiguredAliases(sb.env), false);

    assert.throws(
      () => addAliasStrict('https', 'https://bad.example.com', 'reserved', sb.env),
      /保留命令冲突/,
    );
    assert.throws(
      () => upsertAlias('compact', 'https://bad.example.com', 'reserved', sb.env),
      /保留命令冲突/,
    );

    saveState({
      'conv-a': { tries: 3, dead: true, note_dir: '~/agy-notes/a', ts: Date.now() / 1000 },
    }, sb.env);

    assert.equal(resetConvState('conv-a', sb.env), true);
    const st = loadState(sb.env);
    assert.equal(st['conv-a'].dead, undefined);
    assert.equal(st['conv-a'].note_dir, '~/agy-notes/a');

    for (let i = 0; i < 5; i += 1) {
      upsertAlias(`gw-${i}`, `https://api-${i}.example.com`, `note-${i}`, sb.env);
    }
    assert.equal(hasConfiguredAliases(sb.env), true);
    const mapText = readFileSync(join(sb.dataDir, 'net-map.tsv'), 'utf-8');
    for (let i = 0; i < 5; i += 1) {
      assert.match(mapText, new RegExp(`gw-${i}\\thttps://api-${i}\\.example\\.com`));
    }
  });

  it('日志超限自动原子轮转且保留尾部记录', () => {
    const sb = newSandbox();
    for (let i = 0; i < 20; i += 1) {
      appendLog('y'.repeat(40), sb.env);
    }
    const logPath = join(sb.dataDir, 'hook-invocations.log');
    const before = statSync(logPath).size;
    appendLog('rotation-probe', sb.env, { maxBytes: 1, keepLines: 5 });
    const after = statSync(logPath).size;
    assert.equal(after < before, true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[lines.length - 1], /rotation-probe/);
  });

  it('sanitize 保留工程术语、保护 URI、按需生效，且工作台退出/递增/接力提示准确', () => {
    const sb = newSandbox();
    assert.equal(clean('bypass 安全过滤器 exploit'), '越过 内容校验 利用');
    assert.equal(
      clean('保留 JSON IPv4 sha256 sessionId 与 https://example.com/bypass/path'),
      '保留 JSON IPv4 sha256 sessionId 与 https://example.com/bypass/path',
    );

    assert.equal(applySanitizeIfEnabled('bypass test', sb.env), 'bypass test');
    saveConfig({ sanitizeEnabled: true }, sb.env);
    assert.equal(applySanitizeIfEnabled('bypass test', sb.env), '越过 test');

    assert.deepEqual(
      latinLeftovers(`请查看 ${sb.noteRoot}/ws1/status.md 与 node ${PLUGIN_DIR}/scripts/neturl.mjs file:///tmp/a.md JSON`, sb.env),
      [],
    );

    assert.equal(hasExplicitOffload('```bash\n/note-offload x\n```'), false);
    assert.equal(hasExplicitOffload('/note-offload 执行任务'), true);
    assert.equal(hasExplicitOffloadOff('/note-offload off'), true);
    assert.equal(hasExplicitOffload('/note-offload off'), false);
    assert.equal(hasExplicitOffloadOff('请开启 [退出落盘]'), true);
    assert.match(extractNoteDir('读取 ~/agy-notes/demo-ws/task.md', sb.env), /\/demo-ws$/);

    const wsDir = join(sb.noteRoot, 'demo-ws');
    mkdirSync(wsDir, { recursive: true });
    assert.equal(nextTurnIndex('conv-x', { note_dir: '~/agy-notes/demo-ws' }, sb.env), 1);
    writeFileSync(join(wsDir, 'task.md'), '# task\n', 'utf-8');
    writeFileSync(join(wsDir, 'status.md'), '# status\n', 'utf-8');
    writeFileSync(join(wsDir, 'turn-1.md'), '# t1\n', 'utf-8');
    writeFileSync(join(wsDir, 'turn-3.md'), '# t3\n', 'utf-8');
    assert.equal(nextTurnIndex('conv-x', { note_dir: '~/agy-notes/demo-ws' }, sb.env), 4);

    const relay = buildWorkspaceRelayPrompt('conv-x123456', { note_dir: '~/agy-notes/demo-ws' }, 'agysum.mjs', sb.env);
    assert.match(relay.prompt, /task\.md/);
    assert.match(relay.prompt, /status\.md/);
    assert.match(relay.prompt, /turn-3\.md/);
  });

  it('detectConflicts 精准发现 control-tower、hex8 别名、MCP 重名、Hook 叠加与 PATH 遮蔽', () => {
    const sb = newSandbox();
    const wsRepo = join(sb.root, 'repo');
    mkdirSync(join(wsRepo, '.agents', 'control-tower'), { recursive: true });
    writeFileSync(
      join(wsRepo, '.agents', 'control-tower', 'registry.md'),
      '- **当前现役总控会话**：[`abcd1234`](conversation://abcd1234-0000-0000-0000-000000000000) | 状态：ONLINE\n',
      'utf-8',
    );

    upsertAlias('deadbeef', 'https://hex.example.com', 'hex', sb.env);
    upsertAlias('my-mcp', 'https://mcp.example.com', 'mcp', sb.env);

    writeFileSync(
      join(sb.configDir, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { 'my-mcp': { command: 'node' } } }),
      'utf-8',
    );
    mkdirSync(join(sb.configDir, 'plugins', 'other-plugin'), { recursive: true });
    writeFileSync(
      join(sb.configDir, 'plugins', 'other-plugin', 'hooks.json'),
      JSON.stringify({ other: { Stop: [{ type: 'command', command: 'echo ok' }] } }),
      'utf-8',
    );

    const fakeNeturl = join(sb.binDir, 'neturl');
    writeFileSync(fakeNeturl, '#!/bin/sh\necho shadow\n', 'utf-8');
    chmodSync(fakeNeturl, 0o755);

    const envWithPath = {
      ...sb.env,
      PATH: `${sb.binDir}:${sb.env.PATH || ''}`,
    };
    const cfg = saveConfig({ sanitizeEnabled: true, aliasEnabled: true }, envWithPath);
    const issues = detectConflicts({
      env: envWithPath,
      convId: 'abcd1234-0000-0000-0000-000000000000',
      workspacePaths: [wsRepo],
      config: cfg,
    });

    const codes = new Set(issues.map((i) => i.code));
    assert.equal(codes.has('control_tower_active_controller'), true);
    assert.equal(codes.has('alias_hex8_control_tower'), true);
    assert.equal(codes.has('alias_mcp_collision'), true);
    assert.equal(codes.has('multi_plugin_hook_overlap'), true);
    assert.equal(codes.has('path_shadow_neturl'), true);
  });

  it('isActiveControlTowerController 与 detectConflicts 支持 .agents/SESSION-REGISTRY.md 与 @plugin_data 哈希托管台账', () => {
    const sb = newSandbox();

    // 1. 工作区内 .agents/SESSION-REGISTRY.md
    const wsAgents = join(sb.root, 'ws-agents');
    mkdirSync(join(wsAgents, '.agents'), { recursive: true });
    writeFileSync(
      join(wsAgents, '.agents', 'SESSION-REGISTRY.md'),
      '- **当前现役总控会话**：[`11223344`](conversation://11223344-aaaa-bbbb-cccc-ddddeeeeffff) | 状态：`ONLINE`\n',
      'utf-8',
    );
    assert.equal(
      isActiveControlTowerController({
        convId: '11223344-aaaa-bbbb-cccc-ddddeeeeffff',
        workspacePaths: [wsAgents],
        env: sb.env,
      }),
      true,
    );
    assert.equal(
      isActiveControlTowerController({
        convId: '99887766-aaaa-bbbb-cccc-ddddeeeeffff',
        workspacePaths: [wsAgents],
        env: sb.env,
      }),
      false,
    );

    // 2. @plugin_data/workspaces/<sha256(wsReal).slice(0,16)>/SESSION-REGISTRY.md 托管台账
    const wsManaged = join(sb.root, 'ws-managed');
    mkdirSync(wsManaged, { recursive: true });
    const wsReal = realpathSync(wsManaged);
    const wsHash = createHash('sha256').update(wsReal, 'utf8').digest('hex').slice(0, 16);
    const managedRegDir = join(sb.homeDir, '.gemini', 'antigravity', 'plugin_data', 'control-tower', 'workspaces', wsHash);
    mkdirSync(managedRegDir, { recursive: true });
    writeFileSync(
      join(managedRegDir, 'SESSION-REGISTRY.md'),
      '- **当前现役总控会话**：[`cafebabe`](conversation://cafebabe-1111-2222-3333-444455556666) | 状态：`ONLINE`\n',
      'utf-8',
    );

    const issues = detectConflicts({
      env: sb.env,
      convId: 'cafebabe-1111-2222-3333-444455556666',
      workspacePaths: [wsManaged],
    });
    assert.equal(issues.some((i) => i.code === 'control_tower_active_controller'), true);
  });
});
