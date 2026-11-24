import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { changeTheme, currentThemes, loadThemes, mediaPath, uploadLimit } from './themes.mjs';
import { findAntigravity, kitFolder } from './paths.mjs';
import { closeTps, refreshTps } from './tps.mjs';

const exe = findAntigravity();
if (!exe) {
  console.error('Antigravity Desktop tidak ditemukan. Set AGY_DESKTOP_PATH ke executable aplikasinya.');
  process.exit(1);
}
const folder = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const lock = join(kitFolder, 'instance.lock');
const prefix = '/__agy-wallpaper-local__/';
const statusFile = join(kitFolder, 'status.json');
const layoutFiles = ['wallpaper.css', 'renderer.js'];
const readLayout = () => Promise.all(layoutFiles.map(file => readFile(join(folder, file), 'utf8')));
let [style, renderer] = await readLayout();

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

async function lockInstance() {
  try {
    const handle = await open(lock, 'wx');
    try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); }
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous = await readFile(lock, 'utf8').catch(() => '');
    if (!previous) {
      await delay(150);
      previous = await readFile(lock, 'utf8').catch(() => '');
    }
    if (alive(Number(previous))) return false;
    await unlink(lock).catch(() => {});
    return lockInstance();
  }
}

class Pipe extends EventEmitter {
  constructor(write, read) {
    super();
    this.write = write;
    this.sequence = 0;
    this.pending = new Map();
    this.parts = [];
    this.closed = false;
    read.on('data', data => this.receive(data));
    read.on('end', () => this.close());
    read.on('error', () => this.close());
    write.on('error', () => this.close());
  }

  command(method, params = {}, sessionId = undefined) {
    if (this.closed) return Promise.reject(new Error('Pipe closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const alarm = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 3500);
      this.pending.set(id, { resolve, reject, alarm });
      this.write.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }

  receive(data) {
    for (;;) {
      const end = data.indexOf(0);
      if (end < 0) { this.parts.push(data); break; }
      this.parts.push(data.subarray(0, end));
      const message = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      data = data.subarray(end + 1);
      let value;
      try { value = JSON.parse(message); } catch { continue; }
      if (!value.id) { this.emit('notice', value); continue; }
      const result = this.pending.get(value.id);
      if (!result) continue;
      this.pending.delete(value.id);
      clearTimeout(result.alarm);
      if (value.error) result.reject(new Error(value.error.message));
      else result.resolve(value.result);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.alarm);
      waiter.reject(new Error('Pipe closed'));
    }
    this.pending.clear();
  }
}

async function report(status) {
  await writeFile(statusFile, JSON.stringify({ ...status, checkedAt: new Date().toISOString() })).catch(() => {});
}

function loopbackOrigin(address) {
  try {
    const url = new URL(address);
    return ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port ? url.origin : null;
  } catch { return null; }
}

const nativeHub = 'Boolean(window.electronNative && window.nativeStorage && window.agent && document.body)';

async function setup(pipe, info, origin) {
  const { sessionId } = await pipe.command('Target.attachToTarget', { targetId: info.targetId, flatten: true });
  const send = (name, args) => pipe.command(name, args, sessionId);
  try {
    const result = await send('Runtime.evaluate', { expression: nativeHub, returnByValue: true });
    if (!result.result?.value) {
      await pipe.command('Target.detachFromTarget', { sessionId });
      return null;
    }
    await send('Page.enable');
    await send('Runtime.enable');
    const { frameTree } = await send('Page.getFrameTree');
    const frameId = frameTree.frame.id;
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'AgyWallpaper' });
    const evaluate = expression => send('Runtime.evaluate', {
      expression, contextId: executionContextId, returnByValue: true,
    });
    await send('Runtime.addBinding', { name: 'agyWallpaperCommand', executionContextName: 'AgyWallpaper' });
    await send('DOM.enable');
    await send('CSS.enable');
    const { styleSheetId } = await send('CSS.createStyleSheet', { frameId });
    await send('CSS.setStyleSheetText', { styleSheetId, text: style });
    await send('Fetch.enable', { patterns: [{ urlPattern: origin + prefix + '*', requestStage: 'Request' }] });
    return { context: executionContextId, evaluate, frameId, sessionId, send, origin, styleSheetId, target: info.targetId };
  } catch (error) {
    await pipe.command('Target.detachFromTarget', { sessionId }).catch(() => {});
    throw error;
  }
}

async function serveMedia(view, { request, requestId }) {
  const url = new URL(request.url);
  const id = url.pathname.slice(prefix.length).replace(/\.webm$/, '');
  const path = url.origin === view.origin && url.pathname === prefix + id + '.webm' ? mediaPath(id) : null;
  const respond = (responseCode, responseHeaders = [], body = '') => view.send('Fetch.fulfillRequest', {
    requestId, responseCode, responseHeaders, body,
  });
  if (!path || request.method !== 'GET') return respond(404);
  const data = await readFile(path).catch(() => null);
  if (!data) return respond(404);
  const headers = [
    { name: 'Content-Type', value: 'video/webm' },
    { name: 'Accept-Ranges', value: 'bytes' },
    { name: 'Cache-Control', value: 'no-store' },
  ];
  const range = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'range')?.[1];
  const match = /^bytes=(\d+)-(\d*)$/.exec(range || '');
  if (!match) return respond(200, headers, data.toString('base64'));
  const start = Number(match[1]);
  const end = match[2] ? Math.min(data.length - 1, Number(match[2])) : data.length - 1;
  if (start > end || start >= data.length) {
    return respond(416, [{ name: 'Content-Range', value: `bytes */${data.length}` }]);
  }
  headers.push({ name: 'Content-Range', value: `bytes ${start}-${end}/${data.length}` });
  return respond(206, headers, data.subarray(start, end + 1).toString('base64'));
}

