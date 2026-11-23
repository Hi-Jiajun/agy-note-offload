import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createSandbox } from './helpers/sandbox.mjs';

const PLUGIN_DIR = resolve('plugin');
const AGYNOTE = join(PLUGIN_DIR, 'scripts', 'agynote.mjs');
const AGYSUM = join(PLUGIN_DIR, 'scripts', 'agysum.mjs');
const NETURL = join(PLUGIN_DIR, 'scripts', 'neturl.mjs');

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

describe('CLI 脚本：agynote / agysum / neturl', () => {
  it('agynote init/show/status/clean/config/doctor 正常工作', () => {
    const sb = newSandbox();
    const initOut = execFileSync(process.execPath, [AGYNOTE, 'init', 'ws-demo', '-'], {
      input: '# 测试任务\n',
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(initOut, /task\.md, status\.md/);

    const showOut = execFileSync(process.execPath, [AGYNOTE, 'show', 'ws-demo'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(showOut, /进度看板/);

    mkdirSync(join(sb.noteRoot, 'empty-dir'), { recursive: true });
    const statusOut = execFileSync(process.execPath, [AGYNOTE, 'status'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(statusOut, /ws-demo/);

    const cleanOut = execFileSync(process.execPath, [AGYNOTE, 'clean'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(cleanOut, /删除 1 个空目录/);
    assert.equal(existsSync(join(sb.noteRoot, 'empty-dir')), false);
    assert.equal(existsSync(join(sb.noteRoot, 'ws-demo')), true);

    const cfgDefault = execFileSync(process.execPath, [AGYNOTE, 'config'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(cfgDefault, /sanitizeEnabled=off, aliasEnabled=off/);

    execFileSync(process.execPath, [NETURL, '--set', 'deadbeef', 'https://hex.example.com', 'hex'], { env: sb.env });
    const cfgOn = execFileSync(process.execPath, [AGYNOTE, 'config', '--sanitize', 'on', '--alias', 'on'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(cfgOn, /sanitizeEnabled=on, aliasEnabled=on/);
    assert.match(cfgOn, /alias_hex8_control_tower/);

    const docOut = execFileSync(process.execPath, [AGYNOTE, 'doctor'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(docOut, /已配置真实别名数: [1-9]\d*/);
    assert.match(docOut, /alias_hex8_control_tower/);

    // 测试完整配置中心参数与 --reset 一键恢复默认
    const cfgExt = JSON.parse(execFileSync(process.execPath, [
      AGYNOTE, 'config', '--orch-confirm', 'per_session', '--max-retry', '4', '--retry-window', '30', '--json',
    ], { env: sb.env, encoding: 'utf-8' }));
    assert.equal(cfgExt.config.orchestratorConfirm, 'per_session');
    assert.equal(cfgExt.config.maxRetry, 4);
    assert.equal(cfgExt.config.retryWindowMin, 30);

    const cfgReset = JSON.parse(execFileSync(process.execPath, [AGYNOTE, 'config', '--reset', '--json'], {
      env: sb.env,
      encoding: 'utf-8',
    }));
    assert.equal(cfgReset.config.orchestratorConfirm, 'once');
    assert.equal(cfgReset.config.maxRetry, 2);
    assert.equal(cfgReset.config.sanitizeEnabled, false);

    // 测试多会话 show、status --dead/--filter/--archived/--json、reset 与逻辑/物理归档
    writeFileSync(join(sb.dataDir, '.filter-retry-state.json'), JSON.stringify({
      'aa112233-dead-conv': {
        step: 15,
        tries: 3,
        dead: true,
        dead_reason: 'max_retry',
        note_dir: '~/agy-notes/ws-demo',
        ts: Date.now() / 1000,
      },
      'bb445566-hist-conv': {
        step: 4,
        offload_mode: true,
        note_dir: '~/agy-notes/ws-demo',
        ts: Date.now() / 1000 - 120,
      },
    }), 'utf-8');

    const showMulti = execFileSync(process.execPath, [AGYNOTE, 'show', 'ws-demo'], { env: sb.env, encoding: 'utf-8' });
    assert.match(showMulti, /关联会话 \(2\)/);
    assert.match(showMulti, /aa112233/);
    assert.match(showMulti, /bb445566/);

    const deadJson = JSON.parse(execFileSync(process.execPath, [AGYNOTE, 'status', '--dead', '--json'], {
      env: sb.env,
      encoding: 'utf-8',
    }));
    assert.equal(deadJson.workspaces.length, 1);
    assert.equal(deadJson.workspaces[0].name, 'ws-demo');

    const resetOut = JSON.parse(execFileSync(process.execPath, [AGYNOTE, 'reset', 'aa112233', '--json'], {
      env: sb.env,
      encoding: 'utf-8',
    }));
    assert.equal(resetOut.ok, true);
    assert.equal(resetOut.conversationId, 'aa112233-dead-conv');

    // 逻辑归档默认隐藏，加 --archived 可见
    execFileSync(process.execPath, [AGYNOTE, 'archive', 'ws-demo'], { env: sb.env, encoding: 'utf-8' });
    assert.equal(existsSync(join(sb.noteRoot, 'ws-demo', 'status.md')), true);
    const hiddenStatus = JSON.parse(execFileSync(process.execPath, [AGYNOTE, 'status', '--json'], {
      env: sb.env,
      encoding: 'utf-8',
    }));
    assert.equal(hiddenStatus.workspaces.length, 0);
    assert.equal(hiddenStatus.hiddenArchivedCount, 1);
    const shownArch = JSON.parse(execFileSync(process.execPath, [AGYNOTE, 'status', '--archived', '--json'], {
      env: sb.env,
      encoding: 'utf-8',
    }));
    assert.equal(shownArch.workspaces.length, 1);
    assert.equal(shownArch.workspaces[0].archived, true);

    execFileSync(process.execPath, [AGYNOTE, 'unarchive', 'ws-demo'], { env: sb.env, encoding: 'utf-8' });
    // 物理移动归档与恢复
    execFileSync(process.execPath, [AGYNOTE, 'archive', 'ws-demo', '--move'], { env: sb.env, encoding: 'utf-8' });
    assert.equal(existsSync(join(sb.noteRoot, '_archive', 'ws-demo', 'status.md')), true);
    execFileSync(process.execPath, [AGYNOTE, 'unarchive', 'ws-demo'], { env: sb.env, encoding: 'utf-8' });
    assert.equal(existsSync(join(sb.noteRoot, 'ws-demo', 'status.md')), true);
  });

  it('agysum 支持跨三端 brain 寻址、损坏行容错、修改文件页脚、尾部分块快读及 --tools/--search/--json', () => {
    const sb = newSandbox();
    const cliConvDir = join(sb.brainDirs[1], 'cli12345-aaaa', '.system_generated', 'logs');
    mkdirSync(cliConvDir, { recursive: true });
    const transcript = join(cliConvDir, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: '<USER_REQUEST> 查一下 </USER_REQUEST>' }),
        '{broken json',
        '123',
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          content: '答案正文2 关键字TARGET_HIT',
          tool_calls: [
            { name: 'write_file', arguments: { Path: join(sb.noteRoot, 'ws-demo', 'turn-1.md') } },
            { name: 'run_command', arguments: { CommandLine: 'npm test' } },
          ],
        }),
        JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', content: "This request was blocked by Gemini's filters." }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const out = execFileSync(process.execPath, [AGYSUM, 'cli12345', '--width', '40'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(out, /M3: 答案正文2/);
    assert.match(out, /被拦 1 次（跳过 2 行损坏记录）/);
    assert.match(out, /# 修改文件 \(1 项\):.*turn-1\.md/);

    const toolsOut = execFileSync(process.execPath, [AGYSUM, 'cli12345', '--tools'], {
      env: sb.env,
      encoding: 'utf-8',
    });
    assert.match(toolsOut, /\[tools\].*write_file.*run_command\(npm test\)/);

    const searchJson = JSON.parse(execFileSync(process.execPath, [
      AGYSUM, 'cli12345', '--search', 'target_hit', '--tools', '--json',
    ], { env: sb.env, encoding: 'utf-8' }));
    assert.equal(searchJson.matchedSteps, 1);
    assert.equal(searchJson.steps[0].step, 3);
    assert.equal(searchJson.modifiedFiles.length, 1);

    // 验证 > 512 KB 大日志尾部分块快读
    const bigPath = join(sb.root, 'big-transcript.jsonl');
    const bigRows = [];
    const pad = 'X'.repeat(6000);
    for (let i = 1; i <= 110; i += 1) {
      bigRows.push(JSON.stringify({ step_index: i, type: 'PLANNER_RESPONSE', content: `step-${i} ${pad}` }));
    }
    writeFileSync(bigPath, `${bigRows.join('\n')}\n`, 'utf-8');
    const tailJson = JSON.parse(execFileSync(process.execPath, [AGYSUM, bigPath, '--tail', '5', '--json'], {
      env: sb.env,
      encoding: 'utf-8',
    }));
    assert.equal(tailJson.partialRead, true);
    assert.equal(tailJson.returnedSteps, 5);
    assert.equal(tailJson.steps[tailJson.steps.length - 1].step, 110);
  });

  it('neturl 精准查重、拒收保留关键字与隔离读写正常', () => {
    const sb = newSandbox();
    execFileSync(process.execPath, [NETURL, '--set', 'gw.test', 'https://dot.example.com', 'dot'], { env: sb.env });
    execFileSync(process.execPath, [NETURL, '--set', 'gwXtest', 'https://x.example.com', 'x'], { env: sb.env });

    assert.throws(() => {
      execFileSync(process.execPath, [NETURL, '--set', 'gw.test', 'https://dup.example.com', 'dup'], {
        env: sb.env,
        stdio: 'pipe',
      });
    });
    assert.throws(() => {
      execFileSync(process.execPath, [NETURL, '--set', 'bad/key', 'https://bad.example.com'], {
        env: sb.env,
        stdio: 'pipe',
      });
    });
    assert.throws(() => {
      execFileSync(process.execPath, [NETURL, '--set', 'https', 'https://reserved.example.com'], {
        env: sb.env,
        stdio: 'pipe',
      });
    });

    const u1 = execFileSync(process.execPath, [NETURL, 'gw.test', '/ok'], { env: sb.env, encoding: 'utf-8' }).trim();
    const u2 = execFileSync(process.execPath, [NETURL, 'gwXtest', '/ok'], { env: sb.env, encoding: 'utf-8' }).trim();
    assert.equal(u1, 'https://dot.example.com/ok');
    assert.equal(u2, 'https://x.example.com/ok');

    const listOut = execFileSync(process.execPath, [NETURL, '--list'], { env: sb.env, encoding: 'utf-8' });
    assert.match(listOut, /gw\.test\s+dot/);
    assert.doesNotMatch(listOut, /dot\.example\.com/);
  });
});
