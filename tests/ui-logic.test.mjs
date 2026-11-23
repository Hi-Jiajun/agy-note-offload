import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { withFileLockSync } from '../plugin/lib/lock.mjs';
import {
  appendFlightEvent,
  clearFlightLogs,
  getFlightLogPath,
  readFlightEvents,
  sanitizeLogString,
  sanitizeLogValue,
  summarizeFlightEvents,
} from '../plugin/lib/logger.mjs';
import {
  badgeClass,
  canRenderRich,
  classifyLogLine,
  esc,
  filterLogs,
  fmtBytes,
  fmtIsoShort,
  fmtTime,
  formatFlightLevel,
  formatFlightSummaryText,
  inferLatestTurn,
  isSessionWithinWindow,
  maskValue,
  matchWorkspaceFilter,
  renderDiffView,
  renderInlineMd,
  renderMarkdownRich,
  sortWorkspaces,
  splitWorkspaceFiles,
  validateAliasKey,
  wsNameFromSession,
} from '../plugin/sidecars/board/ui-logic.mjs';
import { createSandbox } from './helpers/sandbox.mjs';

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

describe('L1 Sidecar 前端纯逻辑模块 (ui-logic.mjs)', () => {
  it('Markdown 富渲染支持标题/表格/任务列表/代码块/防 XSS 且 Diff 渲染准确着色', () => {
    const md = [
      '# 标题 <script>alert(1)</script>',
      '- [x] 已完成 **加粗** `code`',
      '- [ ] 待完成 [链接](https://example.com)',
      '',
      '| 列1 | 列2 |',
      '| --- | --- |',
      '| A | B |',
      '',
      '```js',
      'const x = 1 < 2;',
      '```',
    ].join('\n');
    const html = renderMarkdownRich(md);
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('&lt;script&gt;'), true);
    assert.match(html, /<h1>/);
    assert.match(html, /md-task done/);
    assert.match(html, /<table>/);
    assert.match(html, /md-code-lang">js/);
    assert.match(renderInlineMd('**bold** ~~del~~ `x<y`'), /<strong>bold<\/strong> <del>del<\/del> <code>x&lt;y<\/code>/);

    const diff = renderDiffView('diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new');
    assert.match(diff, /diff-meta/);
    assert.match(diff, /diff-hunk/);
    assert.match(diff, /diff-del/);
    assert.match(diff, /diff-add/);

    assert.equal(canRenderRich('status.md', 'ok'), true);
    assert.equal(canRenderRich('a.diff', '+x'), true);
    assert.equal(canRenderRich('a.json', '{}'), false);
    assert.equal(canRenderRich('big.md', 'x'.repeat(200_000)), false);
  });

  it('工作台筛选、排序、文件拆分、别名校验与日志过滤逻辑准确', () => {
    const wsList = [
      { name: 'b-ws', summary: 'normal', health: 'OK', boundConvId: '', boundConvShort: '', updatedAtMs: 200, taskProgress: { done: 1, total: 1 }, archived: false },
      { name: 'a-ws', summary: 'dead task', health: 'DEAD(max_retry)', boundConvId: 'conv-cur', boundConvShort: 'conv-cur', updatedAtMs: 100, taskProgress: { done: 0, total: 2 }, archived: false },
      { name: 'c-old', summary: 'old archived', health: 'OK', boundConvId: '', boundConvShort: '', updatedAtMs: 300, taskProgress: { done: 0, total: 0 }, archived: true },
    ];

    // 默认隐藏已归档
    const activeOnly = wsList.filter((w) => matchWorkspaceFilter(w, { wsFilter: 'all' }));
    assert.deepEqual(activeOnly.map((w) => w.name), ['b-ws', 'a-ws']);

    // 切至已归档视图仅显示归档项
    const archivedOnly = wsList.filter((w) => matchWorkspaceFilter(w, { wsFilter: 'archived' }));
    assert.deepEqual(archivedOnly.map((w) => w.name), ['c-old']);

    // 异常与待办筛选
    assert.deepEqual(wsList.filter((w) => matchWorkspaceFilter(w, { wsFilter: 'alert' })).map((w) => w.name), ['a-ws']);
    assert.deepEqual(wsList.filter((w) => matchWorkspaceFilter(w, { wsFilter: 'todo' })).map((w) => w.name), ['a-ws']);

    // 当前会话置顶排序
    const sorted = sortWorkspaces(activeOnly, { activeConv: 'conv-cur', wsSort: 'updated' });
    assert.equal(sorted[0].name, 'a-ws');

    // 文件核心药丸与更多下拉拆分
    const split = splitWorkspaceFiles({ files: ['status.md', 'task.md', 'turn-3.md', 'turn-1.md', 'notes.log'] });
    assert.deepEqual(split.core, ['status.md', 'task.md', 'turn-3.md']);
    assert.deepEqual(split.more, ['turn-1.md', 'notes.log']);
    assert.equal(inferLatestTurn({ files: ['turn-2.md', 'turn-11.md'] }).latestTurn, 11);

    // 别名校验与辅助格式化
    assert.equal(validateAliasKey('https').valid, false);
    assert.equal(validateAliasKey('deadbeef').level, 'warn');
    assert.equal(validateAliasKey('gw-prod').level, 'ok');
    assert.equal(badgeClass('DEAD(max_retry)'), 'err');
    assert.equal(badgeClass('RETRY(1)'), 'warn');
    assert.equal(badgeClass('OK'), 'ok');
    assert.equal(fmtBytes(1536), '1.5 KB');
    assert.equal(maskValue('https://example.com/v1/secret'), 'https://***cret');
    assert.equal(wsNameFromSession({ noteDir: '~/agy-notes/ws-1/' }), 'ws-1');
    assert.equal(isSessionWithinWindow({ updatedAtMs: Date.now() - 1000 }), true);
    assert.equal(esc('a&b'), 'a&amp;b');
    assert.notEqual(fmtTime(Date.now()), '-');
    assert.notEqual(fmtIsoShort(new Date().toISOString()), '-');

    // 日志分类与过滤
    const logs = [
      '2026-11-24 00:01:00 stop conv=abcd1234 ladder=dead reason=max_retry',
      '2026-11-24 00:02:00 preinvocation alias conv=ffff9999 dir=~/agy-notes/x',
    ];
    assert.equal(classifyLogLine(logs[0]), 'is-err');
    assert.equal(filterLogs(logs, { logFilter: 'warn' }).length, 1);
    assert.equal(filterLogs(logs, { logFilter: 'current', activeConv8: 'abcd1234' }).length, 1);
    assert.equal(formatFlightLevel('error').label, 'ERR');
    assert.match(formatFlightSummaryText({ total: 3, byLevel: { error: 1, warn: 1 }, slowCount: 1 }), /3 事件/);
  });
});

