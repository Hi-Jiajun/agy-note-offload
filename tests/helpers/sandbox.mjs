import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 创建完全隔离的临时测试沙箱，杜绝测试读写宿主机真实插件配置、数据或笔记目录。
 * @returns {{ root: string, homeDir: string, dataDir: string, noteRoot: string, configDir: string, binDir: string, brainDirs: string[], legacyDataDir: string, env: NodeJS.ProcessEnv, cleanup: () => void }}
 */
export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'agy-offload-test-'));
  const homeDir = join(root, 'home');
  const dataDir = join(root, 'data');
  const noteRoot = join(root, 'notes');
  const configDir = join(root, 'config');
  const binDir = join(root, 'bin');
  const legacyDataDir = join(root, 'legacy-data');
  const brainApp = join(root, 'brain-app');
  const brainCli = join(root, 'brain-cli');
  const brainIde = join(root, 'brain-ide');

  for (const d of [homeDir, dataDir, noteRoot, configDir, binDir, brainApp, brainCli, brainIde]) {
    mkdirSync(d, { recursive: true });
  }

  const env = {
    ...process.env,
    HOME: homeDir,
    AGY_OFFLOAD_DATA_DIR: dataDir,
    AGY_NOTE_ROOT: noteRoot,
    AGY_CONFIG_DIR: configDir,
    AGY_BIN_DIR: binDir,
    AGY_BRAIN_ROOT: [brainApp, brainCli, brainIde].join(':'),
  };
  delete env.AGY_LEGACY_DATA_DIR;
  delete env.PLUGIN_ROOT;
  delete env.PLUGIN_DATA;
  delete env.AGY_OFFLOAD_SANITIZE;
  delete env.AGY_OFFLOAD_ALIAS;
  delete env.AGY_CONTROL_TOWER_DATA_DIR;

  return {
    root,
    homeDir,
    dataDir,
    noteRoot,
    configDir,
    binDir,
    legacyDataDir,
    brainDirs: [brainApp, brainCli, brainIde],
    env,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
