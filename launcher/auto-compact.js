(function installAutoCompact(doc = document, win = window) {
  win.__agyAutoCompact?.dispose();
  const composerSelector = '[id="antigravity.agentSidePanelInputBox"], [data-testid="antigravity.agentSidePanelInputBox"]';
  const editorSelector = '[contenteditable="true"][role="combobox"], textarea';
  const sendSelector = '[data-testid="input-send-button"], [data-testid="send-button"]';
  const busySelector = '[data-testid="input-cancel-button"], [data-testid="stop-generation-button"]';
  const attachmentSelector = '[data-testid*="attachment" i], [data-testid*="queued-message" i]';
  const prismSelector = '#ag-prism-pulse-bar, #ag-pulse-status-bar, [data-ag-prism-pulse-bar]';
  const storageKey = 'wallpaper-agy-tps.compact-attempts.v1';
  const sessionPattern = /^\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i;
  const threshold = 90;
  const rearm = 80;
  const idleMs = 15_000;
  const stableMs = 8_000;
  const events = ['pointerdown', 'keydown', 'wheel', 'paste', 'compositionstart'];
  let lastActivity = Date.now();
  let candidate = null;
  let phase = 'waiting';
  let percent = null;
  let pending = null;
  let disposed = false;
  let attempted = [];
  const wait = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const visible = node => Boolean(node?.getClientRects().length);
  const draft = editor => String(editor.value ?? editor.textContent ?? '').replace(/\u200B/g, '').trim();
  const currentId = () => sessionPattern.exec(win.location.pathname)?.[1]?.toLowerCase();

  function loadAttempts() {
    try {
      const value = JSON.parse(win.localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(value)) attempted = value.filter(id => typeof id === 'string').slice(-128);
    } catch {}
  }

  function updateAttempts(id, add) {
    attempted = attempted.filter(item => item !== id);
    if (add) attempted.push(id);
    attempted = attempted.slice(-128);
    try { win.localStorage.setItem(storageKey, JSON.stringify(attempted)); } catch {}
  }

  function sendButton(composer) {
    return [...composer.querySelectorAll(sendSelector)].find(button =>
      visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
  }

  function occupied(composer) {
    return [...composer.querySelectorAll(`${busySelector}, ${attachmentSelector}`)].some(visible);
  }

  function chat() {
    const id = currentId();
    if (!id || doc.hidden || !doc.hasFocus() || !doc.querySelector('[data-testid="conversation-view"]')) return null;
    const composers = [...doc.querySelectorAll(composerSelector)].filter(visible);
    if (composers.length !== 1) return null;
    const composer = composers[0];
    const editor = composer.querySelector(editorSelector);
    const pulse = [...composer.querySelectorAll(prismSelector)].find(visible);
    if (!visible(editor) || !pulse?.shadowRoot) return null;
    const reading = pulse.shadowRoot.querySelector('#context-percent')?.textContent?.trim();
    const match = /^([0-9]{1,3})\s*%$/.exec(reading || '');
    const usage = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(usage) || usage > 100) return null;
    return { id, composer, editor, usage };
  }

  function clearOwnDraft(operation) {
    const { id, editor } = operation;
    if (!operation.inserted || currentId() !== id || doc.activeElement !== editor || draft(editor) !== '/compact') return;
    const selection = doc.getSelection();
    if (typeof editor.select === 'function') editor.select();
    else if (selection) {
      const range = doc.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    doc.execCommand('delete');
  }

  function onActivity(event) {
    if (!event.isTrusted) return;
    lastActivity = Date.now();
    if (pending) {
      pending.cancelled = true;
      clearOwnDraft(pending);
    }
  }

  function stillSafe(operation) {
    if (disposed || operation.cancelled || doc.activeElement !== operation.editor) return false;
    const current = chat();
    return current?.id === operation.id && current.editor === operation.editor &&
      current.usage >= threshold && !occupied(current.composer);
  }

  async function submit(current) {
    const { composer, editor, id } = current;
    const operation = { ...current, cancelled: false, inserted: false };
    pending = operation;
    let dispatched = false;
    try {
      editor.focus({ preventScroll: true });
      if (!stillSafe(operation) || draft(editor) || sendButton(composer)) return;
      operation.inserted = doc.execCommand('insertText', false, '/compact');
      if (!operation.inserted) return;
      phase = 'preparing';

      // Lexical and the native send button update asynchronously after input.
      for (let attempt = 0; attempt < 6; attempt++) {
        await wait(75);
        if (!stillSafe(operation) || draft(editor) !== '/compact') return;
        const button = sendButton(composer);
        if (button) {
          updateAttempts(id, true);
          dispatched = true;
          button.click();
          phase = 'submitted';
          return;
        }
      }
    } finally {
      if (!dispatched) {
        clearOwnDraft(operation);
        phase = 'deferred';
        lastActivity = Date.now();
      }
      pending = null;
      candidate = null;
    }
  }

  async function check() {
    if (disposed || pending) return;
    const current = chat();
    percent = current?.usage ?? null;
    if (!current) { candidate = null; phase = 'no-context'; return; }
    loadAttempts();
    if (current.usage <= rearm && attempted.includes(current.id)) updateAttempts(current.id, false);
    if (current.usage < threshold) { candidate = null; phase = 'below-threshold'; return; }
    if (attempted.includes(current.id)) { candidate = null; phase = 'waiting-for-room'; return; }

    const modal = [...doc.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].some(visible);
    const focused = doc.activeElement;
    const otherControl = focused && focused !== doc.body && focused !== current.editor;
    if (modal || otherControl || occupied(current.composer) || draft(current.editor) || sendButton(current.composer)) {
      candidate = null;
      phase = 'busy-or-draft';
      return;
    }
    const now = Date.now();
    if (candidate?.id !== current.id) candidate = { id: current.id, since: now };
    if (now - lastActivity < idleMs || now - candidate.since < stableMs) { phase = 'waiting-idle'; return; }
    await submit(current);
  }

  for (const event of events) doc.addEventListener(event, onActivity, true);
  const timer = win.setInterval(() => check().catch(() => { phase = 'deferred'; }), 4_000);
  win.__agyAutoCompact = {
    report: () => ({ enabled: true, threshold, phase, percent }),
    dispose: () => {
      disposed = true;
      win.clearInterval(timer);
      for (const event of events) doc.removeEventListener(event, onActivity, true);
      if (pending) clearOwnDraft(pending);
      delete win.__agyAutoCompact;
    },
  };
})
