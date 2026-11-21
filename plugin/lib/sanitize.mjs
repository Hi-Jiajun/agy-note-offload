import { loadConfig } from './config.mjs';
import { getDataDir, getNoteRoot, getPluginRoot, shortPath } from './paths.mjs';

const RAW_REPLACEMENTS = [
  ['\\bbypass\\b', '越过'],
  ['\\bintercept\\b', '接管'],
  ['\\bexploit\\b', '利用'],
  ['\\bpayload\\b', '报文体'],
  ['\\bfake password\\b', '免密'],
  ['\\block\\s?screen\\b', '锁屏'],
  ['\\broot ca\\b', '根证书'],
  ['安全过滤器', '内容校验'],
  ['绕开', '越过'],
  ['攻防', '对抗'],
];

const ASCII_RE = /^[\x00-\x7f]+$/;
const URI_RE = /(?:https?|file|sidecar|conversation):\/\/[^\s)\]`"'>]+/gi;

const COMPILED = RAW_REPLACEMENTS.map(([pattern, repl]) => [
  new RegExp(pattern, ASCII_RE.test(pattern) ? 'gi' : 'g'),
  repl,
]);

export const KEEP = [
  'neturl', 'net-map.tsv', 'https', 'http', 'md', 'hook',
  'decision', 'continue', 'reason', 'injectSteps', 'systemMessage',
  'metadata', 'user_markdown', 'terminationBehavior', 'terminate', 'note-offload',
  'write_file', 'run_command', 'exit_plan_mode', 'agynote', 'task.md', 'status.md',
  'local', 'share', 'bin', 'agy-note-offload',
  'config', 'scripts', 'gemini', 'gw-', 'v1', 'v2',
  'agy-notes', 'turn-', 'read_file', 'offset', 'limit', 'misc', 'agysum', 'transcript',
  'cat', 'grep', 'sed', 'tail', 'width', 'n',
  'node', 'mjs', 'plugin_data', 'antigravity', 'plugins', 'hook-',
  'agynote.mjs', 'agysum.mjs', 'neturl.mjs',
  'Orchestrator', 'Plan', 'Mode', 'Re-plan', 'if', 'stdout', 'off', 'file',
  'JSON', 'IPv4', 'sha256', 'PEM', 'CSV', 'TSV', 'YAML', 'compact',
];

const NOTE_PATH_RE = /~\/agy-notes\/[A-Za-z0-9._-]+/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z0-9_.-]*/g;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubDynamicRoot(text, absRoot, shortRoot, replacement) {
  const candidates = [...new Set([absRoot, shortRoot])]
    .map((r) => (r || '').replace(/\/+$/, ''))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  let out = text;
  for (const root of candidates) {
    const re = new RegExp(`${escapeRegex(root)}(?:/[A-Za-z0-9._-]+)?`, 'g');
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * 将注入给模型的文本执行中性化替换（仅替换敏感对抗词，先保护协议 URI 避免破坏链接）。
 * @param {string} text
 * @returns {string}
 */
export function clean(text) {
  if (!text) return text;
  const savedUris = [];
  let out = String(text).replace(URI_RE, (m) => {
    const token = `\u0000AGY_URI_${savedUris.length}\u0000`;
    savedUris.push(m);
    return token;
  });
  for (const [regex, repl] of COMPILED) {
    out = out.replace(regex, repl);
  }
  out = out.replace(/\u0000AGY_URI_(\d+)\u0000/g, (_, idx) => savedUris[Number(idx)] ?? '');
  return out;
}

/**
 * 仅当配置中开启词表中性化（sanitizeEnabled）时执行 clean()，否则原样返回。
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ sanitizeEnabled?: boolean } | null} [cfg]
 * @returns {string}
 */
export function applySanitizeIfEnabled(text, env = process.env, cfg = null) {
  const raw = text === null || text === undefined ? '' : String(text);
  const activeCfg = cfg || loadConfig(env);
  if (activeCfg && activeCfg.sanitizeEnabled === true) {
    return clean(raw);
  }
  return raw;
}

/**
 * 按需校验文本中残留的拉丁英文单词（跳过标准路径、协议 URI 与扩展白名单词）。
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function latinLeftovers(text, env = process.env) {
  let scrubbed = String(text || '').replace(URI_RE, ' ');

  const noteRoot = getNoteRoot(env);
  scrubbed = scrubDynamicRoot(scrubbed, noteRoot, shortPath(noteRoot, env), '~/agy-notes/');

  const pluginRoot = getPluginRoot(env);
  scrubbed = scrubDynamicRoot(scrubbed, pluginRoot, shortPath(pluginRoot, env), '~/agy-notes/');

  const dataDir = getDataDir(env);
  scrubbed = scrubDynamicRoot(scrubbed, dataDir, shortPath(dataDir, env), '~/agy-notes/');

  scrubbed = scrubbed.replace(NOTE_PATH_RE, '~/agy-notes/');

  const words = new Set(scrubbed.match(LATIN_WORD_RE) || []);
  const leftovers = [];
  for (const word of [...words].sort()) {
    if (KEEP.some((k) => word.startsWith(k) || word.toLowerCase() === k.toLowerCase())) continue;
    if (/^(?:n\d+\.?|[0-9]+)$/.test(word)) continue;
    if (/^(?:[0-9a-f]{8}|selftest)$/.test(word)) continue;
    leftovers.push(word);
  }
  return leftovers;
}
