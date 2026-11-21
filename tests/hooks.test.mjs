import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { upsertAlias } from '../plugin/lib/aliases.mjs';
import { saveConfig } from '../plugin/lib/config.mjs';
import { latinLeftovers } from '../plugin/lib/sanitize.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

const PLUGIN_DIR = resolve('plugin');
const GUARDRAIL = join(PLUGIN_DIR, 'scripts', 'hook-guardrail.mjs');
const RETRY = join(PLUGIN_DIR, 'scripts', 'hook-retry.mjs');
const NOTICE = join(PLUGIN_DIR, 'scripts', 'hook-notice.mjs');

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

function runHook(script, payload, env) {
  return execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf-8',
  }).trim();
}

function writeTranscript(path, rows) {
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf-8');
}

describe('hooks 生命周期：按需零污染、Orchestrator 确认、Stop 递增落盘与防空转', () => {
  it('SessionStart 普通会话零污染清旧态返回 {}，且 Stop 不介入未开启/未绑定会话', () => {
    const sb = newSandbox();
    const stateFile = join(sb.dataDir, '.filter-retry-state.json');
    writeFileSync(stateFile, JSON.stringify({
      selftest: { step: 9, tries: 3, dead: true, ts: Date.now() / 1000 },
    }));

    const out = runHook(GUARDRAIL, { conversationId: 'selftest' }, sb.env);
    assert.equal(out, '{}');
    assert.equal(existsSync(join(sb.noteRoot, 'selftest')), false);
    const st = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(Object.hasOwn(st, 'selftest'), false);

    // 普通会话即便被拦，Stop 也不应介入或建目录
    const transcript = join(sb.root, 'plain.jsonl');
    writeTranscript(transcript, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n帮我解释一下 Promise\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', output_tokens: 1200, content: "This request was blocked by Gemini's filters." },
    ]);
    const stopOut = runHook(RETRY, { transcriptPath: transcript, conversationId: 'plainconv1' }, sb.env);
    assert.equal(stopOut, '{}');
    assert.equal(existsSync(join(sb.noteRoot, 'plaincon')), false);
    const afterSt = JSON.parse(readFileSync(stateFile, 'utf-8'));
    assert.equal(Object.hasOwn(afterSt, 'plainconv1'), false);
  });

  it('可选项默认关闭不强替术语、不注入 neturl；开启后按需清洗、注入 neturl 且输出冲突卡片', () => {
    const sb = newSandbox();
    const transcript = join(sb.root, 't.jsonl');

    // 默认关闭时，即便未配置 net-map.tsv 也不注入 neturl
    const defaultNotice = runHook(NOTICE, {
      conversationId: 'optdefault',
      lastUserInput: '/note-offload 分析当前仓库架构',
    }, sb.env);
    assert.match(defaultNotice, /\[落盘模式\]/);
    assert.doesNotMatch(defaultNotice, /neturl\.mjs/);

    // 开启 sanitize + alias 并登记 hex8 别名，同时验证无残留异常词
    saveConfig({ sanitizeEnabled: true, aliasEnabled: true }, sb.env);
    upsertAlias('deadbeef', 'https://api.example.com', 'hex8', sb.env);

    const gOut = runHook(GUARDRAIL, { conversationId: 'selftest' }, sb.env);
    assert.equal(gOut, '{}');

    const nInit = runHook(NOTICE, {
      conversationId: 'selftest',
      lastUserInput: '/note-offload 开始阶段 1',
    }, sb.env);
    assert.match(nInit, /neturl\.mjs/);
    assert.match(nInit, /alias_hex8_control_tower/);

    writeTranscript(transcript, [{
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      output_tokens: 90,
      input_tokens: 21000,
      cache_read_tokens: 0,
      thinking: 't',
      content: "This request was blocked by Gemini's filters.",
    }]);
    const r1 = runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);

    writeTranscript(transcript, [{
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      output_tokens: 90,
      input_tokens: 21000,
      cache_read_tokens: 0,
      thinking: 't',
      content: "This request was blocked by Gemini's filters.",
    }]);
    const r2 = runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);

    const texts = [];
    for (const raw of [nInit, r1, r2]) {
      const parsed = JSON.parse(raw);
      if (parsed.reason) texts.push(parsed.reason);
      for (const st of parsed.injectSteps || []) {
        const sm = st?.systemMessage?.systemMessage;
        if (sm) texts.push(sm);
      }
    }
    const blob = texts.join('\n');
    const banned = [
      'bypass', 'fake password', 'intercept', 'exploit', 'lockscreen', 'root ca',
      '安全过滤器', '绕开', '攻防', '·',
    ];
    for (const b of banned) {
      assert.equal(blob.toLowerCase().includes(b), false, `banned hit: ${b}`);
    }
    assert.deepEqual(latinLeftovers(blob, sb.env), []);
  });

  it('支持 /note-offload off 与 [退出落盘] 同会话退出，退出后 Stop 不再介入', () => {
    const sb = newSandbox();
    const transcript = join(sb.root, 'off.jsonl');
    const onOut = runHook(NOTICE, {
      conversationId: 'offconv1',
      lastUserInput: '/note-offload 读取 ~/agy-notes/off-ws/task.md 执行任务',
    }, sb.env);
    assert.match(onOut, /\[落盘模式\]/);

    const offOut = runHook(NOTICE, {
      conversationId: 'offconv1',
      lastUserInput: '/note-offload off',
    }, sb.env);
    assert.match(offOut, /\[退出落盘模式\]/);

    writeTranscript(transcript, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload off\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', output_tokens: 1200, content: "This request was blocked by Gemini's filters." },
    ]);
    assert.equal(runHook(RETRY, { transcriptPath: transcript, conversationId: 'offconv1' }, sb.env), '{}');
  });

  it('Orchestrator 首次启用 /note-offload 触发零配额确认卡，回复确认自动补发原指令且无损交接', () => {
    const sb = newSandbox();
    const stateFile = join(sb.dataDir, '.filter-retry-state.json');

    const prompt = '/note-offload 读取 ~/agy-notes/orch-ws/task.md 执行深度重构';
    const firstOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'orch1',
      modelName: 'gemini-pro-orchestrator-neon',
      lastUserInput: prompt,
    }, sb.env));
    assert.equal(firstOut.terminationBehavior, 'terminate');
    assert.match(firstOut.injectSteps[0].systemMessage.metadata.user_markdown, /Orchestrator 模式启用落盘提醒/);

    const midState = JSON.parse(readFileSync(stateFile, 'utf-8')).orch1;
    assert.equal(midState.pending_orch_prompt, prompt);
    assert.equal(Boolean(midState.offload_mode), false);

    const confirmOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'orch1',
      modelName: 'gemini-pro-orchestrator-neon',
      lastUserInput: '确认',
    }, sb.env));
    assert.equal(confirmOut.terminationBehavior, undefined);
    assert.equal(confirmOut.injectSteps[0].userMessage, prompt);
    const injectedRule = confirmOut.injectSteps[1].systemMessage.systemMessage;
    assert.match(injectedRule, /\[落盘模式\]/);
    assert.match(injectedRule, /完整传递核心分析结论/);
    assert.doesNotMatch(injectedRule, /15\s*行/);

    const afterState = JSON.parse(readFileSync(stateFile, 'utf-8')).orch1;
    assert.equal(afterState.orch_confirmed, true);
    assert.equal(afterState.offload_mode, true);
    assert.equal(afterState.pending_orch_prompt, undefined);
  });

  it('命名工作台自动绑定、连续递增 turn-N 编号且熔断卡片优先指向 task/status/turn', () => {
    const sb = newSandbox();
    const transcript = join(sb.root, 't.jsonl');
    runHook(NOTICE, {
      conversationId: 'selftest',
      lastUserInput: '/note-offload 读取 ~/agy-notes/selftest-ws/task.md 与 status.md',
    }, sb.env);

    const wsDir = join(sb.noteRoot, 'selftest-ws');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'task.md'), '# task\n', 'utf-8');
    writeFileSync(join(wsDir, 'status.md'), '# status\n', 'utf-8');
    writeFileSync(join(wsDir, 'turn-1.md'), '# t1\n', 'utf-8');
    writeFileSync(join(wsDir, 'turn-2.md'), '# t2\n', 'utf-8');

    writeTranscript(transcript, [{
      step_index: 98,
      output_tokens: 1200,
      input_tokens: 5000,
      content: "This request was blocked by Gemini's filters.",
    }]);
    const outWs = runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);
    assert.match(outWs, /selftest-ws\/turn-3\.md/);
    assert.doesNotMatch(outWs, /turn-98\.md/);

    writeTranscript(transcript, [{ step_index: 99, output_tokens: 90, input_tokens: 1000, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);
    writeTranscript(transcript, [{ step_index: 100, output_tokens: 90, input_tokens: 1000, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);

    const cardOut = runHook(NOTICE, {
      conversationId: 'selftest',
      initialNumSteps: 110,
      lastUserInput: '继续',
    }, sb.env);
    assert.match(cardOut, /selftest-ws\/task\.md/);
    assert.match(cardOut, /selftest-ws\/status\.md/);
    assert.match(cardOut, /selftest-ws\/turn-2\.md/);
    assert.match(cardOut, /分支会话/);
  });

  it('Orchestrator / 跨轮 Plan mode is on 及 >40 步长尾窗准确走规划精简分流', () => {
    const sb = newSandbox();
    const transcript = join(sb.root, 't.jsonl');

    runHook(NOTICE, { conversationId: 'selftest', lastUserInput: '/note-offload 执行分析' }, sb.env);
    writeTranscript(transcript, [{
      step_index: 335,
      type: 'PLANNER_RESPONSE',
      model: 'gemini-pro-orchestrator',
      output_tokens: 3078,
      input_tokens: 3066,
      cache_read_tokens: 161730,
      content: "This request was blocked by Gemini's filters.",
    }]);
    const outOrch = runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);
    assert.match(outOrch, /\[规划精简\]/);
    assert.match(outOrch, /exit_plan_mode/);
    assert.match(outOrch, /turn-1\.md/);

    // 跨轮场景：第 1 轮曾 Plan mode is off，第 2 轮新 USER_INPUT 后进入 Plan mode is on 且最终步骤缺失 model
    const multiTurnRows = [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 第一轮\n</USER_REQUEST>' },
      { step_index: 2, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: worker turn' },
      { step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-flash-worker-agy', content: 'done' },
      { step_index: 4, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 第二轮规划\n</USER_REQUEST>' },
      { step_index: 5, type: 'SYSTEM_MESSAGE', content: 'Plan mode is on: planning turn' },
    ];
    for (let i = 6; i < 60; i += 1) {
      multiTurnRows.push({ step_index: i, type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-high', content: `step ${i}` });
    }
    multiTurnRows.push({
      step_index: 60,
      type: 'PLANNER_RESPONSE',
      output_tokens: 500,
      content: "This request was blocked by Gemini's filters.",
    });
    writeTranscript(transcript, multiTurnRows);
    const outLongPm = runHook(RETRY, { transcriptPath: transcript, conversationId: 'pm-long' }, sb.env);
    assert.match(outLongPm, /\[规划精简\]/);
    assert.match(outLongPm, /exit_plan_mode/);
  });

  it('普通落盘执行 2 档分级、错峰补注、熔断停机与正常回合清理', () => {
    const sb = newSandbox();
    const transcript = join(sb.root, 't.jsonl');

    runHook(NOTICE, {
      conversationId: 'selftest',
      lastUserInput: '查看 ~/agy-notes/selftest-bind/status.md',
    }, sb.env);

    writeTranscript(transcript, [{ step_index: 4, output_tokens: 90, input_tokens: 21000, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    assert.match(runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env), /\[重写\]/);

    writeTranscript(transcript, [{ step_index: 5, output_tokens: 90, input_tokens: 21000, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    const r2 = runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);
    assert.match(r2, /\[落盘\]/);
    assert.match(r2, /write_file/);
    assert.match(r2, /turn-1\.md/);

    assert.equal(runHook(NOTICE, { conversationId: 'selftest', lastUserInput: '执行下一步' }, sb.env), '{}');
    assert.match(runHook(NOTICE, { conversationId: 'selftest', lastUserInput: '执行下一步' }, sb.env), /\[落盘模式\]/);

    writeTranscript(transcript, [{ step_index: 6, output_tokens: 90, input_tokens: 21000, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    assert.equal(runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env), '{}');

    writeTranscript(transcript, [{ step_index: 7, content: 'hello' }]);
    assert.equal(runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env), '{}');
    const st = JSON.parse(readFileSync(join(sb.dataDir, '.filter-retry-state.json'), 'utf-8')).selftest;
    assert.equal(Object.hasOwn(st, 'tries'), false);
    assert.equal(Object.hasOwn(st, 'dead'), false);
    assert.equal(st.alias_injected, true);
  });

  it('升级防空转：重复重发拦下、/compact 自动解锁、全新指令放行一次、撤回重置与零输出熔断', () => {
    const sb = newSandbox();
    const transcript = join(sb.root, 't.jsonl');

    runHook(NOTICE, {
      conversationId: 'selftest',
      lastUserInput: '/note-offload 读取 ~/agy-notes/selftest-ws/task.md 执行阶段2',
    }, sb.env);

    writeTranscript(transcript, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 读取 ~/agy-notes/selftest-ws/task.md 执行阶段2\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', output_tokens: 1200, content: "This request was blocked by Gemini's filters." },
    ]);
    runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);
    writeTranscript(transcript, [{ step_index: 3, output_tokens: 90, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);
    writeTranscript(transcript, [{ step_index: 4, output_tokens: 90, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env);

    const repOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'selftest',
      initialNumSteps: 10,
      lastUserInput: '/note-offload 读取 ~/agy-notes/selftest-ws/task.md 执行阶段2',
    }, sb.env));
    assert.equal(repOut.terminationBehavior, 'terminate');
    assert.match(repOut.injectSteps[0].systemMessage.metadata.user_markdown, /重复重发/);

    // /compact 放行且自动解除熔断，后续「继续」不再被拦截
    assert.equal(runHook(NOTICE, { conversationId: 'selftest', initialNumSteps: 10, lastUserInput: '/compact' }, sb.env), '{}');
    assert.equal(runHook(NOTICE, { conversationId: 'selftest', initialNumSteps: 11, lastUserInput: '继续' }, sb.env), '{}');

    // 重新模拟熔断，测试全新指令放行一次
    const stateFile = join(sb.dataDir, '.filter-retry-state.json');
    writeFileSync(stateFile, JSON.stringify({
      selftest: { step: 12, tries: 3, dead: true, offload_mode: true, alias_injected: true, notified: false, ts: Date.now() / 1000 },
    }));

    const newOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'selftest',
      initialNumSteps: 14,
      lastUserInput: '改为本地离线统计文件行数，不再执行远端请求',
    }, sb.env));
    assert.equal(newOut.terminationBehavior, undefined);
    assert.equal(newOut.injectSteps[0].systemMessage.systemMessage, '');

    // 撤回重发
    writeFileSync(stateFile, JSON.stringify({ selftest: { step: 98, tries: 3, dead: true, offload_mode: true, ts: Date.now() / 1000 } }));
    assert.equal(runHook(NOTICE, { conversationId: 'selftest', initialNumSteps: 29, lastUserInput: '继续' }, sb.env), '{}');

    writeFileSync(stateFile, JSON.stringify({ selftest: { step: 98, tries: 3, dead: true, offload_mode: true, ts: Date.now() / 1000 } }));
    writeTranscript(transcript, [{ step_index: 64, output_tokens: 90, thinking: 't', content: "This request was blocked by Gemini's filters." }]);
    assert.match(runHook(RETRY, { transcriptPath: transcript, conversationId: 'selftest' }, sb.env), /"decision":"continue"/);

    // 连续 2 次零输出立即熔断
    runHook(NOTICE, { conversationId: 'zero1', lastUserInput: '/note-offload 零输出测试' }, sb.env);
    writeTranscript(transcript, [{ step_index: 4, content: "This request was blocked by Gemini's filters." }]);
    assert.match(runHook(RETRY, { transcriptPath: transcript, conversationId: 'zero1' }, sb.env), /"decision":"continue"/);
    writeTranscript(transcript, [{ step_index: 5, content: "This request was blocked by Gemini's filters." }]);
    assert.equal(runHook(RETRY, { transcriptPath: transcript, conversationId: 'zero1' }, sb.env), '{}');
  });

  it('/note-offload 精准触发负例不误判，静默工作台绑定保留指向', () => {
    const sb = newSandbox();
    const stateFile = join(sb.dataDir, '.filter-retry-state.json');

    const negatives = [
      '请查看 skills/note-offload/SKILL.md 与 ~/.gemini/config/plugins/note-offload/',
      '请不要直接调用 `/note-offload` 命令',
      '示例：\n```bash\n/note-offload 读取任务\n```',
      '/note-offload-extra 测试参数',
    ];
    for (const msg of negatives) {
      const out = runHook(NOTICE, { conversationId: 'neg1', lastUserInput: msg }, sb.env);
      assert.equal(out, '{}', `negative triggered: ${msg}`);
    }

    const silentOut = runHook(NOTICE, {
      conversationId: 'silent1',
      lastUserInput: '请检查 ~/agy-notes/silent-ws/status.md 的进度',
    }, sb.env);
    assert.equal(silentOut, '{}');
    const st = JSON.parse(readFileSync(stateFile, 'utf-8')).silent1;
    assert.match(st.note_dir, /\/silent-ws$/);
    assert.equal(Boolean(st.offload_mode), false);
  });
});
