(() => {
  const ACTIVE_POLL_MS = 1400;
  const IDLE_POLL_MS = 1800;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = {
    overrideConv: '',
    tab: 'live',
    selectedStep: null,
    lastData: null,
    timer: null,
  };

  const paneConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

  async function getJson(path) {
    if (!window.sidecar?.fetch) throw new Error('Buka panel TPS Monitor di Antigravity Desktop.');
    const url = new URL(path, location.origin);
    const res = await window.sidecar.fetch(url.pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(url.searchParams)),
    });
    if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
    return res.json();
  }

  // Sync light/dark attribute from host --background injected by preload.js.
  function syncTheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #101010)';
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
    String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k`;
    return String(Math.round(v));
  }

  function fmtAge(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
    if (sec < 5) return 'baru saja';
    if (sec < 60) return `${Math.round(sec)}d lalu`;
    if (sec < 3600) return `${Math.round(sec / 60)}m lalu`;
    return `${(sec / 3600).toFixed(1)}j lalu`;
  }

  function tpsBand(tps) {
    if (tps >= 100) return 'good';
    if (tps >= 50) return 'ok';
    return 'warn';
  }

  function shortModel(m) {
    if (!m) return '—';
    return m.replace(/^gemini-/, 'g-').replace(/^claude-/, 'c-');
  }

  function renderTurnDetail(t) {
    if (!t) return;
    const cacheStr = t.cacheHit === null ? '—' : `${Math.round(t.cacheHit * 100)}%`;
    const tools = t.tools?.length ? t.tools.join(', ') : 'teks langsung';
    $('barDetail').textContent =
      `Step #${t.step} · ${t.decodeTps} tok/s (${t.out} tok dalam ${t.genSec}s, tool ${t.toolSec}s) · konteks ${fmtTok(t.ctx)} · cache ${cacheStr} · ${t.model || '—'} · [${tools}]`;
  }

  function render(data) {
    state.lastData = data;
    if (!data || !data.ok) {
      $('emptyState').classList.remove('hidden');
      $('emptyState').textContent = data?.hint || 'Belum ada transcript percakapan yang terbaca.';
      $('liveBadge').textContent = 'Menunggu';
      $('liveDot').classList.remove('live');
      return;
    }
    $('emptyState').classList.add('hidden');

    const s = data.summary || {};
    const cur = data.current;
    const isLive = Boolean(data.active || cur?.runningTool);
    $('liveDot').classList.toggle('live', isLive);
    $('liveBadge').classList.toggle('live', isLive);
    $('liveBadge').textContent = isLive
      ? cur?.runningTool
        ? 'Menjalankan tool…'
        : 'Aktif'
      : data.resolvedFrom === 'newest-session' && !state.overrideConv
      ? 'Sesi terbaru'
      : 'Siap';

    const srcTag =
      state.overrideConv
        ? 'dipilih manual'
        : data.resolvedFrom === 'pane'
        ? 'pane ini'
        : 'sesi terbaru';
    $('sessionTitle').textContent = `${data.title || data.conversationId} · (${srcTag})`;

    const heroTurn = cur && cur.decodeTps > 0 ? cur : [...(data.turns || [])].reverse().find((t) => t.decodeTps > 0) || null;
    const heroTps = heroTurn ? heroTurn.decodeTps : s.last10Tps || s.avgTps || 0;
    $('tpsNow').textContent = heroTps ? heroTps.toFixed(1) : '—';
    $('tpsNow').style.color = heroTps >= 100 ? 'var(--good)' : heroTps >= 50 ? 'var(--fg)' : heroTps > 0 ? 'var(--ok)' : 'var(--tps-label-color)';
    $('tpsSub').textContent = heroTurn
      ? `turn #${heroTurn.step} (${heroTurn.out} tok / ${heroTurn.genSec}s)`
      : 'rata-rata sesi';
    $('tpsBar').style.width = `${Math.min(100, Math.round((heroTps / 250) * 100))}%`;

    $('modelChip').textContent = `model: ${cur?.model || s.models?.[0]?.model || '—'}`;
    $('stepChip').textContent = cur ? `step #${cur.step}` : `${s.turns || 0} turn`;
    $('ageChip').textContent = `update ${fmtAge(data.ageSec)}`;

    $('statLast10').textContent = s.last10Tps ? `${s.last10Tps} tok/s` : '—';
    $('statAvg').textContent = `sesi: ${s.avgTps || 0} tok/s`;
    $('statMedian').textContent = s.p50Tps ? `${s.p50Tps} tok/s` : '—';
    $('statP90').textContent = s.p90Tps ? `P90: ${s.p90Tps} tok/s` : 'P90: —';

    $('statCtx').textContent = s.ctxLatest ? Number(s.ctxLatest).toLocaleString('id-ID') : '—';
    $('statCtxSub').textContent = `rata-rata: ${fmtTok(s.ctxAvg)} · ≥150k: ${s.ctxOver150k || 0}`;
    const ctxCard = $('ctxCard');
    ctxCard.classList.remove('good', 'warn', 'bad');
    if (s.ctxLatest >= 300_000) ctxCard.classList.add('bad');
    else if (s.ctxLatest >= 150_000) ctxCard.classList.add('warn');
    else if (s.ctxLatest > 0) ctxCard.classList.add('good');

    const cachePct = s.cacheHitAvg === null || s.cacheHitAvg === undefined ? null : Math.round(s.cacheHitAvg * 100);
    $('statCache').textContent = cachePct === null ? '—' : `${cachePct}%`;
    $('statCacheSub').textContent = `jeda >60s: ${s.gapOver60Pct || 0}% turn`;
    const cacheCard = $('cacheCard');
    cacheCard.classList.remove('good', 'warn', 'bad');
    if (cachePct !== null) {
      if (cachePct < 70) cacheCard.classList.add('bad');
      else if (cachePct < 90) cacheCard.classList.add('warn');
      else cacheCard.classList.add('good');
    }

    const lastTurn = (data.turns || [])[data.turns.length - 1];
    $('statLastOut').textContent = lastTurn ? `${fmtTok(lastTurn.out)} tok` : '—';
    $('statLastTime').textContent = lastTurn ? `decode ${lastTurn.genSec}s · tool ${lastTurn.toolSec}s` : '—';
    $('statTotalOut').textContent = `${fmtTok(s.outputTokens)} tok`;
    $('statTurns').textContent = `${s.turns || 0} turn · ${s.toolCalls || 0} tool`;

    // Bars (last 40 measured turns).
    const chartTurns = (data.turns || []).filter((t) => t.decodeTps > 0).slice(-40);
    const maxTps = Math.max(100, ...chartTurns.map((t) => t.decodeTps));
    const barsEl = $('bars');
    barsEl.innerHTML = '';
    for (const t of chartTurns) {
      const b = document.createElement('div');
      const h = Math.max(6, Math.round((t.decodeTps / maxTps) * 78));
      b.className = `bar ${tpsBand(t.decodeTps)}${state.selectedStep === t.step ? ' sel' : ''}`;
      b.style.height = `${h}px`;
      b.title = `#${t.step}: ${t.decodeTps} tok/s (${t.out} tok / ${t.genSec}s)`;
      b.addEventListener('mouseenter', () => renderTurnDetail(t));
      b.addEventListener('click', () => {
        state.selectedStep = t.step;
        renderTurnDetail(t);
      });
      barsEl.appendChild(b);
    }
    if (!state.selectedStep && chartTurns.length) {
      renderTurnDetail(chartTurns[chartTurns.length - 1]);
    }

    // Recent turns table (newest first, up to 30).
    const rows = (data.turns || []).slice(-30).reverse();
    $('turnWindowLabel').textContent = `${rows.length} dari ${s.turns || 0} turn${data.partial ? ' (tail 3 MB)' : ''}`;
    $('turnsBody').innerHTML = rows
      .map((t) => {
        const band = tpsBand(t.decodeTps);
        const cacheCell = t.cacheHit === null ? '—' : `${Math.round(t.cacheHit * 100)}%`;
        const tools = t.tools?.length ? t.tools.slice(0, 3).join(', ') + (t.tools.length > 3 ? ` +${t.tools.length - 3}` : '') : 'teks';
        return `<tr>
          <td>#${t.step}</td>
          <td>${t.decodeTps ? `<span class="tps-pill ${band}">${t.decodeTps}</span>` : '<span class="muted">final</span>'}</td>
          <td>${fmtTok(t.out)}</td>
          <td>${t.unmeasured ? '—' : `${t.genSec}s`}</td>
          <td>${fmtTok(t.ctx)}</td>
          <td>${cacheCell}</td>
          <td>${esc(shortModel(t.model))} · ${esc(tools)}</td>
        </tr>`;
      })
      .join('');

    // Diagnostics.
    const diags = data.diagnostics || [];
    const warnCount = diags.filter((d) => d.level === 'warn' || d.level === 'bad').length;
    $('diagCount').textContent = String(warnCount || diags.length);
    $('diagList').innerHTML = diags
      .map(
        (d) => `<div class="diag ${esc(d.level)}">
          <div class="diag-title">${esc(d.title)}</div>
          <div class="diag-detail">${esc(d.detail)}</div>
        </div>`
      )
      .join('');
  }

  async function refreshSessions() {
    try {
      const res = await getJson('/api/sessions?limit=10');
      if (!res?.ok) return;
      const picker = $('sessionPicker');
      const keep = state.overrideConv;
      picker.innerHTML =
        `<option value="">Percakapan pane ini (auto)</option>` +
        res.sessions
          .map(
            (s) =>
              `<option value="${esc(s.id)}">${s.active ? '● ' : ''}${esc(s.title.slice(0, 42))} (${s.last10Tps || s.avgTps} tok/s)</option>`
          )
          .join('');
      picker.value = keep;

      $('sessionsList').innerHTML = res.sessions
        .map(
          (s) => `<button class="sess" data-conv="${esc(s.id)}">
            <div class="sess-main">
              <div class="sess-title">${s.active ? '🟢 ' : ''}${esc(s.title)}</div>
              <div class="sess-sub">${esc(s.product)} · ${s.turns} turn · konteks ${fmtTok(s.ctxLatest)} · ${esc(shortModel(s.model))} · ${fmtAge(s.ageSec)}</div>
            </div>
            <div class="sess-tps">${s.last10Tps || s.avgTps} tok/s</div>
          </button>`
        )
        .join('');

      for (const btn of $('sessionsList').querySelectorAll('.sess')) {
        btn.addEventListener('click', () => {
          state.overrideConv = btn.dataset.conv || '';
          $('sessionPicker').value = state.overrideConv;
          switchTab('live');
          poll(true);
        });
      }
    } catch {
      // ignore transient errors
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    for (const el of document.querySelectorAll('.tab')) {
      el.classList.toggle('active', el.dataset.tab === tab);
    }
    for (const p of ['live', 'diag', 'sessions']) {
      $(`panel-${p}`).classList.toggle('hidden', p !== tab);
    }
    if (tab === 'sessions') refreshSessions();
  }

  for (const el of document.querySelectorAll('.tab')) {
    el.addEventListener('click', () => switchTab(el.dataset.tab));
  }
  $('sessionPicker').addEventListener('change', (e) => {
    state.overrideConv = e.target.value || '';
    state.selectedStep = null;
    poll(true);
  });
  $('refreshBtn').addEventListener('click', () => {
    poll(true);
    refreshSessions();
  });

  function renderLive(live) {
    const turn = live?.turn;
    $('liveTiming').textContent = '';
    if (!turn) return;
    if (turn.generating) {
      $('liveBadge').textContent = 'Model sedang menulis';
      $('liveBadge').classList.add('live');
      $('liveDot').classList.add('live');
    }
    if (turn.context > 0) {
      $('statCtx').textContent = turn.context.toLocaleString('id-ID');
    }
    if (turn.tps !== null) {
      $('tpsNow').textContent = turn.tps.toLocaleString('id-ID', { maximumFractionDigits: 1 });
      $('tpsNow').style.color = 'var(--fg)';
      $('tpsSub').textContent = turn.generating ? 'rata-rata respons berjalan' : 'respons model terakhir';
      $('tpsBar').style.width = `${Math.min(100, Math.round(turn.tps / 2.5))}%`;
      const interval = turn.fromVisible ? 'sejak respons terlihat' : 'sejak langkah dibuat';
      $('liveTiming').textContent = `${turn.output.toLocaleString('id-ID')} token output dalam ${turn.seconds.toFixed(1)} dtk · ${interval}`;
    } else if (turn.generating) {
      if (turn.characters >= 12 && turn.seconds >= 0.5 && turn.fromVisible) {
        const estimate = turn.characters / 4 / turn.seconds;
        $('tpsNow').textContent = `≈${estimate.toLocaleString('id-ID', { maximumFractionDigits: 1 })}`;
        $('tpsNow').style.color = 'var(--fg)';
        $('tpsSub').textContent = 'perkiraan respons berjalan';
        $('tpsBar').style.width = `${Math.min(100, Math.round(estimate / 2.5))}%`;
        $('liveTiming').textContent = `${turn.characters.toLocaleString('id-ID')} karakter diterima · perkiraan 4 karakter per token`;
      } else {
        $('tpsSub').textContent = 'TPS respons sebelumnya';
        $('liveTiming').textContent = 'Menunggu data token atau teks respons ini';
      }
    }
  }

  async function poll(force = false) {
    clearTimeout(state.timer);
    const target = state.overrideConv || paneConv();
    const qs = new URLSearchParams({ turns: '60' });
    if (target) qs.set('conversationId', target);
    if (state.overrideConv) qs.set('strict', '1');
    if (force) qs.set('invalidate', '1');
    let nextMs = IDLE_POLL_MS;
    try {
      const data = await getJson(`/api/tps?${qs.toString()}`);
      render(data);
      const session = target || data?.conversationId;
      const live = session
        ? await getJson(`/api/live?${new URLSearchParams({ conversationId: session })}`).catch(() => null)
        : null;
      if ((state.overrideConv || paneConv()) === target) renderLive(live);
      if (live?.turn?.generating || data?.active || data?.current?.runningTool) nextMs = ACTIVE_POLL_MS;
    } catch (err) {
      $('liveBadge').textContent = 'Offline';
      $('liveDot').classList.remove('live');
    }
    state.timer = setTimeout(() => poll(false), nextMs);
  }

  poll(false);
  refreshSessions();
  setInterval(refreshSessions, 15000);
})();
