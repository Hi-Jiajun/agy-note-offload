import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { upsertAlias } from '../plugin/lib/aliases.mjs';
import { loadConfig, saveConfig } from '../plugin/lib/config.mjs';
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

  it('Orchestrator 默认首启一次性确认 (once)，支持 per_session / 永久确认 / off，且动态阈值生效', () => {
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
    assert.equal(loadConfig(sb.env).orchestratorConfirmedOnce, true);

    // 默认 once 模式下，第二个全新 Orchestrator 会话免重复弹确认卡，直接生效
    const secondSessionOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'orch2',
      modelName: 'gemini-pro-orchestrator-neon',
      lastUserInput: '/note-offload 新会话直接执行',
    }, sb.env));
    assert.equal(secondSessionOut.terminationBehavior, undefined);
    assert.match(secondSessionOut.injectSteps[0].systemMessage.systemMessage, /\[落盘模式\]/);

    // 切回 per_session 后再次弹窗；回复「永久确认」切回 once 并全局记住
    saveConfig({ orchestratorConfirm: 'per_session', orchestratorConfirmedOnce: false }, sb.env);
    const thirdCard = JSON.parse(runHook(NOTICE, {
      conversationId: 'orch3',
      modelName: 'gemini-pro-orchestrator-neon',
      lastUserInput: '/note-offload 第三次测试',
    }, sb.env));
    assert.equal(thirdCard.terminationBehavior, 'terminate');
    const permAccept = JSON.parse(runHook(NOTICE, {
      conversationId: 'orch3',
      modelName: 'gemini-pro-orchestrator-neon',
      lastUserInput: '永久确认',
    }, sb.env));
    assert.equal(permAccept.terminationBehavior, undefined);
    assert.equal(loadConfig(sb.env).orchestratorConfirm, 'once');
    assert.equal(loadConfig(sb.env).orchestratorConfirmedOnce, true);

    // 验证配置中心动态 maxRetry=1 在第 2 次受限时立即熔断
    saveConfig({ maxRetry: 1 }, sb.env);
    const tPath = join(sb.root, 'dyn-retry.jsonl');
    runHook(NOTICE, { conversationId: 'dyn1', lastUserInput: '/note-offload 动态阈值测试' }, sb.env);
    writeTranscript(tPath, [{ step_index: 2, output_tokens: 90, thinking: 'ok', content: "This request was blocked by Gemini's filters." }]);
    assert.match(runHook(RETRY, { transcriptPath: tPath, conversationId: 'dyn1' }, sb.env), /"decision":"continue"/);
    writeTranscript(tPath, [{ step_index: 3, output_tokens: 90, thinking: 'ok', content: "This request was blocked by Gemini's filters." }]);
    assert.equal(runHook(RETRY, { transcriptPath: tPath, conversationId: 'dyn1' }, sb.env), '{}');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf-8')).dyn1.dead_reason, 'max_retry');
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
    const curVer = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf-8')).version;
    writeFileSync(stateFile, JSON.stringify({
      selftest: {
        step: 12,
        tries: 3,
        dead: true,
        offload_mode: true,
        alias_injected: true,
        rule_rev: 2,
        rule_version: `${curVer}#2`,
        notified: false,
        ts: Date.now() / 1000,
      },
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

  it('control-tower 现役总控免静默误绑、显式启用合并零配额确认，且 RULE_REV=2 自动刷新存量会话', () => {
    const sb = newSandbox();
    const stateFile = join(sb.dataDir, '.filter-retry-state.json');
    const wsRepo = join(sb.root, 'ct-repo');
    mkdirSync(join(wsRepo, '.agents'), { recursive: true });
    const ctConv = 'cc001122-aaaa-bbbb-cccc-ddddeeeeffff';
    writeFileSync(
      join(wsRepo, '.agents', 'SESSION-REGISTRY.md'),
      `- **当前现役总控会话**：[\`cc001122\`](conversation://${ctConv}) | 状态：\`ONLINE\`\n`,
      'utf-8',
    );

    // 1. 现役总控单提子任务路径，PreInvocation 跳过不写 state，Stop 也跳过不建目录
    const skipNotice = runHook(NOTICE, {
      conversationId: ctConv,
      workspacePaths: [wsRepo],
      lastUserInput: '请核查 ~/agy-notes/sub-task-1/status.md 并更新台账',
    }, sb.env);
    assert.equal(skipNotice, '{}');
    assert.equal(existsSync(stateFile) ? Object.hasOwn(JSON.parse(readFileSync(stateFile, 'utf-8')), ctConv) : false, false);

    const ctTranscript = join(sb.root, 'ct.jsonl');
    writeTranscript(ctTranscript, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n请核查 ~/agy-notes/sub-task-1/status.md\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', output_tokens: 1200, content: "This request was blocked by Gemini's filters." },
    ]);
    const skipRetry = runHook(RETRY, {
      conversationId: ctConv,
      workspacePaths: [wsRepo],
      transcriptPath: ctTranscript,
    }, sb.env);
    assert.equal(skipRetry, '{}');
    assert.equal(existsSync(join(sb.noteRoot, 'sub-task-1')), false);

    // 2. 现役总控 + Orchestrator 显式启用 /note-offload，合并弹出单张零配额确认卡，回复确认自动补发
    const prompt = '/note-offload 分析当前架构并写入 ~/agy-notes/ct-own/task.md';
    const confirmCard = JSON.parse(runHook(NOTICE, {
      conversationId: ctConv,
      workspacePaths: [wsRepo],
      modelName: 'gemini-pro-orchestrator-neon',
      lastUserInput: prompt,
    }, sb.env));
    assert.equal(confirmCard.terminationBehavior, 'terminate');
    const md = confirmCard.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.match(md, /Orchestrator 模式启用落盘提醒/);
    assert.match(md, /control-tower 现役总控/);

    const accepted = JSON.parse(runHook(NOTICE, {
      conversationId: ctConv,
      workspacePaths: [wsRepo],
      modelName: 'gemini-pro-orchestrator-neon',
      lastUserInput: '确认',
    }, sb.env));
    assert.equal(accepted.terminationBehavior, undefined);
    assert.equal(accepted.injectSteps[0].userMessage, prompt);
    assert.match(accepted.injectSteps[1].systemMessage.systemMessage, /\[落盘模式\]/);

    const stAfter = JSON.parse(readFileSync(stateFile, 'utf-8'))[ctConv];
    assert.equal(stAfter.orch_confirmed, true);
    assert.equal(stAfter.ct_confirmed, true);
    assert.equal(stAfter.rule_rev, 2);

    // 3. 存量旧会话（无 rule_rev 或旧版本 rule_version）自动触发版本感知规则刷新且不重复注入
    const legacyConv = 'leg11223-aaaa-bbbb-cccc-ddddeeeeffff';
    const oldVerConv = 'old21000-aaaa-bbbb-cccc-ddddeeeeffff';
    const cur = JSON.parse(readFileSync(stateFile, 'utf-8'));
    cur[legacyConv] = {
      step: 5,
      offload_mode: true,
      alias_injected: true,
      note_dir: '~/agy-notes/legacy-ws',
      ts: Date.now() / 1000,
    };
    cur[oldVerConv] = {
      step: 5,
      offload_mode: true,
      alias_injected: true,
      rule_rev: 2,
      rule_version: '2.0.0#2',
      note_dir: '~/agy-notes/oldver-ws',
      ts: Date.now() / 1000,
    };
    writeFileSync(stateFile, JSON.stringify(cur));

    const refreshed = JSON.parse(runHook(NOTICE, {
      conversationId: legacyConv,
      initialNumSteps: 10,
      lastUserInput: '继续执行阶段 3',
    }, sb.env));
    assert.match(refreshed.injectSteps[0].systemMessage.systemMessage, /\[落盘模式规则已升级 v[\d.]+\]/);
    const updatedLegacy = JSON.parse(readFileSync(stateFile, 'utf-8'))[legacyConv];
    assert.equal(updatedLegacy.rule_rev, 2);
    assert.match(updatedLegacy.rule_version, /^[\d.]+#2$/);

    const secondPass = runHook(NOTICE, {
      conversationId: legacyConv,
      initialNumSteps: 12,
      lastUserInput: '再核对一次',
    }, sb.env);
    assert.equal(secondPass, '{}');

    // 旧版本号会话在发版升级后也自动刷新一次
    const verRefreshed = JSON.parse(runHook(NOTICE, {
      conversationId: oldVerConv,
      initialNumSteps: 10,
      lastUserInput: '继续分析',
    }, sb.env));
    assert.match(verRefreshed.injectSteps[0].systemMessage.systemMessage, /\[落盘模式规则已升级 v[\d.]+\]/);
    assert.equal(runHook(NOTICE, {
      conversationId: oldVerConv,
      initialNumSteps: 12,
      lastUserInput: '再检查一次',
    }, sb.env), '{}');
  });

  it('新版双阶段 Orchestrator 识别、跨轮 Plan Mode 自动重置、enter_plan_mode 与总控首轮交接防误绑', () => {
    const sb = newSandbox();
    const stateFile = join(sb.dataDir, '.filter-retry-state.json');

    // 1. 新版轨迹无 orchestrator 字样：USER_SETTINGS_CHANGE Gemini 4 Neon + exit_plan_mode + Plan mode is off + Hydrogen
    const dualTranscript = join(sb.root, 'dual-phase.jsonl');
    writeTranscript(dualTranscript, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_SETTINGS_CHANGE>\nModel Selection: from None to Gemini 4 Neon (XHigh)\n</USER_SETTINGS_CHANGE>' },
      { step_index: 2, type: 'USER_INPUT', content: '<USER_REQUEST>\n规划阶段\n</USER_REQUEST>' },
      { step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', tool_calls: [{ name: 'exit_plan_mode' }] },
      { step_index: 4, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: this turn runs on the execution model.' },
      { step_index: 5, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-high', content: 'executing' },
    ]);

    const cardOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'neworch1',
      transcriptPath: dualTranscript,
      lastUserInput: '/note-offload 开始新一轮任务',
    }, sb.env));
    assert.equal(cardOut.terminationBehavior, 'terminate');
    assert.match(cardOut.injectSteps[0].systemMessage.metadata.user_markdown, /Orchestrator 模式启用落盘提醒/);

    const confirmOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'neworch1',
      transcriptPath: dualTranscript,
      lastUserInput: '确认',
    }, sb.env));
    assert.match(confirmOut.injectSteps[1].systemMessage.systemMessage, /enter_plan_mode/);

    // 若随后切到非双阶段单模型（无后续 exit/enter/Plan mode 标记），PreInvocation 不再判定为 Orchestrator
    saveConfig({ orchestratorConfirm: 'per_session', orchestratorConfirmedOnce: false }, sb.env);
    const switchedTranscript = join(sb.root, 'switched-single.jsonl');
    writeTranscript(switchedTranscript, [
      { step_index: 1, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: this turn runs on the execution model.' },
      { step_index: 2, type: 'USER_INPUT', content: '<USER_SETTINGS_CHANGE>\nModel Selection: from Gemini 4 Neon to Gemini 4 Flash\n</USER_SETTINGS_CHANGE>' },
      { step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-flash', content: 'plain single model' },
    ]);
    const switchedOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'switched1',
      transcriptPath: switchedTranscript,
      lastUserInput: '/note-offload 普通模型执行',
    }, sb.env));
    assert.equal(switchedOut.terminationBehavior, undefined);
    assert.match(switchedOut.injectSteps[0].systemMessage.systemMessage, /\[落盘模式\]/);

    // 2. Stop: Turn 2 新 USER_INPUT 自动回到 Plan Mode（无 Plan mode is on），Neon 被阻断走 [规划精简]
    const turn2ResetT = join(sb.root, 'turn2-reset.jsonl');
    writeTranscript(turn2ResetT, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload Turn1\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', tool_calls: [{ name: 'exit_plan_mode' }] },
      { step_index: 3, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: this turn runs on the execution model.' },
      { step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-high', content: 'turn 1 complete' },
      { step_index: 5, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload Turn2 新需求\n</USER_REQUEST>' },
      { step_index: 6, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', output_tokens: 720, content: "This request was blocked by Gemini's filters." },
    ]);
    const turn2Out = runHook(RETRY, { transcriptPath: turn2ResetT, conversationId: 'new-pm-t2' }, sb.env);
    assert.match(turn2Out, /\[规划精简\]/);
    assert.match(turn2Out, /exit_plan_mode/);

    // 3. Stop: 执行模型 gemini-4-hydrogen-high 在 Plan mode is off 后受限 -> Tier 1/2，而非 [规划精简]
    const execBlockT = join(sb.root, 'exec-block.jsonl');
    writeTranscript(execBlockT, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 执行\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', tool_calls: [{ name: 'exit_plan_mode' }] },
      { step_index: 3, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: this turn runs on the execution model.' },
      { step_index: 4, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-high', output_tokens: 300, thinking: 't', content: "This request was blocked by Gemini's filters." },
    ]);
    const execOut = runHook(RETRY, { transcriptPath: execBlockT, conversationId: 'new-exec-1' }, sb.env);
    assert.match(execOut, /\[重写\]|\[落盘\]/);
    assert.doesNotMatch(execOut, /\[规划精简\]/);

    // 4. Stop: enter_plan_mode -> [plan review] Plan mode is on -> [规划精简]
    const revT = join(sb.root, 'rev-block.jsonl');
    writeTranscript(revT, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 复核\n</USER_REQUEST>' },
      { step_index: 2, type: 'SYSTEM_MESSAGE', content: 'Plan mode is off: this turn runs on the execution model.' },
      { step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-high', tool_calls: [{ name: 'enter_plan_mode' }] },
      { step_index: 4, type: 'SYSTEM_MESSAGE', content: '[plan review] Plan mode is on: this turn runs on the planning model.' },
      { step_index: 5, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', output_tokens: 680, content: "This request was blocked by Gemini's filters." },
    ]);
    assert.match(runHook(RETRY, { transcriptPath: revT, conversationId: 'new-rev-1' }, sb.env), /\[规划精简\]/);

    // 5. Stop: 纯单模型 gemini-4-neon-xhigh（无任何双阶段信号）不误判 Plan Mode
    const plainSingleT = join(sb.root, 'plain-neon.jsonl');
    writeTranscript(plainSingleT, [
      { step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST>\n/note-offload 普通单模型\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', output_tokens: 300, thinking: 't', content: "This request was blocked by Gemini's filters." },
    ]);
    const plainOut = runHook(RETRY, { transcriptPath: plainSingleT, conversationId: 'plain-neon-1' }, sb.env);
    assert.match(plainOut, /\[重写\]/);
    assert.doesNotMatch(plainOut, /\[规划精简\]/);

    // 6. control-tower step-0 换届接班（台账尚指向前任 ID）豁免静默误绑，同工作区普通子任务仍正常静默绑定，显式 /note-offload 弹确认卡
    const wsRepo = join(sb.root, 'ct-handover-ws');
    mkdirSync(join(wsRepo, '.agents'), { recursive: true });
    const prevCt = 'prev0001-aaaa-bbbb-cccc-ddddeeeeffff';
    const nextCt = 'a3e9fff2-1111-2222-3333-444455556666';
    writeFileSync(
      join(wsRepo, '.agents', 'SESSION-REGISTRY.md'),
      `- **当前现役总控会话**：[\`prev0001\`](conversation://${prevCt}) | 状态：\`ONLINE\`\n`,
      'utf-8',
    );
    const step0Out = runHook(NOTICE, {
      conversationId: nextCt,
      workspacePaths: [wsRepo],
      lastUserInput: '请先接管常驻主交流总控，先读前任交接 ~/agy-notes/prev0001/handover.md 再更新台账',
    }, sb.env);
    assert.equal(step0Out, '{}');
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(stateFile, 'utf-8')), nextCt), false);

    const subTaskOut = runHook(NOTICE, {
      conversationId: 'subw0001-1111-2222-3333-444455556666',
      workspacePaths: [wsRepo],
      lastUserInput: '请执行子任务并更新 ~/agy-notes/sub-work/status.md',
    }, sb.env);
    assert.equal(subTaskOut, '{}');
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(stateFile, 'utf-8')), 'subw0001-1111-2222-3333-444455556666'), true);

    const explicitHandoverCard = JSON.parse(runHook(NOTICE, {
      conversationId: nextCt,
      workspacePaths: [wsRepo],
      lastUserInput: '/note-offload 以常驻主交流总控身份强制开启落盘',
    }, sb.env));
    assert.equal(explicitHandoverCard.terminationBehavior, 'terminate');
    assert.match(explicitHandoverCard.injectSteps[0].systemMessage.metadata.user_markdown, /control-tower 现役总控/);
  });

  it('中后段回退保留落盘态且不重注规则、非受限 Stop 回退不丢状态，回退至启用步数及之前才重置', () => {
    const sb = newSandbox();
    const stateFile = join(sb.dataDir, '.filter-retry-state.json');
    const transcript = join(sb.root, 'rewind-boundary.jsonl');

    // 1. step 10 开启并绑定命名工作台，模拟推到 step 30 且经历过重试/熔断
    const firstOut = JSON.parse(runHook(NOTICE, {
      conversationId: 'rw-mid-1',
      initialNumSteps: 10,
      lastUserInput: '/note-offload 分析 ~/agy-notes/rw-ws/task.md',
    }, sb.env));
    assert.match(firstOut.injectSteps[0].systemMessage.systemMessage, /\[落盘模式\]/);

    const st0 = JSON.parse(readFileSync(stateFile, 'utf-8'));
    st0['rw-mid-1'].step = 30;
    st0['rw-mid-1'].tries = 2;
    st0['rw-mid-1'].dead = true;
    st0['rw-mid-1'].dead_reason = 'max_retry';
    writeFileSync(stateFile, JSON.stringify(st0));

    // 中后段回退至 step 25（> 10）：清 tries/dead，不重注规则，保留 offload_mode 与 note_dir
    assert.equal(runHook(NOTICE, {
      conversationId: 'rw-mid-1',
      initialNumSteps: 25,
      lastUserInput: '继续看下一文件',
    }, sb.env), '{}');
    const stMid = JSON.parse(readFileSync(stateFile, 'utf-8'))['rw-mid-1'];
    assert.equal(stMid.offload_mode, true);
    assert.equal(stMid.alias_injected, true);
    assert.equal(stMid.offload_step, 10);
    assert.equal(stMid.tries, undefined);
    assert.equal(stMid.dead, undefined);
    assert.match(stMid.note_dir, /\/rw-ws$/);

    // 紧接着在 step 26 受限，Stop 正常自动续跑
    writeTranscript(transcript, [{
      step_index: 26,
      type: 'PLANNER_RESPONSE',
      output_tokens: 300,
      thinking: 't',
      content: "This request was blocked by Gemini's filters.",
    }]);
    assert.match(runHook(RETRY, { conversationId: 'rw-mid-1', transcriptPath: transcript }, sb.env), /"decision":"continue"/);

    // 2. 非受限 Stop 发生中后段回退（step 20 < 26，且 > offload_step 10）：保留 offload_mode 与 note_dir 并清 tries
    writeTranscript(transcript, [{
      step_index: 20,
      type: 'PLANNER_RESPONSE',
      content: 'normal finished',
    }]);
    assert.equal(runHook(RETRY, { conversationId: 'rw-mid-1', transcriptPath: transcript }, sb.env), '{}');
    const stFast = JSON.parse(readFileSync(stateFile, 'utf-8'))['rw-mid-1'];
    assert.equal(stFast.offload_mode, true);
    assert.equal(stFast.offload_step, 10);
    assert.equal(stFast.tries, undefined);

    // 3. 受限 Stop 若回退至 offload_step 之前（step 5 < 10）：清空 offload_mode（未再带指令则不续跑）
    stFast.step = 20;
    writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf-8')), 'rw-mid-1': stFast }));
    writeTranscript(transcript, [{
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      output_tokens: 300,
      thinking: 't',
      content: "This request was blocked by Gemini's filters.",
    }]);
    assert.equal(runHook(RETRY, { conversationId: 'rw-mid-1', transcriptPath: transcript }, sb.env), '{}');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf-8'))['rw-mid-1'], undefined);

    // 4. 在 step 0 启用后回退至 step 0 且保留 /note-offload -> 重新注入一次规则；去掉 /note-offload -> 清理状态
    assert.match(runHook(NOTICE, {
      conversationId: 'rw-zero-1',
      initialNumSteps: 0,
      lastUserInput: '/note-offload 首轮任务',
    }, sb.env), /\[落盘模式\]/);
    writeTranscript(transcript, [{ step_index: 12, type: 'PLANNER_RESPONSE', content: 'done' }]);
    assert.equal(runHook(RETRY, { conversationId: 'rw-zero-1', transcriptPath: transcript }, sb.env), '{}');

    const replayKeep = JSON.parse(runHook(NOTICE, {
      conversationId: 'rw-zero-1',
      initialNumSteps: 0,
      lastUserInput: '/note-offload 重发首轮任务',
    }, sb.env));
    assert.match(replayKeep.injectSteps[0].systemMessage.systemMessage, /\[落盘模式\]/);

    writeTranscript(transcript, [{ step_index: 4, type: 'PLANNER_RESPONSE', content: 'done' }]);
    assert.equal(runHook(RETRY, { conversationId: 'rw-zero-1', transcriptPath: transcript }, sb.env), '{}');
    assert.equal(runHook(NOTICE, {
      conversationId: 'rw-zero-1',
      initialNumSteps: 0,
      lastUserInput: '去掉开关改成普通对话',
    }, sb.env), '{}');
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf-8'))['rw-zero-1'], undefined);
  });
});
