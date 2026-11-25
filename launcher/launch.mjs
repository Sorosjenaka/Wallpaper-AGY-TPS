import { spawn, execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, open, stat, unlink } from 'node:fs/promises';
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
const requestFile = join(kitFolder, 'launch.request');
const prefix = '/__agy-wallpaper-local__/';
const statusFile = join(kitFolder, 'status.json');
const layoutFiles = ['wallpaper.css', 'renderer.js'];
const readLayout = () => Promise.all(layoutFiles.map(file => readFile(join(folder, file), 'utf8')));
let [style, renderer] = await readLayout();

const log = (message) => {
  const line = new Date().toISOString() + ' ' + message + '\n';
  appendFile(join(kitFolder, 'launch.log'), line).catch(() => {});
  if (process.env.AGY_WALLPAPER_DEBUG) process.stderr.write(line);
};

const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

const exists = path => stat(path).then(() => true, () => false);

// PIDs are reused after a reboot, so a leftover instance.lock can point at an
// unrelated process. Only treat the lock as live when the owner is really the
// wallpaper supervisor.
const isSupervisor = pid => new Promise(resolve => {
  if (!alive(pid)) return resolve(false);
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    "if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -like '*launch.mjs*') { 'yes' } else { 'no' }",
  ].join('\n');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 },
    (error, stdout) => resolve(String(stdout || '').trim() === 'yes'));
});

const focusRunningApp = () => {
  const focus = spawn(exe, [], { env, detached: true, stdio: 'ignore' });
  focus.on('error', () => {});
  focus.unref();
};

const requestLaunch = async () => {
  await writeFile(requestFile, String(Date.now())).catch(() => {});
  log('wrote launch request');
};

const killForeignInstances = () => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve(false);
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" |",
    "  Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'register_loader' }",
    "if ($procs) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Output ('killed=' + ($procs.ProcessId -join ',')) } else { Write-Output 'killed=none' }",
  ].join('\n');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 },
    (error, stdout) => {
      const text = String(stdout || '').trim();
      log('foreign check: ' + (text || (error && error.message) || 'no output'));
      resolve(text.includes('killed=') && !text.includes('killed=none'));
    });
});

// Stay in the background after Antigravity closes. As soon as a new
// Antigravity process appears (started from any shortcut or directly), stop
// it and relaunch it with the CDP pipe so the wallpaper can attach.
function watchForNextLaunch(exitAt) {
  if (process.platform !== 'win32') return null;
  const since = exitAt + 400;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$since = [long]' + since,
    'while ($true) {',
    '  Start-Sleep -Milliseconds 600',
    '  $procs = @(Get-Process -Name Antigravity -ErrorAction SilentlyContinue |',
    '    Where-Object { try { ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() -gt $since } catch { $false } })',
    '  if ($procs.Count -gt 0) {',
    "    $ids = ($procs | ForEach-Object { $_.Id }) -join ','",
    '    $procs | Stop-Process -Force -ErrorAction SilentlyContinue',
    "    Write-Output ('killed=' + $ids)",
    '    break',
    '  }',
    '}',
  ].join('\n');
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  watcher.on('error', error => log('watcher error: ' + error.message));
  return watcher;
}

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
    if (await isSupervisor(Number(previous))) return false;
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

async function update(view, message = '', complete = true) {
  await view.evaluate(`window.__agyWallpaper?.update(${JSON.stringify(currentThemes())},${JSON.stringify(message)},${complete})`);
}

