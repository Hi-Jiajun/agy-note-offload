#!/usr/bin/env node
/**
 * Note Offload Ring 3: Sanitized Incident Replay Harness
 * 在隔离沙箱中逐条回放 tests/replays/*.replay.json 真实故障夹具，确保历史缺陷零回归。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir, getPluginRoot } from '../plugin/lib/paths.mjs';
import { extractNoteDir } from '../plugin/lib/workspace.mjs';
import { createSandbox } from '../tests/helpers/sandbox.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugin');
const REPLAY_DIR = join(REPO_ROOT, 'tests', 'replays');
const NOTICE = join(PLUGIN_DIR, 'scripts', 'hook-notice.mjs');
const RETRY = join(PLUGIN_DIR, 'scripts', 'hook-retry.mjs');

function runHook(script, payload, env) {
  return execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf-8',
  }).trim();
}

function executeFixture(fixture) {
  const sb = createSandbox();
  try {
    if (fixture.kind === 'extract_note_dir') {
      for (const f of fixture.setup?.rootFiles || []) {
        writeFileSync(join(sb.noteRoot, f), 'standalone file\n', 'utf-8');
      }
      for (const d of fixture.setup?.workspaceDirs || []) {
        mkdirSync(join(sb.noteRoot, d), { recursive: true });
      }
      for (const c of fixture.cases || []) {
        const actual = extractNoteDir(c.input, sb.env);
        if (Object.hasOwn(c, 'expectedDir')) {
          assert.equal(actual, c.expectedDir, `extractNoteDir(${c.input}) => ${actual}`);
        }
        if (c.expectedSuffix) {
          assert.equal(actual.endsWith(c.expectedSuffix), true, `expected suffix ${c.expectedSuffix}, got ${actual}`);
        }
      }
      return;
    }

    if (fixture.kind === 'env_isolation') {
      const foreign = fixture.foreignPluginName || 'agy-powertools';
      const foreignEnv = {
        HOME: sb.homeDir,
        PLUGIN_DATA: join(sb.root, 'pdata', foreign),
        PLUGIN_ROOT: join(sb.root, 'plugins', foreign),
      };
      const expectedData = join(sb.homeDir, '.gemini', 'antigravity', 'plugin_data', 'note-offload');
      assert.equal(getDataDir(foreignEnv), expectedData);
      assert.equal(getPluginRoot(foreignEnv), PLUGIN_DIR);
      return;
    }

    if (fixture.kind === 'ct_controller_guard') {
      const convId = fixture.controllerConvId;
      const ws1 = join(sb.root, 'ws-local-reg');
      mkdirSync(join(ws1, '.agents'), { recursive: true });
      writeFileSync(
        join(ws1, '.agents', 'SESSION-REGISTRY.md'),
        `- **当前现役总控会话**：[\`${convId.slice(0, 8)}\`](conversation://${convId}) | 状态：\`ONLINE\`\n`,
        'utf-8',
      );

      const ws2 = join(sb.root, 'ws-managed-reg');
      mkdirSync(ws2, { recursive: true });
      const wsHash = createHash('sha256').update(realpathSync(ws2), 'utf8').digest('hex').slice(0, 16);
      const managedDir = join(sb.homeDir, '.gemini', 'antigravity', 'plugin_data', 'control-tower', 'workspaces', wsHash);
      mkdirSync(managedDir, { recursive: true });
      writeFileSync(
        join(managedDir, 'SESSION-REGISTRY.md'),
        `- **当前现役总控会话**：[\`${convId.slice(0, 8)}\`](conversation://${convId}) | 状态：\`ONLINE\`\n`,
        'utf-8',
      );

      for (const ws of [ws1, ws2]) {
        const out = runHook(NOTICE, {
          conversationId: convId,
          workspacePaths: [ws],
          lastUserInput: fixture.userInput,
        }, sb.env);
        assert.equal(out, '{}');
      }

      const stateFile = join(sb.dataDir, '.filter-retry-state.json');
      if (existsSync(stateFile)) {
        const st = JSON.parse(readFileSync(stateFile, 'utf-8'));
        assert.equal(Object.hasOwn(st, convId), false);
      }

      const logPath = join(sb.dataDir, 'hook-invocations.log');
      const logContent = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
      assert.equal(logContent.includes('skip_ct_controller'), false, 'hook-invocations.log must not be flooded by skip_ct_controller');
      return;
    }

    if (fixture.kind === 'stop_plan_multiturn') {
      const transcript = join(sb.root, 'multi-plan.jsonl');
      const rows = [
        { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 第一轮\n</USER_REQUEST>' },
        { step_index: 2, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: worker turn' },
        { step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-flash-worker-agy', content: 'done' },
        { step_index: 4, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 第二轮规划\n</USER_REQUEST>' },
        { step_index: 5, type: 'SYSTEM_MESSAGE', content: 'Plan mode is on: planning turn' },
      ];
      const filler = Number(fixture.fillerSteps || 50);
      for (let i = 0; i < filler; i += 1) {
        rows.push({ step_index: 6 + i, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', content: `step ${i}` });
      }
      rows.push({
        step_index: 6 + filler,
        type: 'PLANNER_RESPONSE',
        output_tokens: 450,
        content: "This request was blocked by Gemini's filters.",
      });
      writeFileSync(transcript, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
      const out = runHook(RETRY, { transcriptPath: transcript, conversationId: fixture.convId }, sb.env);
      assert.match(out, new RegExp(fixture.expectedMatch || '\\[规划精简\\]'));
      return;
    }

    if (fixture.kind === 'compact_and_stop_skips') {
      const convId = fixture.convId;
      const stateFile = join(sb.dataDir, '.filter-retry-state.json');
      writeFileSync(stateFile, JSON.stringify({
        [convId]: {
          step: 10,
          tries: 3,
          dead: true,
          dead_reason: 'max_retry',
          offload_mode: true,
          alias_injected: true,
          rule_rev: 2,
          ts: Date.now() / 1000,
        },
      }));

      // /compact 解除熔断
      assert.equal(runHook(NOTICE, { conversationId: convId, initialNumSteps: 11, lastUserInput: '/compact' }, sb.env), '{}');
      const afterCompact = JSON.parse(readFileSync(stateFile, 'utf-8'))[convId];
      assert.equal(afterCompact.dead, undefined);
      assert.equal(afterCompact.tries, undefined);

      // Stop 收到 TERMINAL_CUSTOM_HOOK / INJECTED_RESPONSE / USER_CANCELED 立即跳过且不增 tries
      const transcript = join(sb.root, 'skip.jsonl');
      writeFileSync(
        transcript,
        `${JSON.stringify({ step_index: 12, type: 'PLANNER_RESPONSE', output_tokens: 900, content: "This request was blocked by Gemini's filters." })}\n`,
        'utf-8',
      );
      const logPath = join(sb.dataDir, 'hook-invocations.log');
      const logBefore = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
      for (const reason of fixture.skipReasons || []) {
        const out = runHook(RETRY, {
          conversationId: convId,
          terminationReason: reason,
          transcriptPath: transcript,
        }, sb.env);
        assert.equal(out, '{}', `Stop should immediately skip ${reason}`);
      }
      const afterSkip = JSON.parse(readFileSync(stateFile, 'utf-8'))[convId];
      assert.equal(afterSkip.tries, undefined);
      const logAfter = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
      assert.equal(logAfter, logBefore, 'Skipped Stop reasons must not write hook-invocations.log');
      return;
    }

    throw new Error(`未知回放夹具类型: ${fixture.kind}`);
  } finally {
    sb.cleanup();
  }
}

export function runReplays() {
  const files = readdirSync(REPLAY_DIR)
    .filter((f) => f.endsWith('.replay.json'))
    .sort();
  const results = [];
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(REPLAY_DIR, file), 'utf-8'));
    const t0 = Date.now();
    executeFixture(fixture);
    results.push({
      id: fixture.id,
      title: fixture.title,
      ok: true,
      durationMs: Date.now() - t0,
    });
  }
  return {
    ok: true,
    total: results.length,
    results,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  try {
    const res = runReplays();
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      for (const r of res.results) {
        process.stdout.write(`[PASS] ${r.id} (${r.durationMs}ms): ${r.title}\n`);
      }
      process.stdout.write(`----\nReplays: ${res.total}/${res.total} PASS\n`);
    }
  } catch (err) {
    process.stderr.write(`REPLAY FAIL: ${err?.message || err}\n`);
    process.exit(1);
  }
}
