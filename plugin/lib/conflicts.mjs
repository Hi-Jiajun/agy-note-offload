import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { hasConfiguredAliases, HEX8_CONV_RE, readAliases } from './aliases.mjs';
import { loadConfig } from './config.mjs';
import { getGlobalConfigDir, getHomeDir, getPluginRoot } from './paths.mjs';

const REGISTRY_REL_CANDIDATES = [
  '.agents/SESSION-REGISTRY.md',
  'research/SESSION-REGISTRY.md',
  'SESSION-REGISTRY.md',
  '.agents/control-tower/registry.md',
  'control-tower-registry.md',
];

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function sameConvId(a, b) {
  if (!a || !b) return false;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const x8 = x.slice(0, 8);
  const y8 = y.slice(0, 8);
  return x8.length >= 8 && y8.length >= 8 && (x.startsWith(y8) || y.startsWith(x8));
}

function isPluginExplicitlyDisabled(globalCfg, pluginDirName) {
  const plugins = globalCfg?.plugins;
  if (!plugins || typeof plugins !== 'object') return false;
  const entry = plugins[pluginDirName];
  return Boolean(entry && typeof entry === 'object' && entry.enabled === false);
}

function findControlTowerRegistries(workspacePaths, env = process.env, hintPath = '') {
  if (!Array.isArray(workspacePaths) || workspacePaths.length === 0) return [];
  const home = getHomeDir(env);
  const surfaceMatch = String(hintPath || '').match(/\/\.gemini\/(antigravity(?:-cli|-ide)?)\//);
  const surfaces = [...new Set([
    ...(surfaceMatch ? [surfaceMatch[1]] : []),
    'antigravity',
    'antigravity-cli',
    'antigravity-ide',
  ])];

  const seenWs = new Set();
  const found = new Set();

  for (const rawWs of workspacePaths) {
    if (!rawWs || typeof rawWs !== 'string') continue;
    let wsReal;
    try {
      wsReal = existsSync(rawWs) ? realpathSync(rawWs) : resolve(rawWs);
    } catch {
      wsReal = resolve(rawWs);
    }
    if (seenWs.has(wsReal)) continue;
    seenWs.add(wsReal);

    for (const rel of REGISTRY_REL_CANDIDATES) {
      const cand = join(wsReal, rel);
      if (existsSync(cand)) found.add(cand);
    }

    const wsHash = createHash('sha256').update(wsReal, 'utf8').digest('hex').slice(0, 16);
    if (env.AGY_CONTROL_TOWER_DATA_DIR) {
      const overrideCand = join(resolve(env.AGY_CONTROL_TOWER_DATA_DIR), 'workspaces', wsHash, 'SESSION-REGISTRY.md');
      if (existsSync(overrideCand)) found.add(overrideCand);
    }
    for (const surface of surfaces) {
      const managedCand = join(home, '.gemini', surface, 'plugin_data', 'control-tower', 'workspaces', wsHash, 'SESSION-REGISTRY.md');
      if (existsSync(managedCand)) found.add(managedCand);
    }
  }

  return [...found];
}

const CT_HANDOVER_RE =
  /(?:^|[\s([【（])\/control-tower(?=$|[\s)\]】），。！？,:;])|常驻主交流总控|换届接班|总控换届|接任(?:现役)?总控|接管(?:现役)?总控|新一任(?:现役)?总控/i;

/**
 * 判断用户输入是否显式发起 control-tower 总控换届接班或激活指令。
 * @param {string} text
 * @returns {boolean}
 */
export function isControlTowerHandoverPrompt(text) {
  const cleaned = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  return CT_HANDOVER_RE.test(cleaned);
}

/**
 * 判断指定会话是否为任意工作区 control-tower 台账的现役总控会话，或正在发起总控换届接班。
 * @param {{ convId?: string, workspacePaths?: string[], env?: NodeJS.ProcessEnv, hintPath?: string, lastUserInput?: string }} [options]
 * @returns {boolean}
 */
export function isActiveControlTowerController({
  convId = '',
  workspacePaths = [],
  env = process.env,
  hintPath = '',
  lastUserInput = '',
} = {}) {
  try {
    if (!convId || !Array.isArray(workspacePaths) || workspacePaths.length === 0) return false;
    const convShort = String(convId).trim().slice(0, 8);
    if (convShort.length < 4) return false;

    const registries = findControlTowerRegistries(workspacePaths, env, hintPath);
    if (registries.length === 0) return false;

    for (const regPath of registries) {
      try {
        const lines = readFileSync(regPath, 'utf-8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          if (!/现役总控|currentController/i.test(line)) continue;
          const windowText = lines.slice(i, i + 3).join('\n');
          const convHits = [
            ...windowText.matchAll(/conversation:\/\/([A-Za-z0-9][A-Za-z0-9_-]{3,127})/g),
            ...windowText.matchAll(/`([A-Za-z0-9][A-Za-z0-9_-]{7,127})`/g),
          ].map((m) => m[1]);
          if (convHits.some((hit) => sameConvId(hit, convId)) || windowText.toLowerCase().includes(convShort.toLowerCase())) {
            return true;
          }
        }
      } catch {
        // 忽略单个台账读取失败
      }
    }

    if (lastUserInput && isControlTowerHandoverPrompt(lastUserInput)) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function checkControlTowerSession(convId, workspacePaths, env, hintPath) {
  if (isActiveControlTowerController({ convId, workspacePaths, env, hintPath })) {
    return {
      code: 'control_tower_active_controller',
      level: 'warn',
      message: '当前会话疑似为 control-tower 现役总控会话，开启落盘或熔断拦截可能影响总控轮询与裸会话 ID 摄入',
    };
  }
  return null;
}

function checkAliasesConflicts(cfg, env, globalDir, globalCfg) {
  const issues = [];
  const hasReal = hasConfiguredAliases(env);
  if (!cfg.aliasEnabled && !hasReal) return issues;

  const rows = readAliases(env, { fallbackExample: false });
  if (rows.length === 0) return issues;

  const hexKey = rows.find((r) => HEX8_CONV_RE.test(r.key));
  if (hexKey && !isPluginExplicitlyDisabled(globalCfg, 'control-tower')) {
    issues.push({
      code: 'alias_hex8_control_tower',
      level: 'warn',
      message: `存在 8 位十六进制别名（如 ${hexKey.key}），易与 control-tower 裸会话 ID 自动识别产生冲突`,
    });
  }

  if (cfg.aliasEnabled) {
    const mcpCfg = readJsonSafe(join(globalDir, 'mcp_config.json'));
    const serverNames = mcpCfg?.mcpServers && typeof mcpCfg.mcpServers === 'object'
      ? new Set(Object.keys(mcpCfg.mcpServers).map((k) => k.toLowerCase()))
      : null;
    if (serverNames && serverNames.size > 0) {
      const hit = rows.find((r) => serverNames.has(r.key.toLowerCase()));
      if (hit) {
        issues.push({
          code: 'alias_mcp_collision',
          level: 'warn',
          message: `别名 ${hit.key} 与已配置的 MCP 服务名重名，可能造成命名歧义`,
        });
      }
    }
  }

  return issues;
}

function checkHookOverlap(cfg, globalDir, globalCfg) {
  if (!cfg.sanitizeEnabled && !cfg.aliasEnabled) return null;
  const pluginsDir = join(globalDir, 'plugins');
  if (!existsSync(pluginsDir)) return null;

  const overlapping = [];
  try {
    for (const ent of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      if (ent.name === 'note-offload') continue;
      if (isPluginExplicitlyDisabled(globalCfg, ent.name)) continue;

      const hooksPath = join(pluginsDir, ent.name, 'hooks.json');
      const hooksObj = readJsonSafe(hooksPath);
      if (!hooksObj) continue;

      let hasTargetEvent = false;
      for (const spec of Object.values(hooksObj)) {
        if (!spec || typeof spec !== 'object' || spec.enabled === false) continue;
        if (
          (Array.isArray(spec.PreToolUse) && spec.PreToolUse.length > 0) ||
          (Array.isArray(spec.Stop) && spec.Stop.length > 0)
        ) {
          hasTargetEvent = true;
          break;
        }
      }
      if (hasTargetEvent) {
        overlapping.push(ent.name);
      }
    }
  } catch {
    return null;
  }

  if (overlapping.length > 0) {
    return {
      code: 'multi_plugin_hook_overlap',
      level: 'info',
      message: `检测到同生命周期（PreToolUse/Stop）并存插件（${overlapping.join(', ')}），多插件钩子按顺序叠加可能互相影响注入与停止决策`,
    };
  }
  return null;
}

function checkPathShadowNeturl(cfg, env) {
  if (!cfg.aliasEnabled) return null;
  const rawPath = String(env.PATH || '');
  if (!rawPath) return null;

  const pluginScript = resolve(getPluginRoot(env), 'scripts', 'neturl.mjs');
  let pluginReal = '';
  try {
    pluginReal = existsSync(pluginScript) ? realpathSync(pluginScript) : pluginScript;
  } catch {
    pluginReal = pluginScript;
  }

  for (const dir of rawPath.split(delimiter)) {
    if (!dir) continue;
    const cand = join(dir, 'neturl');
    try {
      if (!existsSync(cand)) continue;
      const st = statSync(cand);
      if (!st.isFile()) continue;
      accessSync(cand, constants.X_OK);
      const realCand = realpathSync(cand);
      if (realCand !== pluginReal) {
        return {
          code: 'path_shadow_neturl',
          level: 'warn',
          message: `PATH 中存在外部同名命令 ${cand}，建议始终通过 node <插件目录>/scripts/neturl.mjs 绝对路径调用`,
        };
      }
    } catch {
      // 忽略权限或断链异常
    }
  }
  return null;
}

/**
 * 检测当前可选项及运行时环境与其他插件或官方配置间的潜在冲突风险。
 * @param {{ env?: NodeJS.ProcessEnv, convId?: string, workspacePaths?: string[], hintPath?: string, config?: { sanitizeEnabled?: boolean, aliasEnabled?: boolean } | null }} [options]
 * @returns {Array<{ code: string, level: 'warn' | 'info', message: string }>}
 */
export function detectConflicts({
  env = process.env,
  convId = '',
  workspacePaths = [],
  hintPath = '',
  config = null,
} = {}) {
  const issues = [];
  try {
    const cfg = config || loadConfig(env);
    const globalDir = getGlobalConfigDir(env);
    const globalCfg = readJsonSafe(join(globalDir, 'config.json'));

    const ctIssue = checkControlTowerSession(convId, workspacePaths, env, hintPath);
    if (ctIssue) issues.push(ctIssue);

    issues.push(...checkAliasesConflicts(cfg, env, globalDir, globalCfg));

    const hookIssue = checkHookOverlap(cfg, globalDir, globalCfg);
    if (hookIssue) issues.push(hookIssue);

    const pathIssue = checkPathShadowNeturl(cfg, env);
    if (pathIssue) issues.push(pathIssue);
  } catch {
    // 冲突检测自身永不阻塞主流程
  }
  return issues;
}