async function install(view) {
  const result = await view.evaluate(
    `${renderer.trim()}(${JSON.stringify(currentThemes())},${JSON.stringify(prefix)},${uploadLimit})`,
  );
  if (result.exceptionDetails) throw new Error('Theme UI could not initialize');
}

async function update(view, message = '') {
  await view.evaluate(`window.__agyWallpaper?.update(${JSON.stringify(currentThemes())},${JSON.stringify(message)})`);
}

async function main() {
  await mkdir(kitFolder, { recursive: true, mode: 0o700 });
  let ownsInstance = await lockInstance();
  if (!ownsInstance) {
    let previousPid;
    try { previousPid = JSON.parse(await readFile(statusFile, 'utf8')).pid; } catch {}
    if (!alive(previousPid)) {
      for (let attempt = 0; attempt < 16 && !ownsInstance; attempt++) {
        await delay(150);
        ownsInstance = await lockInstance();
      }
    }
  }
  if (!ownsInstance) {
    const focus = spawn(exe, [], { env, detached: true, stdio: 'ignore' });
    focus.on('error', () => {});
    focus.unref();
    return;
  }
  let child;
  let watcher;
  const views = new Map();
  const probes = new Map();
  try {
    await loadThemes();
    child = spawn(exe, ['--remote-debugging-pipe'], {
      env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    child.on('error', () => {});
    const pipe = new Pipe(child.stdio[3], child.stdio[4]);
    await report({ status: 'starting', pid: child.pid });
    pipe.on('notice', event => {
      const view = views.get(event.sessionId);
      if (event.method === 'Target.detachedFromTarget') views.delete(event.params.sessionId);
      if (!view) return;
      if (event.method === 'Fetch.requestPaused') {
        void serveMedia(view, event.params).catch(() => {});
      }
      if (event.method === 'Page.frameNavigated' && event.params.frame.id === view.frameId) {
        views.delete(view.sessionId);
        probes.delete(view.target);
        void pipe.command('Target.detachFromTarget', { sessionId: view.sessionId }).catch(() => {});
      }
      if (event.method === 'Runtime.bindingCalled' && event.params.name === 'agyWallpaperCommand' &&
          event.params.executionContextId === view.context && currentThemes()) {
        void (async () => {
          try {
            await changeTheme(JSON.parse(event.params.payload));
            await Promise.allSettled([...views.values()].map(item => update(item)));
          } catch (error) {
            await update(view, error.message?.length < 180 ? error.message : 'Tema tidak bisa disimpan.');
          }
        })().catch(() => {});
      }
    });

    let layoutChanged = false;
    watcher = watch(folder, { persistent: false }, (_event, file) => {
      if (layoutFiles.includes(file)) layoutChanged = true;
    });
    watcher.on('error', () => {});
    let rounds = 0;
    while (!pipe.closed && child.exitCode === null) {
      try {
        if (layoutChanged) {
          layoutChanged = false;
          [style, renderer] = await readLayout();
          await Promise.allSettled([...views.values()].map(async view => {
            await view.send('CSS.setStyleSheetText', { styleSheetId: view.styleSheetId, text: style });
            await view.evaluate('window.__agyWallpaper?.dispose()');
            await install(view);
          }));
        }
        const { targetInfos } = await pipe.command('Target.getTargets');
        for (const info of targetInfos) {
          const origin = loopbackOrigin(info.url);
          if (!origin || !['page', 'webview', 'other'].includes(info.type) ||
              [...views.values()].some(view => view.target === info.targetId) ||
              (probes.get(info.targetId) ?? 0) > Date.now()) continue;
          probes.set(info.targetId, Date.now() + 5000);
          const view = await setup(pipe, info, origin).catch(() => null);
          if (!view) continue;
          views.set(view.sessionId, view);
          try { await install(view); }
          catch {
            views.delete(view.sessionId);
            await pipe.command('Target.detachFromTarget', { sessionId: view.sessionId }).catch(() => {});
          }
        }
        await refreshTps([...views.values()]);
        if (rounds++ % 4 === 0) {
          let metrics = null;
          for (const view of views.values()) {
            const result = await view.evaluate('window.__agyWallpaper?.report()').catch(() => null);
            const current = result?.result?.value;
            if (current && (!metrics || current.playing)) metrics = current;
          }
          await report({ status: metrics ? 'ready' : 'waiting-for-hub', pid: child.pid, views: views.size, metrics });
        }
      } catch {
        if (pipe.closed) break;
      }
      await delay(1000);
    }
    await report({ status: 'closed' });
  } finally {
    watcher?.close();
    await closeTps();
    await unlink(lock).catch(() => {});
  }
}

main().catch(async () => {
  await report({ status: 'error' });
  const original = spawn(exe, [], { env, detached: true, stdio: 'ignore' });
  original.on('error', () => {});
  original.unref();
});
