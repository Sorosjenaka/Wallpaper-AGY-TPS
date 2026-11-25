import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../launcher/auto-compact.js', import.meta.url), 'utf8');
const firstChat = '/c/12345678-1234-1234-1234-123456789abc';
const nextChat = '/c/87654321-1234-1234-1234-123456789abc';

function fixture() {
  const state = {
    usage: 91, draft: '', busy: false, attachment: false, focus: true, multiple: false,
    sent: [], onSubmitWait: null, onEditorFocus: null,
  };
  const box = () => [{}];
  const listeners = new Map();
  const storage = new Map();
  let clock = 0;
  let check;
  const editor = {
    get textContent() { return state.draft; },
    getClientRects: box,
    focus() {
      doc.activeElement = editor;
      state.onEditorFocus?.();
    },
    select() {},
  };
  const send = {
    getClientRects: box,
    getAttribute: () => null,
    click() { state.sent.push({ route: win.location.pathname, draft: state.draft }); state.draft = ''; },
  };
  const pulse = {
    getClientRects: box,
    shadowRoot: {
      querySelector: () => ({ textContent: state.usage === null ? '—' : `${state.usage}%` }),
    },
  };
  const composer = {
    getClientRects: box,
    contains: value => value === editor,
    querySelector: () => editor,
    querySelectorAll(selector) {
      if (selector.includes('input-send-button')) return state.draft || state.attachment ? [send] : [];
      if (selector.includes('input-cancel-button')) return state.busy || state.attachment ? [{ getClientRects: box }] : [];
      if (selector.includes('ag-prism-pulse-bar')) return [pulse];
      return [];
    },
  };
  const doc = {
    hidden: false,
    body: {},
    activeElement: null,
    hasFocus: () => state.focus,
    querySelector: () => ({}),
    querySelectorAll: selector => selector.includes('agentSidePanelInputBox')
      ? (state.multiple ? [composer, composer] : [composer]) : [],
    addEventListener(event, fn) { listeners.set(event, fn); },
    removeEventListener(event) { listeners.delete(event); },
    getSelection: () => null,
    execCommand(command, _, value) {
      if (command === 'insertText') state.draft += value;
      if (command === 'delete') state.draft = '';
      return true;
    },
  };
  doc.activeElement = doc.body;
  const win = {
    location: { pathname: firstChat },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setInterval(fn) { check = fn; return 1; },
    clearInterval() {},
    setTimeout(fn) {
      const before = state.onSubmitWait;
      state.onSubmitWait = null;
      before?.(listeners);
      fn();
    },
  };
  const install = runInNewContext(source, { Date: { now: () => clock } });
  install(doc, win);
  return {
    state, doc, win,
    async tick(times = 1) {
      for (let index = 0; index < times; index++) { clock += 4_000; await check(); }
    },
  };
}

test('compacts the idle conversation once and rearms after usage drops', async () => {
  const { state, tick } = fixture();
  await tick(3);
  assert.equal(state.sent.length, 0);
  await tick();
  assert.deepEqual(state.sent, [{ route: firstChat, draft: '/compact' }]);
  await tick(10);
  assert.equal(state.sent.length, 1);
  state.usage = 79;
  await tick();
  state.usage = 93;
  await tick(3);
  assert.equal(state.sent.length, 2);
});

test('waits through low or missing readings, active turns, drafts and ambiguous panes', async () => {
  for (const data of [
    { usage: 89 }, { usage: null }, { busy: true }, { draft: 'unfinished input' },
    { attachment: true }, { focus: false }, { multiple: true },
  ]) {
    const { state, tick } = fixture();
    Object.assign(state, data);
    await tick(10);
    assert.deepEqual(state.sent, []);
    assert.equal(state.draft, data.draft || '');
  }
});

test('cancels on user input and only clears its own /compact draft', async () => {
  const { state, tick } = fixture();
  state.onSubmitWait = listeners => {
    listeners.get('keydown')({ isTrusted: true });
    state.draft += 'my draft';
  };
  await tick(4);
  assert.equal(state.draft, 'my draft');
  assert.deepEqual(state.sent, []);
});

test('a conversation switch or a draft restored on focus prevents submit', async () => {
  const switched = fixture();
  switched.state.onSubmitWait = () => {
    switched.win.location.pathname = nextChat;
    switched.state.draft = 'another conversation draft';
  };
  await switched.tick(4);
  assert.equal(switched.state.draft, 'another conversation draft');
  assert.deepEqual(switched.state.sent, []);

  const restored = fixture();
  restored.state.onEditorFocus = () => { restored.state.draft = '/compact'; };
  await restored.tick(4);
  assert.equal(restored.state.draft, '/compact');
  assert.deepEqual(restored.state.sent, []);
});
