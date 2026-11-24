import { spawnSync } from 'node:child_process';
import { constants, statSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findAntigravity, home, kitFolder, pluginName, readSettings, settingsPath, sidecarName } from '../launcher/paths.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const configDir = join(home, '.gemini', 'config');
const configPath = join(configDir, 'config.json');
const pluginPath = join(configDir, 'plugins', pluginName);
const manifestPath = join(pluginPath, 'plugin.json');
const sidecar = `${pluginName}/${sidecarName}`;
const dataMode = { mode: 0o600 };
const { positionals: [action], values } = parseArgs({
  allowPositionals: true,
  options: { 'app-path': { type: 'string' }, 'ffmpeg-path': { type: 'string' }, 'max-fps': { type: 'string' } },
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
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // The one-time backup stays in the user's private data directory.
  await copyFile(configPath, join(kitFolder, 'config-before-first-install.json'), constants.COPYFILE_EXCL)
    .catch(error => { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; });
  if (enable) {
    config.sidecars ??= {};
    config.sidecars[sidecar] = { ...config.sidecars[sidecar], enabled: true };
  } else {
    delete config.sidecars[sidecar];
  }
  await writeJson(configPath, config);
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

  await mkdir(kitFolder, { recursive: true, mode: 0o700 });
  await mkdir(dirname(pluginPath), { recursive: true, mode: 0o700 });
  await cp(join(repo, 'launcher'), join(kitFolder, 'launcher'), { recursive: true });
  await cp(join(repo, 'plugin'), pluginPath, { recursive: true });
  await writeJson(settingsPath, { appPath, ffmpegPath, maxFps });
  await writeFile(join(kitFolder, 'node-path.txt'), process.execPath + '\n', dataMode);
  await setSidecarEnabled(config, true);
  console.log('Launcher dan plugin TPS siap.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
