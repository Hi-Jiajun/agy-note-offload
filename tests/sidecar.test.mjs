import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSandbox } from './helpers/sandbox.mjs';

const SIDECAR_DIR = resolve('plugin', 'sidecars', 'board');
const SIDECAR_MAIN = join(SIDECAR_DIR, 'main.mjs');
const SHIM_LOADER = resolve('tests', 'helpers', 'register-sidecar-shim.mjs');

const sandboxes = [];

function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

function findSidecarLoader() {
  const realHome = homedir();
  const candidates = [
    join(realHome, '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'register_loader.js'),
    join(realHome, '.gemini', 'config', 'node_modules', 'sidecar_sdk', 'register_loader.js'),
  ];
  for (const cand of candidates) {
    if (existsSync(cand)) return pathToFileURL(cand).href;
  }
  return pathToFileURL(SHIM_LOADER).href;
}

async function reqJson(base, token, method, path, body = null, useToken = true) {
  const headers = {};
  if (useToken) headers['x-sidecar-token'] = token;
  let payload;
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const resp = await fetch(`${base}${path}`, { method, headers, body: payload });
  return { status: resp.status, text: await resp.text() };
}

afterEach(() => {
  while (sandboxes.length > 0) {
    sandboxes.pop().cleanup();
  }
});

describe('Sidecar 后端契约（实测 sidecar_sdk）与前端安全检查', () => {
  it('HTTP 鉴权、分片大文件预览、knownSig 去重、风险确认编辑、配置更新与冲突检测全通过', async () => {
    const sb = createSandbox();
    sandboxes.push(sb);

    const port = await getFreePort();
    const token = 'selftest-token-123';
    const loaderHref = findSidecarLoader();

    const child = spawn(process.execPath, ['--import', loaderHref, SIDECAR_MAIN], {
      cwd: SIDECAR_DIR,
      env: {
        ...sb.env,
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
        ANTIGRAVITY_CSRF_TOKEN: 'selftest-csrf',
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let i = 0; i < 40; i += 1) {
        try {
          const r = await reqJson(base, token, 'GET', '/', null, false);
          if (r.status === 200 && r.text.includes('/preload.js')) {
            ready = true;
            break;
          }
        } catch {
          await new Promise((r) => setTimeout(r, 80));
        }
      }
      assert.equal(ready, true, 'sidecar server failed to start');

      // 1. 鉴权与方法限制
      assert.equal((await reqJson(base, token, 'POST', '/api/workspace/init', { name: 'ws1' }, false)).status, 401);
      assert.equal((await reqJson(base, token, 'POST', '/api/snapshot', {}, false)).status, 401);
      assert.equal((await reqJson(base, token, 'POST', '/api/file', { workspace: 'ws1', file: 'task.md' }, false)).status, 401);
      assert.equal((await reqJson(base, token, 'GET', '/api/snapshot', null, false)).status, 405);
      assert.equal((await reqJson(base, token, 'GET', '/styles.css', null, false)).status, 200);
      assert.equal((await reqJson(base, token, 'GET', '/app.js', null, false)).status, 200);
      assert.equal((await reqJson(base, token, 'GET', '/preload.js', null, false)).status, 200);

      const badJson = await reqJson(base, token, 'POST', '/api/workspace/init', '{bad json', true);
      assert.equal(badJson.status >= 400, true);

      // 2. 工作台读写及扩充后缀支持
      const initRes = await reqJson(base, token, 'POST', '/api/workspace/init', { name: 'ws1', taskContent: '# T1\nhello\n' });
      assert.equal(initRes.status, 200);
      assert.equal(JSON.parse(initRes.text).ok, true);

      const saveRes = await reqJson(base, token, 'POST', '/api/workspace/save', {
        workspace: 'ws1',
        file: 'task.md',
        content: '# T1 updated\n',
      });
      assert.equal(saveRes.status, 200);

      const fileRes = await reqJson(base, token, 'POST', '/api/file', { workspace: 'ws1', file: 'task.md' });
      assert.equal(fileRes.status, 200);
      const fileData = JSON.parse(fileRes.text);
      assert.equal(fileData.content, '# T1 updated\n');
      assert.equal(fileData.directEditable, true);

      // knownSig 未变不重传
      const sameRes = await reqJson(base, token, 'POST', '/api/file', {
        workspace: 'ws1',
        file: 'task.md',
        knownSig: fileData.sig,
      });
      assert.equal(sameRes.status, 200);
      assert.equal(JSON.parse(sameRes.text).unchanged, true);

      // 新增 .csv/.yaml/.diff 文件可见与风险确认解锁编辑
      writeFileSync(join(sb.noteRoot, 'ws1', 'metrics.csv'), 'a,b\n1,2\n', 'utf-8');
      writeFileSync(join(sb.noteRoot, 'ws1', 'patch.diff'), '--- a\n+++ b\n', 'utf-8');
      writeFileSync(join(sb.noteRoot, 'ws1', 'turn-1.md'), 'frozen', 'utf-8');

      assert.equal(
        (await reqJson(base, token, 'POST', '/api/workspace/save', {
          workspace: 'ws1',
          file: 'turn-1.md',
          content: 'without-confirm',
        })).status,
        403,
      );
      assert.equal(
        (await reqJson(base, token, 'POST', '/api/workspace/save', {
          workspace: 'ws1',
          file: 'turn-1.md',
          content: 'confirmed-edit',
          confirmRisk: true,
        })).status,
        200,
      );
      assert.equal(readFileSync(join(sb.noteRoot, 'ws1', 'turn-1.md'), 'utf-8'), 'confirmed-edit');

      assert.equal(
        (await reqJson(base, token, 'POST', '/api/workspace/save', {
          workspace: 'ws1',
          file: 'turn-1.md',
          content: 'chunk-truncate',
          chunked: true,
          confirmRisk: true,
        })).status,
        400,
      );

      // 3. > 1 MB 大文件分片浏览与 mode: 'full' 完整加载（无 413 拒读）
      const bigSize = 1_200_000;
      const bigContent = `${'A'.repeat(262_144)}${'B'.repeat(bigSize - 262_144)}`;
      writeFileSync(join(sb.noteRoot, 'ws1', 'huge.log'), bigContent, 'utf-8');

      const chunk0 = JSON.parse((await reqJson(base, token, 'POST', '/api/file', {
        workspace: 'ws1',
        file: 'huge.log',
      })).text);
      assert.equal(chunk0.chunked, true);
      assert.equal(chunk0.offset, 0);
      assert.equal(chunk0.length, 262_144);
      assert.equal(chunk0.hasPrev, false);
      assert.equal(chunk0.hasNext, true);
      assert.equal(chunk0.canForceFull, true);
      assert.equal(chunk0.content.startsWith('AAAA'), true);

      const chunk1 = JSON.parse((await reqJson(base, token, 'POST', '/api/file', {
        workspace: 'ws1',
        file: 'huge.log',
        offset: 262_144,
      })).text);
      assert.equal(chunk1.chunked, true);
      assert.equal(chunk1.hasPrev, true);
      assert.equal(chunk1.content.startsWith('BBBB'), true);

      const fullData = JSON.parse((await reqJson(base, token, 'POST', '/api/file', {
        workspace: 'ws1',
        file: 'huge.log',
        mode: 'full',
      })).text);
      assert.equal(fullData.chunked, false);
      assert.equal(fullData.content.length, bigSize);
      assert.equal(fullData.confirmEditable, true);

      assert.equal(
        (await reqJson(base, token, 'POST', '/api/file', { workspace: '../etc', file: 'passwd' })).status,
        400,
      );

      // 4. 别名增删、可选项更新、冲突回显与状态重置
      const upHex = await reqJson(base, token, 'POST', '/api/alias/upsert', {
        key: 'deadbeef',
        value: 'https://hex.example.com',
        note: 'hex',
      });
      assert.equal(upHex.status, 200);

      const cfgRes = JSON.parse((await reqJson(base, token, 'POST', '/api/config/update', {
        sanitizeEnabled: true,
        aliasEnabled: true,
      })).text);
      assert.equal(cfgRes.ok, true);
      assert.deepEqual(cfgRes.config, { sanitizeEnabled: true, aliasEnabled: true });
      assert.equal(cfgRes.conflicts.some((c) => c.code === 'alias_hex8_control_tower'), true);

      const delAlias = await reqJson(base, token, 'POST', '/api/alias/delete', { key: 'deadbeef' });
      assert.equal(delAlias.status, 200);
      assert.equal(JSON.parse(delAlias.text).aliases.some((a) => a.key === 'deadbeef'), false);

      writeFileSync(
        join(sb.dataDir, '.filter-retry-state.json'),
        JSON.stringify({
          deadconv1234: { tries: 3, dead: true, dead_reason: 'max_retry', ts: Date.now() / 1000 },
        }),
      );
      const snap1 = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snap1.workspaces.length, 1);
      assert.equal(snap1.workspaces[0].files.includes('metrics.csv'), true);
      assert.equal(snap1.workspaces[0].files.includes('patch.diff'), true);
      assert.equal(snap1.trackedSessions[0].dead, true);
      assert.deepEqual(snap1.config, { sanitizeEnabled: true, aliasEnabled: true });

      assert.equal((await reqJson(base, token, 'POST', '/api/state/reset', { conversationId: 'deadconv1234' })).status, 200);
      const snap2 = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snap2.trackedSessions[0].dead, false);

      // 5. 空目录清理
      mkdirSync(join(sb.noteRoot, 'empty-ws'), { recursive: true });
      const cleanRes = JSON.parse((await reqJson(base, token, 'POST', '/api/workspace/clean', {})).text);
      assert.equal(cleanRes.removedCount, 1);
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('前端不含会导致 flash 降级的 startConversation、无间隔号且启用分片/增量刷新/风险确认', () => {
    const html = readFileSync(join(SIDECAR_DIR, 'index.html'), 'utf-8');
    const appJs = readFileSync(join(SIDECAR_DIR, 'app.js'), 'utf-8');
    assert.equal(html.includes('btn-start-conv'), false);
    assert.equal(appJs.includes('startConversation'), false);
    assert.equal(html.includes('·') || appJs.includes('·'), false);
    assert.equal(appJs.includes('visibilitychange'), true);
    assert.equal(appJs.includes('computeSnapshotSig'), true);
    assert.equal(appJs.includes('knownSig'), true);
    assert.equal(appJs.includes('confirmRisk'), true);
  });
});
