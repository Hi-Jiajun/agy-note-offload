import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve('.');
const PLUGIN_DIR = join(ROOT, 'plugin');

function walkJsFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkJsFiles(full, out);
    } else if (ent.name.endsWith('.mjs') || ent.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('插件规范校验：清单、版本一致、Hook 契约、语法与官方 agy 校验', () => {
  it('plugin.json 仅使用官方允许字段且与根 package.json 版本一致', () => {
    const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const pj = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf-8'));
    const allowed = new Set([
      'name', 'displayName', 'version', 'description',
      'author', 'homepage', 'repository', 'logo', 'suggestedPrompts', 'disabled',
    ]);
    for (const k of Object.keys(pj)) {
      assert.equal(allowed.has(k), true, `unknown plugin.json key: ${k}`);
    }
    assert.equal(pj.name, 'note-offload');
    assert.equal(pj.version, rootPkg.version);
    assert.equal(existsSync(join(PLUGIN_DIR, pj.logo)), true);
  });

  it('hooks.json 事件合法、引用脚本均存在且具备可执行权限', () => {
    const hj = JSON.parse(readFileSync(join(PLUGIN_DIR, 'hooks.json'), 'utf-8'));
    const okKeys = new Set(['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop', 'enabled']);
    assert.deepEqual(
      new Set(Object.keys(hj)),
      new Set(['note-offload-guardrail', 'note-offload-retry', 'note-offload-notice']),
    );
    for (const spec of Object.values(hj)) {
      for (const [k, v] of Object.entries(spec)) {
        assert.equal(okKeys.has(k), true, `invalid hook event: ${k}`);
        if (Array.isArray(v)) {
          for (const item of v) {
            const parts = String(item.command || '').trim().split(/\s+/);
            assert.equal(parts.length >= 2, true);
            const scriptPath = join(PLUGIN_DIR, parts[parts.length - 1]);
            assert.equal(existsSync(scriptPath), true, `missing hook script: ${scriptPath}`);
            assert.notEqual(statSync(scriptPath).mode & 0o111, 0, `not executable: ${scriptPath}`);
          }
        }
      }
    }
  });

  it('sidecar.json、SKILL.md 相对路径引用与全仓 JS 语法检查通过', () => {
    const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const scPkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'sidecars', 'board', 'package.json'), 'utf-8'));
    const scJson = JSON.parse(readFileSync(join(PLUGIN_DIR, 'sidecars', 'board', 'sidecar.json'), 'utf-8'));
    assert.equal(scPkg.version, rootPkg.version);
    assert.equal(scJson.has_web_ui, true);
    assert.equal(
      (scJson.ui_config?.views || []).some((v) => v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE'),
      true,
    );

    const skillPath = join(PLUGIN_DIR, 'skills', 'note-offload', 'SKILL.md');
    const skillText = readFileSync(skillPath, 'utf-8');
    assert.equal(skillText.startsWith('---\n') && skillText.includes('name: note-offload\n'), true);
    for (const banned of ['安全过滤器', '绕开', '攻防', 'bypass', 'exploit', 'fake password']) {
      assert.equal(skillText.toLowerCase().includes(banned), false);
    }
    for (const m of skillText.matchAll(/\[[^\]]+\]\((\.\.\/[^)]+)\)/g)) {
      assert.equal(existsSync(resolve(skillPath, '..', m[1])), true, `broken SKILL link: ${m[1]}`);
    }

    for (const jsFile of walkJsFiles(ROOT)) {
      execFileSync(process.execPath, ['--check', jsFile]);
    }
  });

  it('agy plugin validate ./plugin --strict --json 零告警零错误（如系统已安装 agy）', (t) => {
    try {
      execFileSync('which', ['agy'], { stdio: 'ignore' });
    } catch {
      t.skip('环境未安装 agy CLI');
      return;
    }
    const out = execFileSync('agy', ['plugin', 'validate', PLUGIN_DIR, '--strict', '--json'], {
      encoding: 'utf-8',
    });
    const report = JSON.parse(out);
    assert.deepEqual(report.findings, []);
    assert.equal(report.components.hooks, 3);
    assert.equal(report.components.sidecars, 1);
    assert.equal(report.components.skills, 1);
  });
});
