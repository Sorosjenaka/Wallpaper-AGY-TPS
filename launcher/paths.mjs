import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const home = homedir();
export const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
export const kitFolder = process.platform === 'darwin'
  ? join(home, 'Library', 'Application Support', 'Wallpaper-AGY-TPS')
  : join(local, 'Wallpaper-AGY-TPS');
export const pluginName = 'wallpaper-agy-tps';
export const sidecarName = 'tps_monitor';
export const bridgeFolder = join(home, '.gemini', 'antigravity', 'sidecar_data', pluginName, sidecarName, 'data');
export const settingsPath = join(kitFolder, 'settings.json');

export function readSettings() {
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')) || {}; }
  catch { return {}; }
}

export function findAntigravity(preferred = readSettings().appPath) {
  const mac = root => join(root, 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity');
  const candidates = process.platform === 'darwin'
    ? [mac('/Applications'), mac(join(home, 'Applications'))]
    : [join(local, 'Programs', 'antigravity', 'Antigravity.exe'),
       join(process.env.ProgramFiles || 'C:/Program Files', 'Antigravity', 'Antigravity.exe')];
  return [process.env.AGY_DESKTOP_PATH, preferred, ...candidates]
    .find(path => typeof path === 'string' && path && existsSync(path));
}
