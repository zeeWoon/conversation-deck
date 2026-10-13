/**
 * Conversation Deck: Cloudflare server (optional, version 2.6).
 *
 * Runs the same game as the Apps Script backend (Code.gs), but each lobby lives in its own Durable Object, so
 * lobbies never wait for each other, and phones get changes pushed over a WebSocket instead of asking every
 * few seconds. The Google Sheet stays the place where prompts and settings are edited: the server reads them
 * from the Apps Script web app (action "export") and sends join and card log rows back (action "logrows").
 *
 * Settings on Cloudflare (Worker > Settings > Variables and Secrets), both as type "Secret":
 *   SHEET_API  the Apps Script web app link that ends in /exec
 *   SHEET_KEY  the same long password as WORKER_KEY in Code.gs
 */
import { DurableObject } from 'cloudflare:workers';

const VERSION = '2.6';

const CFG = {
  LOBBY_TTL: 6 * 3600 * 1000, /* a lobby with nobody connected is removed this long after its last change */
  SETTINGS_MS: 15000,         /* the Settings tab is read again after this long, so the open/closed switch acts within about this */
  AWAY_MS: 45000,             /* a player with no sign of life for this long is shown as away */
  SEEN_MS: 700000,            /* a player with no sign of life for this long is removed (their locked card stays locked) */
  PRUNE_EVERY: 60000,
  HARD_MAX_PLAYERS: 350,
  ROSTER_MAX: 40,
  CHANGES: 2,
  MAX_NAME: 20,
  LOG_BATCH: 25,              /* log rows are sent to the sheet in groups, at least every LOG_GAP */
  LOG_GAP: 15000,
  LOG_KEEP: 2000,             /* rows kept while the sheet cannot be reached */
  TICK_MS: 30000,             /* while phones are connected, the lobby checks for away players and the closed switch this often */
  IDLE_MS: 10 * 60000,        /* a lobby where nobody has tapped anything for this long stops checking the sheet */
  IDLE_TICK_MS: 5 * 60000,    /* ...and checks on its connections only this often */
  QUIET_MS: 5 * 60000,        /* a connection with no ping for this long (a phone put away with the page open) is closed */
  SHEET_TIMEOUT: 25000,
  MAX_BODY: 8000
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOBBY_ACTS = new Set(['join', 'state', 'draw', 'lock', 'next', 'leave']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

/* ---------- small helpers (the same rules as Code.gs) ---------- */

const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, CFG.MAX_NAME);
const cleanToken = s => { s = String(s || ''); return /^[A-Za-z0-9_-]{8,40}$/.test(s) ? s : ''; };
const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
function normLang(s) {
  s = String(s || '').trim().toLowerCase().replace(/_/g, '-');
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(s) ? s : '';
}
function chooseLang(meta, want, defLang) {
  want = normLang(want);
  if (want && meta.counts[want]) return want;
  if (meta.counts[defLang]) return defLang;
  return Object.keys(meta.counts)[0];
}
function pickUiLang(want, idx) {
  want = normLang(want);
  const codes = idx.langs.map(l => l.code);
  if (want && codes.includes(want)) return want;
  const pre = want.split('-')[0];
  if (pre && codes.includes(pre)) return pre;
  return idx.defLang;
}
function randomCode(letter) {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  let c = letter;
  for (let i = 0; i < 3; i++) c += CODE_CHARS.charAt(b[i] % CODE_CHARS.length);
  return c;
}
const pollMs = n => Math.min(30000, Math.max(3000, 3000 + (n - 10) * 100));
const errText = e => String(e && e.message || e);

function reply(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS) });
}

/** Calls the Apps Script web app with the shared key. */
async function sheet(env, body) {
  const url = String(env.SHEET_API || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error('SHEET_API is not set. Add it under Settings > Variables and Secrets.');
  if (!env.SHEET_KEY) throw new Error('SHEET_KEY is not set. Add it under Settings > Variables and Secrets.');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: String(env.SHEET_KEY) }, body)),
    redirect: 'follow',
    signal: AbortSignal.timeout(CFG.SHEET_TIMEOUT)
  });
  const text = await res.text();
  let r;
  try { r = JSON.parse(text); } catch (e) {
    throw new Error('SHEET_API did not answer with data (HTTP ' + res.status + '). Use the web app link that ends in /exec, deployed with access "Anyone".');
  }
  if (r && r.ok === false && r.err === 'denied') throw new Error('The sheet refused the key. SHEET_KEY here must match WORKER_KEY in Code.gs (at least 16 characters), and the web app must be redeployed as a new version.');
  if (r && r.ok === false && r.err === 'bad') throw new Error('The Apps Script code is older than 2.6. Paste the new Code.gs and deploy a new version.');
  return r;
}

const hubOf = env => env.HUB.get(env.HUB.idFromName('hub'));
const lobbyOf = (env, code) => env.LOBBY.get(env.LOBBY.idFromName(code));

