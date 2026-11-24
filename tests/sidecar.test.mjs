import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { touchHookHeartbeat } from '../plugin/lib/logger.mjs';
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
  return { status: resp.status, text: await resp.text(), headers: resp.headers };
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
      const indexRes = await reqJson(base, token, 'GET', '/', null, false);
      assert.equal(indexRes.status, 200);
      assert.equal((indexRes.headers.get('cache-control') || '').includes('no-store'), true);
      assert.equal(/\/styles\.css\?v=\d+/.test(indexRes.text), true);
      assert.equal(/\/app\.js\?v=\d+/.test(indexRes.text), true);

      const cssRes = await reqJson(base, token, 'GET', '/styles.css', null, false);
      assert.equal(cssRes.status, 200);
      assert.equal((cssRes.headers.get('cache-control') || '').includes('no-store'), true);
      assert.equal((await reqJson(base, token, 'GET', '/styles.css?v=2.0.1-ui', null, false)).status, 200);

      const jsRes = await reqJson(base, token, 'GET', '/app.js', null, false);
      assert.equal(jsRes.status, 200);
      assert.equal((jsRes.headers.get('cache-control') || '').includes('no-store'), true);
      assert.equal((await reqJson(base, token, 'GET', '/app.js?v=2.0.1-ui', null, false)).status, 200);

      const logicRes = await reqJson(base, token, 'GET', '/ui-logic.mjs', null, false);
      assert.equal(logicRes.status, 200);
      assert.equal((logicRes.headers.get('cache-control') || '').includes('no-store'), true);

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
        content: [
          '# T1 updated',
          '- [x] done 1',
          '- [ ] todo 1',
          '1. [X] done 2',
          '```md',
          '- [ ] fake todo inside fence',
          '- [x] fake done inside fence',
          '```',
          '',
        ].join('\n'),
      });
      assert.equal(saveRes.status, 200);

      const fileRes = await reqJson(base, token, 'POST', '/api/file', { workspace: 'ws1', file: 'task.md' });
      assert.equal(fileRes.status, 200);
      const fileData = JSON.parse(fileRes.text);
      assert.equal(fileData.content.includes('# T1 updated'), true);
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

      // 4. 别名增删、示例状态标记、可选项更新、冲突回显与状态重置
      const snapBeforeAlias = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snapBeforeAlias.hasRealAliases, false);
      assert.equal(snapBeforeAlias.aliasesIsExample, true);
      assert.equal(snapBeforeAlias.emptyWorkspaceCount, 0);

      const upHex = await reqJson(base, token, 'POST', '/api/alias/upsert', {
        key: 'deadbeef',
        value: 'https://hex.example.com',
        note: 'hex',
      });
      assert.equal(upHex.status, 200);

      const cfgRes = JSON.parse((await reqJson(base, token, 'POST', '/api/config/update', {
        sanitizeEnabled: true,
        aliasEnabled: true,
        maxRetry: 4,
        orchestratorConfirm: 'per_session',
      })).text);
      assert.equal(cfgRes.ok, true);
      assert.equal(cfgRes.config.sanitizeEnabled, true);
      assert.equal(cfgRes.config.aliasEnabled, true);
      assert.equal(cfgRes.config.maxRetry, 4);
      assert.equal(cfgRes.config.orchestratorConfirm, 'per_session');
      assert.equal(cfgRes.conflicts.some((c) => c.code === 'alias_hex8_control_tower'), true);

      const delAlias = await reqJson(base, token, 'POST', '/api/alias/delete', { key: 'deadbeef' });
      assert.equal(delAlias.status, 200);
      assert.equal(JSON.parse(delAlias.text).aliases.some((a) => a.key === 'deadbeef'), false);

      writeFileSync(join(sb.noteRoot, 'ws1', 'turn-3.md'), 'turn3', 'utf-8');
      writeFileSync(
        join(sb.dataDir, '.filter-retry-state.json'),
        JSON.stringify({
          deadconv1234: {
            tries: 3,
            dead: true,
            dead_reason: 'max_retry',
            note_dir: '~/agy-notes/ws1',
            ts: Date.now() / 1000,
          },
          histconv5678: {
            step: 5,
            offload_mode: true,
            note_dir: '~/agy-notes/ws1',
            ts: Date.now() / 1000 - 300,
          },
        }),
      );
      const snap1 = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snap1.workspaces.length, 1);
      assert.equal(snap1.workspaces[0].files.includes('metrics.csv'), true);
      assert.equal(snap1.workspaces[0].files.includes('patch.diff'), true);
      assert.deepEqual(snap1.workspaces[0].taskProgress, { done: 2, total: 3 });
      assert.equal(snap1.workspaces[0].turnCount, 2);
      assert.equal(snap1.workspaces[0].latestTurn, 3);
      assert.equal(snap1.workspaces[0].latestTurnFile, 'turn-3.md');
      assert.equal(snap1.workspaces[0].isEmpty, false);
      assert.equal(snap1.workspaces[0].sessionCount, 2);
      assert.equal(snap1.workspaces[0].boundSessions.length, 2);
      assert.equal(snap1.hasRealAliases, true);
      assert.equal(snap1.aliasesIsExample, false);
      assert.equal(snap1.trackedSessions[0].dead, true);
      assert.equal(snap1.trackedSessions[0].wsName, 'ws1');
      assert.equal(snap1.trackedSessions[0].withinWindow, true);
      assert.equal(snap1.config.sanitizeEnabled, true);
      assert.equal(snap1.config.aliasEnabled, true);
      assert.equal(snap1.config.maxRetry, 4);

      // 二次无变更轮询命中 mtimeMs 缓存
      const snapCached = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snapCached.cacheStats.hits >= 1, true);

      // 逻辑归档与取消归档（不移动磁盘目录）
      const archRes = JSON.parse((await reqJson(base, token, 'POST', '/api/workspace/archive', {
        workspace: 'ws1',
        archived: true,
      })).text);
      assert.equal(archRes.ok, true);
      assert.equal(archRes.moved, false);
      const snapArch = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snapArch.archivedCount, 1);
      assert.equal(snapArch.workspaces[0].archived, true);

      await reqJson(base, token, 'POST', '/api/workspace/archive', { workspace: 'ws1', archived: false });

      // 一键重置配置中心默认
      const resetCfgRes = JSON.parse((await reqJson(base, token, 'POST', '/api/config/reset', {})).text);
      assert.equal(resetCfgRes.ok, true);
      assert.equal(resetCfgRes.config.maxRetry, 2);
      assert.equal(resetCfgRes.config.orchestratorConfirm, 'once');
      assert.equal(resetCfgRes.config.sanitizeEnabled, false);

      assert.equal((await reqJson(base, token, 'POST', '/api/state/reset', { conversationId: 'deadconv1234' })).status, 200);
      const snap2 = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snap2.trackedSessions[0].dead, false);

      // 5. 空目录统计与清理
      mkdirSync(join(sb.noteRoot, 'empty-ws'), { recursive: true });
      const snapWithEmpty = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snapWithEmpty.emptyWorkspaceCount, 1);

      const cleanRes = JSON.parse((await reqJson(base, token, 'POST', '/api/workspace/clean', {})).text);
      assert.equal(cleanRes.removedCount, 1);
      touchHookHeartbeat(sb.dataDir, { event: 'PreInvocation', hook: 'hook-notice' });
      const snapAfterClean = JSON.parse((await reqJson(base, token, 'POST', '/api/snapshot', {})).text);
      assert.equal(snapAfterClean.emptyWorkspaceCount, 0);
      assert.equal(typeof snapAfterClean.version, 'string');
      assert.equal(typeof snapAfterClean.flightSummary?.total, 'number');
      assert.equal(snapAfterClean.heartbeat?.event, 'PreInvocation');

      // 6. 黑匣子飞行诊断读取与清空（鉴权保护）
      assert.equal((await reqJson(base, token, 'POST', '/api/diagnostics/logs', {}, false)).status, 401);
      const diagRes = JSON.parse((await reqJson(base, token, 'POST', '/api/diagnostics/logs', { limit: 20 })).text);
      assert.equal(diagRes.ok, true);
      assert.equal(Array.isArray(diagRes.events), true);
      assert.equal(diagRes.events.length >= 1, true, 'expected prior 400/403 API checks to be recorded in flight log');

      const clearDiag = JSON.parse((await reqJson(base, token, 'POST', '/api/diagnostics/clear', {})).text);
      assert.equal(clearDiag.ok, true);
      assert.equal(clearDiag.summary.total, 0);
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('前端不含会导致 flash 降级的 startConversation、无间隔号且启用分片/增量刷新/风险确认/防丢稿机制', () => {
    const html = readFileSync(join(SIDECAR_DIR, 'index.html'), 'utf-8');
    const css = readFileSync(join(SIDECAR_DIR, 'styles.css'), 'utf-8');
    const appJs = readFileSync(join(SIDECAR_DIR, 'app.js'), 'utf-8');
    assert.equal(html.includes('btn-start-conv'), false);
    assert.equal(appJs.includes('startConversation'), false);
    assert.equal(appJs.includes('window.confirm(') || appJs.includes('window.alert('), false);
    assert.equal(html.includes('·') || css.includes('·') || appJs.includes('·'), false);
    assert.equal(appJs.includes('visibilitychange'), true);
    assert.equal(appJs.includes('computeSnapshotSig'), true);
    assert.equal(appJs.includes('knownSig'), true);
    assert.equal(appJs.includes('confirmRisk'), true);
    assert.equal(appJs.includes('guardDirtyNavigation'), true);
    assert.equal(appJs.includes('isEditorDirty'), true);
    assert.equal(appJs.includes('checkExternalFileChange'), true);
    assert.equal(html.includes('/styles.css?v='), true);
    assert.equal(html.includes('/app.js?v='), true);
    const svgTags = html.match(/<svg\b[^>]*>/g) || [];
    assert.equal(svgTags.length > 0, true);
    for (const tag of svgTags) {
      assert.equal(/\bwidth="\d+"/.test(tag), true, `SVG 缺少 width: ${tag}`);
      assert.equal(/\bheight="\d+"/.test(tag), true, `SVG 缺少 height: ${tag}`);
      assert.equal(tag.includes('fill="none"'), true, `SVG 缺少 fill="none": ${tag}`);
    }
  });
});