describe('Ring 1 黑匣子飞行日志与文件锁超时防护 (logger.mjs + lock.mjs)', () => {
  it('自动脱敏主目录、私有网段、Bearer/查询令牌、API 密钥前缀与敏感对象键，并支持轮转与清理', () => {
    const sb = newSandbox();
    const fakeHomePath = `${'/'}${'ho'}me/alice/secret/file.txt`;
    const fakeIp = ['192', '168', '10', '22'].join('.');
    const fakeKey = `${'sk'}-${'A'.repeat(24)}`;
    const rawMsg = `read ${fakeHomePath} from http://${fakeIp}:8080/api?token=abc12345 Bearer secretToken999 ${fakeKey}`;
    const cleaned = sanitizeLogString(rawMsg);

    assert.equal(cleaned.includes('alice'), false);
    assert.equal(cleaned.includes(fakeIp), false);
    assert.equal(cleaned.includes('abc12345'), false);
    assert.equal(cleaned.includes('secretToken999'), false);
    assert.equal(cleaned.includes(fakeKey), false);
    assert.match(cleaned, /<HOME>/);
    assert.match(cleaned, /<PRIVATE_IP>/);
    assert.match(cleaned, /<REDACTED>/);
    assert.match(cleaned, /<REDACTED_KEY>/);

    const sanitizedObj = sanitizeLogValue({ apiKey: 'top-secret', nested: { path: fakeHomePath } });
    assert.equal(sanitizedObj.apiKey, '[REDACTED]');
    assert.equal(sanitizedObj.nested.path.includes('<HOME>'), true);

    for (let i = 0; i < 8; i += 1) {
      appendFlightEvent(sb.dataDir, {
        level: i % 3 === 0 ? 'error' : 'info',
        source: 'test',
        event: `ev_${i}`,
        conv: '12345678-aaaa',
        durationMs: i === 0 ? 150 : 10,
        message: `msg ${i} ${'x'.repeat(120)}`,
      }, { maxBytes: 400, maxFiles: 3 });
    }
    const logPath = getFlightLogPath(sb.dataDir);
    assert.equal(existsSync(logPath), true);
    assert.equal(existsSync(`${logPath}.1`), true);

    const events = readFlightEvents(sb.dataDir, { limit: 20 });
    assert.equal(events.length >= 3, true);
    const errOnly = readFlightEvents(sb.dataDir, { level: 'error' });
    assert.equal(errOnly.every((e) => e.level === 'error'), true);

    const summary = summarizeFlightEvents(sb.dataDir);
    assert.equal(summary.total >= 3, true);
    assert.equal(summary.byLevel.error >= 1, true);

    clearFlightLogs(sb.dataDir);
    assert.equal(existsSync(logPath), false);
    assert.equal(readFlightEvents(sb.dataDir).length, 0);
  });

  it('withFileLockSync 超时触发 onTimeout 回调，strict 模式抛出 ELOCKTIMEOUT 不静默无锁写入', () => {
    const sb = newSandbox();
    const lockPath = join(sb.dataDir, 'held.lock');
    // 写入当前存活 PID 的新鲜锁模拟被占锁
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'other-holder', ts: Date.now() }), 'utf-8');

    let calledInfo = null;
    const nonStrictOut = withFileLockSync(lockPath, () => 'ran-fallback', {
      timeoutMs: 30,
      staleMs: 60_000,
      strict: false,
      onTimeout: (info) => {
        calledInfo = info;
      },
    });
    assert.equal(nonStrictOut, 'ran-fallback');
    assert.equal(calledInfo?.reason, 'TIMEOUT');
    assert.equal(existsSync(lockPath), true, '非持锁者不得误删他人锁文件');

    let strictCalled = false;
    assert.throws(
      () => withFileLockSync(lockPath, () => 'should-not-run', {
        timeoutMs: 30,
        staleMs: 60_000,
        strict: true,
        onTimeout: () => {
          strictCalled = true;
        },
      }),
      (err) => err?.code === 'ELOCKTIMEOUT',
    );
    assert.equal(strictCalled, true);
  });
});