/* ---------- the front door ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/ws') {
      const code = cleanCode(url.searchParams.get('code'));
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426, headers: CORS });
      if (code.length !== 4 || !cleanToken(url.searchParams.get('token'))) return new Response('Bad lobby or token', { status: 400, headers: CORS });
      return lobbyOf(env, code).fetch(request);
    }

    if (request.method === 'POST' && (url.pathname === '/api' || url.pathname === '/')) {
      const text = await request.text();
      if (text.length > CFG.MAX_BODY) return reply({ ok: false, err: 'bad' });
      let req;
      try { req = JSON.parse(text); } catch (e) { return reply({ ok: false, err: 'bad' }); }
      if (!req || typeof req !== 'object' || Array.isArray(req)) return reply({ ok: false, err: 'bad' });
      try { return reply(await route(env, req)); }
      catch (e) { return reply({ ok: false, err: 'server', msg: errText(e) }); }
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/check')) {
      let s;
      try { s = await hubOf(env).status(); } catch (e) { s = { ok: false, err: errText(e) }; }
      if (url.searchParams.has('json')) return reply(s);
      return new Response(statusText(s), { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, CORS) });
    }
    return new Response('Not found', { status: 404, headers: CORS });
  }
};

async function route(env, req) {
  if (req.a === 'decks') return hubOf(env).decks(String(req.lang || ''));
  if (req.a === 'create') return create(env, req);
  if (LOBBY_ACTS.has(req.a)) {
    const code = cleanCode(req.code);
    if (code.length !== 4 || !cleanToken(req.token)) return { ok: false, err: 'bad' };
    return lobbyOf(env, code).act(plain(req));
  }
  return { ok: false, err: 'bad' };
}

/** Only the fields a lobby uses, so nothing odd is passed along. */
function plain(req) {
  return {
    a: String(req.a || ''), code: String(req.code || ''), token: String(req.token || ''), name: String(req.name || ''),
    lang: String(req.lang || ''), deck: String(req.deck || ''),
    cats: Array.isArray(req.cats) ? req.cats.slice(0, 50).map(c => String(c).slice(0, 40)) : []
  };
}

async function create(env, req) {
  const token = cleanToken(req.token), name = cleanName(req.name);
  if (!token || !name) return { ok: false, err: 'bad' };
  const pre = await hubOf(env).prepCreate(String(req.deck || ''), String(req.lang || ''), String(req.pass || ''));
  if (!pre.ok) return pre;
  for (let i = 0; i < 40; i++) {
    const code = randomCode(pre.letter);
    const r = await lobbyOf(env, code).act(Object.assign(plain(req), { a: 'create', code, deck: pre.deck }));
    if (r.err !== 'exists') return r;
  }
  return { ok: false, err: 'busy' };
}

function statusText(s) {
  const lines = ['Conversation Deck server ' + VERSION, ''];
  if (!s.ok) {
    lines.push('Not ready: ' + (s.err || 'unknown problem'));
  } else {
    lines.push('Google Sheet: connected (Apps Script ' + (s.sheetVer || '?') + ')');
    lines.push('App: ' + (s.open ? 'open' : 'CLOSED (players see the closed message)'));
    lines.push('Decks: ' + s.decks + ', prompts: ' + s.prompts + ', languages: ' + s.langs.join(', '));
    lines.push('Prompts last read from the sheet: ' + s.contentAge);
    if (s.err) lines.push('', 'Last problem reaching the sheet: ' + s.err);
  }
  lines.push('', 'Put this address in the page as SU_WORKER to use this server.');
  return lines.join('\n') + '\n';
}

