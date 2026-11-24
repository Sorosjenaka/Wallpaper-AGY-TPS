import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function startComposerBridge(dataDir, getMetrics) {
  if (!dataDir) return;
  const requestFile = join(dataDir, 'composer-request.json');
  const replyFile = join(dataDir, 'composer-reply.json');
  const pending = join(dataDir, `composer-reply.${process.pid}.tmp`);
  let previous;

  async function update() {
    const request = JSON.parse(await readFile(requestFile, 'utf8').catch(() => 'null'));
    if (!request || !uuid.test(request.source) || !Number.isFinite(request.time) ||
        Math.abs(Date.now() - request.time) > 5000 || !Array.isArray(request.conversations)) {
      if (previous) {
        await rm(replyFile, { force: true });
        await rm(requestFile, { force: true });
      }
      previous = null;
      return;
    }
    if (previous === request.time) return;
    const chats = request.conversations.slice(0, 4).filter(item => item &&
      uuid.test(item.id) && typeof item.title === 'string' && item.title.length <= 240);
    const results = Object.fromEntries(await Promise.all(chats.map(async ({ id, title }) => [
      id, await getMetrics(title).catch(() => null),
    ])));
    await writeFile(pending, JSON.stringify({ source: request.source, time: Date.now(), results }), { mode: 0o600 });
    await rename(pending, replyFile);
    previous = request.time;
  }

  async function poll() {
    try { await update(); }
    catch { await rm(pending, { force: true }).catch(() => {}); }
    setTimeout(poll, 750).unref();
  }

  void poll();
}
