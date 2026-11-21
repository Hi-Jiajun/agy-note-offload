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
  });

  it('agysum 支持跨三端 brain 寻址及损坏行容错', () => {
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
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', content: '答案正文2' }),
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
