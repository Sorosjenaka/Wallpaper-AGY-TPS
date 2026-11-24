/**
 * TPS Monitor — sidecar backend for Antigravity Desktop.
 *
 * Reads Antigravity's conversation records without editing them.
 *
 *   <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * and turns the per-step records into live throughput metrics:
 *   - PLANNER_RESPONSE: created_at, model, input_tokens, cache_read_tokens,
 *     output_tokens, tool_calls
 *   - GENERIC (tool results): created_at + "Created At:" / "Completed At:"
 *     headers embedded in content
 *
 * Because the transcript is flushed per step, a turn's generation window is
 * [planner.created_at .. first tool start] and, for the newest turn of a live
 * session, [planner.created_at .. file mtime]. Transcript-derived rates are estimates.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { readLiveSteps, summarizeLiveSteps } from './trajectory-live.mjs';
import { desktopConversation } from './conversation.mjs';
import { startComposerBridge } from './composer-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const MAX_TAIL_BYTES = 3 * 1024 * 1024;
const MAX_TURN_SECONDS = 900;

// ---------------------------------------------------------------------------
// App data dirs (same contract as the native swarm_board sidecar).
// ---------------------------------------------------------------------------

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .map((name) => join(root, name))
    .filter((c) => existsSync(join(c, 'brain')));
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStat(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transcript parsing.
// ---------------------------------------------------------------------------

function parseTimeMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const PAIR_RE = /Created At:\s*([^\r\n]+)(?:\r?\n)+Completed At:\s*([^\r\n]+)/g;
const CREATED_RE = /Created At:\s*([^\r\n]+)/g;
const COMPLETED_RE = /Completed At:\s*([^\r\n]+)/g;

// One tool step can carry several Created/Completed pairs (parallel calls).
function toolWindow(step) {
  const content = typeof step.content === 'string' ? step.content : '';
  let start = null;
  let end = null;
  let matched = false;
  PAIR_RE.lastIndex = 0;
  for (let m = PAIR_RE.exec(content); m !== null; m = PAIR_RE.exec(content)) {
    matched = true;
    const a = parseTimeMs(m[1].trim());
    const b = parseTimeMs(m[2].trim());
    if (a !== null && (start === null || a < start)) start = a;
    if (b !== null && (end === null || b > end)) end = b;
  }
  if (!matched) {
    CREATED_RE.lastIndex = 0;
    for (let m = CREATED_RE.exec(content); m !== null; m = CREATED_RE.exec(content)) {
      const a = parseTimeMs(m[1].trim());
      if (a !== null && (start === null || a < start)) start = a;
    }
    COMPLETED_RE.lastIndex = 0;
    for (let m = COMPLETED_RE.exec(content); m !== null; m = COMPLETED_RE.exec(content)) {
      const b = parseTimeMs(m[1].trim());
      if (b !== null && (end === null || b > end)) end = b;
    }
  }
  return { start, end };
}

function readTailText(file, maxBytes) {
  const st = safeStat(file);
  if (!st) return null;
  if (st.size <= maxBytes) {
    try {
      return { text: readFileSync(file, 'utf8'), partial: false, stat: st };
    } catch {
      return null;
    }
  }
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    const text = buf.toString('utf8');
    const firstBreak = text.indexOf('\n');
    return {
      text: firstBreak === -1 ? text : text.slice(firstBreak + 1),
      partial: true,
      stat: st,
    };
  } finally {
    closeSync(fd);
  }
}

function parseSteps(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && typeof o.type === 'string') out.push(o);
    } catch {
      // A half-flushed last line: ignore it, the next poll sees it complete.
    }
  }
  return out;
}

function round1(v) {
  return Math.round((Number.isFinite(v) ? v : 0) * 10) / 10;
}

function round2(v) {
  return Math.round((Number.isFinite(v) ? v : 0) * 100) / 100;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

// Turns = one PLANNER_RESPONSE plus the tool steps that follow it.
function buildTurns(steps, fileMtimeMs, nowMs) {
  const turns = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type !== 'PLANNER_RESPONSE') continue;
    const t0 = parseTimeMs(s.created_at);
    if (t0 === null) continue;

    let firstGenericMs = null;
    let lastGenericMs = null;
    let toolStart = null;
    let toolEnd = null;
    let mediaCount = 0;
    let boundaryMs = null;
    let runningTool = false;
    for (let k = i + 1; k < steps.length; k++) {
      const n = steps[k];
      const tn = parseTimeMs(n.created_at);
      if (n.type === 'GENERIC' || n.type === 'EPHEMERAL_MESSAGE') {
        if (tn !== null) {
          if (firstGenericMs === null || tn < firstGenericMs) firstGenericMs = tn;
          if (lastGenericMs === null || tn > lastGenericMs) lastGenericMs = tn;
        }
        if (n.status === 'RUNNING') runningTool = true;
        if (Array.isArray(n.media)) mediaCount += n.media.length;
        const w = toolWindow(n);
        if (w.start !== null && (toolStart === null || w.start < toolStart)) toolStart = w.start;
        if (w.end !== null && (toolEnd === null || w.end > toolEnd)) toolEnd = w.end;
        continue;
      }
      boundaryMs = tn;
      break;
    }

    const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
    const outTok = Math.max(0, Number(s.output_tokens) || 0);
    const inTok = Math.max(0, Number(s.input_tokens) || 0);
    const cacheTok = Math.max(0, Number(s.cache_read_tokens) || 0);
    const ctx = inTok + cacheTok;

    // End of the model's generation window.
    // A final text-only PLANNER_RESPONSE (calls === 0) has no trailing tool
    // step; its next step is a later USER_INPUT or idle SYSTEM_MESSAGE written
    // minutes later. Measuring across that idle gap would collapse TPS to ~1.
    const isFinalTextTurn = calls.length === 0 && toolStart === null && firstGenericMs === null;
    const isLastPlanner = i === lastPlannerIndex(steps, i);
    const tailFlushMs = isLastPlanner && fileMtimeMs > t0 && fileMtimeMs - t0 <= 60_000 ? fileMtimeMs : null;
    const genEnd = isFinalTextTurn
      ? tailFlushMs
      : toolStart ?? firstGenericMs ?? boundaryMs ?? tailFlushMs;
    const isOpenTail = boundaryMs === null;
    const unmeasuredTextTurn = genEnd === null;
    const endMs = genEnd ?? t0;
    const genSec = Math.max(0, (endMs - t0) / 1000);
    const turnEndMs = unmeasuredTextTurn ? t0 : boundaryMs ?? (toolEnd ?? lastGenericMs ?? endMs);
    const turnSec = Math.max(genSec, (turnEndMs - t0) / 1000);
    const toolSec = Math.max(0, turnSec - genSec);

    // Timestamp granularity in transcript.jsonl is 1 second; floor sub-2s
    // big bursts to at least 1.5s so rounding jitter never fabricates >1000 tok/s.
    const effGenSec = genSec > 0 && genSec <= 1 && outTok > 250 ? 1.5 : genSec;
    const decodeTps = !unmeasuredTextTurn && effGenSec >= 1 ? outTok / effGenSec : 0;
    const turnTps = !unmeasuredTextTurn && turnSec >= 1 ? outTok / turnSec : 0;

    turns.push({
      step: Number.isInteger(s.step_index) ? s.step_index : i,
      at: t0,
      model: typeof s.model === 'string' ? s.model : null,
      out: outTok,
      input: inTok,
      cache: cacheTok,
      ctx,
      cacheHit: ctx > 0 ? cacheTok / ctx : null,
      calls: calls.length,
      tools: calls.map((c) => (typeof c?.name === 'string' ? c.name : '?')).slice(0, 12),
      media: mediaCount,
      genSec: round1(genSec),
      toolSec: round1(toolSec),
      turnSec: round1(turnSec),
      decodeTps: outTok > 0 && decodeTps > 0 ? round1(decodeTps) : 0,
      turnTps: outTok > 0 && turnTps > 0 ? round1(turnTps) : 0,
      unmeasured: unmeasuredTextTurn,
      open: isOpenTail,
      runningTool,
      outlier: genSec > MAX_TURN_SECONDS,
      thinking: typeof s.thinking === 'string' ? s.thinking.length : 0,
    });
  }
  return turns;
}

let lastIndexMemo = null;
function lastPlannerIndex(steps, i) {
  if (!lastIndexMemo || lastIndexMemo.for !== steps) {
    let idx = -1;
    for (let k = steps.length - 1; k >= 0; k--) {
      if (steps[k].type === 'PLANNER_RESPONSE') {
        idx = k;
        break;
      }
    }
    lastIndexMemo = { for: steps, idx };
  }
  return lastIndexMemo.idx === i;
}

function summarize(turns, steps, opts = {}) {
  const measured = turns.filter((t) => t.decodeTps > 0 && !t.outlier && t.genSec >= 0.5);
  const tpsSorted = measured.map((t) => t.decodeTps).sort((a, b) => a - b);
  const totalOut = measured.reduce((a, t) => a + t.out, 0);
  const totalGen = measured.reduce((a, t) => a + t.genSec, 0);
  const totalTool = turns.reduce((a, t) => a + t.toolSec, 0);
  const ctxTurns = turns.filter((t) => t.ctx > 0);
  const ctxAvg = ctxTurns.length ? ctxTurns.reduce((a, t) => a + t.ctx, 0) / ctxTurns.length : 0;
  const cacheTurns = ctxTurns.filter((t) => t.ctx >= 10000);
  const cacheHitAvg = cacheTurns.length
    ? cacheTurns.reduce((a, t) => a + t.cache / t.ctx, 0) / cacheTurns.length
    : null;
  const gaps = [];
  for (let i = 1; i < turns.length; i++) gaps.push((turns[i].at - turns[i - 1].at) / 1000);
  const gapOver60 = gaps.filter((g) => g > 60).length;
  const models = new Map();
  for (const t of turns) {
    if (!t.model) continue;
    models.set(t.model, (models.get(t.model) || 0) + 1);
  }
  const last = turns[turns.length - 1] || null;
  const recent = measured.slice(-10);
  return {
    scope: opts.scope || 'session',
    turns: turns.length,
    llmTurns: measured.length,
    toolCalls: turns.reduce((a, t) => a + t.calls, 0),
    mediaLoads: turns.reduce((a, t) => a + t.media, 0),
    outputTokens: totalOut,
    genSec: round1(totalGen),
    toolSec: round1(totalTool),
    avgTps: totalGen > 0 ? round1(totalOut / totalGen) : 0,
    last10Tps: recent.length ? round1(recent.reduce((a, t) => a + t.out, 0) / Math.max(recent.reduce((a, t) => a + t.genSec, 0), 0.5)) : 0,
    peakTps: tpsSorted.length ? round1(tpsSorted[tpsSorted.length - 1]) : 0,
    p50Tps: round1(percentile(tpsSorted, 0.5)),
    p90Tps: round1(percentile(tpsSorted, 0.9)),
    slowTps: round1(percentile(tpsSorted, 0.1)),
    ctxLatest: last ? last.ctx : 0,
    ctxAvg: Math.round(ctxAvg),
    ctxOver150k: turns.filter((t) => t.ctx >= 150000).length,
    ctxOver300k: turns.filter((t) => t.ctx >= 300000).length,
    cacheHitAvg: cacheHitAvg === null ? null : round2(cacheHitAvg),
    gapCount: gaps.length,
    gapOver60,
    gapOver60Pct: gaps.length ? round1((gapOver60 / gaps.length) * 100) : 0,
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([model, count]) => ({ model, count })),
    steps: steps.length,
  };
}

function diagnose(summary, turns) {
  const out = [];
  const push = (level, title, detail) => out.push({ level, title, detail });
  if (!turns.length) {
    push('info', 'Belum ada turn tercatat', 'Mulai percakapan di pane ini, panel akan langsung mengisi diri.');
    return out;
  }
  const effort = (turns[turns.length - 1]?.model || '').split('-').pop();
  if (['xhigh', 'high'].includes(effort)) {
    push(
      'warn',
      `Effort tinggi aktif (${effort})`,
      'Thinking panjang = token keluar lebih lambat. Untuk pekerjaan rutin pakai effort low/medium: TPS bisa 2-4x lipat.'
    );
  } else if (['low', 'medium'].includes(effort)) {
    push('good', `Effort ${effort} aktif`, 'Setting tercepat yang tersedia untuk model ini.');
  }
  if (summary.ctxLatest >= 300000) {
    push('bad', `Konteks ${Math.round(summary.ctxLatest / 1000)}k token`, 'Prefill raksasa tiap turn. Mulai chat baru sekarang — ini pembunuh TPS nomor satu.');
  } else if (summary.ctxLatest >= 150000) {
    push('warn', `Konteks ${Math.round(summary.ctxLatest / 1000)}k token`, `Di atas 150k, tiap turn mengirim ulang semua riwayat. ${summary.ctxOver150k}/${summary.turns} turn ada di zona lambat.`);
  } else {
    push('good', `Konteks ${Math.round(summary.ctxLatest / 1000)}k token`, 'Masih ramping, prefill per turn murah.');
  }
  if (summary.mediaLoads > 0 && summary.ctxOver180kMedia === undefined) {
    // placeholder avoided; media handled below with explicit turn scan
  }
  const mediaHigh = turns.filter((t) => t.media > 0 && t.ctx >= 180000).length;
  if (mediaHigh > 0) {
    push('bad', `${mediaHigh} turn multimodal di konteks besar`, 'Gambar/frame/video yang menumpuk di sesi utama diproses ulang tiap turn. Pindahkan inspeksi visual ke subagent/sesi terpisah.');
  } else if (summary.mediaLoads > 0) {
    push('info', `${summary.mediaLoads} media termuat di sesi ini`, 'Jaga agar tetap sedikit; media di konteks besar memperlambat semua turn.');
  }
  if (summary.cacheHitAvg !== null) {
    if (summary.cacheHitAvg < 0.7) {
      push('bad', `Prompt cache ${Math.round(summary.cacheHitAvg * 100)}%`, 'Sebagian besar token dibayar penuh (prefill ulang). Jangan ganti model di tengah sesi dan kurangi jeda antar-turn.');
    } else if (summary.cacheHitAvg < 0.9) {
      push('warn', `Prompt cache ${Math.round(summary.cacheHitAvg * 100)}%`, `Jeda antar-turn > 60s ada di ${summary.gapOver60Pct}% turn; cache kedaluwarsa saat menunggu. `);
    } else {
      push('good', `Prompt cache ${Math.round(summary.cacheHitAvg * 100)}%`, 'Cache bekerja baik — token input hampir gratis.');
    }
  }
  if (summary.gapOver60Pct > 40) {
    push('warn', `${summary.gapOver60Pct}% jeda turn > 60s`, 'Antrean panjang antar-turn membuat prompt cache basi. Kumpulkan permintaan dalam satu kali kirim.');
  }
  const fastTurns = turns.filter((t) => t.tools.some((n) => /batch_search|apply_edits|read_slices|quick_outline|run_checks/.test(n))).length;
  if (fastTurns === 0) {
    push('info', 'Tool agy-fast belum terlihat di sesi ini', 'Plugin agy-fast baru aktif di sesi baru; buka chat baru agar batch_search/apply_edits dipakai.');
  } else {
    push('good', `${fastTurns} turn memakai agy-fast`, 'Batching tool menekan jumlah round-trip model.');
  }
  if (summary.p50Tps && summary.p50Tps >= 80) {
    push('good', `Median ${summary.p50Tps} tok/s`, 'Kecepatan decode sehat.');
  } else if (summary.p50Tps) {
    push('warn', `Median ${summary.p50Tps} tok/s`, 'Dorong ke atas dengan konteks kecil + effort rendah + model flash/neon.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversation discovery + per-file cache.
// ---------------------------------------------------------------------------

const cache = new Map(); // file -> { key, data }

function loadTranscript(file, maxBytes = MAX_TAIL_BYTES) {
  const st = safeStat(file);
  if (!st) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.data;
  const tail = readTailText(file, maxBytes);
  if (!tail) return null;
  const steps = parseSteps(tail.text);
  const now = Date.now();
  const turns = buildTurns(steps, st.mtimeMs, now);
  const summary = summarize(turns, steps);
  const data = {
    file,
    partial: tail.partial,
    mtimeMs: st.mtimeMs,
    sizeBytes: st.size,
    ageSec: round1((now - st.mtimeMs) / 1000),
    active: now - st.mtimeMs < 8000,
    steps,
    turns,
    summary,
    diagnostics: diagnose(summary, turns),
    title: null,
  };
  cache.set(file, { key, data, readAt: now });
  if (cache.size > 40) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].readAt - b[1].readAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return data;
}

function transcriptFor(conv) {
  if (!conv || !ID_RE.test(conv)) return null;
  for (const appData of findAppDataDirs()) {
    const f = join(appData, 'brain', conv, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(f)) return { appData, file: f };
  }
  return null;
}

function newestConversation() {
  let bestWithPlanner = null;
  let bestAny = null;
  for (const appData of findAppDataDirs()) {
    for (const id of safeReaddir(join(appData, 'brain'))) {
      const f = join(appData, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
      const st = safeStat(f);
      if (!st) continue;
      if (!bestAny || st.mtimeMs > bestAny.mtimeMs) {
        bestAny = { appData, id, file: f, mtimeMs: st.mtimeMs };
      }
      // Skip tiny pre-warmed conversations that only have SYSTEM_MESSAGE.
      if (st.size < 16384) {
        const tail = readTailText(f, 16384);
        if (!tail || !tail.text.includes('"PLANNER_RESPONSE"')) continue;
      }
      if (!bestWithPlanner || st.mtimeMs > bestWithPlanner.mtimeMs) {
        bestWithPlanner = { appData, id, file: f, mtimeMs: st.mtimeMs };
      }
    }
  }
  return bestWithPlanner || bestAny;
}

const PRINTABLE_RE = /[\u0020-\u007e\u00a0-\u024b\u4e00-\u9fff]{6,}/g;

function sessionTitle(appData, conv, data) {
  const pb = join(appData, 'chapter_titles', `${conv}.pb`);
  if (existsSync(pb)) {
    try {
      const raw = readFileSync(pb, 'utf8');
      const found = raw.match(PRINTABLE_RE) || [];
      const candidate = found
        .map((s) => s.trim())
        .filter((s) => /[a-zA-Z]{3}/.test(s) && !/^[A-Za-z0-9+/=]{20,}$/.test(s))
        .sort((a, b) => b.length - a.length)[0];
      if (candidate) return candidate.slice(0, 90);
    } catch {
      // fall through
    }
  }
  const firstUser = data?.steps?.find((s) => s.type === 'USER_INPUT' && typeof s.content === 'string');
  if (firstUser) {
    const cleaned = firstUser.content
      .replace(/<\/?USER_REQUEST>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned.slice(0, 90);
  }
  return conv.slice(0, 8);
}

function listSessions(limit) {
  const rows = [];
  for (const appData of findAppDataDirs()) {
    for (const id of safeReaddir(join(appData, 'brain'))) {
      const file = join(appData, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
      const st = safeStat(file);
      if (!st) continue;
      rows.push({ appData, id, file, mtimeMs: st.mtimeMs });
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const row of rows) {
    if (out.length >= Math.max(1, Math.min(limit || 8, 20))) break;
    const data = loadTranscript(row.file, 1024 * 1024);
    if (!data || data.summary.turns === 0) continue;
    out.push({
      id: row.id,
      product: basename(row.appData),
      title: sessionTitle(row.appData, row.id, data),
      mtimeMs: row.mtimeMs,
      ageSec: Math.round((Date.now() - row.mtimeMs) / 1000),
      active: data.active,
      turns: data.summary.turns,
      llmTurns: data.summary.llmTurns,
      toolCalls: data.summary.toolCalls,
      avgTps: data.summary.avgTps,
      last10Tps: data.summary.last10Tps,
      peakTps: data.summary.peakTps,
      ctxLatest: data.summary.ctxLatest,
      cacheHitAvg: data.summary.cacheHitAvg,
      model: data.summary.models[0]?.model || null,
      truncated: data.partial,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Static assets use GET. Data routes use authenticated POST.
// ---------------------------------------------------------------------------

const app = new SidecarApp();

const STATIC = {
  '/styles.css': ['styles.css', 'text/css'],
  '/app.js': ['app.js', 'application/javascript'],
};

app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), { contentType: 'text/html' }));
for (const [route, [file, type]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }), 'GET');
}

// The single live-metrics route for the conversation this pane belongs to.
app.api(
  '/api/tps',
  (data) => {
  const requested = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
  let target = requested ? transcriptFor(requested) : null;
  let fallbackUsed = false;
  if (target) {
    const parsedReq = loadTranscript(target.file);
    if (!data.strict && (!parsedReq || parsedReq.summary.turns === 0)) {
      const newest = newestConversation();
      if (newest && newest.file !== target.file) {
        target = { appData: newest.appData, file: newest.file };
        fallbackUsed = true;
      }
    }
  }
  if (!target) {
    target = transcriptFor(app.config.conversationId || '');
  }
  if (!target) {
    const newest = newestConversation();
    if (newest) {
      target = { appData: newest.appData, file: newest.file };
      fallbackUsed = true;
    }
  }
    if (!target) {
      return {
        ok: false,
        reason: 'no-transcript',
        hint: 'Buka (atau mulai) satu percakapan Antigravity, panel akan langsung membaca log-nya.',
        conversationId: requested || app.config.conversationId || null,
      };
    }
    if (data.invalidate) cache.delete(target.file);
    const conv = basename(dirname(dirname(dirname(target.file))));
    const parsed = loadTranscript(target.file);
    if (!parsed) return { ok: false, reason: 'unreadable', conversationId: conv };
    const limit = Math.max(5, Math.min(Number(data.turns) || 60, 400));
    const turns = parsed.turns.slice(-limit).map((t) => ({ ...t }));
    const last = parsed.turns[parsed.turns.length - 1] || null;
    const now = Date.now();
    const liveElapsed = last ? Math.max(0, Math.round((now - last.at) / 1000)) : null;
    return {
      ok: true,
      conversationId: conv,
      resolvedFrom: fallbackUsed ? 'newest-session' : requested ? 'pane' : 'env',
      title: sessionTitle(target.appData, conv, parsed),
      partial: parsed.partial,
      active: parsed.active,
      ageSec: parsed.ageSec,
      liveElapsedSec: liveElapsed,
      current: last
        ? {
            step: last.step,
            model: last.model,
            out: last.out,
            ctx: last.ctx,
            calls: last.calls,
            runningTool: last.runningTool,
            open: last.open,
            decodeTps: last.decodeTps,
            genSec: last.genSec,
          }
        : null,
      turns,
      summary: parsed.summary,
      diagnostics: parsed.diagnostics,
    };
  },
  'POST'
);

// Recent local conversations, for the history table / picking another session.
app.api('/api/sessions', (data) => ({ ok: true, sessions: listSessions(Number(data.limit) || 8) }), 'POST');

async function liveTurn(id, recent) {
  const last = recent?.steps.at(-1)?.step_index;
  const offset = Number.isInteger(last) ? Math.max(0, last - 6) : 0;
  const { steps, reason } = await readLiveSteps(id, offset);
  if (!steps) return { ok: false, reason };
  return { ok: true, turn: summarizeLiveSteps(steps, offset) };
}

app.api('/api/live', async (data) => {
  const id = data.conversationId;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    return { ok: false, reason: 'invalid-conversation' };
  }
  const target = transcriptFor(id);
  const recent = target ? loadTranscript(target.file) : null;
  return liveTurn(id, recent);
}, 'POST');

async function composerMetrics(title) {
  const unavailable = { tps: null, context: null, estimated: false, writing: false };
  const id = desktopConversation(title, findAppDataDirs()[0]);
  if (!id) return unavailable;

  const target = transcriptFor(id);
  const recent = target ? loadTranscript(target.file) : null;
  const { turn } = await liveTurn(id, recent);
  const context = turn?.context || recent?.summary.ctxLatest || null;
  if (turn?.tps != null) return { tps: turn.tps, context, estimated: false, writing: turn.generating };
  if (turn?.generating) {
    const estimate = turn.fromVisible && turn.characters >= 12 && turn.seconds >= 0.5
      ? Math.round(turn.characters / 4 / turn.seconds * 10) / 10 : null;
    return { tps: estimate, context, estimated: estimate != null, writing: true };
  }
  const previous = recent?.turns.findLast(item => item.decodeTps > 0 && !item.outlier);
  return { tps: previous?.decodeTps ?? null, context, estimated: Boolean(previous), writing: false };
}

// Health: what the sidecar can see (used by the UI's status line).
app.api('/api/health', () => {
  return {
    ok: true,
    node: process.version,
    cacheEntries: cache.size,
  };
}, 'POST');

app.run().then(() => {
  startComposerBridge(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, composerMetrics);
});
