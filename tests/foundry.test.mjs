import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { appendFlightEvent } from '../plugin/lib/logger.mjs';
import { runDoctor } from '../scripts/offload-doctor.mjs';
import { runMiner } from '../scripts/offload-miner.mjs';
import { createSnapshot, listSnapshots, rollbackToSnapshot, safeInstallRelease } from '../scripts/offload-release.mjs';
import { runSkillEval } from '../scripts/offload-skill-eval.mjs';
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

describe('五环自进化工程基座 (Miner / Skill Eval / Doctor / Snapshot Rollback)', () => {
  it('Ring 2 遥测矿机只读汇总并产出准确提案且输出无隐私泄露', () => {
    const sb = newSandbox();
    mkdirSync(join(sb.noteRoot, 'empty-ws'), { recursive: true });
    mkdirSync(join(sb.noteRoot, 'active-ws'), { recursive: true });
    writeFileSync(join(sb.noteRoot, 'active-ws', 'status.md'), '# ok\n', 'utf-8');
    writeFileSync(join(sb.noteRoot, 'handover-20261124.md'), '# standalone\n', 'utf-8');
    writeFileSync(
      join(sb.dataDir, '.filter-retry-state.json'),
      JSON.stringify({
        c1: { offload_mode: true, note_dir: '~/agy-notes/active-ws', ts: Date.now() / 1000 },
        c2: { offload_mode: true, note_dir: '~/agy-notes/active-ws', ts: Date.now() / 1000 },
        c3: { note_dir: '~/agy-notes/handover-20261124.md', ts: Date.now() / 1000 },
      }),
      'utf-8',
    );
    appendFlightEvent(sb.dataDir, {
      level: 'error',
      source: 'hook-retry',
      event: 'circuit_breaker',
      message: 'test err',
    });

    const report = runMiner({ env: sb.env, dataDir: sb.dataDir, noteRoot: sb.noteRoot });
    assert.equal(report.workspaces.emptyDirs, 1);
    assert.equal(report.workspaces.standaloneRootFiles, 1);
    assert.equal(report.state.multiSessionWorkspaces, 1);
    assert.equal(report.state.fileNoteDirAnomalies, 1);
    const codes = new Set(report.proposals.map((p) => p.code));
    assert.equal(codes.has('flight_errors_detected'), true);
    assert.equal(codes.has('empty_workspaces'), true);
    assert.equal(codes.has('legacy_file_note_dir'), true);
  });

  it('Ring 4 (L4) 技能与提示词行为契约评测全部通过', () => {
    const res = runSkillEval();
    assert.equal(res.ok, true, JSON.stringify(res.cases.filter((c) => !c.ok)));
    assert.equal(res.total >= 10, true);
  });

  it('Ring 5 快照保留上限 3 份、safeInstallRelease 需 --confirm 且回滚准确恢复旧版本', () => {
    const sb = newSandbox();
    const installedDir = join(sb.configDir, 'plugins', 'note-offload');
    mkdirSync(join(installedDir, 'scripts'), { recursive: true });
    writeFileSync(join(installedDir, 'plugin.json'), JSON.stringify({ name: 'note-offload', version: '2.0.0' }), 'utf-8');
    writeFileSync(join(installedDir, 'scripts', 'marker.txt'), 'old-2.0.0', 'utf-8');

    // 未传 confirm 被门禁拒绝
    assert.throws(
      () => safeInstallRelease({ confirm: false, env: sb.env, configDir: sb.configDir, dataDir: sb.dataDir, checkAgyCli: false }),
      /--confirm/,
    );

    // 连续创建 4 份快照仅保留最新 3 份
    for (let i = 1; i <= 4; i += 1) {
      const r = createSnapshot({ env: sb.env, configDir: sb.configDir, dataDir: sb.dataDir, tagSuffix: `s${i}` });
      assert.equal(r.created, true);
    }
    const snapsBefore = listSnapshots({ env: sb.env, dataDir: sb.dataDir });
    assert.equal(snapsBefore.length, 3);

    // 安全实装最新版
    const inst = safeInstallRelease({
      confirm: true,
      env: sb.env,
      configDir: sb.configDir,
      dataDir: sb.dataDir,
      checkAgyCli: false,
      checkProcesses: false,
    });
    assert.equal(inst.ok, true);
    assert.equal(inst.snapshot.created, true);

    const docAfterInstall = runDoctor({
      env: sb.env,
      configDir: sb.configDir,
      dataDir: sb.dataDir,
      checkAgyCli: false,
      checkProcesses: false,
    });
    assert.equal(docAfterInstall.ok, true);

    // 回滚至 v2.0.0 快照
    const rb = rollbackToSnapshot({
      snapshotName: inst.snapshot.snapshot.name,
      env: sb.env,
      configDir: sb.configDir,
      dataDir: sb.dataDir,
      checkAgyCli: false,
      checkProcesses: false,
    });
    assert.equal(rb.ok, true);
    assert.equal(JSON.parse(readFileSync(join(installedDir, 'plugin.json'), 'utf-8')).version, '2.0.0');
    assert.equal(readFileSync(join(installedDir, 'scripts', 'marker.txt'), 'utf-8'), 'old-2.0.0');
  });
});