async function importFromPicker(view) {
  // Resolve the File captured by the trusted change event in the isolated world.
  const { result } = await view.send('Runtime.evaluate', {
    expression: 'window.__agyWallpaper?.takeUpload()',
    contextId: view.context,
  });
  const objectId = result?.objectId;
  if (!objectId) throw new Error('Pilih file wallpaper lagi.');
  try {
    const { path } = await view.send('DOM.getFileInfo', { objectId });
    return path;
  } finally {
    await view.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

async function main() {
  await mkdir(kitFolder, { recursive: true, mode: 0o700 });
  let ownsInstance = await lockInstance();
  if (!ownsInstance) {
    let previous = {};
    try { previous = JSON.parse(await readFile(statusFile, 'utf8')); } catch {}
    const fresh = previous.checkedAt && Date.now() - Date.parse(previous.checkedAt) < 10000;
    if (previous.status === 'ready' && fresh && alive(Number(previous.pid))) {
      focusRunningApp();
      return;
    }
    if (previous.status === 'waiting' && fresh) {
      await requestLaunch();
      return;
    }
    // The previous supervisor may be shutting down; give it time to release
    // the lock before falling back to a launch request.
    for (let attempt = 0; attempt < 20 && !ownsInstance; attempt++) {
      await delay(150);
      ownsInstance = await lockInstance();
    }
    if (!ownsInstance) {
      await requestLaunch();
      return;
    }
  }
  let child;
  let pipe;
  let lastExitAt = 0;
  let layoutWatcher;
  let layoutChanged = false;
  const views = new Map();
  const probes = new Map();
  const spawnChild = () => {
    views.clear();
    probes.clear();
    child = spawn(exe, ['--remote-debugging-pipe'], {
      env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    child.on('error', error => log('spawn error: ' + error.message));
    child.on('exit', (code, signal) => {
      lastExitAt = Date.now();
      log('antigravity exited code=' + code + ' signal=' + signal);
    });
    pipe = new Pipe(child.stdio[3], child.stdio[4]);
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
            const command = JSON.parse(event.params.payload);
            if (command.action === 'import') command.file = await importFromPicker(view);
            await changeTheme(command);
            await Promise.allSettled([...views.values()].map(item => update(item, '', item === view)));
          } catch (error) {
            await update(view, error.message?.length < 180 ? error.message : 'Tema tidak bisa disimpan.');
          }
        })().catch(() => {});
      }
    });
    log('spawned antigravity pid=' + child.pid);
    return child;
  };

  try {
    await loadThemes();
    layoutWatcher = watch(folder, { persistent: false }, (_event, file) => {
      if (layoutFiles.includes(file)) layoutChanged = true;
    });
    layoutWatcher.on('error', () => {});
    await killForeignInstances();
    await unlink(requestFile).catch(() => {});

    while (true) {
      spawnChild();
      await report({ status: 'starting', pid: child.pid });
      let rounds = 0;
      while (true) {
        try {
          if (child.exitCode !== null) break;
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
        } catch (error) {
          log('loop error: ' + (error && error.message || error));
          if (child.exitCode !== null) break;
          if (pipe.closed) {
            log('pipe closed while app is alive; restarting it');
            child.kill();
            await delay(1200);
            break;
          }
        }
        await delay(1000);
      }

      const exitAt = lastExitAt || Date.now();
      log('antigravity closed at ' + new Date(exitAt).toISOString() + ', waiting for next launch');
      await report({ status: 'waiting', pid: null });
      const watcher = watchForNextLaunch(exitAt);
      let killedByWatcher = false;
      watcher?.stdout.on('data', data => {
        const text = String(data).trim();
        if (text) { log('watcher ' + text); killedByWatcher = true; }
      });
      let lastReport = Date.now();
      try {
        while (!killedByWatcher) {
          if (await exists(requestFile)) {
            await unlink(requestFile).catch(() => {});
            log('launch request received');
            break;
          }
          if (Date.now() - lastReport > 4000) {
            lastReport = Date.now();
            await report({ status: 'waiting', pid: null });
          }
          await delay(400);
        }
      } finally {
        watcher?.kill();
      }
      await delay(killedByWatcher ? 1500 : 900);
    }
  } finally {
    layoutWatcher?.close();
    await closeTps();
    await unlink(lock).catch(() => {});
    await unlink(requestFile).catch(() => {});
  }
}

main().catch(async error => {
  log('fatal: ' + (error && error.stack || error));
  await report({ status: 'error' });
  focusRunningApp();
});
