import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bridgeFolder } from './paths.mjs';

const requestPath = join(bridgeFolder, 'composer-request.json');
const replyPath = join(bridgeFolder, 'composer-reply.json');
const source = randomUUID();

export async function refreshTps(views) {
  const visible = (await Promise.all(views.map(async view => {
    const result = await view.evaluate('window.__agyWallpaper?.conversationTitle()').catch(() => null);
    const title = result?.result?.value;
    if (!title || title.length > 240) {
      view.conversation = null;
      return null;
    }
    if (view.conversation?.title !== title) view.conversation = { title, id: randomUUID() };
    return view;
  }))).filter(Boolean).slice(0, 4);
  if (!visible.length) return;

  let results = {};
  try {
    const reply = JSON.parse(await readFile(replyPath, 'utf8'));
    if (reply.source === source && Math.abs(Date.now() - reply.time) < 5000) results = reply.results;
  } catch {}

  await Promise.allSettled(visible.map(view => {
    const { title, id } = view.conversation;
    const value = results?.[id] || null;
    return view.evaluate(`window.__agyWallpaper?.showTps(${JSON.stringify(title)},${JSON.stringify(value)})`);
  }));
  const temporary = join(bridgeFolder, `composer-request.${source}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({
      source, time: Date.now(), conversations: visible.map(view => view.conversation),
    }), { mode: 0o600 });
    await rename(temporary, requestPath);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function closeTps() {
  try {
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    if (request.source === source) await rm(requestPath, { force: true });
  } catch {}
}
