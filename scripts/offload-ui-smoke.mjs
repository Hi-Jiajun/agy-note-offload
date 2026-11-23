#!/usr/bin/env node
/**
 * Note Offload Ring 4 (L3): Zero-Dependency Real Headless Browser UI Smoke Test (CDP)
 * 在隔离沙箱启动 Sidecar 进程 + 本地无头 Chrome/Chromium，通过 Node 内置 WebSocket (CDP)
 * 验证 Aux Pane 窄栏 (390x844 暗/亮色) 与宽栏 (960x844)、0 Console/Page Error、0 水平溢出、
 * 页签切换、工作台详情渲染、设置抽屉与黑匣子飞行诊断筛选交互。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { upsertAlias } from '../plugin/lib/aliases.mjs';
import { appendFlightEvent } from '../plugin/lib/logger.mjs';
import { createSandbox } from '../tests/helpers/sandbox.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SIDECAR_DIR = join(REPO_ROOT, 'plugin', 'sidecars', 'board');
const SIDECAR_MAIN = join(SIDECAR_DIR, 'main.mjs');
const SHIM_LOADER = join(REPO_ROOT, 'tests', 'helpers', 'register-sidecar-shim.mjs');

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

function findChromeBinary() {
  const envBin = (process.env.OFFLOAD_CHROME_BIN || process.env.CHROME_BIN || '').trim();
  if (envBin && existsSync(envBin)) return envBin;

  const fixed = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of fixed) {
    if (existsSync(p)) return p;
  }

  const pwCache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(pwCache)) {
    try {
      const dirs = readdirSync(pwCache)
        .filter((d) => d.startsWith('chromium-'))
        .sort()
        .reverse();
      for (const d of dirs) {
        const cand = join(pwCache, d, 'chrome-linux64', 'chrome');
        if (existsSync(cand)) return cand;
      }
    } catch {
      // ignore
    }
  }
  return '';
}

class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id && this.#pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        } else {
          res(msg.result || {});
        }
        return;
      }
      if (msg.method && this.#listeners.has(msg.method)) {
        for (const fn of this.#listeners.get(msg.method)) {
          fn(msg.params || {});
        }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('Timed out connecting to CDP WebSocket')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        res();
      });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        rej(err);
      });
    });
    return new CdpClient(ws);
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rej(new Error(`CDP timeout waiting for ${method}`));
      }, 10000);
      this.#pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          res(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          rej(err);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
  }
}

async function waitForCondition(fn, { timeoutMs = 6000, intervalMs = 80, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function launchChrome(chromeBin, profileDir) {
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderrBuf = '';
  const wsBrowserUrl = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`Chrome failed to emit DevTools URL: ${stderrBuf.slice(-400)}`)), 12000);
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        res(m[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`Chrome exited early (${code}): ${stderrBuf.slice(-400)}`));
    });
  });

  const debugPort = wsBrowserUrl.match(/127\.0\.0\.1:(\d+)/)[1];
  const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('Could not find CDP page target');
  }
  return { proc, pageWsUrl: pageTarget.webSocketDebuggerUrl };
}

export async function runUiSmoke({ requireBrowser = false } = {}) {
  const chromeBin = findChromeBinary();
  if (!chromeBin) {
    if (requireBrowser) {
      throw new Error('No Chromium/Chrome binary found for L3 UI smoke test');
    }
    return { skipped: true, reason: 'No local Chrome/Chromium binary available' };
  }

  const pluginMeta = JSON.parse(readFileSync(join(REPO_ROOT, 'plugin', 'plugin.json'), 'utf-8'));
  const sb = createSandbox();
  let sidecarProc = null;
  let chromeProc = null;
  let cdp = null;

  try {
    const profileDir = join(sb.root, 'chrome-profile');
    mkdirSync(profileDir, { recursive: true });

    // 1) 造样本工作台、状态、别名与飞行日志
    const ws1 = join(sb.noteRoot, 'smoke-ws');
    mkdirSync(ws1, { recursive: true });
    writeFileSync(join(ws1, 'task.md'), '# 冒烟任务\n- [x] 步骤 1\n- [ ] 步骤 2\n', 'utf-8');
    writeFileSync(join(ws1, 'status.md'), '# 进度看板\n- 当前状态：L3 冒烟进行中\n', 'utf-8');
    writeFileSync(join(ws1, 'turn-1.md'), '## 阶段 1\n| 指标 | 结果 |\n| --- | --- |\n| 状态 | OK |\n', 'utf-8');
    writeFileSync(join(ws1, 'patch.diff'), 'diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n', 'utf-8');

    const convId = 'aa112233-1111-2222-3333-444455556666';
    writeFileSync(
      join(sb.dataDir, '.filter-retry-state.json'),
      JSON.stringify({
        [convId]: {
          step: 12,
          tries: 3,
          dead: true,
          dead_reason: 'max_retry',
          offload_mode: true,
          note_dir: '~/agy-notes/smoke-ws',
          ts: Date.now() / 1000,
        },
      }),
      'utf-8',
    );
    upsertAlias('gw-smoke', 'https://smoke.example.com/api', 'smoke endpoint', sb.env);
    appendFlightEvent(sb.dataDir, {
      level: 'info',
      source: 'hook-notice',
      event: 'rule_inject',
      conv: convId,
      message: 'Smoke test info event',
    });
    appendFlightEvent(sb.dataDir, {
      level: 'warn',
      source: 'hook-retry',
      event: 'stop_retry',
      conv: convId,
      message: 'Smoke test warn event',
    });

    const port = await getFreePort();
    const token = 'offload-ui-smoke-token';
    const loaderHref = findSidecarLoader();
    sidecarProc = spawn(process.execPath, ['--import', loaderHref, SIDECAR_MAIN], {
      cwd: SIDECAR_DIR,
      env: {
        ...sb.env,
        ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1',
        ANTIGRAVITY_CSRF_TOKEN: 'smoke-csrf',
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(port),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const base = `http://127.0.0.1:${port}`;
    await waitForCondition(async () => {
      try {
        const r = await fetch(`${base}/`);
        return r.status === 200;
      } catch {
        return false;
      }
    }, { label: 'Sidecar HTTP server startup' });

    const launched = await launchChrome(chromeBin, profileDir);
    chromeProc = launched.proc;
    cdp = await CdpClient.connect(launched.pageWsUrl);

    const consoleErrors = [];
    const pageExceptions = [];

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        consoleErrors.push(text);
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageExceptions.push(p.exceptionDetails?.text || JSON.stringify(p.exceptionDetails));
    });

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.sidecar = {
          conversationId: ${JSON.stringify(convId)},
          ui: { toggleConversation: () => {}, toggleAuxPane: () => {} },
        };
      `,
    });

    await cdp.send('Page.navigate', { url: `${base}/?token=${token}` });

    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`document.getElementById('ws-list')?.textContent?.includes('smoke-ws')`)),
      { label: 'Workspaces snapshot render' },
    );

    const checks = [];

    // 2) 检查设置面板版本显示与窄栏无溢出
    await cdp.evaluate(`document.getElementById('btn-settings')?.click()`);
    await new Promise((r) => setTimeout(r, 80));
    const versionText = await cdp.evaluate(`document.getElementById('settings-version')?.textContent?.trim()`);
    assert.equal(versionText, `v${pluginMeta.version}`);
    const settingsOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
    assert.equal(settingsOverflow, true, 'Settings drawer overflow in 390px narrow view');
    await cdp.evaluate(`document.getElementById('btn-close-settings')?.click()`);
    checks.push('narrow-dark:settings');

    // 3) 点击进入工作台详情页并切换 diff 文件验证富渲染与零溢出
    await cdp.evaluate(`document.querySelector('.ws-card[data-ws="smoke-ws"]')?.click()`);
    await waitForCondition(
      async () => Boolean(await cdp.evaluate(`!document.getElementById('ws-detail-view')?.classList.contains('hidden')`)),
      { label: 'Workspace detail open' },
    );
    const detailOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
    assert.equal(detailOverflow, true, 'Detail view overflow in 390px narrow view');
    await cdp.evaluate(`document.getElementById('btn-back')?.click()`);
    checks.push('narrow-dark:detail');

    // 4) 遍历 3 个主 Tab 检查窄栏零溢出
    for (const tab of ['workspaces', 'aliases', 'monitor']) {
      await cdp.evaluate(`document.querySelector('.tab[data-tab="${tab}"]')?.click()`);
      await new Promise((r) => setTimeout(r, 80));
      const metrics = await cdp.evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        active: document.getElementById('panel-${tab}')?.classList.contains('active'),
      })`);
      assert.equal(metrics.active, true, `Tab ${tab} should be active`);
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth + 2,
        `Narrow 390px overflow on tab ${tab}: ${metrics.scrollWidth} > ${metrics.innerWidth}`,
      );
      checks.push(`narrow-dark:${tab}`);
    }

    // 5) 展开黑匣子飞行诊断抽屉并验证筛选交互
    await cdp.evaluate(`document.getElementById('btn-toggle-diag')?.click()`);
    await waitForCondition(
      async () => Number(await cdp.evaluate(`document.querySelectorAll('#diag-events-list .diag-row').length`)) >= 2,
      { label: 'Diagnostics flight rows rendered' },
    );
    await cdp.evaluate(`(() => {
      const sel = document.getElementById('diag-level-filter');
      sel.value = 'warn_or_error';
      sel.dispatchEvent(new Event('change'));
    })()`);
    await waitForCondition(
      async () => Number(await cdp.evaluate(`document.querySelectorAll('#diag-events-list .diag-row').length`)) === 1,
      { label: 'Diagnostics warn_or_error filter' },
    );
    checks.push('diagnostics-filter');

    // 6) 切换亮色主题并检查 theme 同步
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await cdp.evaluate(`document.documentElement.setAttribute('style', '--background: #ffffff')`);
    await new Promise((r) => setTimeout(r, 60));
    const lightTheme = await cdp.evaluate(`document.documentElement.dataset.theme`);
    assert.equal(lightTheme, 'light', 'Theme observer should switch dataset.theme to light');
    checks.push('narrow-light-theme');

    // 7) 切到宽栏 960x844 检查无溢出
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 960,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.evaluate(`document.querySelector('.tab[data-tab="workspaces"]')?.click()`);
    await new Promise((r) => setTimeout(r, 80));
    const wideOverflow = await cdp.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`);
    assert.equal(wideOverflow, true, 'Wide viewport should have zero horizontal overflow');
    checks.push('wide-960:workspaces');

    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join(' | ')}`);
    assert.deepEqual(pageExceptions, [], `Page exceptions: ${pageExceptions.join(' | ')}`);

    return {
      skipped: false,
      ok: true,
      browser: chromeBin.split('/').pop(),
      version: versionText,
      checksPassed: checks.length,
      checks,
      consoleErrors: 0,
      pageExceptions: 0,
    };
  } finally {
    if (cdp) cdp.close();
    if (chromeProc) {
      try {
        chromeProc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    if (sidecarProc) {
      try {
        sidecarProc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    sb.cleanup();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const jsonMode = process.argv.includes('--json');
  const requireBrowser = process.argv.includes('--require-browser');
  try {
    const res = await runUiSmoke({ requireBrowser });
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (res.skipped) {
      process.stdout.write(`SKIP: ${res.reason}\n`);
    } else {
      process.stdout.write(
        `OK: L3 真浏览器 UI 冒烟全部通过 (${res.browser}, ${res.version}, ${res.checksPassed} 项检查, 0 Console Error)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`FAIL: L3 UI 冒烟失败 -> ${err?.message || err}\n`);
    process.exit(1);
  }
}
