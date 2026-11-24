(function installWallpaper(initial, mediaPrefix, uploadLimit) {
  if (window.__agyWallpaper) {
    window.__agyWallpaper.update(initial);
    return;
  }
  let state = initial;
  let pending = false;
  let deleteId = null;
  let dock;
  let sidebarDock;
  let surface;
  let transparentChat;
  let hasSurface = false;
  let current;
  let composer;
  let shownTitle;
  const tpsFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
  const contextFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const make = (name, attributes = {}, text) => {
    const node = document.createElement(name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, callback, className = '') => {
    const el = make('button', { type: 'button', class: className }, text);
    el.addEventListener('click', event => { if (event.isTrusted) callback(); });
    return el;
  };

  const layer = make('div', { id: 'agy-wallpaper-layer', 'aria-hidden': 'true' });
  const video = make('video', { playsinline: '', loop: '', muted: '', preload: 'metadata', tabindex: '-1' });
  video.muted = true;
  layer.append(video);
  const meter = make('div', { id: 'agy-tps-meter', 'aria-label': 'TPS dan konteks' });
  const tps = make('span');
  const context = make('span');
  meter.append(tps, context);
  const controls = make('div', { id: 'agy-wallpaper-controls', hidden: '' });
  const dialog = make('dialog', { 'aria-labelledby': 'agy-wallpaper-title' });
  const title = make('h2', { id: 'agy-wallpaper-title' }, 'Tema wallpaper');
  const list = make('ul', { class: 'aw-list' });
  const hint = make('p', { class: 'aw-hint' }, 'GIF, MP4, atau WebM hingga 16 MB.');
  const status = make('p', { class: 'aw-status', role: 'status' });
  const picker = make('input', { type: 'file', accept: '.gif,.mp4,.webm', hidden: '' });
  const open = button('Tema', () => {
    if (dialog.open) dialog.close();
    else {
      dialog.show();
      open.setAttribute('aria-expanded', 'true');
    }
  }, 'aw-trigger');
  open.setAttribute('aria-haspopup', 'dialog');
  open.setAttribute('aria-expanded', 'false');
  const close = button('Minimalkan', () => dialog.close(), 'aw-neutral');
  const upload = button('Unggah tema', () => picker.click(), 'aw-primary');
  const disable = button('Matikan wallpaper', () => send({ action: 'select', id: null }), 'aw-neutral');
  const header = make('div', { class: 'aw-header' });
  const footer = make('div', { class: 'aw-footer' });
  header.append(title, close);
  footer.append(upload, disable);
  dialog.append(header, list, footer, hint, status, picker);
  controls.append(open, dialog);
  document.body.append(controls);
  dialog.addEventListener('close', () => {
    open.setAttribute('aria-expanded', 'false');
    deleteId = null;
    renderList();
    open.focus();
  });
  controls.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dialog.open) { dialog.close(); event.stopPropagation(); }
  });

  function send(command) {
    if (pending) return;
    pending = true;
    status.textContent = command.action === 'import' ? 'Menyiapkan animasi…' : 'Menyimpan…';
    renderList();
    window.agyWallpaperCommand(JSON.stringify(command));
  }

  picker.addEventListener('change', async event => {
    if (!event.isTrusted) return;
    const file = picker.files[0];
    picker.value = '';
    if (!file || pending) return;
    if (file.size > uploadLimit) { status.textContent = 'Ukuran file melebihi 16 MB.'; return; }
    pending = true;
    status.textContent = 'Membaca file…';
    renderList();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pieces = [];
      for (let index = 0; index < bytes.length; index += 32768) {
        pieces.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
      }
      pending = false;
      send({ action: 'import', name: file.name, data: btoa(pieces.join('')) });
    } catch {
      update(state, 'File tidak bisa dibaca.');
    }
  });

  function renderList() {
    list.replaceChildren();
    if (!state.themes.length) list.append(make('li', { class: 'aw-empty' }, 'Belum ada tema.'));
    for (const theme of state.themes) {
      const row = make('li', { class: 'aw-row' });
      const label = make('span', { class: 'aw-name', title: theme.name }, theme.name);
      const use = button(theme.id === state.active ? 'Aktif' : 'Pakai',
        () => send({ action: 'select', id: theme.id }), 'aw-neutral');
      use.disabled = pending || theme.id === state.active;
      use.setAttribute('aria-label', (theme.id === state.active ? 'Tema aktif ' : 'Pakai ') + theme.name);
      const remove = button(theme.id === deleteId ? 'Konfirmasi hapus' : 'Hapus', () => {
        if (theme.id === deleteId) {
          send({ action: 'remove', id: theme.id });
        } else {
          deleteId = theme.id;
          status.textContent = 'Klik Konfirmasi hapus untuk menghapus salinan tema.';
          renderList();
          list.querySelector('[data-awaiting-delete]')?.focus();
        }
      }, 'aw-delete');
      remove.disabled = pending;
      remove.setAttribute('aria-label', remove.textContent + ' ' + theme.name);
      if (theme.id === deleteId) remove.setAttribute('data-awaiting-delete', '');
      row.append(label, use, remove);
      list.append(row);
    }
    upload.disabled = pending;
    disable.disabled = pending || state.active === null;
  }

  function locateDock() {
    if (dock?.isConnected && controls.parentElement === sidebarDock
        && sidebarDock.clientWidth >= 112 && dock.getClientRects().length) return;
    dock?.classList.remove('aw-settings-for-theme');
    sidebarDock?.classList.remove('aw-theme-sidebar');
    dock = null;
    sidebarDock = null;
    for (const sidebar of document.querySelectorAll('[class~="bg-sidebar"]')) {
      if (sidebar.clientWidth < 112) continue;
      const settings = [...sidebar.querySelectorAll('button,[role="button"],a')].find(element => {
        const name = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent;
        return /^(Settings|Pengaturan)$/i.test(name.trim()) && element.getClientRects().length;
      });
      if (!settings) continue;
      dock = settings;
      sidebarDock = sidebar;
      dock.classList.add('aw-settings-for-theme');
      sidebarDock.classList.add('aw-theme-sidebar');
      sidebarDock.append(controls);
      controls.hidden = false;
      return;
    }
    if (dialog.open) dialog.close();
    controls.hidden = true;
  }

  function refreshSurfaces() {
    const nextComposer = document.querySelector(
      '[id="antigravity.agentSidePanelInputBox"], [data-testid="antigravity.agentSidePanelInputBox"]',
    );
    if (composer !== nextComposer || meter.parentElement !== nextComposer) {
      composer?.classList.remove('aw-composer-anchor');
      composer = nextComposer;
      if (composer) {
        if (getComputedStyle(composer).position === 'static') composer.classList.add('aw-composer-anchor');
        composer.append(meter);
      } else {
        meter.remove();
      }
    }
    if (shownTitle !== conversationTitle()) showTps(conversationTitle(), null);
    let chat = composer?.parentElement;
    while (chat && chat !== document.body && chat.offsetHeight < innerHeight * 0.55) chat = chat.parentElement;
    if (chat === document.body || chat?.parentElement === document.body) chat = null;
    const next = chat?.parentElement || document.querySelector('.agy-inset-shell');
    if (surface !== next) {
      surface?.classList.remove('aw-pane');
      surface = next;
      if (surface) {
        surface.classList.add('aw-pane');
        surface.prepend(layer);
      } else {
        layer.remove();
      }
    }
    if (chat !== transparentChat) {
      transparentChat?.classList.remove('aw-clear');
      transparentChat = chat;
      transparentChat?.classList.add('aw-clear');
    }
    const active = Boolean(surface);
    document.body.classList.toggle('aw-wallpaper-active', active);
    layer.hidden = !active || !state.active;
    if (active !== hasSurface) {
      hasSurface = active;
      playWhenVisible();
    }
  }

  function conversationTitle() {
    return !document.hidden && composer?.isConnected ? document.title.trim() : null;
  }

  function showTps(title, value) {
    if (conversationTitle() !== title) return;
    shownTitle = title;
    const speed = Number.isFinite(value?.tps) && value.tps > 0
      ? (value.estimated ? '≈' : '') + tpsFormat.format(value.tps) + ' tok/s' : 'TPS —';
    const size = Number.isFinite(value?.context) && value.context > 0
      ? contextFormat.format(value.context) : '—';
    if (tps.textContent !== speed) tps.textContent = speed;
    if (context.textContent !== 'Konteks ' + size) context.textContent = 'Konteks ' + size;
    meter.dataset.writing = Boolean(value?.writing);
    meter.title = value?.writing ? 'Model sedang menghasilkan respons' : 'Pengukuran respons terakhir';
  }

  function playWhenVisible() {
    if (!current || !hasSurface || document.hidden) video.pause();
    else video.play().catch(() => {});
  }

  function update(next, message = '') {
    state = next;
    pending = false;
    deleteId = null;
    status.textContent = message;
    renderList();
    locateDock();
    refreshSurfaces();
    if (current !== state.active) {
      current = state.active;
      if (current) {
        video.src = mediaPrefix + current + '.webm';
      } else {
        video.removeAttribute('src');
        video.load();
      }
      playWhenVisible();
    }
  }

  document.addEventListener('visibilitychange', playWhenVisible);
  const timer = setInterval(() => {
    if (document.hidden) return;
    locateDock();
    refreshSurfaces();
  }, 1200);
  window.__agyWallpaper = {
    update,
    conversationTitle,
    showTps,
    report: () => ({
      active: current,
      attached: hasSurface,
      coversChat: hasSurface && layer.offsetHeight >= surface.clientHeight - 1,
      docked: !controls.hidden && controls.parentElement === sidebarDock,
      minimized: !dialog.open,
      visible: !document.hidden,
      playing: !video.paused && video.readyState >= 2,
      sourceWidth: video.videoWidth,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      dropped: video.getVideoPlaybackQuality().droppedVideoFrames,
      currentTime: video.currentTime,
      error: video.error?.code ?? null,
    }),
    dispose: () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', playWhenVisible);
      video.pause();
      layer.remove();
      controls.remove();
      meter.remove();
      composer?.classList.remove('aw-composer-anchor');
      dock?.classList.remove('aw-settings-for-theme');
      sidebarDock?.classList.remove('aw-theme-sidebar');
      surface?.classList.remove('aw-pane');
      transparentChat?.classList.remove('aw-clear');
      document.body.classList.remove('aw-wallpaper-active');
      delete window.__agyWallpaper;
    },
  };
  update(initial);
})
