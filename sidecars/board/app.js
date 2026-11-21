(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const uiToken = params.get('token') || '';

  const state = {
    tab: 'workspaces',
    snap: null,
    search: '',
    selectedWs: '',
    selectedFile: '',
    fileMeta: null,
    editing: false,
    revealAliases: false,
    toastTimer: null,
  };

  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #181a1f)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = c.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
    }
  }
  syncTheme();
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

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

  function badgeClass(health) {
    if (!health || health === '-') return 'muted';
    if (health.startsWith('DEAD')) return 'err';
    if (health.startsWith('RETRY')) return 'warn';
    return 'ok';
  }

  function fmtTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function maskValue(val) {
    const s = String(val || '');
    if (s.length <= 12) return '****';
    return `${s.slice(0, 8)}***${s.slice(-4)}`;
  }

  function renderMarkdownLite(md) {
    const lines = String(md || '').split(/\r?\n/);
    let html = '';
    let inPre = false;
    let inList = false;

    const flushList = () => {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    };

    for (const raw of lines) {
      if (raw.trim().startsWith('```')) {
        flushList();
        if (!inPre) {
          html += '<pre><code>';
          inPre = true;
        } else {
          html += '</code></pre>';
          inPre = false;
        }
        continue;
      }
      if (inPre) {
        html += esc(raw) + '\n';
        continue;
      }
      const line = raw.trim();
      if (!line) {
        flushList();
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        flushList();
        const tag = `h${h[1].length}`;
        html += `<${tag}>${esc(h[2])}</${tag}>`;
        continue;
      }
      const li = line.match(/^[-*]\s+(.*)$/);
      if (li) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${esc(li[1])}</li>`;
        continue;
      }
      flushList();
      html += `<p style="margin:4px 0;">${esc(raw)}</p>`;
    }
    flushList();
    if (inPre) html += '</code></pre>';
    return html || '<div class="empty-hint">文件内容为空</div>';
  }

  function launchPromptFor(wsName) {
    const root = (state.snap?.noteRoot || '~/agy-notes').replace(/\/+$/, '');
    return `/note-offload 读取 ${root}/${wsName}/task.md 与 status.md，执行下一未完成阶段并落盘汇报。`;
  }

  function renderWorkspaces() {
    const snap = state.snap;
    if (!snap) return;

    const activeConv = window.sidecar?.conversationId || snap.activeConversationId || '';
    const kw = state.search.trim().toLowerCase();
    const list = snap.workspaces.filter((w) => {
      if (!kw) return true;
      return w.name.toLowerCase().includes(kw) || (w.summary || '').toLowerCase().includes(kw);
    });

    const bound = activeConv
      ? snap.workspaces.find((w) => w.boundConvId === activeConv)
      : null;
    const banner = $('bound-banner');
    if (bound) {
      banner.classList.remove('hidden');
      banner.innerHTML = `
        <span>当前会话已绑定 <strong>${esc(bound.name)}</strong> (${esc(bound.health)})</span>
        <button type="button" class="btn primary xs" id="btn-open-bound">打开工作台</button>
      `;
      $('btn-open-bound').onclick = () => openWorkspace(bound.name);
    } else {
      banner.classList.add('hidden');
    }

    const container = $('ws-list');
    if (!list.length) {
      container.innerHTML = '<div class="empty-hint">暂无匹配的落盘工作台，点击右上角「+ 新建」即可创建。</div>';
      return;
    }

    container.innerHTML = list.map((w) => {
      const cls = badgeClass(w.health);
      const stepPart = w.step != null ? ` | 步数 ${w.step}` : '';
      const convPart = w.boundConvShort ? ` | 会话 ${esc(w.boundConvShort)}` : '';
      const summary = w.summary ? esc(w.summary) : '暂无状态摘要';
      return `
        <div class="card ws-card" data-ws="${esc(w.name)}">
          <div class="ws-head">
            <span class="ws-name">${esc(w.name)}</span>
            <span class="badge ${cls}">${esc(w.health)}</span>
          </div>
          <div class="ws-meta">${w.fileCount} 个文件${stepPart}${convPart} | ${fmtTime(w.updatedAtMs)}</div>
          <div class="ws-summary">${summary}</div>
          <div class="ws-actions">
            <button type="button" class="btn secondary xs act-copy" data-ws="${esc(w.name)}">复制启动词</button>
            ${w.boundConvId ? `<button type="button" class="btn ghost xs act-jump" data-conv="${esc(w.boundConvId)}">切换会话</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    for (const card of container.querySelectorAll('.ws-card')) {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        openWorkspace(card.dataset.ws);
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
        const cid = btn.dataset.conv;
        if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(cid);
        } else {
          copyText(cid);
          showToast(`已复制会话 ID: ${cid.slice(0, 8)}`);
        }
      });
    }
  }

  function renderDetailHeader() {
    const ws = state.snap?.workspaces.find((w) => w.name === state.selectedWs);
    if (!ws) {
      backToList();
      return null;
    }
    $('detail-name').textContent = ws.name;
    const badge = $('detail-health');
    badge.textContent = ws.health;
    badge.className = `badge ${badgeClass(ws.health)}`;

    const jumpBtn = $('btn-jump-conv');
    if (ws.boundConvId) {
      jumpBtn.classList.remove('hidden');
      jumpBtn.onclick = () => {
        if (window.sidecar?.ui?.toggleConversation) {
          window.sidecar.ui.toggleConversation(ws.boundConvId);
        } else {
          copyText(ws.boundConvId);
          showToast(`已复制会话 ID: ${ws.boundConvShort}`);
        }
      };
    } else {
      jumpBtn.classList.add('hidden');
    }

    const pills = $('file-pills');
    if (!ws.files.length) {
      pills.innerHTML = '<span class="muted">目录暂无文件</span>';
    } else {
      pills.innerHTML = ws.files.map((f) =>
        `<button type="button" class="pill ${f === state.selectedFile ? 'active' : ''}" data-file="${esc(f)}">${esc(f)}</button>`
      ).join('');
      for (const p of pills.querySelectorAll('.pill')) {
        p.addEventListener('click', () => loadFile(ws.name, p.dataset.file));
      }
    }
    return ws;
  }

  async function openWorkspace(wsName) {
    state.selectedWs = wsName;
    state.editing = false;
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
      state.selectedFile = '';
      state.fileMeta = null;
      $('current-file-path').textContent = ws.shortPath;
      $('file-viewer').innerHTML = '<div class="empty-hint">该目录暂无 .md 文件</div>';
      $('file-viewer').classList.remove('hidden');
      $('file-editor-wrap').classList.add('hidden');
      $('btn-toggle-edit').classList.add('hidden');
    }
  }

  function backToList() {
    state.selectedWs = '';
    state.selectedFile = '';
    state.fileMeta = null;
    state.editing = false;
    $('ws-detail-view').classList.add('hidden');
    $('ws-list-view').classList.remove('hidden');
    renderWorkspaces();
  }

  async function loadFile(wsName, fileName, preserveIfEditing = false) {
    if (preserveIfEditing && state.editing) return;
    state.selectedFile = fileName;
    renderDetailHeader();
    try {
      const data = await apiPost('/api/file', { workspace: wsName, file: fileName });
      state.fileMeta = data;
      $('current-file-path').textContent = data.shortPath;

      const canEdit = fileName === 'task.md' || fileName === 'status.md';
      const toggleBtn = $('btn-toggle-edit');
      if (canEdit) {
        toggleBtn.classList.remove('hidden');
        toggleBtn.textContent = state.editing ? '切回预览' : '在线编辑';
      } else {
        toggleBtn.classList.add('hidden');
        state.editing = false;
      }

      if (state.editing && canEdit) {
        $('file-viewer').classList.add('hidden');
        $('file-editor-wrap').classList.remove('hidden');
        $('file-editor').value = data.content;
      } else {
        $('file-editor-wrap').classList.add('hidden');
        $('file-viewer').classList.remove('hidden');
        $('file-viewer').innerHTML = renderMarkdownLite(data.content);
      }
    } catch (err) {
      showToast(err.message || '读取文件失败', true);
    }
  }

  async function saveCurrentFile() {
    if (!state.selectedWs || !state.selectedFile) return;
    try {
      await apiPost('/api/workspace/save', {
        workspace: state.selectedWs,
        file: state.selectedFile,
        content: $('file-editor').value,
      });
      state.editing = false;
      showToast(`已保存 ${state.selectedFile}`);
      await refreshAll(true);
      await loadFile(state.selectedWs, state.selectedFile);
    } catch (err) {
      showToast(err.message || '保存失败', true);
    }
  }

  function renderAliases() {
    const rows = state.snap?.aliases || [];
    const el = $('alias-list');
    if (!rows.length) {
      el.innerHTML = '<div class="empty-hint">暂未配置远端地址别名</div>';
      return;
    }
    el.innerHTML = rows.map((r) => `
      <div class="card alias-row">
        <div class="alias-info">
          <div><strong>${esc(r.key)}</strong> <span class="muted">${esc(r.note || '')}</span></div>
          <div class="alias-val">${esc(state.revealAliases ? r.value : maskValue(r.value))}</div>
        </div>
        <div class="row-gap">
          <button type="button" class="btn ghost xs act-edit-alias" data-key="${esc(r.key)}">改</button>
          <button type="button" class="btn danger xs act-del-alias" data-key="${esc(r.key)}">删</button>
        </div>
      </div>
    `).join('');

    for (const btn of el.querySelectorAll('.act-edit-alias')) {
      btn.addEventListener('click', () => {
        const hit = rows.find((r) => r.key === btn.dataset.key);
        if (!hit) return;
        $('alias-key').value = hit.key;
        $('alias-val').value = hit.value;
        $('alias-note').value = hit.note || '';
      });
    }
    for (const btn of el.querySelectorAll('.act-del-alias')) {
      btn.addEventListener('click', async () => {
        try {
          await apiPost('/api/alias/delete', { key: btn.dataset.key });
          showToast(`已删除别名 ${btn.dataset.key}`);
          await refreshAll(true);
        } catch (err) {
          showToast(err.message || '删除失败', true);
        }
      });
    }
  }

  function renderMonitor() {
    const sessions = state.snap?.trackedSessions || [];
    const el = $('session-list');
    if (!sessions.length) {
      el.innerHTML = '<div class="empty-hint">暂无追踪会话记录</div>';
    } else {
      el.innerHTML = sessions.map((s) => `
        <div class="card alias-row">
          <div class="alias-info">
            <div class="row-gap">
              <strong>${esc(s.convShort)}</strong>
              <span class="badge ${badgeClass(s.health)}">${esc(s.health)}</span>
              <span class="muted">步数 ${s.step ?? '-'}</span>
            </div>
            <div class="alias-val">${esc(s.noteDir)} | ${fmtTime(s.updatedAtMs)}</div>
          </div>
          ${(s.dead || s.tries > 0) ? `<button type="button" class="btn secondary xs act-reset" data-conv="${esc(s.convId)}">解除熔断</button>` : ''}
        </div>
      `).join('');

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

    const logs = state.snap?.logs || [];
    $('log-box').textContent = logs.length ? logs.join('\n') : '暂无调用日志';
  }

  function renderCurrentView(forceReloadFile = false) {
    const snap = state.snap;
    if (!snap) return;
    const deadCount = snap.trackedSessions.filter((s) => s.dead).length;
    $('top-summary').textContent = deadCount
      ? `${snap.workspaces.length} 工作台 | ${deadCount} 熔断`
      : `${snap.workspaces.length} 工作台 | 正常`;

    if (state.tab === 'workspaces') {
      if (state.selectedWs) {
        renderDetailHeader();
        if (forceReloadFile && state.selectedFile && !state.editing) {
          loadFile(state.selectedWs, state.selectedFile, true);
        }
      } else {
        renderWorkspaces();
      }
    } else if (state.tab === 'aliases') {
      renderAliases();
    } else {
      renderMonitor();
    }
  }

  async function refreshAll(forceFile = false) {
    try {
      const conv = window.sidecar?.conversationId || '';
      state.snap = await apiPost('/api/snapshot', conv ? { conversationId: conv } : {});
      $('live-dot').classList.remove('err');
      renderCurrentView(forceFile);
    } catch {
      $('live-dot').classList.add('err');
    }
  }

  // 事件绑定
  for (const tabBtn of document.querySelectorAll('.tab')) {
    tabBtn.addEventListener('click', () => {
      state.tab = tabBtn.dataset.tab;
      for (const b of document.querySelectorAll('.tab')) {
        b.classList.toggle('active', b === tabBtn);
      }
      for (const p of document.querySelectorAll('.panel')) {
        p.classList.toggle('active', p.id === `panel-${state.tab}`);
      }
      renderCurrentView(false);
    });
  }

  $('ws-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderWorkspaces();
  });

  $('btn-toggle-create').addEventListener('click', () => {
    $('create-box').classList.toggle('hidden');
    if (!$('create-box').classList.contains('hidden')) $('new-ws-name').focus();
  });

  $('btn-cancel-create').addEventListener('click', () => {
    $('create-box').classList.add('hidden');
  });

  $('create-box').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('new-ws-name').value.trim();
    const taskContent = $('new-ws-task').value;
    try {
      const res = await apiPost('/api/workspace/init', { name, taskContent });
      $('new-ws-name').value = '';
      $('new-ws-task').value = '';
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

  $('btn-back').addEventListener('click', backToList);

  $('btn-copy-prompt').addEventListener('click', async () => {
    if (!state.selectedWs) return;
    const ok = await copyText(launchPromptFor(state.selectedWs));
    showToast(ok ? '已复制接力启动词' : '复制失败', !ok);
  });

  $('btn-start-conv').addEventListener('click', async () => {
    if (!state.selectedWs) return;
    const prompt = launchPromptFor(state.selectedWs);
    if (window.sidecar?.agent?.startConversation) {
      try {
        await window.sidecar.agent.startConversation(prompt, state.selectedWs);
        showToast('已拉起新会话接力执行');
        return;
      } catch {}
    }
    const ok = await copyText(prompt);
    showToast(ok ? '已复制启动词，请粘贴开新会话' : '拉起新会话失败', !ok);
  });

  $('btn-open-editor').addEventListener('click', () => {
    const abs = state.fileMeta?.absPath;
    if (!abs) return;
    if (window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: `file://${abs}` });
    } else {
      copyText(abs);
      showToast('已复制绝对路径');
    }
  });

  $('btn-copy-path').addEventListener('click', async () => {
    const p = state.fileMeta?.shortPath || $('current-file-path').textContent;
    const ok = await copyText(p);
    showToast(ok ? '已复制路径' : '复制失败', !ok);
  });

  $('btn-toggle-edit').addEventListener('click', () => {
    if (!state.fileMeta) return;
    state.editing = !state.editing;
    $('btn-toggle-edit').textContent = state.editing ? '切回预览' : '在线编辑';
    if (state.editing) {
      $('file-viewer').classList.add('hidden');
      $('file-editor-wrap').classList.remove('hidden');
      $('file-editor').value = state.fileMeta.content;
      $('file-editor').focus();
    } else {
      $('file-editor-wrap').classList.add('hidden');
      $('file-viewer').classList.remove('hidden');
    }
  });

  $('btn-cancel-edit').addEventListener('click', () => {
    state.editing = false;
    $('btn-toggle-edit').textContent = '在线编辑';
    $('file-editor-wrap').classList.add('hidden');
    $('file-viewer').classList.remove('hidden');
  });

  $('btn-save-file').addEventListener('click', saveCurrentFile);
  $('file-editor').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrentFile();
    }
  });

  $('btn-toggle-reveal').addEventListener('click', () => {
    state.revealAliases = !state.revealAliases;
    $('btn-toggle-reveal').textContent = state.revealAliases ? '隐藏真值' : '显示真值';
    renderAliases();
  });

  $('alias-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = $('alias-key').value.trim();
    const value = $('alias-val').value.trim();
    const note = $('alias-note').value.trim();
    try {
      await apiPost('/api/alias/upsert', { key, value, note });
      $('alias-key').value = '';
      $('alias-val').value = '';
      $('alias-note').value = '';
      showToast(`已保存别名 ${key}`);
      await refreshAll(false);
    } catch (err) {
      showToast(err.message || '保存别名失败', true);
    }
  });

  void refreshAll(false);
  setInterval(() => refreshAll(true), 3000);
})();