/* ---------- Hub: one copy of the prompts and settings for all lobbies ---------- */

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cfg = null; this.cfgAt = 0; this.h = ''; this.sheetVer = '';
    this.idx = null; this.idxAt = 0; this.chunks = new Map();
    this.cfgP = null; this.contentP = null; this.contentFail = 0; this.chunkP = new Map(); this.err = '';
    ctx.blockConcurrencyWhile(async () => {
      try {
        const got = await ctx.storage.get(['cfg', 'idx']);
        const c = got.get('cfg');
        if (c) { this.cfg = c.v; this.h = c.h; this.sheetVer = c.ver || ''; }
        const i = got.get('idx');
        if (i) { this.idx = i.v; this.idxAt = i.at || 0; }
      } catch (e) { /* start empty; the sheet is read on first use */ }
    });
  }

  /** Settings no older than SETTINGS_MS, and prompts matching the sheet's fingerprint. Stale copies are served while one refresh runs. */
  async ready(wait) {
    if (!this.idx) {                       /* first use: the index carries the settings too */
      if (!this.contentP) this.contentP = this.pullContent().finally(() => { this.contentP = null; });
      await this.contentP;
      return;
    }
    if (!this.cfg || Date.now() - this.cfgAt >= CFG.SETTINGS_MS) {
      if (!this.cfgP) this.cfgP = this.pullSettings().finally(() => { this.cfgP = null; });
      if (!this.cfg || wait) await this.cfgP.catch(e => { if (!this.cfg) throw e; }); else this.cfgP.catch(() => {});
    }
    if (!this.idx || (this.idx.h !== this.h && Date.now() - this.contentFail > 30000)) {
      if (!this.contentP) this.contentP = this.pullContent().finally(() => { this.contentP = null; });
      if (!this.idx) await this.contentP; else this.contentP.catch(() => {});
    }
  }

  async pullSettings() {
    try {
      const r = await sheet(this.env, { a: 'export', part: 'settings' });
      if (!r || !r.ok || !r.settings) throw new Error('The sheet answered: ' + (r && (r.msg || r.err) || 'nothing'));
      const before = JSON.stringify([this.cfg, this.h, this.sheetVer]);
      this.cfg = r.settings; this.h = String(r.h || ''); this.sheetVer = String(r.ver || ''); this.cfgAt = Date.now(); this.err = '';
      if (JSON.stringify([this.cfg, this.h, this.sheetVer]) !== before) await this.ctx.storage.put('cfg', { v: this.cfg, h: this.h, ver: this.sheetVer });
      if (this.idx && this.idx.h !== this.h && !this.contentP) {      /* the prompts changed: start fetching them now */
        this.contentP = this.pullContent().finally(() => { this.contentP = null; });
        this.contentP.catch(() => {});
      }
    } catch (e) {
      this.err = errText(e);
      this.cfgAt = Date.now() - CFG.SETTINGS_MS + 5000;   /* try again in about 5 seconds */
      if (!this.cfg) throw e;
    }
  }

  /** Reads the deck list, languages and page text (small). Each deck's prompts are read when first needed (chunk). */
  async pullContent() {
    try {
      const r = await sheet(this.env, { a: 'export', part: 'index' });
      if (!r || !r.ok || !r.idx || !r.settings) throw new Error('The sheet answered: ' + (r && (r.msg || r.err) || 'nothing'));
      this.idx = r.idx; this.idxAt = Date.now();
      this.cfg = r.settings; this.h = String(r.h || r.idx.h); this.sheetVer = String(r.ver || ''); this.cfgAt = Date.now(); this.err = '';
      await this.ctx.storage.put({ idx: { v: this.idx, at: this.idxAt }, cfg: { v: this.cfg, h: this.h, ver: this.sheetVer } });
      this.ctx.waitUntil(this.warmAll());
    } catch (e) {
      this.err = errText(e);
      this.contentFail = Date.now();
      if (!this.idx) throw e;
    }
  }

  async pullChunk(id, lang) {
    const r = await sheet(this.env, { a: 'export', part: 'deck', deck: id, lang });
    if (!r || !r.ok || !r.chunk) throw new Error('The sheet answered: ' + (r && (r.msg || r.err) || 'nothing'));
    const e = { h: String(r.h || ''), d: r.chunk };
    this.chunks.set(id + ':' + lang, e);
    await this.ctx.storage.put('c:' + id + ':' + lang, e);
    if (e.h && e.h !== this.h) this.h = e.h;      /* the sheet changed again meanwhile: the index is read again next time */
    return e.d;
  }

  /** What a lobby needs to know: settings and, per deck, the languages it has. Small, so lobbies can ask often. */
  async info(wait) {
    await this.ready(!!wait);
    return {
      cfg: this.cfg, h: this.idx.h, defLang: this.idx.defLang,
      decks: this.idx.decks.map(m => ({ id: m.id, letter: m.letter, counts: m.counts }))
    };
  }

  /** Reads every deck in every language in the background, two at a time, so nobody waits for the sheet later. */
  async warmAll() {
    if (this.warming) return;
    this.warming = true;
    try {
      const jobs = [];
      this.idx.decks.forEach(m => Object.keys(m.counts).forEach(l => jobs.push([m.id, l])));
      const next = async () => { for (let j = jobs.shift(); j; j = jobs.shift()) { try { await this.chunk(j[0], j[1]); } catch (e) {} } };
      await Promise.all([next(), next()]);
    } finally { this.warming = false; }
  }

  /** One deck in one language, matching the current prompts. An older copy is used if the sheet cannot be reached. */
  async chunk(id, lang) {
    await this.ready();
    const meta = this.idx.decks.find(m => m.id === id);
    if (!meta || !meta.counts[lang]) return null;
    const k = id + ':' + lang, h = this.idx.h;
    let e = this.chunks.get(k);
    if (e && e.h === h) return e.d;
    if (!e) {
      e = await this.ctx.storage.get('c:' + k);
      if (e) { this.chunks.set(k, e); if (e.h === h) return e.d; }
    }
    let p = this.chunkP.get(k);
    if (!p) { p = this.pullChunk(id, lang).finally(() => { this.chunkP.delete(k); }); this.chunkP.set(k, p); }
    try { return await p; } catch (err) { this.err = errText(err); if (e) return e.d; throw err; }
  }

  /** The home screen: deck list and page text in the language asked for (same answer as Code.gs actDecks_). */
  async decks(want) {
    await this.ready();
    const cfg = this.cfg, idx = this.idx;
    const lang = pickUiLang(want, idx);
    const strings = Object.assign({}, idx.strings[idx.defLang] || {}, idx.strings[lang] || {});
    const out = { ok: true, ver: VERSION, open: cfg.open, msg: cfg.closedMsg, needPass: !!cfg.pass, lang, defLang: idx.defLang, langs: idx.langs, strings, decks: [] };
    if (!cfg.open) return out;
    out.decks = idx.decks.map(m => {
      const cl = chooseLang(m, lang, idx.defLang);
      return { id: m.id, letter: m.letter, color: m.color, on: m.on, name: m.names[lang] || m.base, blurb: m.blurbs[lang] || m.baseBlurb, count: m.counts[cl], cardLang: cl, fallback: cl !== lang };
    });
    return out;
  }

  async prepCreate(deck, lang, pass) {
    await this.ready();
    const cfg = this.cfg;
    if (!cfg.open) return { ok: false, err: 'closed', msg: cfg.closedMsg };
    if (cfg.pass && String(pass || '').trim().toLowerCase() !== String(cfg.pass).toLowerCase()) return { ok: false, err: 'pass' };
    const meta = this.idx.decks.find(m => m.id === deck);
    if (!meta) return { ok: false, err: 'nodeck' };
    return { ok: true, letter: meta.letter, deck: meta.id };
  }

  async status() {
    try { await this.ready(); } catch (e) { return { ok: false, err: errText(e) }; }
    let prompts = 0;
    this.idx.decks.forEach(m => Object.keys(m.counts).forEach(l => { prompts += m.counts[l]; }));
    const mins = Math.round((Date.now() - this.idxAt) / 60000);
    return {
      ok: true, ver: VERSION, sheetVer: this.sheetVer, open: !!this.cfg.open, decks: this.idx.decks.length, prompts,
      langs: this.idx.langs.map(l => l.code), contentAge: mins < 1 ? 'just now' : mins + ' min ago', err: this.err
    };
  }
}

