import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const prismName = 'obsidian-prism';
export const prismSidecar = 'obsidian-prism/daemon';
const upstream = 'https://github.com/RMvdesi/obsidian-prism.git';
const tag = 'v1.0.8-beta.2';
const revision = '7cc059d5b549410cee3e9d70bc8577b3f21b1a06';
const patchedPaths = ['vendor/effort-slider/upstream-client.js', 'sidecars/daemon/main.mjs'];
const require = createRequire(import.meta.url);

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.error) throw new Error(`Git: ${result.error.message}`);
  return result;
}

function normalize(text) {
  return text.replaceAll('\r\n', '\n');
}

async function replaceText(file, contents) {
  const pending = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(pending, contents, { flag: 'wx', mode: 0o600 });
    await rename(pending, file);
  } finally {
    await rm(pending, { force: true });
  }
}

export async function installPrism(repo, configDir, kitFolder) {
  const source = join(kitFolder, prismName);
  const target = join(configDir, 'plugins', prismName);
  const manifest = join(target, 'plugin.json');
  const patch = join(repo, 'prism', 'reasoning-effort.patch');
  if (!existsSync(source)) {
    const clone = git(kitFolder, 'clone', '--depth', '1', '--branch', tag, upstream, source);
    if (clone.status !== 0) throw new Error(`Kloning Obsidian Prism gagal. ${clone.stderr?.trim() || ''}`);
  }
  if (git(source, 'rev-parse', 'HEAD').stdout.trim() !== revision) {
    throw new Error(`Source Prism harus memakai revisi ${revision}.`);
  }
  if (git(source, 'apply', '--reverse', '--check', patch).status !== 0) {
    const applied = git(source, 'apply', patch);
    if (applied.status !== 0) throw new Error(`Patch Prism gagal diterapkan. ${applied.stderr?.trim() || ''}`);
  }
  const targetDir = await lstat(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (targetDir) {
    if (!targetDir.isDirectory() || !existsSync(manifest)) {
      throw new Error('Direktori plugin Prism yang sudah ada tidak dikenali.');
    }
    const installed = JSON.parse(await readFile(manifest, 'utf8'));
    if (installed.name !== prismName || `v${installed.version}` !== tag) {
      throw new Error(`Patch mendukung Obsidian Prism ${tag}. Versi yang sudah terpasang perlu dipertahankan atau disesuaikan dahulu.`);
    }
    const changes = [];
    for (const path of patchedPaths) {
      const file = join(target, path);
      if (!(await lstat(file)).isFile()) throw new Error(`File Prism tidak dikenali: ${path}.`);
      const current = normalize(await readFile(file, 'utf8'));
      const patched = await readFile(join(source, path), 'utf8');
      if (current === normalize(patched)) continue;
      const original = git(source, 'show', `${revision}:${path}`);
      const withoutNotice = normalize(patched).replace(/^\/\/ Modified by 0XSoros on .* for the Wallpaper-AGY-TPS integration\.\n/, '');
      if (original.status !== 0 || (current !== normalize(original.stdout) && current !== withoutNotice)) {
        throw new Error(`File Prism sudah memiliki modifikasi lain: ${path}.`);
      }
      changes.push({ file, patched });
    }
    for (const { file, patched } of changes) await replaceText(file, patched);
  } else {
    const defaults = JSON.parse(await readFile(join(source, 'config.example.json'), 'utf8'));
    Object.assign(defaults, {
      language: 'en', lang: 'en', palette: 'obsidian', motionLevel: 'ultra', targetFps: '120',
      mascot: 'dual', composerRestyle: true, telemetryModule: 'on', effortSliderModule: 'on',
      thoughtTranslate: 'off', omniModule: 'off', autoUpdate: 'off', autoArchiveOnExit: false,
      sidebarRestyle: false, sidebar: 'off', hostLocalization: 'off',
    });
    await replaceText(join(source, 'config.json'), JSON.stringify(defaults, null, 2) + '\n');
    const { installPlugin } = require(join(source, 'tools', 'install-plugin.cjs'));
    await installPlugin({
      sourceDir: source, targetDir: target, hostConfigDir: configDir,
      startDaemon: false, syncShortcuts: false, deferRelaunchPrompt: true,
      createLauncher: false, cleanLegacySibling: false,
    });
  }
  const sidecar = join(target, 'sidecars', 'daemon', 'sidecar.json');
  const config = JSON.parse(await readFile(sidecar, 'utf8'));
  // The Kit owns the launch sequence. Prism only attaches to the current app.
  config.env = { ...config.env, PRISM_DISABLE_SHORTCUT_SYNC: '1', PRISM_NO_RELAUNCH_PROMPT: '1' };
  await replaceText(sidecar, JSON.stringify(config, null, 2) + '\n');
  await writeFile(join(target, '.kit-hide-storage-popup'), '', { mode: 0o600 });
}
