import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { extname, isAbsolute, join, parse } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { kitFolder, readSettings } from './paths.mjs';

const folder = join(kitFolder, 'themes');
export const uploadLimit = 300_000_000;
const stateFile = join(folder, 'themes.json');
const settings = readSettings();
const requestedFps = String(process.env.AGY_WALLPAPER_MAX_FPS || settings.maxFps || 60);
const fpsLimit = ['30', '60', '120'].includes(requestedFps) ? requestedFps : '60';
const mediaTypes = {
  '.gif': ['gif', data => ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())],
  '.mp4': ['mov', data => data.subarray(4, 8).toString() === 'ftyp'],
  '.webm': ['matroska', data => data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))],
};
const idPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
let state;
let changes = Promise.resolve();

export async function loadThemes() {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    const themes = saved.themes.filter(theme => idPattern.test(theme.id) && typeof theme.name === 'string');
    state = { themes, active: themes.some(theme => theme.id === saved.active) ? saved.active : null };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { themes: [], active: null };
    await saveThemes(state);
  }
  return state;
}

async function saveThemes(next) {
  const temporary = join(folder, 'themes.pending.json');
  await writeFile(temporary, JSON.stringify(next));
  await rename(temporary, stateFile);
  state = next;
}

export function currentThemes() {
  return state;
}

export function mediaPath(id) {
  if (!idPattern.test(id) || !state?.themes.some(theme => theme.id === id)) return null;
  return join(folder, `${id}.webm`);
}

export function changeTheme(command) {
  const run = changes.then(() => update(command));
  changes = run.catch(() => {});
  return run;
}

async function update({ action, id, file }) {
  switch (action) {
    case 'select':
      if (id !== null && !mediaPath(id)) throw new Error('Tema tidak ditemukan.');
      await saveThemes({ ...state, active: id });
      break;
    case 'remove': {
      const path = mediaPath(id);
      if (!path) throw new Error('Tema tidak ditemukan.');
      await saveThemes({
        themes: state.themes.filter(theme => theme.id !== id),
        active: state.active === id ? null : state.active,
      });
      await rm(path, { force: true });
      break;
    }
    case 'import':
      await importTheme(file);
      break;
    default:
      throw new Error('Aksi tema tidak dikenal.');
  }
  return state;
}

async function importTheme(file) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Pilih file wallpaper lagi.');
  const mediaType = mediaTypes[extname(file).toLowerCase()];
  if (!mediaType) throw new Error('Pilih GIF, MP4, atau WebM.');
  const [format, validHeader] = mediaType;

  const id = randomUUID();
  const original = join(folder, `${id}.input`);
  const output = join(folder, `${id}.webm`);
  let saved = false;
  try {
    await stageUpload(file, original, validHeader);
    await transcode(original, output, format);
    const label = parse(file).name.trim().slice(0, 64) || 'Tema baru';
    await saveThemes({ themes: [...state.themes, { id, name: label }], active: id });
    saved = true;
  } finally {
    await rm(original, { force: true }).catch(() => {});
    if (!saved) await rm(output, { force: true }).catch(() => {});
  }
}

async function stageUpload(file, destination, validHeader) {
  const source = await open(file, 'r').catch(() => null);
  if (!source) throw new Error('File wallpaper tidak bisa dibuka.');
  try {
    const info = await source.stat();
    const { size } = info;
    if (size > uploadLimit) throw new Error(`Ukuran file melebihi ${uploadLimit / 1_000_000} MB.`);
    if (!info.isFile() || size === 0) throw new Error('File wallpaper kosong atau tidak bisa dibaca.');
    const header = Buffer.alloc(8);
    const { bytesRead } = await source.read(header, 0, header.length, 0);
    if (!validHeader(header.subarray(0, bytesRead))) {
      throw new Error('File harus berupa GIF, MP4, atau WebM yang valid.');
    }
    // Bound the copy even if the original grows during import.
    await pipeline(
      source.createReadStream({ start: 0, end: size - 1, autoClose: false }),
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
  } finally {
    await source.close();
  }
}

function transcode(input, output, format) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error', '-nostdin', '-filter_threads', '2', '-protocol_whitelist', 'file,pipe',
      '-f', format, '-threads', '2', '-max_pixels', '64000000', '-i', input,
      '-t', '120', '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
      '-vf', 'scale=w=min(3840\\,iw):h=min(2160\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1',
      '-fpsmax', fpsLimit,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '33',
      '-deadline', 'realtime', '-cpu-used', '6', '-threads', '2', output,
    ];
    const ffmpeg = process.env.AGY_FFMPEG_PATH || settings.ffmpegPath || 'ffmpeg';
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => child.kill(), 5 * 60_000);
    const failed = () => reject(new Error('Antigravity tidak bisa menyiapkan animasi dari file ini.'));
    child.once('error', () => { clearTimeout(timeout); failed(); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(); else failed();
    });
  });
}
