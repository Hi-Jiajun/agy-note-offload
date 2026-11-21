#!/usr/bin/env node
/**
 * 干净卸载 note-offload 原生插件：
 *   - 安全移除 <configDir>/plugins/note-offload/
 *   - 清理 ~/.local/bin 与旧 scripts 目录下归属本插件的软链及 hooks.json 旧键
 *   - 保留 plugin_data/note-offload 与 ~/agy-notes/ 用户数据
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteSync } from '../plugin/lib/lock.mjs';
import { expandHome, getHomeDir } from '../plugin/lib/paths.mjs';

const OLD_HOOK_KEYS = [
  'gemini-filter-guardrail',
  'gemini-filter-retry',
  'gemini-filter-notice',
  'note-offload-guardrail',
  'note-offload-retry',
  'note-offload-notice',
];

function unlinkIfOwned(linkPath) {
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) return;
    const target = readlinkSync(linkPath);
    if (target.includes('/plugins/note-offload/') || target.includes('agy-note-offload')) {
      unlinkSync(linkPath);
    }
  } catch {
    // 忽略不存在的路径
  }
}

function main() {
  const home = getHomeDir(process.env);
  const configDir = resolve(expandHome(process.env.AGY_CONFIG_DIR || join(home, '.gemini', 'config'), home));
  const pluginDir = join(configDir, 'plugins', 'note-offload');
  const binDir = resolve(expandHome(process.env.AGY_BIN_DIR || join(home, '.local', 'bin'), home));
  const legacyScriptsDir = join(configDir, 'scripts');
  const legacyHooksJson = join(configDir, 'hooks.json');

  if (existsSync(pluginDir) && pluginDir.endsWith(join('plugins', 'note-offload'))) {
    rmSync(pluginDir, { recursive: true, force: true });
  }

  for (const cmd of ['agynote', 'agysum', 'neturl']) {
    unlinkIfOwned(join(binDir, cmd));
    unlinkIfOwned(join(legacyScriptsDir, cmd));
  }
  unlinkIfOwned(join(legacyScriptsDir, 'net-map.tsv'));

  if (existsSync(legacyHooksJson)) {
    try {
      const data = JSON.parse(readFileSync(legacyHooksJson, 'utf-8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        let changed = false;
        for (const k of OLD_HOOK_KEYS) {
          if (Object.hasOwn(data, k)) {
            delete data[k];
            changed = true;
          }
        }
        if (changed) {
          if (Object.keys(data).length > 0) {
            atomicWriteSync(legacyHooksJson, `${JSON.stringify(data, null, 2)}\n`);
          } else {
            unlinkSync(legacyHooksJson);
          }
        }
      }
    } catch {
      // 忽略损坏的旧配置文件
    }
  }

  process.stdout.write('已卸载 note-offload 插件（已保留插件数据目录与 ~/agy-notes/）\n');
}

main();
