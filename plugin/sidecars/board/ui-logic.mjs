/**
 * Note Offload Sidecar 前端纯逻辑模块（浏览器 ESM 与 Node L1 单元测试共享）。
 */
export const CHUNK_STEP_BYTES = 256 * 1024;
export const MD_RICH_LIMIT_BYTES = 128 * 1024;
export const DIFF_RICH_LIMIT_BYTES = 256 * 1024;
export const WS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ALIAS_KEY_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const HEX8_RE = /^[0-9a-f]{8}$/i;
export const RESERVED_ALIAS_KEYS = new Set([
  'http', 'https', 'file', 'sidecar', 'conversation', 'localhost',
  'agy', 'agynote', 'agysum', 'neturl', 'compact', 'plan', 'boost',
  'swarm', 'teamwork', 'goal',
]);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

export function badgeClass(health) {
  if (!health || health === '-') return 'muted';
  if (health.startsWith('DEAD')) return 'err';
  if (health.startsWith('RETRY')) return 'warn';
  return 'ok';
}

export function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtIsoShort(iso) {
  if (!iso) return '-';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso).slice(0, 19);
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fmtBytes(n) {
  const val = Number(n || 0);
  if (val >= 1024 * 1024) return `${(val / (1024 * 1024)).toFixed(2)} MB`;
  if (val >= 1024) return `${(val / 1024).toFixed(1)} KB`;
  return `${val} B`;
}

export function maskValue(val) {
  const s = String(val || '');
  if (s.length <= 12) return '****';
  return `${s.slice(0, 8)}***${s.slice(-4)}`;
}