/* ---------- Lobby: one Durable Object per lobby code ---------- */

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.L = null;              /* the lobby, same shape as in Code.gs */
    this.info = null; this.infoAt = 0; this.infoP = null;
    this.decks = new Map();     /* "deck:lang" -> {h, d} */
    this.cardMaps = new WeakMap();
    this.seen = new Map();      /* player -> last time they did something over plain HTTP or a socket message */
    this.logq = [];
    this.rev = 0; this.sent = new WeakMap(); this.bt = 0; this.awaySig = ''; this.awayC = null; this.closedSent = false;
    this.alarmAt = undefined; this.flushing = false;
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {}
    ctx.blockConcurrencyWhile(async () => {
      try {
        const got = await ctx.storage.get(['L', 'logq', 'info']);
        this.L = got.get('L') || null;
        this.logq = got.get('logq') || [];
        const inf = got.get('info');
        if (inf) this.info = inf;            /* served while a fresh copy is fetched */
        if (this.L && this.L.seen) Object.keys(this.L.seen).forEach(k => this.seen.set(k, this.L.seen[k]));
      } catch (e) {}
    });
  }

  hub() { return hubOf(this.env); }

  /** True when nobody in this lobby has joined, drawn, locked in or moved on for a while. */
  idle() { return !!this.L && Date.now() - (this.L.tap || this.L.created || 0) > CFG.IDLE_MS; }

  /** Settings and deck list. Normally a stale copy is used while a fresh one is fetched; wait=true (the alarm) waits for the fresh one. */
  async getInfo(wait) {
    if (this.info && Date.now() - this.infoAt < CFG.SETTINGS_MS) return this.info;
    if (this.info && this.idle()) return this.info;      /* nobody is tapping: don't keep asking the sheet */
    if (!this.infoP) {
      this.infoP = this.hub().info(!!wait).then(i => {
        const changed = JSON.stringify(i) !== JSON.stringify(this.info);
        this.info = i; this.infoAt = Date.now();
        if (changed) this.ctx.storage.put('info', i);
        return i;
      }).finally(() => { this.infoP = null; });
    }
    if (this.info && !wait) { this.infoP.catch(() => {}); return this.info; }
    try { return await this.infoP; } catch (e) { if (this.info) return this.info; throw e; }
  }

  cardAt(d, key) {
    let m = this.cardMaps.get(d);
    if (!m) { m = new Map(); d.cards.forEach(c => m.set(c.key, c)); this.cardMaps.set(d, m); }
    return m.get(key) || null;
  }

  async chunk(id, lang, h) {
    const k = id + ':' + lang;
    let e = this.decks.get(k);
    if (e && e.h === h) return e.d;
    if (!e) {
      const s = await this.ctx.storage.get('d:' + k);
      if (s) { e = s; this.decks.set(k, e); if (e.h === h) return e.d; }
    }
    try {
      const d = await this.hub().chunk(id, lang);
      if (!d) return e ? e.d : null;
      e = { h, d };
      this.decks.set(k, e);
      this.ctx.storage.put('d:' + k, e);
      return d;
    } catch (err) {
      if (e) return e.d;
      throw err;
    }
  }

  /** The deck in the language this player reads. Each player chooses their own; the lobby itself has no language. */
  async deckFor(deckId, want, p) {
    const info = await this.getInfo();
    const meta = info.decks.find(m => m.id === deckId);
    if (!meta) return null;
    return this.chunk(meta.id, chooseLang(meta, want || (p && p.lang), info.defLang), info.h);
  }

  /* ----- storage, alarm, log ----- */

  save() {
    const L = this.L;
    L.v = (L.v || 0) + 1;
    L.last = Date.now();
    const seen = {};
    L.order.forEach(id => { if (this.seen.has(id)) seen[id] = this.seen.get(id); });
    L.seen = seen;
    this.ctx.storage.put('L', L);
    this.changed();
    this.arm().catch(() => {});
  }

  async arm(force) {
    if (!this.L) return;
    const now = Date.now();
    let t = (this.L.last || now) + CFG.LOBBY_TTL;
    if (this.ctx.getWebSockets().length) t = Math.min(t, now + (this.idle() ? CFG.IDLE_TICK_MS : CFG.TICK_MS));
    if (this.logq.length) t = Math.min(t, this.logq[0].at + CFG.LOG_GAP);
    t = Math.max(t, now + 1000);
    if (this.alarmAt === undefined) this.alarmAt = await this.ctx.storage.getAlarm();
    if (force || this.alarmAt === null || this.alarmAt > t + 1000 || this.alarmAt < now - 60000) {
      this.alarmAt = t;
      await this.ctx.storage.setAlarm(t);
    }
  }

  log(tab, row) {
    this.logq.push({ at: Date.now(), tab, row: [new Date().toISOString()].concat(row) });
    if (this.logq.length > CFG.LOG_KEEP) this.logq = this.logq.slice(-CFG.LOG_KEEP);
    this.ctx.storage.put('logq', this.logq);
    if (this.logq.length >= CFG.LOG_BATCH) this.ctx.waitUntil(this.flushLog());
    else this.arm().catch(() => {});
  }

  async flushLog() {
    if (!this.logq.length || this.flushing) return;
    this.flushing = true;
    const batch = this.logq.slice(0, 500), rows = {};
    batch.forEach(e => { (rows[e.tab] = rows[e.tab] || []).push(e.row); });
    try {
      const r = await sheet(this.env, { a: 'logrows', rows });
      if (r && r.ok) {
        this.logq = this.logq.slice(batch.length);
        await this.ctx.storage.put('logq', this.logq);
      }
    } catch (e) {
      /* the rows stay queued and are sent with the next group */
    } finally { this.flushing = false; }
  }

  async alarm() {
    this.alarmAt = null;
    if (!this.L) { await this.ctx.storage.deleteAll(); return; }
    const now = Date.now();
    if (this.logq.length && (now - this.logq[0].at >= CFG.LOG_GAP || this.logq.length >= CFG.LOG_BATCH)) await this.flushLog();
    this.closeQuiet(now);
    const socks = this.ctx.getWebSockets();
    if (socks.length) {
      const live = this.liveMap();
      live.forEach((t, id) => { if (now - t < CFG.AWAY_MS) this.seen.set(id, Math.max(this.seen.get(id) || 0, t)); });
      let info = this.info;
      if (!this.idle()) { try { info = await this.getInfo(true); } catch (e) {} }
      if (info && !info.cfg.open) this.pushClosed(info.cfg.closedMsg);
      else {
        this.closedSent = false;
        if (this.prune(null)) this.save();
        else if (JSON.stringify(this.awaySet(true)) !== this.awaySig) this.changed();
      }
    } else if (now - (this.L.last || 0) > CFG.LOBBY_TTL) {
      if (this.logq.length) await this.flushLog();
      await this.ctx.storage.deleteAll();
      this.L = null; this.logq = [];
      return;
    }
    await this.arm(true);
  }

  /** Close connections that have sent no ping for a long time, so a phone left with the page open doesn't keep the lobby busy.
   *  When that phone is used again, the page reconnects by itself. */
  closeQuiet(now) {
    for (const ws of this.ctx.getWebSockets()) {
      let t = 0;
      try { const att = ws.deserializeAttachment(); t = att && att.at || 0; } catch (e) {}
      try { const ar = this.ctx.getWebSocketAutoResponseTimestamp(ws); if (ar) t = Math.max(t, ar.getTime()); } catch (e) {}
      if (now - t > CFG.QUIET_MS) { try { ws.close(1001, 'quiet'); } catch (e) {} }
    }
  }

  /* ----- who is here ----- */

  /** Last sign of life per player from their open connections (the page pings every 20 seconds). */
  liveMap() {
    const m = new Map();
    for (const ws of this.ctx.getWebSockets()) {
      let att = null;
      try { att = ws.deserializeAttachment(); } catch (e) {}
      if (!att || !att.pid) continue;
      let t = att.at || 0;
      try { const ar = this.ctx.getWebSocketAutoResponseTimestamp(ws); if (ar) t = Math.max(t, ar.getTime()); } catch (e) {}
      m.set(att.pid, Math.max(m.get(att.pid) || 0, t));
    }
    return m;
  }

  lastSign(id, live) { return Math.max(live.get(id) || 0, this.seen.get(id) || 0); }

  awaySet(fresh) {
    const now = Date.now();
    if (!fresh && this.awayC && now - this.awayC.t < 2000) return this.awayC.a;
    const live = this.liveMap(), a = {};
    this.L.order.forEach(id => { if (now - this.lastSign(id, live) > CFG.AWAY_MS) a[id] = 1; });
    this.awayC = { t: now, a };
    return a;
  }

  /** Remove players who have been gone a long time. Their locked cards stay locked. Returns true if anyone was removed. */
  prune(keepPid) {
    const L = this.L, now = Date.now();
    if (now - (L.pr || L.created || 0) < CFG.PRUNE_EVERY) return false;
    L.pr = now;
    const live = this.liveMap();
    let gone = false;
    L.order.slice().forEach(id => {
      if (id === keepPid) return;
      if (now - this.lastSign(id, live) > CFG.SEEN_MS) {
        delete L.players[id];
        L.order = L.order.filter(x => x !== id);
        this.seen.delete(id);
        gone = true;
      }
    });
    return gone;
  }

  /* ----- views: what a player is allowed to see (same as Code.gs view_) ----- */

  heldByOthers(pid) {
    const t = {};
    Object.keys(this.L.players).forEach(id => {
      if (id === pid) return;
      const p = this.L.players[id];
      if (p.phase === 'drawn' && p.held) t[p.held] = 1;
    });
    return t;
  }

  /** The parts of a view that are the same for every player reading deck d. Worked out once per update. */
  viewParts(d) {
    const L = this.L;
    const ids = L.order.filter(id => L.players[id]);
    const n = ids.length;
    let lockN = 0, drawN = 0;
    const drawnHeld = {};
    ids.forEach(id => {
      const p = L.players[id];
      if (p.phase === 'locked') lockN++;
      else if (p.phase === 'drawn') { drawN++; if (p.held) drawnHeld[p.held] = 1; }
    });
    const leftBy = {};
    let left = 0;
    d.cards.forEach(c => {
      if (L.locked[c.key]) return;
      left++;
      if (!drawnHeld[c.key]) leftBy[c.cat] = (leftBy[c.cat] || 0) + 1;
    });
    const away = this.awaySet(false), rosterJson = {};
    const entry = (id, me) => {
      const p = L.players[id];
      return JSON.stringify({ n: p.n, st: p.phase === 'locked' ? 'lock' : (p.phase === 'drawn' ? 'draw' : 'pick'), me, away: !me && !!away[id] });
    };
    const show = n > CFG.ROSTER_MAX ? ids.slice(0, CFG.ROSTER_MAX) : ids;
    show.forEach(id => { rosterJson[id] = entry(id, false); });
    return { d, ids, n, lockN, drawN, left, leftBy, show, rosterJson, entry,
      head: { ok: true, v: L.v, code: L.code, lang: d.lang, poll: pollMs(n), push: true,
        deck: { id: d.id, name: d.name, color: d.color, on: d.on, letter: d.letter } } };
  }

  /** One player's view as JSON text (same content as Code.gs view_): others' cards are never included. */
  viewJson(P, pid) {
    const L = this.L, d = P.d, me = L.players[pid];
    if (!me) return JSON.stringify({ ok: false, err: 'notjoined' });
    /* categories: my own drawn card still counts as left for me */
    let mine = null;
    if (me.phase === 'drawn' && me.held && !L.locked[me.held]) { const c = this.cardAt(d, me.held); if (c) mine = c.cat; }
    const cats = d.cats.map(c => ({ name: c.name, total: c.count, left: (P.leftBy[c.name] || 0) + (c.name === mine ? 1 : 0) }));
    let show = P.show;
    if (P.n > CFG.ROSTER_MAX && !show.includes(pid)) { show = show.slice(); show[show.length - 1] = pid; }
    const roster = '[' + show.map(id => id === pid ? P.entry(id, true) : (P.rosterJson[id] || P.entry(id, false))).join(',') + ']';
    let card = null;
    if (me.held && me.phase !== 'idle') {
      const c = this.cardAt(d, me.held);
      if (c) card = { cat: c.cat, q: c.q, n: c.n };
    }
    const body = Object.assign({}, P.head, {
      left: P.left, cats, roster: 0, counts: { n: P.n, lock: P.lockN, draw: P.drawN },
      me: { phase: card ? me.phase : 'idle', changes: me.changes, card }
    });
    return JSON.stringify(body).replace('"roster":0', '"roster":' + roster);
  }

  view(pid, d) {
    if (!d) return { ok: false, err: 'nodeck' };
    if (!this.L.players[pid]) return { ok: false, err: 'notjoined' };
    return JSON.parse(this.viewJson(this.viewParts(d), pid));
  }

  /* ----- pushing changes to connected phones ----- */

  changed() {
    this.rev++;
    if (this.bt) return;
    const n = this.L ? this.L.order.length : 0;
    const ms = n <= 20 ? 100 : Math.min(300, n * 3);   /* a crowd gets at most about three updates a second */
    this.bt = setTimeout(() => { this.bt = 0; this.broadcast().catch(() => {}); }, ms);
  }

  async broadcast() {
    if (!this.L) return;
    const socks = this.ctx.getWebSockets();
    if (!socks.length) return;
    let info;
    try { info = await this.getInfo(); } catch (e) { return; }
    if (!info.cfg.open) { this.pushClosed(info.cfg.closedMsg); return; }
    const targets = [];
    for (const ws of socks) {
      let att = null;
      try { att = ws.deserializeAttachment(); } catch (e) {}
      if (att && att.pid && this.L.players[att.pid]) targets.push({ ws, att });
    }
    /* load each language once, then build every view without waiting in between */
    const langs = new Map();
    for (const t of targets) {
      const want = t.att.lang || this.L.players[t.att.pid].lang || '';
      if (!langs.has(want)) {
        try { langs.set(want, await this.deckFor(this.L.deck, want, null)); } catch (e) { langs.set(want, null); }
      }
    }
    if (!this.L) return;
    const rev = this.rev;
    this.awaySig = JSON.stringify(this.awaySet(true));
    const parts = new Map();
    for (const t of targets) {
      if (this.sent.get(t.ws) === rev || !this.L.players[t.att.pid]) continue;
      const d = langs.get(t.att.lang || this.L.players[t.att.pid].lang || '');
      if (!d) continue;
      let P = parts.get(d);
      if (!P) { P = this.viewParts(d); parts.set(d, P); }
      try { t.ws.send('{"push":' + this.viewJson(P, t.att.pid) + '}'); this.sent.set(t.ws, rev); } catch (e) {}
    }
  }

  pushClosed(msg) {
    if (this.closedSent) return;
    this.closedSent = true;
    const out = JSON.stringify({ push: { ok: false, err: 'closed', msg: msg || '' } });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(out); } catch (e) {} }
  }

  /* ----- WebSocket connections ----- */

  async fetch(request) {
    const url = new URL(request.url);
    const token = cleanToken(url.searchParams.get('token'));
    if (!token || (request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Bad request', { status: 400 });
    if (this.ctx.getWebSockets().length >= CFG.HARD_MAX_PLAYERS * 2) return new Response('Too many connections', { status: 503 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server, [token]);
    server.serializeAttachment({ pid: token, lang: normLang(url.searchParams.get('lang')), at: Date.now() });
    this.ctx.waitUntil(this.hello(server, token));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The first message on a new connection: the player's view, or why there is none. */
  async hello(ws, pid) {
    let msg;
    try {
      if (!this.L) msg = { ok: false, err: 'nolobby' };
      else {
        const info = await this.getInfo();
        if (!info.cfg.open) msg = { ok: false, err: 'closed', msg: info.cfg.closedMsg };
        else if (!this.L || !this.L.players[pid]) msg = { ok: false, err: this.L ? 'notjoined' : 'nolobby' };
        else {
          const att = ws.deserializeAttachment() || {};
          const d = await this.deckFor(this.L.deck, att.lang, this.L.players[pid]);
          msg = this.view(pid, d);
          this.changed();       /* others see this player back from away */
          this.sent.set(ws, this.rev);
          await this.arm();
        }
      }
    } catch (e) { msg = { ok: false, err: 'server', msg: errText(e) }; }
    try { ws.send(JSON.stringify({ push: msg })); } catch (e) {}
    if (!msg.ok && msg.err === 'nolobby') { try { ws.close(4004, 'nolobby'); } catch (e) {} }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > CFG.MAX_BODY) return;
    if (message === 'ping') { try { ws.send('pong'); } catch (e) {} return; }
    let m;
    try { m = JSON.parse(message); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const id = m.id;
    const att = ws.deserializeAttachment() || {};
    let r;
    if (!LOBBY_ACTS.has(m.a) || !att.pid) r = { ok: false, err: 'bad' };
    else if (!this.L) r = { ok: false, err: 'nolobby' };
    else {
      const lang = normLang(m.lang);
      att.at = Date.now();
      if (lang && lang !== att.lang && this.L) this.L.tap = Date.now();   /* switching language is a tap too */
      if (lang) att.lang = lang;
      try { ws.serializeAttachment(att); } catch (e) {}
      r = await this.act(Object.assign(plain(m), { token: att.pid, code: this.L.code }));
      if (r && r.ok && r.v !== undefined) this.sent.set(ws, this.rev);
    }
    try { ws.send(JSON.stringify({ id, r })); } catch (e) {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      const att = ws.deserializeAttachment();
      if (att && att.pid) this.seen.set(att.pid, Date.now());
    } catch (e) {}
    try { ws.close(1000, 'bye'); } catch (e) {}
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (e) {}
  }

  /* ----- the game (same rules as Code.gs) ----- */

  async act(req) {
    try {
      const a = req.a, token = cleanToken(req.token), code = cleanCode(req.code);
      if (!token || code.length !== 4) return { ok: false, err: 'bad' };
      if (a === 'create') return await this.actCreate(req, token, code);
      if (!this.L || this.L.code !== code) return { ok: false, err: 'nolobby' };
      if (a === 'leave') return this.actLeave(token);
      if (a !== 'state') this.L.tap = Date.now();         /* join, draw, lock and next wake an idle lobby */
      const info = await this.getInfo();
      if (!info.cfg.open) return { ok: false, err: 'closed', msg: info.cfg.closedMsg };
      if (!this.L) return { ok: false, err: 'nolobby' };
      switch (a) {
        case 'join': return await this.actJoin(req, token, info.cfg);
        case 'state': return await this.actState(req, token);
        case 'draw': return await this.actDraw(req, token, info.cfg);
        case 'lock': return await this.actLock(req, token, info.cfg);
        case 'next': return await this.actNext(req, token);
        default: return { ok: false, err: 'bad' };
      }
    } catch (e) {
      return { ok: false, err: 'server', msg: errText(e) };
    }
  }

  newPlayer(name) { return { n: name, phase: 'idle', held: null, changes: CFG.CHANGES, seen: {} }; }

  uniqueName(pid, name) {
    const taken = {};
    Object.keys(this.L.players).forEach(id => { if (id !== pid) taken[this.L.players[id].n.toLowerCase()] = 1; });
    if (!taken[name.toLowerCase()]) return name;
    for (let i = 2; i < 1000; i++) {
      const cand = name.slice(0, CFG.MAX_NAME - String(i).length - 1) + ' ' + i;
      if (!taken[cand.toLowerCase()]) return cand;
    }
    return name;
  }

  heal(d, p) {
    if (p.phase === 'idle' || !p.held) return;
    if (this.cardAt(d, p.held)) return;
    p.phase = 'idle'; p.held = null; p.seen = {}; p.changes = CFG.CHANGES;
  }

  unlockedCount(d) {
    let n = 0;
    d.cards.forEach(c => { if (!this.L.locked[c.key]) n++; });
    return n;
  }

  /** Cards locked by people who have moved on go back into the deck. Cards still showing as locked stay out. */
  recycle() {
    const keep = {};
    Object.keys(this.L.players).forEach(id => {
      const p = this.L.players[id];
      if (p.phase === 'locked' && p.held) keep[p.held] = id;
    });
    this.L.locked = keep;
    this.L.round = (this.L.round || 0) + 1;
  }

  async actCreate(req, token, code) {
    const name = cleanName(req.name);
    if (!name) return { ok: false, err: 'bad' };
    if (this.L) return { ok: false, err: 'exists' };
    const info = await this.getInfo();
    if (!info.cfg.open) return { ok: false, err: 'closed', msg: info.cfg.closedMsg };
    const meta = info.decks.find(m => m.id === req.deck);
    if (!meta || meta.letter !== code.charAt(0)) return { ok: false, err: 'nodeck' };
    const d = await this.deckFor(meta.id, req.lang, null);
    if (!d) return { ok: false, err: 'nodeck' };
    if (this.L) return { ok: false, err: 'exists' };
    const now = Date.now();
    this.L = { code, deck: meta.id, created: now, pr: now, tap: now, locked: {}, players: {}, order: [], v: 0 };
    this.L.players[token] = this.newPlayer(name);
    this.L.players[token].lang = d.lang;
    this.L.order.push(token);
    this.seen.set(token, now);
    this.save();
    if (info.cfg.logJoins) this.log('Joins', ['hosted', code, d.name, d.lang, name, 1]);
    /* get the other languages ready, so a player who switches language doesn't wait */
    this.ctx.waitUntil(Promise.all(Object.keys(meta.counts).filter(l => l !== d.lang).map(l => this.chunk(meta.id, l, info.h).catch(() => null))));
    return this.view(token, d);
  }

  async actJoin(req, token, cfg) {
    const name = cleanName(req.name);
    if (!name) return { ok: false, err: 'bad' };
    const d = await this.deckFor(this.L.deck, req.lang, this.L.players[token]);
    if (!d) return { ok: false, err: 'nodeck' };
    const L = this.L;
    if (!L) return { ok: false, err: 'nolobby' };
    const cap = cfg.maxPlayers ? Math.min(cfg.maxPlayers, CFG.HARD_MAX_PLAYERS) : CFG.HARD_MAX_PLAYERS;
    this.seen.set(token, Date.now());
    this.prune(token);
    const isNew = !L.players[token];
    if (isNew) {
      if (L.order.length >= cap) return { ok: false, err: 'full' };
      L.players[token] = this.newPlayer(this.uniqueName(token, name));
      L.order.push(token);
    } else {
      L.players[token].n = this.uniqueName(token, name);
    }
    L.players[token].lang = d.lang;
    this.save();
    if (isNew && cfg.logJoins) this.log('Joins', ['joined', L.code, d.name, d.lang, L.players[token].n, L.order.length]);
    return this.view(token, d);
  }

  async actState(req, token) {
    if (!this.L.players[token]) return { ok: false, err: 'notjoined' };
    this.seen.set(token, Date.now());
    const d = await this.deckFor(this.L.deck, req.lang, this.L.players[token]);
    if (!this.L) return { ok: false, err: 'nolobby' };
    const p = this.L.players[token];
    if (!p) return { ok: false, err: 'notjoined' };
    if (d) p.lang = d.lang;
    return this.view(token, d);
  }

  async actDraw(req, token, cfg) {
    const cats = Array.isArray(req.cats) ? req.cats.map(String) : [];
    if (!this.L.players[token]) return { ok: false, err: 'notjoined' };
    const d = await this.deckFor(this.L.deck, req.lang, this.L.players[token]);
    if (!d) return { ok: false, err: 'nodeck' };
    const L = this.L;
    if (!L) return { ok: false, err: 'nolobby' };
    const p = L.players[token];
    if (!p) return { ok: false, err: 'notjoined' };
    this.seen.set(token, Date.now());
    p.lang = d.lang;
    this.heal(d, p);
    const fail = err => { const v = this.view(token, d); v.ok = false; v.err = err; return v; };
    if (p.phase === 'locked') return fail('locked');
    const changing = p.phase === 'drawn';
    if (changing && p.changes <= 0) return fail('nochanges');
    if (cfg.empty === 'reshuffle' && this.unlockedCount(d) === 0) this.recycle();
    const oth = this.heldByOthers(token);
    const scope = d.cards.filter(c => (!cats.length || cats.includes(c.cat)) && !L.locked[c.key] && !oth[c.key] && c.key !== p.held);
    if (!scope.length) { if (L.round) this.save(); return fail(changing ? 'noother' : 'none'); }
    let fresh = scope.filter(c => !p.seen[c.key]);
    if (!fresh.length) { p.seen = {}; fresh = scope; }
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    const card = fresh[b[0] % fresh.length];
    p.seen[card.key] = 1;
    if (changing) p.changes--;
    p.phase = 'drawn';
    p.held = card.key;
    this.save();
    return this.view(token, d);
  }

  async actLock(req, token, cfg) {
    if (!this.L.players[token]) return { ok: false, err: 'notjoined' };
    const d = await this.deckFor(this.L.deck, req.lang, this.L.players[token]);
    if (!d) return { ok: false, err: 'nodeck' };
    const L = this.L;
    if (!L) return { ok: false, err: 'nolobby' };
    const p = L.players[token];
    if (!p) return { ok: false, err: 'notjoined' };
    this.seen.set(token, Date.now());
    p.lang = d.lang;
    this.heal(d, p);
    const fail = err => { const v = this.view(token, d); v.ok = false; v.err = err; return v; };
    if (p.phase === 'locked') return this.view(token, d);           /* a repeated tap is not an error */
    if (p.phase !== 'drawn' || !p.held) return fail('nocard');
    const owner = L.locked[p.held];
    if (owner && owner !== token) {
      p.phase = 'idle'; p.held = null;
      this.save();
      return fail('taken');
    }
    L.locked[p.held] = token;
    p.phase = 'locked';
    const c = this.cardAt(d, p.held);
    if (cfg.empty === 'reshuffle' && this.unlockedCount(d) === 0) this.recycle();
    this.save();
    if (c && cfg.logCards) this.log('Log', [L.code, d.name, c.cat, c.q, p.n]);
    return this.view(token, d);
  }

  async actNext(req, token) {
    if (!this.L.players[token]) return { ok: false, err: 'notjoined' };
    const d = await this.deckFor(this.L.deck, req.lang, this.L.players[token]);
    const L = this.L;
    if (!L) return { ok: false, err: 'nolobby' };
    const p = L.players[token];
    if (!p) return { ok: false, err: 'notjoined' };
    this.seen.set(token, Date.now());
    if (d) { p.lang = d.lang; this.heal(d, p); }
    if (p.phase === 'locked') { p.phase = 'idle'; p.held = null; p.seen = {}; p.changes = CFG.CHANGES; }
    this.save();
    return this.view(token, d);
  }

  actLeave(token) {
    const L = this.L;
    if (!L.players[token]) return { ok: true };
    delete L.players[token];
    L.order = L.order.filter(x => x !== token);
    this.seen.delete(token);
    this.save();
    for (const ws of this.ctx.getWebSockets(token)) { try { ws.close(1000, 'left'); } catch (e) {} }
    return { ok: true };
  }
}
