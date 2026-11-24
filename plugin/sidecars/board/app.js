import {
  badgeClass,
  canRenderRich,
  CHUNK_STEP_BYTES,
  classifyLogLine,
  esc,
  filterLogs,
  fmtBytes,
  fmtIsoShort,
  fmtTime,
  formatFlightLevel,
  formatFlightSummaryText,
  formatHeartbeatText,
  inferLatestTurn,
  isSessionWithinWindow,
  maskValue,
  matchWorkspaceFilter,
  renderDiffView,
  renderMarkdownRich,
  sortWorkspaces,
  splitWorkspaceFiles,
  validateAliasKey,
  WS_NAME_RE,
  wsNameFromSession,
} from './ui-logic.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const uiToken = params.get('token') || '';

const state = {
  tab: 'workspaces',
  snap: null,
  search: '',
  wsFilter: 'all',
  wsSort: 'updated',
  wsFilterOpen: false,
  settingsOpen: false,
  conflictsExpanded: false,
  conflictsAutoInitialized: false,
  selectedWs: '',
  selectedFile: '',
  fileMeta: null,
  fileSig: '',
  chunkOffset: 0,
  forceFull: false,
  viewRaw: false,
  editing: false,
  editConfirmed: false,
  pendingNavAction: null,
  externalChange: null,
  revealAliases: false,
  aliasFormOpen: false,
  editingAliasKey: '',
  confirmDeleteAliasKey: '',
  confirmDeleteTimer: null,
  logFilter: 'all',
  logQuery: '',
  lastLogSig: '',
  diagOpen: false,
  diagLevel: '',
  diagEvents: [],
  diagConfirmClear: false,
  diagConfirmTimer: null,
  resetSettingsConfirm: false,
  resetSettingsTimer: null,
  configSaving: false,
  toastTimer: null,
  lastViewSig: '',
  refreshing: false,
};

  function syncTheme() {
    let theme = '';
    const inlineBg = document.documentElement.style.getPropertyValue('--background').trim();
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    if (inlineBg || (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent')) {
      const nums = (c.match(/[\d.]+/g) || []).map(Number);
      if (nums.length >= 3) {
        const scale = c.startsWith('color(') ? 1 : 255;
        const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        theme = lum < 0.5 ? 'dark' : 'light';
      }
    }
    if (!theme && window.matchMedia) {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', syncTheme);
    }
  }

  function showToast(msg, isErr = false) {
    const el = $('toast');
    el.textContent = msg;
    el.className = isErr ? 'toast error' : 'toast';
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }

  async function apiPost(path, body = {}) {
    if (window.sidecar?.fetch) {
      const res = await window.sidecar.fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (uiToken) headers['x-sidecar-token'] = uiToken;
    const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function getActiveConvId(snap = state.snap) {
    return window.sidecar?.conversationId || snap?.activeConversationId || '';
  }

  function jumpToConversation(convId) {
    if (!convId) return;
    if (window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(convId);
      return;
    }
    void copyText(convId).then((ok) => {
      showToast(ok ? `已复制会话 ID: ${convId.slice(0, 8)}` : '复制失败', !ok);
    });
  }

  function launchPromptFor(wsName) {
    const root = (state.snap?.noteRoot || '~/agy-notes').replace(/\/+$/, '');
    return `/note-offload 读取 ${root}/${wsName}/task.md 与 status.md，执行下一未完成阶段并落盘汇报。`;
  }

  function renderFileViewer(fileName, content) {
    const viewer = $('file-viewer');
    const lower = String(fileName || '').toLowerCase();
    if (!content) {
      viewer.innerHTML = '<div class="empty-hint">文件内容为空</div>';
      return;
    }
    if (!state.viewRaw && canRenderRich(fileName, content)) {
      if (lower.endsWith('.md')) {
        viewer.innerHTML = renderMarkdownRich(content);
        return;
      }
      if (lower.endsWith('.diff') || lower.endsWith('.patch')) {
        viewer.innerHTML = renderDiffView(content);
        return;
      }
    }
    viewer.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'raw-pre';
    const code = document.createElement('code');
    code.textContent = content;
    pre.appendChild(code);
    viewer.appendChild(pre);
  }

  function isEditorDirty() {
    if (!state.editing) return false;
    return $('file-editor').value !== (state.fileMeta?.content ?? '');
  }

  function updateEditorStatusBar() {
    const text = $('file-editor').value;
    const lines = text ? text.split(/\r?\n/).length : 0;
    const dirty = isEditorDirty();
    $('editor-dirty-badge').classList.toggle('hidden', !dirty);
    $('editor-stats').textContent = `${lines} 行 / ${text.length} 字  Ctrl+S 保存`;
  }

  function hideDirtyGuard() {
    state.pendingNavAction = null;
    $('dirty-guard-bar').classList.add('hidden');
  }

  function hideExternalChangeBar() {
    state.externalChange = null;
    $('external-change-bar').classList.add('hidden');
  }

  function guardDirtyNavigation(actionFn, promptText = '') {
    if (!isEditorDirty()) {
      hideDirtyGuard();
      actionFn();
      return true;
    }
    state.pendingNavAction = actionFn;
    $('dirty-guard-text').textContent = promptText || '当前编辑内容尚未保存，是否保存后再离开？';
    $('dirty-guard-bar').classList.remove('hidden');
    return false;
  }

  function enterEditMode(content) {
    state.editing = true;
    hideDirtyGuard();
    hideExternalChangeBar();
    $('edit-risk-bar').classList.add('hidden');
    $('file-viewer').classList.add('hidden');
    $('file-editor-wrap').classList.remove('hidden');
    $('file-editor').value = content;
    updateEditorStatusBar();
    updateEditControls(state.fileMeta);
    $('file-editor').focus();
  }

  function exitEditModeToViewer() {
    state.editing = false;
    hideDirtyGuard();
    hideExternalChangeBar();
    $('file-editor-wrap').classList.add('hidden');
    $('file-viewer').classList.remove('hidden');
    if (state.fileMeta) {
      renderFileViewer(state.selectedFile, state.fileMeta.content);
    }
    updateEditControls(state.fileMeta);
  }

  function computeSnapshotSig(snap) {
    if (!snap) return '';
    return JSON.stringify({
      tab: state.tab,
      search: state.search,
      wsFilter: state.wsFilter,
      wsSort: state.wsSort,
      wsSel: state.selectedWs,
      fileSel: state.selectedFile,
      reveal: state.revealAliases,
      activeConv: getActiveConvId(snap),
      noteRoot: snap.noteRoot,
      dataDir: snap.dataDir,
      config: snap.config,
      hasRealAliases: snap.hasRealAliases,
      aliasesIsExample: snap.aliasesIsExample,
      emptyWorkspaceCount: snap.emptyWorkspaceCount,
      archivedCount: snap.archivedCount,
      conflicts: snap.conflicts,
      workspaces: snap.workspaces.map((w) => [
        w.name,
        w.updatedAtMs,
        w.health,
        w.step,
        w.fileCount,
        w.summary,
        w.boundConvId,
        w.sessionCount,
        w.archived,
        w.taskProgress,
        w.turnCount,
        w.latestTurn,
      ]),
      trackedSessions: snap.trackedSessions.map((s) => [
        s.convId,
        s.wsName,
        s.health,
        s.step,
        s.withinWindow,
        s.updatedAtMs,
        s.noteDir,
      ]),
      aliases: snap.aliases,
      logs: snap.logs,
      flightSummary: snap.flightSummary,
      heartbeat: snap.heartbeat,
    });
  }

  function renderHeaderAndSettings(snap) {
    const activeWsCount = (snap.workspaces || []).filter((w) => !w.archived).length;
    const archivedCount = Number(snap.archivedCount ?? (snap.workspaces || []).filter((w) => w.archived).length);
    const deadCount = snap.trackedSessions.filter((s) => s.dead).length;
    const summaryEl = $('top-summary');
    summaryEl.textContent = deadCount
      ? `${activeWsCount} 工作台 / ${deadCount} 熔断`
      : `${activeWsCount} 工作台`;
    summaryEl.classList.toggle('has-alert', deadCount > 0);

    $('settings-version').textContent = snap.version ? `v${snap.version}` : '';
    $('settings-version').classList.toggle('hidden', !snap.version);

    $('tab-count-workspaces').textContent = activeWsCount ? String(activeWsCount) : '';
    $('seg-ws-archived').textContent = archivedCount > 0 ? `已归档 (${archivedCount})` : '已归档';
    $('tab-count-aliases').textContent = snap.aliases.length ? String(snap.aliases.length) : '';
    const alertSessions = snap.trackedSessions.filter((s) => s.dead || s.tries > 0).length;
    $('tab-count-monitor').textContent = alertSessions
      ? String(alertSessions)
      : (snap.trackedSessions.length ? String(snap.trackedSessions.length) : '');

    const cfg = snap.config || {
      sanitizeEnabled: false,
      aliasEnabled: false,
      orchestratorConfirm: 'once',
      orchestratorConfirmedOnce: false,
      maxRetry: 2,
      retryWindowMin: 15,
      zeroOutLimit: 2,
      longAnswerTokens: 800,
      bigContextTokens: 120000,
    };
    $('opt-sanitize').checked = Boolean(cfg.sanitizeEnabled);
    $('opt-alias').checked = Boolean(cfg.aliasEnabled);
    $('opt-alias-inline').checked = Boolean(cfg.aliasEnabled);
    $('opt-sanitize').disabled = state.configSaving;
    $('opt-alias').disabled = state.configSaving;
    $('opt-alias-inline').disabled = state.configSaving;

    const orchSel = $('opt-orch-confirm');
    orchSel.value = cfg.orchestratorConfirm || 'once';
    orchSel.disabled = state.configSaving;
    const orchStatus = $('orch-once-status');
    const resetOrchBtn = $('btn-reset-orch-once');
    if (cfg.orchestratorConfirm === 'once') {
      orchStatus.textContent = cfg.orchestratorConfirmedOnce
        ? '已全局记住首次确认（后续 Orchestrator 免重复弹窗）'
        : '首次在 Orchestrator 启用时确认一次后全局记住';
      resetOrchBtn.classList.toggle('hidden', !cfg.orchestratorConfirmedOnce);
    } else if (cfg.orchestratorConfirm === 'per_session') {
      orchStatus.textContent = '每个 Orchestrator 新会话首次启用时确认（总控始终按会话确认）';
      resetOrchBtn.classList.add('hidden');
    } else {
      orchStatus.textContent = '已关闭 Orchestrator 确认卡（control-tower 总控仍受保护）';
      resetOrchBtn.classList.add('hidden');
    }

    const numBindings = [
      ['opt-max-retry', cfg.maxRetry],
      ['opt-retry-window', cfg.retryWindowMin],
      ['opt-zero-limit', cfg.zeroOutLimit],
      ['opt-long-tokens', cfg.longAnswerTokens],
      ['opt-big-ctx', cfg.bigContextTokens],
    ];
    for (const [id, val] of numBindings) {
      const inp = $(id);
      if (inp && document.activeElement !== inp) {
        inp.value = String(val ?? '');
      }
      if (inp) inp.disabled = state.configSaving;
    }
    $('btn-save-settings').disabled = state.configSaving;
    const resetBtn = $('btn-reset-settings');
    resetBtn.disabled = state.configSaving;
    resetBtn.textContent = state.resetSettingsConfirm ? '确认恢复默认?' : '恢复默认';
    resetBtn.className = state.resetSettingsConfirm ? 'btn danger xs' : 'btn ghost xs';

    $('env-note-root').textContent = snap.noteRoot || '~/agy-notes';
    $('env-data-dir').textContent = snap.dataDir || 'plugin_data/note-offload';

    const hasConflicts = Array.isArray(snap.conflicts) && snap.conflicts.length > 0;
    const dot = $('settings-conflict-dot');
    dot.classList.toggle('hidden', !hasConflicts);
    dot.classList.toggle('warn', hasConflicts);
  }

  function renderConflicts(conflicts) {
    const banner = $('conflict-banner');
    if (!conflicts || !conflicts.length) {
      banner.classList.add('hidden');
      $('conflict-list').innerHTML = '';
      state.conflictsAutoInitialized = false;
      return;
    }
    banner.classList.remove('hidden');
    if (!state.conflictsAutoInitialized) {
      state.conflictsExpanded = conflicts.some((c) => c.level === 'warn');
      state.conflictsAutoInitialized = true;
    }
    $('conflict-summary').textContent = `检测到 ${conflicts.length} 条兼容性或配置提示`;
    const list = $('conflict-list');
    list.innerHTML = conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('');
    list.classList.toggle('hidden', !state.conflictsExpanded);
    const btn = $('btn-toggle-conflicts');
    btn.textContent = state.conflictsExpanded ? '收起' : '展开';
    btn.setAttribute('aria-expanded', state.conflictsExpanded ? 'true' : 'false');
  }

  function renderWorkspaces() {
    const snap = state.snap;
    if (!snap) return;

    const activeConv = getActiveConvId(snap);
    const kw = state.search.trim().toLowerCase();

    const emptyCount = snap.emptyWorkspaceCount !== undefined
      ? Number(snap.emptyWorkspaceCount || 0)
      : (snap.workspaces || []).filter((w) => Number(w.fileCount || 0) === 0).length;
    const emptyBar = $('empty-clean-bar');
    if (emptyCount > 0) {
      emptyBar.classList.remove('hidden');
      $('empty-clean-text').textContent = `检测到 ${emptyCount} 个 0 文件空目录`;
    } else {
      emptyBar.classList.add('hidden');
    }

    const filterActive = state.wsFilter !== 'all' || state.wsSort !== 'updated';
    $('ws-filter-dot').classList.toggle('hidden', !filterActive);

    const list = sortWorkspaces(
      snap.workspaces.filter((w) => matchWorkspaceFilter(w, { kw, wsFilter: state.wsFilter, activeConv })),
      { activeConv, wsSort: state.wsSort },
    );

    const container = $('ws-list');
    if (!list.length) {
      const emptyMsg = snap.workspaces.length
        ? '没有符合当前筛选条件的工作台'
        : '暂无落盘工作台，点击右上角「+ 新建」即可创建';
      container.innerHTML = `<div class="empty-hint">${emptyMsg}</div>`;
      return;
    }

    container.innerHTML = list.map((w) => {
      const cls = badgeClass(w.health);
      const isCurrent = Boolean(activeConv && w.boundConvId === activeConv);
      const prog = w.taskProgress || { done: 0, total: 0 };
      const progDone = prog.total > 0 && prog.done >= prog.total;
      const { latestTurn } = inferLatestTurn(w);
      const tags = [];
      if (prog.total > 0) {
        tags.push(`<span class="tag-pill ${progDone ? 'ok' : 'muted'} tabular">待办 ${prog.done}/${prog.total}</span>`);
      }
      if (latestTurn !== null && latestTurn !== undefined) {
        tags.push(`<span class="tag-pill muted tabular">turn-${latestTurn}</span>`);
      }
      if (w.boundConvShort) {
        const sessLabel = Number(w.sessionCount || 0) > 1
          ? `会话 ${esc(w.boundConvShort)} (+${w.sessionCount - 1})`
          : `会话 ${esc(w.boundConvShort)}`;
        tags.push(`<span class="tag-pill muted tabular">${sessLabel}</span>`);
      }
      if (w.archived) {
        tags.push('<span class="tag-pill warn">已归档</span>');
      }

      const metaParts = [`${w.fileCount} 文件`];
      if (w.step != null) metaParts.push(`步数 ${w.step}`);
      metaParts.push(fmtTime(w.updatedAtMs));

      const summary = w.summary ? esc(w.summary) : '暂无状态摘要';
      return `
        <div class="card ws-card${isCurrent ? ' is-current' : ''}" data-ws="${esc(w.name)}">
          <div class="ws-head">
            <div class="ws-title-wrap">
              <span class="ws-name">${esc(w.name)}</span>
              ${isCurrent ? '<span class="tag-pill primary">当前会话</span>' : ''}
            </div>
            <span class="badge ${cls}">${esc(w.health)}</span>
          </div>
          <div class="ws-meta tabular">${metaParts.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
          <div class="ws-summary">${summary}</div>
          <div class="ws-foot">
            <div class="ws-tags">${tags.join('')}</div>
            <div class="ws-actions">
              <button type="button" class="btn secondary xs act-copy" data-ws="${esc(w.name)}">复制启动词</button>
              ${w.boundConvId ? `<button type="button" class="btn ghost xs act-jump" data-conv="${esc(w.boundConvId)}">切换会话</button>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    for (const card of container.querySelectorAll('.ws-card')) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        void openWorkspace(card.dataset.ws);
      });
    }
    for (const btn of container.querySelectorAll('.act-copy')) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await copyText(launchPromptFor(btn.dataset.ws));
        showToast(ok ? '已复制启动词，直接粘贴发给新会话即可' : '复制失败', !ok);
      });
    }
    for (const btn of container.querySelectorAll('.act-jump')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToConversation(btn.dataset.conv);
      });
    }
  }

  function renderDetailHeader() {
    const ws = state.snap?.workspaces.find((w) => w.name === state.selectedWs);
    if (!ws) {
      backToList(true);
      return null;
    }
    const activeConv = getActiveConvId();
    const isCurrent = Boolean(activeConv && ws.boundConvId === activeConv);

    $('detail-name').textContent = ws.name;
    $('detail-current-tag').classList.toggle('hidden', !isCurrent);

    const badge = $('detail-health');
    badge.textContent = ws.health;
    badge.className = `badge ${badgeClass(ws.health)}`;

    const jumpBtn = $('btn-jump-conv');
    if (ws.boundConvId) {
      jumpBtn.classList.remove('hidden');
      jumpBtn.onclick = () => jumpToConversation(ws.boundConvId);
    } else {
      jumpBtn.classList.add('hidden');
    }

    const archBtn = $('btn-archive-ws');
    archBtn.textContent = ws.archived ? '取消归档' : '归档';

    const sessionsWrap = $('detail-sessions');
    const boundList = Array.isArray(ws.boundSessions) ? ws.boundSessions : [];
    if (boundList.length > 0) {
      sessionsWrap.classList.remove('hidden');
      sessionsWrap.innerHTML =
        `<span class="muted">关联会话 (${boundList.length})</span>` +
        boundList.map((s) => {
          const isCur = Boolean(activeConv && s.convId === activeConv);
          const stepTxt = s.step != null ? ` #${s.step}` : '';
          return (
            `<button type="button" class="session-chip${isCur ? ' is-current' : ''}" data-conv="${esc(s.convId)}" title="点击切换或复制会话 ID">` +
              `<span class="tabular">${esc(s.convShort)}${esc(stepTxt)}</span>` +
              `<span class="badge ${badgeClass(s.health)}">${esc(s.health)}</span>` +
            '</button>'
          );
        }).join('');
      for (const chip of sessionsWrap.querySelectorAll('.session-chip')) {
        chip.addEventListener('click', () => jumpToConversation(chip.dataset.conv));
      }
    } else {
      sessionsWrap.classList.add('hidden');
      sessionsWrap.innerHTML = '';
    }

    const { core, more } = splitWorkspaceFiles(ws);
    const pills = $('file-core-pills');
    if (!ws.files.length) {
      pills.innerHTML = '<span class="muted">目录暂无文件</span>';
      $('file-more-wrap').classList.add('hidden');
      return ws;
    }

    pills.innerHTML = core.map((f) =>
      `<button type="button" class="pill ${f === state.selectedFile ? 'active' : ''}" data-file="${esc(f)}">${esc(f)}</button>`,
    ).join('');
    for (const p of pills.querySelectorAll('.pill')) {
      p.addEventListener('click', () => {
        const target = p.dataset.file;
        if (target === state.selectedFile) return;
        guardDirtyNavigation(() => {
          void loadFile(ws.name, target);
        });
      });
    }

    const moreWrap = $('file-more-wrap');
    const moreSel = $('file-more-select');
    if (more.length > 0) {
      moreWrap.classList.remove('hidden');
      moreSel.innerHTML =
        `<option value="">更多文件 (${more.length})</option>` +
        more.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
      const selectedInMore = more.includes(state.selectedFile);
      moreSel.value = selectedInMore ? state.selectedFile : '';
      moreSel.classList.toggle('set', selectedInMore);
    } else {
      moreWrap.classList.add('hidden');
      moreSel.innerHTML = '';
    }

    return ws;
  }

  function updateChunkControls(data) {
    const bar = $('chunk-bar');
    if (!data || (!data.chunked && Number(data.totalBytes || 0) <= 1024 * 1024)) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const prevBtn = $('btn-chunk-prev');
    const nextBtn = $('btn-chunk-next');
    const tailBtn = $('btn-chunk-tail');
    const fullBtn = $('btn-chunk-full');

    if (data.chunked) {
      const start = Number(data.offset || 0);
      const end = start + Number(data.length || 0);
      $('chunk-info').textContent = `分片只读：${fmtBytes(start)} - ${fmtBytes(end)} / 共 ${fmtBytes(data.totalBytes)}`;
      prevBtn.classList.remove('hidden');
      nextBtn.classList.remove('hidden');
      tailBtn.classList.remove('hidden');
      prevBtn.disabled = !data.hasPrev;
      nextBtn.disabled = !data.hasNext;
      if (data.canForceFull) {
        fullBtn.classList.remove('hidden');
        fullBtn.textContent = '加载全文';
      } else {
        fullBtn.classList.add('hidden');
      }
    } else {
      $('chunk-info').textContent = `已完整加载（共 ${fmtBytes(data.totalBytes)}）`;
      prevBtn.classList.add('hidden');
      nextBtn.classList.add('hidden');
      tailBtn.classList.add('hidden');
      fullBtn.classList.remove('hidden');
      fullBtn.textContent = '切回分片';
    }
  }

  function updateEditControls(data) {
    const toggleBtn = $('btn-toggle-edit');
    const rawBtn = $('btn-toggle-raw');
    const riskBar = $('edit-risk-bar');

    if (!data || data.chunked) {
      toggleBtn.classList.add('hidden');
      rawBtn.classList.add('hidden');
      riskBar.classList.add('hidden');
      state.editing = false;
      return;
    }

    const showRawBtn = !state.editing && canRenderRich(state.selectedFile, data.content);
    rawBtn.classList.toggle('hidden', !showRawBtn);
    if (showRawBtn) {
      rawBtn.textContent = state.viewRaw ? '预览' : '源码';
    }

    if (data.directEditable) {
      toggleBtn.classList.remove('hidden');
      riskBar.classList.add('hidden');
      toggleBtn.textContent = state.editing ? '切回预览' : '在线编辑';
      return;
    }

    if (data.confirmEditable) {
      toggleBtn.classList.remove('hidden');
      toggleBtn.textContent = state.editing
        ? '切回预览'
        : (state.editConfirmed ? '在线编辑' : '解锁编辑');
      return;
    }

    toggleBtn.classList.add('hidden');
    riskBar.classList.add('hidden');
    state.editing = false;
  }

  async function openWorkspace(wsName) {
    state.selectedWs = wsName;
    state.selectedFile = '';
    state.fileMeta = null;
    state.fileSig = '';
    state.chunkOffset = 0;
    state.forceFull = false;
    state.viewRaw = false;
    state.editing = false;
    state.editConfirmed = false;
    state.lastViewSig = '';
    hideDirtyGuard();
    hideExternalChangeBar();

    $('ws-list-view').classList.add('hidden');
    $('ws-detail-view').classList.remove('hidden');
    const ws = renderDetailHeader();
    if (!ws) return;

    const targetFile = ws.files.includes('status.md')
      ? 'status.md'
      : (ws.files.includes('task.md') ? 'task.md' : ws.files[0] || '');

    if (targetFile) {
      await loadFile(wsName, targetFile);
    } else {
      $('current-file-path').textContent = ws.shortPath;
      $('current-file-meta').textContent = '';
      $('file-viewer').innerHTML = '<div class="empty-hint">该目录暂无可读文件</div>';
      $('file-viewer').classList.remove('hidden');
      $('file-editor-wrap').classList.add('hidden');
      $('chunk-bar').classList.add('hidden');
      $('edit-risk-bar').classList.add('hidden');
      $('btn-toggle-edit').classList.add('hidden');
      $('btn-toggle-raw').classList.add('hidden');
    }
  }

  function backToList(force = false) {
    const doBack = () => {
      state.selectedWs = '';
      state.selectedFile = '';
      state.fileMeta = null;
      state.fileSig = '';
      state.chunkOffset = 0;
      state.forceFull = false;
      state.viewRaw = false;
      state.editing = false;
      state.editConfirmed = false;
      state.lastViewSig = '';
      hideDirtyGuard();
      hideExternalChangeBar();
      $('ws-detail-view').classList.add('hidden');
      $('ws-list-view').classList.remove('hidden');
      renderWorkspaces();
    };
    if (force) {
      doBack();
    } else {
      guardDirtyNavigation(doBack, '离开详情页将丢失未保存修改，是否保存？');
    }
  }

  async function checkExternalFileChange() {
    if (!state.editing || !state.selectedWs || !state.selectedFile || state.fileMeta?.chunked || !state.fileSig) {
      return;
    }
    try {
      const data = await apiPost('/api/file', {
        workspace: state.selectedWs,
        file: state.selectedFile,
        offset: 0,
        mode: state.forceFull ? 'full' : 'auto',
        knownSig: state.fileSig,
      });
      if (data.unchanged || data.chunked) return;
      if (state.externalChange?.sig === data.sig) return;

      if (!isEditorDirty()) {
        state.fileSig = data.sig || `${data.updatedAtMs}:${data.size}`;
        state.fileMeta = data;
        $('file-editor').value = data.content;
        $('current-file-meta').textContent = `${fmtBytes(data.size)}  ${fmtTime(data.updatedAtMs)}`;
        updateEditorStatusBar();
        showToast('磁盘文件已更新，已自动同步最新版本');
        return;
      }

      state.externalChange = data;
      $('external-change-text').textContent = `磁盘上的 ${state.selectedFile} 已被更新（${fmtTime(data.updatedAtMs)}），当前保留你的未保存草稿。`;
      $('external-change-bar').classList.remove('hidden');
    } catch {
      // 忽略瞬时读取错误
    }
  }

  async function loadFile(wsName, fileName, options = {}) {
    const { preserveIfEditing = false, force = false } = options;
    if (preserveIfEditing && state.editing) return;

    const switchedFile = wsName !== state.selectedWs || fileName !== state.selectedFile;
    if (switchedFile) {
      state.selectedWs = wsName;
      state.selectedFile = fileName;
      state.fileSig = '';
      state.fileMeta = null;
      state.chunkOffset = 0;
      state.forceFull = false;
      state.viewRaw = false;
      state.editing = false;
      state.editConfirmed = false;
      hideDirtyGuard();
      hideExternalChangeBar();
      $('edit-risk-bar').classList.add('hidden');
    }
    if (typeof options.offset === 'number') {
      state.chunkOffset = Math.max(0, options.offset);
    }
    if (typeof options.mode === 'string') {
      state.forceFull = options.mode === 'full';
    }

    renderDetailHeader();
    const contentEl = $('main-content');
    const prevScroll = !switchedFile && contentEl ? contentEl.scrollTop : 0;

    try {
      const reqBody = {
        workspace: wsName,
        file: fileName,
        offset: state.chunkOffset,
        mode: state.forceFull ? 'full' : 'auto',
      };
      if (preserveIfEditing && !force && !switchedFile && state.fileSig) {
        reqBody.knownSig = state.fileSig;
      }

      const data = await apiPost('/api/file', reqBody);
      if (data.unchanged) {
        return;
      }

      state.fileSig = data.sig || `${data.updatedAtMs}:${data.size}`;
      state.fileMeta = data;
      state.chunkOffset = Number(data.offset || 0);
      $('current-file-path').textContent = data.shortPath;
      $('current-file-meta').textContent = `${fmtBytes(data.size)}  ${fmtTime(data.updatedAtMs)}`;

      updateChunkControls(data);
      updateEditControls(data);

      const canEditNow = !data.chunked && (data.directEditable || (data.confirmEditable && state.editConfirmed));
      if (state.editing && canEditNow) {
        enterEditMode(data.content);
      } else {
        $('file-editor-wrap').classList.add('hidden');
        $('file-viewer').classList.remove('hidden');
        renderFileViewer(fileName, data.content);
        if (!switchedFile && contentEl) {
          contentEl.scrollTop = prevScroll;
        }
      }
    } catch (err) {
      showToast(err.message || '读取文件失败', true);
    }
  }

  async function saveCurrentFile() {
    if (!state.selectedWs || !state.selectedFile) return false;
    if (state.fileMeta?.chunked) {
      showToast('分片只读模式下禁止保存，请先加载全文', true);
      return false;
    }
    try {
      await apiPost('/api/workspace/save', {
        workspace: state.selectedWs,
        file: state.selectedFile,
        content: $('file-editor').value,
        chunked: false,
        confirmRisk: Boolean(state.editConfirmed),
      });
      state.editing = false;
      state.fileSig = '';
      hideExternalChangeBar();
      showToast(`已保存 ${state.selectedFile}`);
      await refreshAll(true);
      await loadFile(state.selectedWs, state.selectedFile, { force: true });
      return true;
    } catch (err) {
      showToast(err.message || '保存失败', true);
      return false;
    }
  }

  function openAliasForm(row = null) {
    state.aliasFormOpen = true;
    $('alias-form').classList.remove('hidden');
    if (row) {
      state.editingAliasKey = row.key;
      $('alias-form-title').textContent = `编辑别名：${row.key}`;
      $('alias-key').value = row.key;
      $('alias-note').value = row.note || '';
      $('alias-val').value = row.value;
      $('btn-alias-submit').textContent = '更新别名';
      updateAliasKeyHint();
      $('alias-val').focus();
    } else {
      state.editingAliasKey = '';
      $('alias-form-title').textContent = '新增别名映射';
      $('alias-key').value = '';
      $('alias-note').value = '';
      $('alias-val').value = '';
      $('btn-alias-submit').textContent = '保存别名';
      updateAliasKeyHint();
      $('alias-key').focus();
    }
  }

  function closeAliasForm() {
    state.aliasFormOpen = false;
    state.editingAliasKey = '';
    $('alias-form').classList.add('hidden');
  }

  function updateAliasKeyHint() {
    const check = validateAliasKey($('alias-key').value);
    const hint = $('alias-key-hint');
    const input = $('alias-key');
    input.classList.toggle('invalid', !check.valid);
    hint.className = check.level === 'err' ? 'field-hint err' : (check.level === 'warn' ? 'field-hint warn' : 'field-hint');
    hint.textContent = check.text;
  }

  function renderAliases() {
    const snap = state.snap;
    if (!snap) return;

    if (snap.dataDir) {
      $('alias-map-path').textContent = `${snap.dataDir}/net-map.tsv`;
    }

    const enabled = Boolean(snap.config?.aliasEnabled);
    const isExample = snap.aliasesIsExample !== undefined
      ? Boolean(snap.aliasesIsExample)
      : (!snap.hasRealAliases && (snap.aliases || []).length > 0);
    $('alias-example-banner').classList.toggle('hidden', !isExample);

    $('alias-status-hint').textContent = enabled
      ? (snap.hasRealAliases ? '已开启按需注入，真实别名表已生效' : '已开启按需注入，保存真实别名后即生效')
      : '默认关闭自动注入，可在此随时切换';

    const rows = snap.aliases || [];
    const el = $('alias-list');
    if (!rows.length) {
      el.innerHTML = '<div class="empty-hint">暂未配置远端地址别名，点击「+ 新增别名」添加</div>';
      return;
    }

    el.innerHTML = rows.map((r) => {
      const confirming = state.confirmDeleteAliasKey === r.key;
      const valText = state.revealAliases ? r.value : maskValue(r.value);
      return `
        <div class="card alias-row">
          <div class="alias-info">
            <div class="alias-head">
              <strong>${esc(r.key)}</strong>
              ${isExample ? '<span class="tag-pill warn">示例</span>' : ''}
              ${r.note ? `<span class="muted">${esc(r.note)}</span>` : ''}
            </div>
            <div class="alias-val">${esc(valText)}</div>
          </div>
          <div class="row-gap">
            <button type="button" class="btn ghost xs act-copy-alias" data-key="${esc(r.key)}">复制</button>
            <button type="button" class="btn secondary xs act-edit-alias" data-key="${esc(r.key)}">编辑</button>
            <button type="button" class="btn ${confirming ? 'danger' : 'ghost'} xs act-del-alias" data-key="${esc(r.key)}">
              ${confirming ? '确认删除?' : '删除'}
            </button>
          </div>
        </div>
      `;
    }).join('');

    for (const btn of el.querySelectorAll('.act-copy-alias')) {
      btn.addEventListener('click', async () => {
        const ok = await copyText(btn.dataset.key);
        showToast(ok ? `已复制别名 ${btn.dataset.key}` : '复制失败', !ok);
      });
    }

    for (const btn of el.querySelectorAll('.act-edit-alias')) {
      btn.addEventListener('click', () => {
        const hit = rows.find((r) => r.key === btn.dataset.key);
        if (hit) openAliasForm(hit);
      });
    }

    for (const btn of el.querySelectorAll('.act-del-alias')) {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        if (state.confirmDeleteAliasKey !== key) {
          state.confirmDeleteAliasKey = key;
          clearTimeout(state.confirmDeleteTimer);
          state.confirmDeleteTimer = setTimeout(() => {
            if (state.confirmDeleteAliasKey === key) {
              state.confirmDeleteAliasKey = '';
              if (state.tab === 'aliases') renderAliases();
            }
          }, 3000);
          renderAliases();
          return;
        }
        clearTimeout(state.confirmDeleteTimer);
        state.confirmDeleteAliasKey = '';
        try {
          await apiPost('/api/alias/delete', { key });
          showToast(`已删除别名 ${key}`);
          await refreshAll(true);
        } catch (err) {
          showToast(err.message || '删除失败', true);
        }
      });
    }
  }

  function getFilteredLogs() {
    const snap = state.snap;
    return filterLogs(snap?.logs || [], {
      logFilter: state.logFilter,
      logQuery: state.logQuery,
      activeConv8: getActiveConvId(snap).slice(0, 8),
    });
  }

  function renderDiagnosticsPanel() {
    $('diag-summary').textContent = formatFlightSummaryText(state.snap?.flightSummary);
    $('diag-heartbeat').textContent = formatHeartbeatText(state.snap?.heartbeat);
    $('diag-drawer').classList.toggle('hidden', !state.diagOpen);
    const toggleBtn = $('btn-toggle-diag');
    toggleBtn.textContent = state.diagOpen ? '收起' : '展开';
    toggleBtn.setAttribute('aria-expanded', state.diagOpen ? 'true' : 'false');

    const clearBtn = $('btn-diag-clear');
    clearBtn.textContent = state.diagConfirmClear ? '确认清空?' : '清空日志';
    clearBtn.className = state.diagConfirmClear ? 'btn danger xs' : 'btn ghost xs';

    if (!state.diagOpen) return;
    const list = $('diag-events-list');
    const events = state.diagEvents || [];
    if (!events.length) {
      list.innerHTML = '<div class="muted">暂无匹配的飞行诊断事件</div>';
      return;
    }
    list.innerHTML = events.map((ev) => {
      const lv = formatFlightLevel(ev.level);
      const dur = Number.isFinite(ev.durationMs) ? `${ev.durationMs}ms` : '';
      const convTag = ev.conv ? `<span class="tag-pill muted tabular">${esc(ev.conv)}</span>` : '';
      return (
        '<div class="diag-row">' +
          '<div class="diag-row-head">' +
            `<span class="badge ${lv.cls}">${lv.label}</span>` +
            `<span class="diag-source">${esc(ev.source || 'core')}</span>` +
            `<span class="diag-event">${esc(ev.event || 'event')}</span>` +
            convTag +
            (dur ? `<span class="muted tabular">${esc(dur)}</span>` : '') +
            `<span class="diag-ts tabular">${esc(fmtIsoShort(ev.ts))}</span>` +
          '</div>' +
          (ev.message ? `<div class="diag-msg">${esc(ev.message)}</div>` : '') +
        '</div>'
      );
    }).join('');
  }

  async function loadDiagnostics() {
    try {
      const res = await apiPost('/api/diagnostics/logs', {
        limit: 80,
        level: state.diagLevel,
      });
      if (state.snap && res.summary) {
        state.snap.flightSummary = res.summary;
      }
      state.diagEvents = Array.isArray(res.events) ? res.events : [];
      renderDiagnosticsPanel();
    } catch (err) {
      showToast(err.message || '读取飞行诊断日志失败', true);
    }
  }

  function renderLogsOnly(force = false) {
    const filtered = getFilteredLogs();
    const sig = JSON.stringify([state.logFilter, state.logQuery, filtered]);
    if (!force && sig === state.lastLogSig) return;
    state.lastLogSig = sig;

    const box = $('log-box');
    const prevScrollTop = box.scrollTop;
    const wasAtTop = prevScrollTop <= 4;

    if (!filtered.length) {
      const hasRaw = (state.snap?.logs || []).length > 0;
      box.innerHTML = `<div class="muted">${hasRaw ? '没有匹配当前筛选条件的日志' : '暂无 Hook 调度日志'}</div>`;
      return;
    }

    box.innerHTML = filtered.map((line) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/);
      const cls = classifyLogLine(line);
      if (m) {
        return (
          `<div class="log-line ${cls}">` +
            `<span class="log-ts">${esc(m[1])}</span>` +
            `<span class="log-msg">${esc(m[2])}</span>` +
          '</div>'
        );
      }
      return `<div class="log-line ${cls}"><span class="log-msg">${esc(line)}</span></div>`;
    }).join('');

    box.scrollTop = wasAtTop ? 0 : prevScrollTop;
  }

  function renderMonitor() {
    const snap = state.snap;
    if (!snap) return;

    const activeConv = getActiveConvId(snap);
    const sessions = [...(snap.trackedSessions || [])];
    sessions.sort((a, b) => {
      const rank = (s) => {
        const win = isSessionWithinWindow(s);
        if (s.dead) return 0;
        if (s.tries > 0 && win) return 1;
        if (win) return 2;
        return 3;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0);
    });

    const deadCount = sessions.filter((s) => s.dead).length;
    const retryCount = sessions.filter((s) => !s.dead && s.tries > 0 && isSessionWithinWindow(s)).length;
    $('session-summary').textContent = sessions.length
      ? `${sessions.length} 会话 / ${deadCount} 熔断 / ${retryCount} 重试中`
      : '0 追踪会话';

    const wsSet = new Set((snap.workspaces || []).map((w) => w.name));
    const el = $('session-list');

    if (!sessions.length) {
      el.innerHTML = '<div class="empty-hint">暂无追踪会话记录</div>';
    } else {
      el.innerHTML = sessions.map((s) => {
        const isCurrent = Boolean(activeConv && s.convId === activeConv);
        const wsName = wsNameFromSession(s);
        const hasWs = Boolean(wsName && wsSet.has(wsName));
        const reasonPart = s.dead && s.deadReason ? `原因: ${esc(s.deadReason)}  ` : '';
        return `
          <div class="card session-row">
            <div class="alias-info">
              <div class="alias-head">
                <strong class="tabular">${esc(s.convShort)}</strong>
                ${isCurrent ? '<span class="tag-pill primary">当前</span>' : ''}
                <span class="badge ${badgeClass(s.health)}">${esc(s.health)}</span>
                <span class="muted tabular">步数 ${s.step ?? '-'}</span>
              </div>
              <div class="alias-val">${reasonPart}${esc(s.noteDir)}  ${fmtTime(s.updatedAtMs)}</div>
            </div>
            <div class="row-gap">
              ${hasWs ? `<button type="button" class="btn ghost xs act-open-ws" data-ws="${esc(wsName)}">工作台</button>` : ''}
              <button type="button" class="btn ghost xs act-jump-sess" data-conv="${esc(s.convId)}">切换</button>
              ${(s.dead || s.tries > 0) ? `<button type="button" class="btn secondary xs act-reset" data-conv="${esc(s.convId)}">解除熔断</button>` : ''}
            </div>
          </div>
        `;
      }).join('');

      for (const btn of el.querySelectorAll('.act-open-ws')) {
        btn.addEventListener('click', () => {
          const targetWs = btn.dataset.ws;
          switchTab('workspaces', () => {
            void openWorkspace(targetWs);
          });
        });
      }
      for (const btn of el.querySelectorAll('.act-jump-sess')) {
        btn.addEventListener('click', () => jumpToConversation(btn.dataset.conv));
      }
      for (const btn of el.querySelectorAll('.act-reset')) {
        btn.addEventListener('click', async () => {
          try {
            await apiPost('/api/state/reset', { conversationId: btn.dataset.conv });
            showToast('已重置会话重试与熔断计数');
            await refreshAll(true);
          } catch (err) {
            showToast(err.message || '重置失败', true);
          }
        });
      }
    }

    renderLogsOnly();
    renderDiagnosticsPanel();
    if (state.diagOpen) {
      void loadDiagnostics();
    }
  }

  function renderCurrentView(forceReloadFile = false, forceRender = false) {
    const snap = state.snap;
    if (!snap) return;

    const sig = computeSnapshotSig(snap);
    const unchanged = !forceRender && sig === state.lastViewSig;
    if (!unchanged) {
      state.lastViewSig = sig;
      renderHeaderAndSettings(snap);
      renderConflicts(snap.conflicts || []);

      if (state.tab === 'workspaces') {
        if (state.selectedWs) {
          renderDetailHeader();
        } else {
          renderWorkspaces();
        }
      } else if (state.tab === 'aliases') {
        renderAliases();
      } else {
        renderMonitor();
      }
    }

    if (forceReloadFile && state.tab === 'workspaces' && state.selectedWs && state.selectedFile) {
      if (state.editing) {
        void checkExternalFileChange();
      } else {
        void loadFile(state.selectedWs, state.selectedFile, { preserveIfEditing: true });
      }
    }
  }

  function switchTab(tabName, afterSwitch = null) {
    const doSwitch = () => {
      state.tab = tabName;
      for (const b of document.querySelectorAll('.tab')) {
        const active = b.dataset.tab === tabName;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      for (const p of document.querySelectorAll('.panel')) {
        p.classList.toggle('active', p.id === `panel-${tabName}`);
      }
      renderCurrentView(false, true);
      if (typeof afterSwitch === 'function') afterSwitch();
    };
    if (state.tab === 'workspaces' && tabName !== 'workspaces') {
      guardDirtyNavigation(doSwitch, '切换页签前是否保存当前未保存的修改？');
    } else {
      doSwitch();
    }
  }

  async function refreshAll(forceFile = false) {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const conv = window.sidecar?.conversationId || '';
      state.snap = await apiPost('/api/snapshot', conv ? { conversationId: conv } : {});
      $('live-dot').classList.remove('err');
      renderCurrentView(forceFile, false);
    } catch {
      $('live-dot').classList.add('err');
    } finally {
      state.refreshing = false;
    }
  }

  async function updateConfigOption(patch) {
    if (state.configSaving) return;
    state.configSaving = true;
    $('opt-sanitize').disabled = true;
    $('opt-alias').disabled = true;
    $('opt-alias-inline').disabled = true;
    try {
      const conv = window.sidecar?.conversationId || '';
      const res = await apiPost('/api/config/update', {
        ...patch,
        ...(conv ? { conversationId: conv } : {}),
      });
      if (state.snap) {
        state.snap.config = res.config;
        state.snap.conflicts = res.conflicts || [];
      }
      showToast(res.conflicts?.length ? '已更新配置，检测到潜在冲突提示' : '已更新配置选项');
    } catch (err) {
      showToast(err.message || '配置更新失败', true);
    } finally {
      state.configSaving = false;
      if (state.snap) renderHeaderAndSettings(state.snap);
      await refreshAll(false);
    }
  }

  // 事件绑定：顶栏导航与设置面板
  for (const tabBtn of document.querySelectorAll('.tab')) {
    tabBtn.addEventListener('click', () => {
      if (tabBtn.dataset.tab === state.tab) return;
      switchTab(tabBtn.dataset.tab);
    });
  }

  $('btn-refresh').addEventListener('click', () => {
    const btn = $('btn-refresh');
    btn.classList.remove('spinning');
    void btn.offsetWidth;
    btn.classList.add('spinning');
    void refreshAll(true);
  });

  function setSettingsOpen(open) {
    state.settingsOpen = open;
    $('settings-panel').classList.toggle('hidden', !open);
    $('btn-settings').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  $('btn-settings').addEventListener('click', () => setSettingsOpen(!state.settingsOpen));
  $('btn-close-settings').addEventListener('click', () => setSettingsOpen(false));

  $('btn-copy-note-root').addEventListener('click', async () => {
    const ok = await copyText($('env-note-root').textContent);
    showToast(ok ? '已复制工作台目录路径' : '复制失败', !ok);
  });

  $('btn-copy-data-dir').addEventListener('click', async () => {
    const ok = await copyText($('env-data-dir').textContent);
    showToast(ok ? '已复制数据目录路径' : '复制失败', !ok);
  });

  $('btn-toggle-conflicts').addEventListener('click', () => {
    state.conflictsExpanded = !state.conflictsExpanded;
    if (state.snap) renderConflicts(state.snap.conflicts || []);
  });

  // 事件绑定：工作台列表与筛选
  $('ws-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderWorkspaces();
  });

  $('btn-ws-filter').addEventListener('click', () => {
    state.wsFilterOpen = !state.wsFilterOpen;
    $('ws-filter-bar').classList.toggle('hidden', !state.wsFilterOpen);
    $('btn-ws-filter').setAttribute('aria-expanded', state.wsFilterOpen ? 'true' : 'false');
  });

  for (const segBtn of document.querySelectorAll('[data-ws-filter]')) {
    segBtn.addEventListener('click', () => {
      state.wsFilter = segBtn.dataset.wsFilter;
      for (const b of document.querySelectorAll('[data-ws-filter]')) {
        b.classList.toggle('active', b === segBtn);
      }
      renderWorkspaces();
    });
  }

  $('ws-sort').addEventListener('change', (e) => {
    state.wsSort = e.target.value === 'name' ? 'name' : 'updated';
    renderWorkspaces();
  });

  $('btn-toggle-create').addEventListener('click', () => {
    $('create-box').classList.toggle('hidden');
    if (!$('create-box').classList.contains('hidden')) {
      $('new-ws-name').focus();
    }
  });

  $('btn-cancel-create').addEventListener('click', () => {
    $('create-box').classList.add('hidden');
  });

  $('new-ws-name').addEventListener('input', () => {
    const val = $('new-ws-name').value.trim();
    const hint = $('new-ws-hint');
    if (!val) {
      $('new-ws-name').classList.remove('invalid');
      hint.className = 'field-hint';
      hint.textContent = '仅支持字母、数字及 . _ -（最多 64 字符）';
      return;
    }
    if (!WS_NAME_RE.test(val)) {
      $('new-ws-name').classList.add('invalid');
      hint.className = 'field-hint err';
      hint.textContent = '名称非法：须以字母或数字开头，仅含字母、数字及 . _ -';
    } else {
      $('new-ws-name').classList.remove('invalid');
      hint.className = 'field-hint';
      hint.textContent = '名称格式有效';
    }
  });

  $('create-box').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('new-ws-name').value.trim();
    const taskContent = $('new-ws-task').value;
    if (!WS_NAME_RE.test(name)) {
      $('new-ws-name').classList.add('invalid');
      $('new-ws-name').focus();
      showToast('工作台名称格式无效', true);
      return;
    }
    try {
      const res = await apiPost('/api/workspace/init', { name, taskContent });
      $('new-ws-name').value = '';
      $('new-ws-task').value = '';
      $('new-ws-name').classList.remove('invalid');
      $('create-box').classList.add('hidden');
      const ok = await copyText(res.launchPrompt);
      showToast(ok ? `已创建 ${res.name} 并复制启动词` : `已创建 ${res.name}`);
      await refreshAll(false);
      await openWorkspace(res.name);
    } catch (err) {
      showToast(err.message || '创建失败', true);
    }
  });

  $('btn-clean-empty').addEventListener('click', async () => {
    try {
      const res = await apiPost('/api/workspace/clean', {});
      showToast(`已清理 ${res.removedCount} 个空目录`);
      await refreshAll(false);
    } catch (err) {
      showToast(err.message || '清理失败', true);
    }
  });

  // 事件绑定：详情页文件浏览、防丢稿与编辑
  $('btn-back').addEventListener('click', () => backToList(false));

  $('file-more-select').addEventListener('change', (e) => {
    const target = e.target.value;
    if (!target || target === state.selectedFile) return;
    const allowed = guardDirtyNavigation(() => {
      void loadFile(state.selectedWs, target);
    });
    if (!allowed) {
      const ws = state.snap?.workspaces.find((w) => w.name === state.selectedWs);
      const { more } = ws ? splitWorkspaceFiles(ws) : { more: [] };
      e.target.value = more.includes(state.selectedFile) ? state.selectedFile : '';
    }
  });

  $('btn-copy-prompt').addEventListener('click', async () => {
    if (!state.selectedWs) return;
    const ok = await copyText(launchPromptFor(state.selectedWs));
    showToast(ok ? '已复制接力启动词' : '复制失败', !ok);
  });

  $('btn-archive-ws').addEventListener('click', async () => {
    const ws = state.snap?.workspaces.find((w) => w.name === state.selectedWs);
    if (!ws) return;
    const nextArchived = !ws.archived;
    try {
      await apiPost('/api/workspace/archive', {
        workspace: ws.name,
        archived: nextArchived,
      });
      showToast(nextArchived ? `已逻辑归档 ${ws.name}（保留磁盘目录不断链）` : `已恢复工作台 ${ws.name}`);
      await refreshAll(false);
    } catch (err) {
      showToast(err.message || '归档操作失败', true);
    }
  });

  $('btn-open-editor').addEventListener('click', () => {
    const abs = state.fileMeta?.absPath;
    if (!abs) return;
    if (window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: `file://${abs}` });
    } else {
      void copyText(abs).then((ok) => {
        showToast(ok ? '已复制文件绝对路径' : '复制失败', !ok);
      });
    }
  });

  $('btn-copy-path').addEventListener('click', async () => {
    const p = state.fileMeta?.shortPath || $('current-file-path').textContent;
    const ok = await copyText(p);
    showToast(ok ? '已复制路径' : '复制失败', !ok);
  });

  $('btn-toggle-raw').addEventListener('click', () => {
    if (!state.fileMeta || state.editing) return;
    state.viewRaw = !state.viewRaw;
    $('btn-toggle-raw').textContent = state.viewRaw ? '预览' : '源码';
    renderFileViewer(state.selectedFile, state.fileMeta.content);
  });

  $('btn-chunk-prev').addEventListener('click', () => {
    if (!state.selectedWs || !state.selectedFile) return;
    const prevOffset = Math.max(0, Number(state.fileMeta?.offset || 0) - CHUNK_STEP_BYTES);
    void loadFile(state.selectedWs, state.selectedFile, { offset: prevOffset, mode: 'auto', force: true });
  });

  $('btn-chunk-next').addEventListener('click', () => {
    if (!state.selectedWs || !state.selectedFile || !state.fileMeta) return;
    const nextOffset = Number(state.fileMeta.offset || 0) + Number(state.fileMeta.length || CHUNK_STEP_BYTES);
    void loadFile(state.selectedWs, state.selectedFile, { offset: nextOffset, mode: 'auto', force: true });
  });

  $('btn-chunk-tail').addEventListener('click', () => {
    if (!state.selectedWs || !state.selectedFile || !state.fileMeta) return;
    const total = Number(state.fileMeta.totalBytes || 0);
    const tailOffset = Math.max(0, total - CHUNK_STEP_BYTES);
    void loadFile(state.selectedWs, state.selectedFile, { offset: tailOffset, mode: 'auto', force: true });
  });

  $('btn-chunk-full').addEventListener('click', () => {
    if (!state.selectedWs || !state.selectedFile) return;
    const nextMode = state.forceFull ? 'auto' : 'full';
    void loadFile(state.selectedWs, state.selectedFile, { offset: 0, mode: nextMode, force: true });
  });

  $('btn-toggle-edit').addEventListener('click', () => {
    const meta = state.fileMeta;
    if (!meta || meta.chunked) return;
    if (state.editing) {
      guardDirtyNavigation(() => exitEditModeToViewer(), '退出编辑前是否保存未保存的内容？');
      return;
    }
    if (meta.confirmEditable && !state.editConfirmed) {
      $('edit-risk-bar').classList.remove('hidden');
      return;
    }
    enterEditMode(meta.content);
  });

  $('btn-risk-cancel').addEventListener('click', () => {
    $('edit-risk-bar').classList.add('hidden');
  });

  $('btn-risk-confirm').addEventListener('click', () => {
    if (!state.fileMeta || state.fileMeta.chunked) return;
    state.editConfirmed = true;
    enterEditMode(state.fileMeta.content);
  });

  $('btn-cancel-edit').addEventListener('click', () => {
    guardDirtyNavigation(() => exitEditModeToViewer(), '放弃本次未保存的编辑内容？');
  });

  $('btn-dirty-stay').addEventListener('click', () => {
    hideDirtyGuard();
    $('file-editor').focus();
  });

  $('btn-dirty-discard').addEventListener('click', () => {
    const next = state.pendingNavAction;
    hideDirtyGuard();
    exitEditModeToViewer();
    if (typeof next === 'function') next();
  });

  $('btn-dirty-save').addEventListener('click', async () => {
    const next = state.pendingNavAction;
    const ok = await saveCurrentFile();
    if (ok) {
      hideDirtyGuard();
      if (typeof next === 'function') next();
    }
  });

  $('btn-ext-ignore').addEventListener('click', () => {
    $('external-change-bar').classList.add('hidden');
  });

  $('btn-ext-reload').addEventListener('click', () => {
    const ext = state.externalChange;
    if (!ext) return;
    state.fileSig = ext.sig || `${ext.updatedAtMs}:${ext.size}`;
    state.fileMeta = ext;
    $('file-editor').value = ext.content;
    $('current-file-meta').textContent = `${fmtBytes(ext.size)}  ${fmtTime(ext.updatedAtMs)}`;
    hideExternalChangeBar();
    hideDirtyGuard();
    updateEditorStatusBar();
    showToast('已重新加载磁盘最新版本');
  });

  $('file-editor').addEventListener('input', () => {
    updateEditorStatusBar();
  });

  $('btn-save-file').addEventListener('click', () => {
    void saveCurrentFile();
  });

  $('file-editor').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveCurrentFile();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      guardDirtyNavigation(() => exitEditModeToViewer(), '退出编辑前是否保存未保存的内容？');
    }
  });

  // 事件绑定：别名表
  $('btn-toggle-reveal').addEventListener('click', () => {
    state.revealAliases = !state.revealAliases;
    $('btn-toggle-reveal').textContent = state.revealAliases ? '隐藏真值' : '显示真值';
    renderAliases();
  });

  $('btn-toggle-alias-form').addEventListener('click', () => {
    if (state.aliasFormOpen && !state.editingAliasKey) {
      closeAliasForm();
    } else {
      openAliasForm(null);
    }
  });

  $('btn-cancel-alias-form').addEventListener('click', closeAliasForm);
  $('alias-key').addEventListener('input', updateAliasKeyHint);

  $('alias-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('alias-key').value.trim();
    const value = $('alias-val').value.trim();
    const note = $('alias-note').value.trim();
    const prevKey = state.editingAliasKey;
    try {
      await apiPost('/api/alias/upsert', { key, value, note });
      if (prevKey && prevKey !== key) {
        await apiPost('/api/alias/delete', { key: prevKey }).catch(() => {});
      }
      closeAliasForm();
      showToast(`已保存别名 ${key}`);
      await refreshAll(false);
    } catch (err) {
      showToast(err.message || '保存别名失败', true);
    }
  });

  // 事件绑定：开关配置双向同步
  $('opt-sanitize').addEventListener('change', (e) => {
    void updateConfigOption({ sanitizeEnabled: Boolean(e.target.checked) });
  });

  $('opt-alias').addEventListener('change', (e) => {
    void updateConfigOption({ aliasEnabled: Boolean(e.target.checked) });
  });

  $('opt-alias-inline').addEventListener('change', (e) => {
    void updateConfigOption({ aliasEnabled: Boolean(e.target.checked) });
  });

  $('opt-orch-confirm').addEventListener('change', (e) => {
    void updateConfigOption({ orchestratorConfirm: e.target.value });
  });

  $('btn-reset-orch-once').addEventListener('click', () => {
    void updateConfigOption({ orchestratorConfirmedOnce: false });
  });

  $('btn-save-settings').addEventListener('click', () => {
    const patch = {
      maxRetry: Number.parseInt($('opt-max-retry').value, 10),
      retryWindowMin: Number.parseInt($('opt-retry-window').value, 10),
      zeroOutLimit: Number.parseInt($('opt-zero-limit').value, 10),
      longAnswerTokens: Number.parseInt($('opt-long-tokens').value, 10),
      bigContextTokens: Number.parseInt($('opt-big-ctx').value, 10),
    };
    for (const [k, v] of Object.entries(patch)) {
      if (!Number.isInteger(v)) {
        showToast(`参数 ${k} 必须为有效整数`, true);
        return;
      }
    }
    void updateConfigOption(patch);
  });

  $('btn-reset-settings').addEventListener('click', async () => {
    if (!state.resetSettingsConfirm) {
      state.resetSettingsConfirm = true;
      clearTimeout(state.resetSettingsTimer);
      state.resetSettingsTimer = setTimeout(() => {
        state.resetSettingsConfirm = false;
        if (state.snap) renderHeaderAndSettings(state.snap);
      }, 3000);
      if (state.snap) renderHeaderAndSettings(state.snap);
      return;
    }
    clearTimeout(state.resetSettingsTimer);
    state.resetSettingsConfirm = false;
    state.configSaving = true;
    try {
      const conv = window.sidecar?.conversationId || '';
      const res = await apiPost('/api/config/reset', conv ? { conversationId: conv } : {});
      if (state.snap) {
        state.snap.config = res.config;
        state.snap.conflicts = res.conflicts || [];
      }
      showToast('已一键恢复全部内置默认配置');
    } catch (err) {
      showToast(err.message || '恢复默认配置失败', true);
    } finally {
      state.configSaving = false;
      if (state.snap) renderHeaderAndSettings(state.snap);
      await refreshAll(false);
    }
  });

  // 事件绑定：监控日志工具栏
  for (const segBtn of document.querySelectorAll('[data-log-filter]')) {
    segBtn.addEventListener('click', () => {
      state.logFilter = segBtn.dataset.logFilter;
      for (const b of document.querySelectorAll('[data-log-filter]')) {
        b.classList.toggle('active', b === segBtn);
      }
      renderLogsOnly(true);
    });
  }

  $('log-search').addEventListener('input', (e) => {
    state.logQuery = e.target.value;
    renderLogsOnly(true);
  });

  $('btn-copy-logs').addEventListener('click', async () => {
    const lines = getFilteredLogs();
    if (!lines.length) {
      showToast('当前没有可复制的日志', true);
      return;
    }
    const ok = await copyText(lines.join('\n'));
    showToast(ok ? `已复制 ${lines.length} 条日志` : '复制失败', !ok);
  });

  // 事件绑定：黑匣子飞行诊断
  $('btn-toggle-diag').addEventListener('click', () => {
    state.diagOpen = !state.diagOpen;
    renderDiagnosticsPanel();
    if (state.diagOpen) {
      void loadDiagnostics();
    }
  });

  $('diag-level-filter').addEventListener('change', (e) => {
    state.diagLevel = e.target.value || '';
    void loadDiagnostics();
  });

  $('btn-diag-refresh').addEventListener('click', () => {
    void loadDiagnostics();
  });

  $('btn-diag-clear').addEventListener('click', async () => {
    if (!state.diagConfirmClear) {
      state.diagConfirmClear = true;
      clearTimeout(state.diagConfirmTimer);
      state.diagConfirmTimer = setTimeout(() => {
        state.diagConfirmClear = false;
        renderDiagnosticsPanel();
      }, 3000);
      renderDiagnosticsPanel();
      return;
    }
    clearTimeout(state.diagConfirmTimer);
    state.diagConfirmClear = false;
    try {
      const res = await apiPost('/api/diagnostics/clear', {});
      if (state.snap && res.summary) {
        state.snap.flightSummary = res.summary;
      }
      state.diagEvents = [];
      renderDiagnosticsPanel();
      showToast('已清空黑匣子飞行日志');
    } catch (err) {
      showToast(err.message || '清空飞行日志失败', true);
    }
  });

  // 全局 Esc 关闭浮层表单/面板
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.target === $('file-editor')) return;
    if (state.settingsOpen) {
      setSettingsOpen(false);
    } else if (state.aliasFormOpen) {
      closeAliasForm();
    } else if (!$('create-box').classList.contains('hidden')) {
      $('create-box').classList.add('hidden');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void refreshAll(true);
    }
  });

  void refreshAll(false);
  setInterval(() => {
    if (!document.hidden) {
      void refreshAll(true);
    }
  }, 3000);