export function renderInlineMd(raw) {
  const codeTokens = [];
  const withTokens = String(raw || '').replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${esc(code)}</code>`);
    return `\u0000CODE${idx}\u0000`;
  });

  let safe = esc(withTokens);
  safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => (
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  ));
  safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  safe = safe.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  safe = safe.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');

  return safe.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeTokens[Number(i)] || '');
}

export function parseTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

export function isTableSepLine(line) {
  return /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim());
}

export function renderMarkdownRich(md) {
  const lines = String(md || '').split(/\r?\n/);
  if (!lines.some((l) => l.trim())) {
    return '<div class="empty-hint">文件内容为空</div>';
  }

  const out = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length) {
        const closeTrim = lines[i].trim();
        if (
          closeTrim.length >= fenceLen &&
          closeTrim.split('').every((ch) => ch === fenceChar)
        ) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      const langLabel = lang ? `<span class="md-code-lang">${esc(lang)}</span>` : '';
      out.push(`<pre class="md-code">${langLabel}<code>${esc(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMd(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^([-*_])(?:\s*\1){2,}$/.test(trimmed)) {
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isTableSepLine(lines[i + 1])) {
      const headers = parseTableRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length) {
        const rowTrim = lines[i].trim();
        if (!rowTrim || !rowTrim.includes('|')) break;
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headers.map((h) => `<th>${renderInlineMd(h)}</th>`).join('')}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${rows.map((r) => `<tr>${headers.map((_, idx) => `<td>${renderInlineMd(r[idx] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '';
      out.push(`<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${quoteLines.map((q) => renderInlineMd(q)).join('<br>')}</blockquote>`);
      continue;
    }

    if (/^(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].trim().match(/^(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/);
        if (!m) break;
        const done = m[1].toLowerCase() === 'x';
        items.push(
          `<li class="md-task${done ? ' done' : ''}">` +
            `<span class="md-check" aria-hidden="true">${done ? '&#10003;' : ''}</span>` +
            `<span class="md-task-text">${renderInlineMd(m[2])}</span>` +
          '</li>',
        );
        i += 1;
      }
      out.push(`<ul class="md-task-list">${items.join('')}</ul>`);
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (/^[-*+]\s+\[([ xX])\]\s+/.test(t)) break;
        const m = t.match(/^[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${renderInlineMd(m[1])}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (/^\d+[.)]\s+\[([ xX])\]\s+/.test(t)) break;
        const m = t.match(/^\d+[.)]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${renderInlineMd(m[1])}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    const paraLines = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (
        !t ||
        /^(`{3,}|~{3,})/.test(t) ||
        /^#{1,4}\s+/.test(t) ||
        /^>\s?/.test(t) ||
        /^([-*_])(?:\s*\1){2,}$/.test(t) ||
        /^(?:[-*+]|\d+[.)])\s+/.test(t) ||
        (t.includes('|') && i + 1 < lines.length && isTableSepLine(lines[i + 1]))
      ) {
        break;
      }
      paraLines.push(renderInlineMd(t));
      i += 1;
    }
    if (paraLines.length) {
      out.push(`<p>${paraLines.join('<br>')}</p>`);
    }
  }

  return out.length ? out.join('') : '<div class="empty-hint">文件内容为空</div>';
}

export function renderDiffView(content) {
  const lines = String(content || '').split(/\r?\n/);
  return (
    '<div class="diff-view">' +
    lines.map((line) => {
      let cls = 'diff-line';
      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('+++ ') ||
        line.startsWith('--- ')
      ) {
        cls += ' diff-meta';
      } else if (line.startsWith('@@')) {
        cls += ' diff-hunk';
      } else if (line.startsWith('+')) {
        cls += ' diff-add';
      } else if (line.startsWith('-')) {
        cls += ' diff-del';
      }
      return `<div class="${cls}">${esc(line || ' ')}</div>`;
    }).join('') +
    '</div>'
  );
}

export function canRenderRich(fileName, content) {
  const lower = String(fileName || '').toLowerCase();
  const len = String(content || '').length;
  if (lower.endsWith('.md')) return len <= MD_RICH_LIMIT_BYTES;
  if (lower.endsWith('.diff') || lower.endsWith('.patch')) return len <= DIFF_RICH_LIMIT_BYTES;
  return false;
}

export function inferLatestTurn(ws) {
  if (ws && ws.latestTurn !== undefined) {
    return {
      latestTurn: ws.latestTurn,
      latestTurnFile: ws.latestTurnFile || (ws.latestTurn !== null ? `turn-${ws.latestTurn}.md` : ''),
    };
  }
  let latestTurn = null;
  let latestTurnFile = '';
  for (const name of (ws?.files || [])) {
    const m = /^turn-(\d+)\.md$/.exec(name);
    if (!m) continue;
    const num = Number.parseInt(m[1], 10);
    if (Number.isInteger(num) && (latestTurn === null || num > latestTurn)) {
      latestTurn = num;
      latestTurnFile = name;
    }
  }
  return { latestTurn, latestTurnFile };
}

export function splitWorkspaceFiles(ws) {
  const files = Array.isArray(ws?.files) ? ws.files : [];
  const { latestTurnFile } = inferLatestTurn(ws);
  const core = [];
  for (const fixed of ['status.md', 'task.md']) {
    if (files.includes(fixed)) core.push(fixed);
  }
  if (latestTurnFile && files.includes(latestTurnFile) && !core.includes(latestTurnFile)) {
    core.push(latestTurnFile);
  }
  if (core.length === 0) {
    core.push(...files.slice(0, 3));
  }
  const coreSet = new Set(core);
  const more = files.filter((f) => !coreSet.has(f));
  return { core, more };
}

export function wsNameFromSession(s) {
  if (s?.wsName) return s.wsName;
  const nd = String(s?.noteDir || '').replace(/\/+$/, '');
  const idx = nd.lastIndexOf('/');
  return idx >= 0 ? nd.slice(idx + 1) : nd;
}

export function isSessionWithinWindow(s, nowMs = Date.now(), windowMin = 15) {
  if (s && s.withinWindow !== undefined) return Boolean(s.withinWindow);
  return Boolean(s?.updatedAtMs && (nowMs - Number(s.updatedAtMs) <= windowMin * 60 * 1000));
}

export function matchWorkspaceFilter(w, { kw = '', wsFilter = 'all', activeConv = '' } = {}) {
  const archived = Boolean(w?.archived);
  if (wsFilter === 'archived') {
    if (!archived) return false;
  } else if (archived) {
    return false;
  }

  if (kw) {
    const lowerKw = kw.toLowerCase();
    const hit =
      String(w.name || '').toLowerCase().includes(lowerKw) ||
      String(w.summary || '').toLowerCase().includes(lowerKw) ||
      String(w.boundConvShort || '').toLowerCase().includes(lowerKw);
    if (!hit) return false;
  }
  if (wsFilter === 'bound') {
    return Boolean(w.boundConvId) || (Boolean(activeConv) && w.boundConvId === activeConv);
  }
  if (wsFilter === 'alert') {
    return String(w.health || '').startsWith('DEAD') || String(w.health || '').startsWith('RETRY');
  }
  if (wsFilter === 'todo') {
    return Number(w.taskProgress?.total || 0) > 0 && Number(w.taskProgress?.done || 0) < Number(w.taskProgress?.total || 0);
  }
  return true;
}

export function sortWorkspaces(list, { activeConv = '', wsSort = 'updated' } = {}) {
  return [...list].sort((a, b) => {
    const aCur = Boolean(activeConv && a.boundConvId === activeConv);
    const bCur = Boolean(activeConv && b.boundConvId === activeConv);
    if (aCur !== bCur) return aCur ? -1 : 1;
    if (wsSort === 'name') {
      return String(a.name || '').localeCompare(String(b.name || ''));
    }
    return Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0);
  });
}

export function validateAliasKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) {
    return { valid: true, level: 'idle', text: '1 到 32 位字母、数字、点、下划线或连字符' };
  }
  if (!ALIAS_KEY_RE.test(key)) {
    return { valid: false, level: 'err', text: '别名格式非法：仅支持字母、数字、点、下划线或连字符（1-32 位）' };
  }
  if (RESERVED_ALIAS_KEYS.has(key.toLowerCase())) {
    return { valid: false, level: 'err', text: `别名 "${key}" 为系统保留关键字，请换用其他名称` };
  }
  if (HEX8_RE.test(key)) {
    return { valid: true, level: 'warn', text: '提示：8 位十六进制别名可能与 control-tower 裸会话 ID 冲突' };
  }
  return { valid: true, level: 'ok', text: '格式合法，可通过 neturl 引用' };
}

export function classifyLogLine(line) {
  const text = String(line || '');
  if (/\b(DEAD|ERROR|FAIL|DENY|BLOCK)\b|熔断|拒绝|失败|越界/i.test(text)) return 'is-err';
  if (/\b(RETRY|WARN|CONFLICT)\b|重试|警告|冲突/i.test(text)) return 'is-warn';
  if (/\b(OK|ALLOW|PASS|RESET)\b|通过|恢复|重置/i.test(text)) return 'is-ok';
  return '';
}

export function filterLogs(logs, { logFilter = 'all', logQuery = '', activeConv8 = '' } = {}) {
  const q = String(logQuery || '').trim().toLowerCase();
  const c8 = String(activeConv8 || '').toLowerCase();
  return (logs || []).filter((line) => {
    if (logFilter === 'warn') {
      const cls = classifyLogLine(line);
      if (cls !== 'is-err' && cls !== 'is-warn') return false;
    } else if (logFilter === 'current') {
      if (!c8 || !String(line || '').toLowerCase().includes(c8)) return false;
    }
    if (q && !String(line || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

export function formatFlightLevel(level) {
  const lv = String(level || 'info').toLowerCase();
  if (lv === 'error') return { label: 'ERR', cls: 'err' };
  if (lv === 'warn') return { label: 'WARN', cls: 'warn' };
  return { label: 'INFO', cls: 'muted' };
}

export function formatFlightSummaryText(summary) {
  if (!summary || typeof summary !== 'object') return '暂无 24h 飞行记录';
  const total = Number(summary.total || 0);
  const err = Number(summary.byLevel?.error || 0);
  const warn = Number(summary.byLevel?.warn || 0);
  const slow = Number(summary.slowCount || 0);
  return `近 24h ${total} 事件 / ${err} 错误 / ${warn} 警告 / ${slow} 慢调用`;
}

export function formatHeartbeatText(hb, nowMs = Date.now()) {
  if (!hb || typeof hb !== 'object' || !Number.isFinite(hb.tsMs)) {
    return 'Hook 存活：等待首次宿主拉起';
  }
  const diffSec = Math.max(0, Math.floor((nowMs - hb.tsMs) / 1000));
  let age;
  if (diffSec < 60) age = '刚刚';
  else if (diffSec < 3600) age = `${Math.floor(diffSec / 60)} 分钟前`;
  else if (diffSec < 48 * 3600) age = `${Math.floor(diffSec / 3600)} 小时前`;
  else age = `${Math.floor(diffSec / (24 * 3600))} 天前`;
  const evPart = hb.event ? ` (${hb.event})` : '';
  return `Hook 存活：${age}${evPart}`;
}
