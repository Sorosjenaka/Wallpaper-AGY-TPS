import { spawnSync } from 'node:child_process';
import { constants, statSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findAntigravity, home, kitFolder, pluginName, readSettings, settingsPath, sidecarName } from '../launcher/paths.mjs';
import { installPrism, prismName, prismSidecar } from './prism.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = join(home, '.gemini', 'config');
const configPath = join(configDir, 'config.json');
const pluginPath = join(configDir, 'plugins', pluginName);
const manifestPath = join(pluginPath, 'plugin.json');
const sidecar = `${pluginName}/${sidecarName}`;
const dataMode = { mode: 0o600 };
const { positionals: [action], values } = parseArgs({
  allowPositionals: true,
  options: {
    'app-path': { type: 'string' }, 'ffmpeg-path': { type: 'string' }, 'max-fps': { type: 'string' },
    'with-prism': { type: 'boolean' }, 'without-prism': { type: 'boolean' },
  },
});

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  const staging = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(staging, JSON.stringify(value, null, 2) + '\n', { ...dataMode, flag: 'wx' });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

async function setSidecarEnabled(config, enable) {
  if (!enable && !config.sidecars?.[sidecar]) return;
  if (enable && config.sidecars?.[sidecar]?.enabled === true) return;
  if (enable) {
    config.sidecars ??= {};
    config.sidecars[sidecar] = { ...config.sidecars[sidecar], enabled: true };
  } else {
    delete config.sidecars[sidecar];
  }
  await writeHostConfig(config);
}

async function backupHostConfig() {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // The one-time backup stays in the user's private data directory.
  await copyFile(configPath, join(kitFolder, 'config-before-first-install.json'), constants.COPYFILE_EXCL)
    .catch(error => { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; });
}

async function writeHostConfig(config) {
  await backupHostConfig();
  await writeJson(configPath, config);
}

async function retireIdleLauncher() {
  const lock = join(kitFolder, 'instance.lock');
  const pid = Number(await readFile(lock, 'utf8').catch(() => ''));
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    throw error;
  }
  const launcher = join(kitFolder, 'launcher', 'launch.mjs');
  if (process.platform === 'win32') {
    const command = [
      '$ErrorActionPreference = "Stop"',
      '$owner = Get-CimInstance Win32_Process -Filter "ProcessId=$env:AGY_KIT_SETUP_PID"',
      'if (!$owner -or $owner.Name -ne "node.exe" -or !$owner.CommandLine.Contains($env:AGY_KIT_SETUP_LAUNCHER)) { exit 0 }',
      '$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$env:AGY_KIT_SETUP_PID")',
      'if ($children | Where-Object Name -eq "Antigravity.exe") { exit 78 }',
      '$watchers = $children | Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -like "*Start-Sleep -Milliseconds 600*" -and $_.CommandLine -like "*Get-Process -Name Antigravity*" }',
      '$watchers | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }',
      'Stop-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue',
    ].join('\n');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, AGY_KIT_SETUP_PID: String(pid), AGY_KIT_SETUP_LAUNCHER: launcher },
      windowsHide: true, timeout: 15000,
    });
    if (result.status === 78) throw new Error('Keluar dari Antigravity Desktop sebelum menjalankan installer.');
    if (result.status !== 0) throw new Error('Peluncur Antigravity Kit belum bisa dihentikan.');
    return;
  }
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (!result.stdout?.trim().endsWith(launcher)) return;
  const children = spawnSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  if (children.status === 0) throw new Error('Keluar dari Antigravity Desktop sebelum menjalankan installer.');
  if (children.status !== 1) throw new Error('Peluncur Antigravity Kit belum bisa diperiksa.');
  process.kill(pid);
}

async function main() {
  if (!['win32', 'darwin'].includes(process.platform) || !['install', 'uninstall'].includes(action)) {
    throw new Error('Gunakan skrip instalasi Windows atau macOS.');
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Perlu Node.js 24 atau yang lebih baru.');
  const config = await readJson(configPath, {});
  const manifest = await readJson(manifestPath, null);
  if (manifest && manifest.name !== pluginName) throw new Error('Direktori plugin sudah dipakai oleh plugin lain.');
  if (action === 'uninstall') {
    await retireIdleLauncher();
    await setSidecarEnabled(config, false);
    if (manifest) await rm(pluginPath, { recursive: true, force: true });
    const runtime = join(kitFolder, 'launcher');
    for (const name of ['launch.mjs', 'paths.mjs', 'renderer.js', 'themes.mjs', 'tps.mjs', 'wallpaper.css']) {
      await rm(join(runtime, name), { force: true });
    }
    console.log('Plugin dilepas. Wallpaper dan pengaturan lokal tetap tersimpan.');
    return;
  }

  if (values['app-path'] && !statSync(resolve(values['app-path']), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Executable dari --app-path tidak ditemukan.');
  }
  const previous = readSettings();
  if (values['with-prism'] && values['without-prism']) throw new Error('Pilih satu mode Prism.');
  const prism = !values['without-prism'] && (values['with-prism'] || previous.prism === true);
  const appPath = values['app-path'] ? resolve(values['app-path']) : previous.appPath;
  const maxFps = Number(values['max-fps'] || previous.maxFps || 60);
  if (![30, 60, 120].includes(maxFps)) throw new Error('Batas FPS harus 30, 60, atau 120.');
  if (!findAntigravity(appPath)) throw new Error('Instal Antigravity Desktop terlebih dahulu.');
  const ffmpegPath = values['ffmpeg-path'] || previous.ffmpegPath || 'ffmpeg';
  const ffmpeg = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  if (ffmpeg.status !== 0) {
    throw new Error('FFmpeg tidak ditemukan. Instal FFmpeg dan buka terminal baru.');
  }
  if (!/\blibvpx-vp9\b/.test(ffmpeg.stdout)) throw new Error('FFmpeg perlu encoder libvpx-vp9.');

  await retireIdleLauncher();
  await mkdir(kitFolder, { recursive: true, mode: 0o700 });
  let activeConfig = config;
  if (prism) {
    await backupHostConfig();
    await installPrism(repo, configDir, kitFolder);
    activeConfig = await readJson(configPath, {});
    activeConfig.plugins ??= {};
    activeConfig.plugins[prismName] = { ...activeConfig.plugins[prismName], enabled: true };
    if (config.plugins?.['antigravity-prism']) {
      activeConfig.plugins['antigravity-prism'] = config.plugins['antigravity-prism'];
    }
    activeConfig.sidecars ??= {};
    activeConfig.sidecars[prismSidecar] = { ...activeConfig.sidecars[prismSidecar], enabled: true };
    await writeHostConfig(activeConfig);
  } else if (previous.prism === true && activeConfig.sidecars?.[prismSidecar]) {
    activeConfig.sidecars[prismSidecar].enabled = false;
    await writeHostConfig(activeConfig);
  }
  await mkdir(dirname(pluginPath), { recursive: true, mode: 0o700 });
  await cp(join(repo, 'launcher'), join(kitFolder, 'launcher'), { recursive: true });
  await cp(join(repo, 'plugin'), pluginPath, { recursive: true });
  await writeJson(settingsPath, { appPath, ffmpegPath, maxFps, prism });
  await writeFile(join(kitFolder, 'node-path.txt'), process.execPath + '\n', dataMode);
  await setSidecarEnabled(activeConfig, true);
  console.log(prism ? 'Launcher, Prism, dan patch slider siap.' : 'Launcher dan plugin TPS siap.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
