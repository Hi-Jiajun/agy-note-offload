#!/usr/bin/env node
/**
 * 本地开发/源码安装器：
 *   1. 将纯净 ./plugin/ 整目录同步至 <configDir>/plugins/note-offload/
 *   2. 将旧散装数据与 ~/.local/share/agy-note-offload 平滑迁移至 plugin_data/note-offload
 *   3. 清理旧全局 hooks.json 键、旧散装 skill 与旧路径兼容软链
 *   4. 默认清除 ~/.local/bin 关联旧软链保持单包内聚；仅显式传 --link-cli 时创建新 .mjs 软链
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteSync } from '../plugin/lib/lock.mjs';
import { ensureDataDir, expandHome, getDataDir, getHomeDir } from '../plugin/lib/paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_PLUGIN = join(REPO_ROOT, 'plugin');

const OLD_HOOK_KEYS = [
  'gemini-filter-guardrail',
  'gemini-filter-retry',
  'gemini-filter-notice',
  'note-offload-guardrail',
  'note-offload-retry',
  'note-offload-notice',
];

const OLD_LEGACY_SCRIPT_FILES = [
  'provider-filter-guardrail.py',
  'provider-filter-retry.py',
  'provider-filter-notice.py',
  'hooklib.py',
  'sanitize.py',
  'selftest.sh',
  'file-mode-prompt.md',
  'retry-terms.txt',
  'agynote',
  'agysum',
  'neturl',
  'net-map.tsv',
];

const CLI_BINS = [
  ['agynote', 'agynote.mjs'],
  ['agysum', 'agysum.mjs'],
  ['neturl', 'neturl.mjs'],
];

function safeUnlinkIfOwned(linkPath) {
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) return;
    const target = readlinkSync(linkPath);
    if (target.includes('/plugins/note-offload/') || target.includes('agy-note-offload')) {
      unlinkSync(linkPath);
    }
  } catch {
    // 忽略不存在或权限问题
  }
}

function migrateLegacyScriptsDir(legacyScriptsDir, dataDir) {
  if (!existsSync(legacyScriptsDir)) return;
  for (const fname of ['net-map.tsv', '.filter-retry-state.json', 'hook-invocations.log']) {
    const src = join(legacyScriptsDir, fname);
    const dst = join(dataDir, fname);
    try {
      const st = lstatSync(src);
      if (!st.isSymbolicLink() && st.isFile() && !existsSync(dst)) {
        atomicWriteSync(dst, readFileSync(src));
        unlinkSync(src);
      }
    } catch {
      // 忽略不存在的文件
    }
  }
}

function cleanLegacyHooksJson(legacyHooksJson) {
  if (!existsSync(legacyHooksJson)) return;
  let data;
  try {
    data = JSON.parse(readFileSync(legacyHooksJson, 'utf-8'));
  } catch {
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;

  let changed = false;
  for (const k of OLD_HOOK_KEYS) {
    if (Object.hasOwn(data, k)) {
      delete data[k];
      changed = true;
    }
  }
  if (!changed) return;

  if (Object.keys(data).length > 0) {
    atomicWriteSync(legacyHooksJson, `${JSON.stringify(data, null, 2)}\n`);
  } else {
    unlinkSync(legacyHooksJson);
  }
}

function main() {
  const linkCli = process.argv.includes('--link-cli');
  const home = getHomeDir(process.env);
  const configDir = resolve(expandHome(process.env.AGY_CONFIG_DIR || join(home, '.gemini', 'config'), home));
  const pluginDir = join(configDir, 'plugins', 'note-offload');
  const binDir = resolve(expandHome(process.env.AGY_BIN_DIR || join(home, '.local', 'bin'), home));
  const legacyScriptsDir = join(configDir, 'scripts');
  const legacySkillDir = join(configDir, 'skills', 'note-offload');
  const legacyHooksJson = join(configDir, 'hooks.json');

  // 1) 确保目标数据目录就绪并迁移旧数据（未配置 net-map.tsv 时不自动写入示例表，保证按需检测准确）
  const dataDir = getDataDir(process.env);
  mkdirSync(dataDir, { recursive: true });
  migrateLegacyScriptsDir(legacyScriptsDir, dataDir);
  ensureDataDir(process.env);

  // 2) 整目录洁净同步 plugin/ 到运行态目录
  if (resolve(SRC_PLUGIN) !== resolve(pluginDir)) {
    mkdirSync(join(configDir, 'plugins'), { recursive: true });
    if (existsSync(pluginDir)) {
      rmSync(pluginDir, { recursive: true, force: true });
    }
    cpSync(SRC_PLUGIN, pluginDir, { recursive: true, force: true });
  }

  const installedScriptsDir = join(pluginDir, 'scripts');
  for (const ent of readdirSync(installedScriptsDir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.endsWith('.mjs')) {
      chmodSync(join(installedScriptsDir, ent.name), 0o755);
    }
  }

  // 3) 清理旧散装注册、旧 Skill 与历史兼容软链
  cleanLegacyHooksJson(legacyHooksJson);
  if (existsSync(legacySkillDir)) {
    rmSync(legacySkillDir, { recursive: true, force: true });
  }
  for (const oldName of OLD_LEGACY_SCRIPT_FILES) {
    const oldPath = join(legacyScriptsDir, oldName);
    try {
      const st = lstatSync(oldPath);
      if (st.isSymbolicLink() || st.isFile()) {
        unlinkSync(oldPath);
      }
    } catch {
      // 忽略不存在的文件
    }
  }

  // 4) 处理 ~/.local/bin 软链：默认清除旧软链保持单包内聚，仅 --link-cli 时建立新软链
  for (const [cmd, scriptName] of CLI_BINS) {
    const dstLink = join(binDir, cmd);
    if (linkCli) {
      mkdirSync(binDir, { recursive: true });
      try {
        lstatSync(dstLink);
        unlinkSync(dstLink);
      } catch {
        // 不存在直接建链
      }
      symlinkSync(join(installedScriptsDir, scriptName), dstLink);
    } else {
      safeUnlinkIfOwned(dstLink);
    }
  }

  process.stdout.write('原生插件安装完成：\n');
  process.stdout.write(`  插件目录: ${pluginDir}\n`);
  process.stdout.write(`  数据目录: ${dataDir}\n`);
  if (linkCli) {
    process.stdout.write(`  CLI 软链: ${binDir}/{agynote,agysum,neturl}\n`);
  } else {
    process.stdout.write('  CLI 模式: 插件单包自包含（未写入外部软链）\n');
  }
}

main();
