#!/usr/bin/env node
/**
 * Note Offload Ring 4 (L4): Golden Skill & Prompt Behavioral Contract Evaluation
 * 验证 SKILL.md、Hook 提示词、零污染边界、无损 Orchestrator 交接、无间隔号红线与插件严检契约。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../tests/helpers/sandbox.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugin');
const SKILL_PATH = join(PLUGIN_DIR, 'skills', 'note-offload', 'SKILL.md');
const NOTICE_SCRIPT = join(PLUGIN_DIR, 'scripts', 'hook-notice.mjs');
const RETRY_SCRIPT = join(PLUGIN_DIR, 'scripts', 'hook-retry.mjs');
const GUARDRAIL_SCRIPT = join(PLUGIN_DIR, 'scripts', 'hook-guardrail.mjs');

function walkFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      walkFiles(full, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function runHook(script, payload, env) {
  return execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf-8',
  }).trim();
}

export function runSkillEval() {
  const cases = [];
  const runCase = (id, title, fn) => {
    const t0 = Date.now();
    try {
      fn();
      cases.push({ id, title, ok: true, durationMs: Date.now() - t0 });
    } catch (err) {
      cases.push({ id, title, ok: false, error: err?.message || String(err), durationMs: Date.now() - t0 });
    }
  };

  const skillText = readFileSync(SKILL_PATH, 'utf-8');
  const noticeText = readFileSync(NOTICE_SCRIPT, 'utf-8');

  runCase('E01', 'SKILL.md frontmatter 与核心触发/退出/单目录契约完整', () => {
    assert.match(skillText, /^---\s*\n[\s\S]*?name:\s*note-offload[\s\S]*?---/);
    assert.equal(skillText.includes('/note-offload off'), true);
    assert.equal(skillText.includes('严禁双写'), true);
    assert.equal(skillText.includes('Orchestrator'), true);
  });

  runCase('E02', '无损 Orchestrator 规划交接：严禁存在 15 行硬上限阉割', () => {
    const sb = createSandbox();
    try {
      const out = runHook(NOTICE_SCRIPT, {
        conversationId: 'eval-orch-rule',
        lastUserInput: '/note-offload 开始评估',
      }, sb.env);
      const parsed = JSON.parse(out);
      const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
      assert.match(msg, /完整传递核心分析结论/);
      assert.doesNotMatch(msg, /15\s*行/);
      assert.equal(skillText.includes('不限 15 行'), true);
    } finally {
      sb.cleanup();
    }
  });

  runCase('E03', '运行态 plugin/ 全目录零间隔号 (U+00B7) 合规', () => {
    const files = walkFiles(PLUGIN_DIR);
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      assert.equal(text.includes('\u00B7'), false, `Found middle dot in ${f}`);
    }
  });

  runCase('E04', '默认 Hook 提示词无敏感对抗词与异常短语', () => {
    const sb = createSandbox();
    try {
      const out = runHook(NOTICE_SCRIPT, {
        conversationId: 'eval-clean-prompt',
        lastUserInput: '/note-offload 检查状态',
      }, sb.env);
      const parsed = JSON.parse(out);
      const msg = (parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || '').toLowerCase();
      for (const word of ['bypass', 'exploit', 'intercept', '安全过滤器', '绕开']) {
        assert.equal(msg.includes(word), false, `Unexpected sensitive word: ${word}`);
      }
    } finally {
      sb.cleanup();
    }
  });

  runCase('E05', '可点击 file:// 路径链接契约存在于规则与技能文档', () => {
    assert.equal(noticeText.includes('file://'), true);
    assert.equal(skillText.includes('file://'), true);
  });

  runCase('E06', 'SessionStart 普通会话零污染：返回 {} 且不预建工作台目录', () => {
    const sb = createSandbox();
    try {
      const out = runHook(GUARDRAIL_SCRIPT, { conversationId: 'eval-plain-1' }, sb.env);
      assert.equal(out, '{}');
      assert.equal(existsSync(join(sb.noteRoot, 'eval-pla')), false);
    } finally {
      sb.cleanup();
    }
  });

  runCase('E07', '根目录独立普通文件永不误绑为工作台目录', () => {
    const sb = createSandbox();
    try {
      writeFileSync(join(sb.noteRoot, 'handover-20261124.md'), '# handover\n', 'utf-8');
      const out = runHook(NOTICE_SCRIPT, {
        conversationId: 'eval-file-guard',
        lastUserInput: '请参考 ~/agy-notes/handover-20261124.md 的说明',
      }, sb.env);
      assert.equal(out, '{}');
      const stateFile = join(sb.dataDir, '.filter-retry-state.json');
      const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf-8')) : {};
      assert.equal(Object.hasOwn(st, 'eval-file-guard'), false);
    } finally {
      sb.cleanup();
    }
  });

  runCase('E08', 'Stop 立即跳过 TERMINAL_CUSTOM_HOOK 与 INJECTED_RESPONSE', () => {
    const sb = createSandbox();
    try {
      const tPath = join(sb.root, 't.jsonl');
      writeFileSync(
        tPath,
        `${JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', content: "This request was blocked by Gemini's filters." })}\n`,
        'utf-8',
      );
      runHook(NOTICE_SCRIPT, { conversationId: 'eval-skip', lastUserInput: '/note-offload hi' }, sb.env);
      for (const reason of ['TERMINAL_CUSTOM_HOOK', 'INJECTED_RESPONSE']) {
        const out = runHook(RETRY_SCRIPT, {
          conversationId: 'eval-skip',
          terminationReason: reason,
          transcriptPath: tPath,
        }, sb.env);
        assert.equal(out, '{}');
      }
    } finally {
      sb.cleanup();
    }
  });

  runCase('E09', 'control-tower 现役总控静默放行且不向 hook-invocations.log 刷屏', () => {
    const sb = createSandbox();
    try {
      const ws = join(sb.root, 'repo-ct');
      mkdirSync(join(ws, '.agents'), { recursive: true });
      const cid = 'deadbeef-1111-2222-3333-444455556666';
      writeFileSync(
        join(ws, '.agents', 'SESSION-REGISTRY.md'),
        `- **当前现役总控会话**：[\`deadbeef\`](conversation://${cid}) | 状态：\`ONLINE\`\n`,
        'utf-8',
      );
      const out = runHook(NOTICE_SCRIPT, {
        conversationId: cid,
        workspacePaths: [ws],
        lastUserInput: '汇总 ~/agy-notes/task-a/status.md',
      }, sb.env);
      assert.equal(out, '{}');
      const logFile = join(sb.dataDir, 'hook-invocations.log');
      const logText = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : '';
      assert.equal(logText.includes('skip_ct_controller'), false);
    } finally {
      sb.cleanup();
    }
  });

  runCase('E10', '官方 agy plugin validate ./plugin --strict 零告警', () => {
    const which = spawnSync('which', ['agy'], { encoding: 'utf-8' });
    if (which.status !== 0) return;
    const res = spawnSync('agy', ['plugin', 'validate', PLUGIN_DIR, '--strict', '--json'], { encoding: 'utf-8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
  });

  const failed = cases.filter((c) => !c.ok);
  return {
    ok: failed.length === 0,
    total: cases.length,
    passed: cases.length - failed.length,
    failed: failed.length,
    cases,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  const res = runSkillEval();
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
  } else {
    for (const c of res.cases) {
      const tag = c.ok ? 'PASS' : 'FAIL';
      process.stdout.write(`[${tag}] ${c.id} (${c.durationMs}ms): ${c.title}${c.error ? ` -> ${c.error}` : ''}\n`);
    }
    process.stdout.write(`----\nSkill Eval: ${res.passed}/${res.total} PASS\n`);
  }
  process.exit(res.ok ? 0 : 1);
}
