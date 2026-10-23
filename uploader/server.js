'use strict';

// Servizio dei giochi.
// Porta privata (PORT, raggiunta solo da nginx su /api/): caricamento ed eliminazione dei
//   giochi e gestione dei gruppi di giochi, con la password GIOCHI_PASSWORD.
// Porta pubblica (PUBLIC_PORT, pubblicata con il funnel di Tailscale): solo i gruppi, tramite
//   link con codice. Un gruppo con più giochi mostra una pagina di scelta; con un gioco solo
//   porta dritto al gioco. I giochi sono serviti in sandbox.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 3001;
// Giochi caricati dalla pagina: cartella condivisa che nginx serve su /caricati/
const DATA_DIR = process.env.DATA_DIR || '/data';
// Giochi della repo (app/files/), in sola lettura
const REPO_DIR = process.env.REPO_DIR || '/repo';
// Stato privato (gruppi e loro codici): NON va nella cartella dei giochi, che nginx rende elencabile
const STATE_DIR = process.env.STATE_DIR || '/state';
const GROUPS_FILE = path.join(STATE_DIR, 'groups.json');
const PASSWORD = process.env.GIOCHI_PASSWORD || '';
// Indirizzo con cui i genitori raggiungono la porta pubblica (es. https://.../m)
const PUBLIC_URL = /^https?:\/\/[^\s?#]+$/.test(String(process.env.GIOCHI_PUBLIC_URL || '').replace(/\/+$/, ''))
  ? String(process.env.GIOCHI_PUBLIC_URL).replace(/\/+$/, '')
  : '';

const MAX_SIZE = 3 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_GROUPS = 200;
const MAX_GROUP_GAMES = 30;
const SESSION_MS = 12 * 60 * 60 * 1000;
const NAME = /^[a-z0-9][a-z0-9._-]{0,78}\.html$/;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const SOURCES = { files: REPO_DIR, caricati: DATA_DIR };

// Il segreto delle sessioni sta solo in memoria: dopo un riavvio serve rientrare con la password.
const secret = crypto.randomBytes(32);

for (const dir of [DATA_DIR, STATE_DIR]) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    console.error(`La cartella ${dir} non è scrivibile`);
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Oltre il limite si scarta il resto e si risponde a fine invio (nginx comunque
      // non lascia passare più di 4 MB)
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) reject(httpError(413, `File troppo grande (massimo ${limit / 1024 / 1024} MB)`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
  } catch (e) {
    throw e.status ? e : httpError(400, 'Richiesta non valida');
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ── Sessione ──
function sign(value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function isAuthed(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)minigiochi=([0-9]+)\.([0-9a-f]{64})/);
  if (!m || Number(m[1]) < Date.now()) return false;
  const expected = Buffer.from(sign(m[1]), 'hex');
  return crypto.timingSafeEqual(expected, Buffer.from(m[2], 'hex'));
}

// I cookie non distinguono le porte: nome diverso da quello della homepage ("giochi"), così
// entrare in una delle due pagine non fa uscire dall'altra.
function cookie(req, value, clear) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `minigiochi=${value}; Path=/api/; HttpOnly; SameSite=Strict${secure}${clear ? '; Max-Age=0' : ''}`;
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

let failures = 0;
let lockedUntil = 0;

// ── Giochi ──
function cleanName(raw) {
  const base = path.basename(String(raw || ''))
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.htm$/, '.html')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
  if (!NAME.test(base) || base.includes('..')) {
    throw httpError(400, 'Nome del file non valido: serve un file .html');
  }
  return base;
}

function listUploaded() {
  return fs.readdirSync(DATA_DIR).filter((n) => NAME.test(n));
}

// Tutti i giochi, identificati da "files/<nome>" (repo) o "caricati/<nome>" (caricati).
function allGameKeys() {
  const keys = [];
  for (const [source, dir] of Object.entries(SOURCES)) {
    try {
      fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && /\.html?$/i.test(d.name) && !d.name.startsWith('.'))
        .forEach((d) => keys.push(`${source}/${d.name}`));
    } catch {
      // cartella assente: nessun gioco da quella fonte
    }
  }
  return keys;
}

function gamePath(key) {
  const slash = key.indexOf('/');
  const dir = SOURCES[key.slice(0, slash)];
  const file = key.slice(slash + 1);
  if (!dir || !file || file.includes('/') || file.includes('\\') || file.startsWith('.')) return null;
  return path.join(dir, file);
}

// Titolo, icona e descrizione letti dal gioco (<title>, <meta name="icona">, <meta name="description">)
function gameInfo(key) {
  let html = '';
  try {
    html = fs.readFileSync(gamePath(key), 'utf8').slice(0, 200 * 1024);
  } catch {
    // gioco non leggibile: si usano i valori predefiniti
  }
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3];
    if (attrs.name && attrs.content !== undefined) meta[attrs.name.toLowerCase()] = attrs.content.trim();
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const file = key.slice(key.indexOf('/') + 1);
  const fallback = file.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
  return {
    title: ((titleMatch && titleMatch[1].trim()) || fallback.charAt(0).toUpperCase() + fallback.slice(1)).slice(0, 60),
    icon: Array.from(meta.icona || '🎮').slice(0, 4).join(''),
    desc: (meta.description || '').slice(0, 140),
  };
}

// ── Gruppi ──
// groups.json: [{ "token": "<codice>", "label": "nome interno", "games": ["files/x.html", ...] }]
let groups = [];
try {
  groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
  if (!Array.isArray(groups)) groups = [];
} catch {
  groups = [];
}

function saveGroups() {
  writeAtomic(GROUPS_FILE, JSON.stringify(groups, null, 1));
}

function newToken() {
  return crypto.randomBytes(16).toString('base64url');
}

// Toglie dai gruppi i giochi che non esistono più (eliminati o tolti dalla repo).
function pruneGroups() {
  const existing = new Set(allGameKeys());
  let changed = false;
  for (const g of groups) {
    const kept = g.games.filter((k) => existing.has(k));
    if (kept.length !== g.games.length) {
      g.games = kept;
      changed = true;
    }
  }
  if (changed) saveGroups();
}

function cleanGroup(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'Gruppo non valido');
  const label = String(body.label || '').trim().slice(0, 60);
  const existing = new Set(allGameKeys());
  const games = [...new Set(Array.isArray(body.games) ? body.games.map(String) : [])]
    .filter((k) => existing.has(k))
    .slice(0, MAX_GROUP_GAMES);
  if (games.length === 0) throw httpError(400, 'Scegli almeno un gioco');
  return { label, games };
}

function groupList() {
  pruneGroups();
  return groups.map(({ token, label, games }) => ({ token, label, games, url: PUBLIC_URL ? `${PUBLIC_URL}/${token}` : '' }));
}

function findGroup(token) {
  return TOKEN.test(token) ? groups.find((g) => g.token === token) : undefined;
}

// Chiave pubblica di un gioco dentro un gruppo: stabile, ma non rivela il nome del file.
function itemKey(group, key) {
  return crypto.createHash('sha256').update(`${group.token}:${key}`).digest('base64url').slice(0, 12);
}

// ── Porta privata (dietro nginx) ──
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/session') {
    return sendJson(res, 200, { enabled: Boolean(PASSWORD), auth: Boolean(PASSWORD) && isAuthed(req) });
  }

  if (!PASSWORD) throw httpError(503, 'Caricamento non attivo: manca GIOCHI_PASSWORD sul Pi');

  // Le modifiche devono arrivare dalla pagina dei giochi (un modulo di un altro sito non
  // può aggiungere questa intestazione)
  if (req.method !== 'GET' && req.headers['x-giochi'] !== '1') throw httpError(403, 'Richiesta non valida');

  if (route === 'POST /api/login') {
    if (Date.now() < lockedUntil) throw httpError(429, 'Troppi tentativi, riprova tra un minuto');
    const body = await readJson(req);
    if (typeof body.password === 'string' && body.password.length <= 200 && passwordMatches(body.password)) {
      failures = 0;
      const exp = String(Date.now() + SESSION_MS);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, `${exp}.${sign(exp)}`) });
    }
    failures += 1;
    if (failures >= 5) {
      failures = 0;
      lockedUntil = Date.now() + 60 * 1000;
    }
    throw httpError(401, 'Password errata');
  }

  if (route === 'POST /api/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', true) });
  }

  if (!isAuthed(req)) throw httpError(401, 'Serve la password');

  if (route === 'POST /api/upload') {
    const name = cleanName(url.searchParams.get('name'));
    const file = path.join(DATA_DIR, name);
    const exists = fs.existsSync(file);
    if (exists && url.searchParams.get('replace') !== '1') {
      throw httpError(409, `Esiste già un gioco chiamato ${name}`);
    }
    if (!exists && listUploaded().length >= MAX_FILES) throw httpError(507, 'Troppi giochi caricati: eliminane qualcuno');
    const buf = await readBody(req, MAX_SIZE);
    const text = buf.toString('utf8');
    if (!buf.length || text.includes('\u0000') || !/<(!doctype|html|head|body|script|div|canvas)/i.test(text)) {
      throw httpError(400, 'Il file non sembra una pagina html');
    }
    writeAtomic(file, buf);
    return sendJson(res, exists ? 200 : 201, { name });
  }

  const del = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    const name = cleanName(decodeURIComponent(del[1]));
    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) throw httpError(404, 'Gioco non trovato');
    fs.unlinkSync(file);
    pruneGroups();
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/groups') {
    return sendJson(res, 200, { publicUrl: PUBLIC_URL, groups: groupList() });
  }

  if (route === 'POST /api/groups') {
    if (groups.length >= MAX_GROUPS) throw httpError(400, 'Troppi gruppi: eliminane qualcuno');
    groups.push({ token: newToken(), ...cleanGroup(await readJson(req)) });
    saveGroups();
    return sendJson(res, 201, { publicUrl: PUBLIC_URL, groups: groupList() });
  }

  const g = url.pathname.match(/^\/api\/groups\/([^/]+)(\/rotate)?$/);
  if (g) {
    const group = findGroup(g[1]);
    if (!group) throw httpError(404, 'Gruppo non trovato');
    if (req.method === 'PUT' && !g[2]) {
      Object.assign(group, cleanGroup(await readJson(req)));
    } else if (req.method === 'DELETE' && !g[2]) {
      groups = groups.filter((x) => x !== group);
    } else if (req.method === 'POST' && g[2]) {
      group.token = newToken();
    } else {
      throw httpError(405, 'Metodo non consentito');
    }
    saveGroups();
    return sendJson(res, 200, { publicUrl: PUBLIC_URL, groups: groupList() });
  }

  throw httpError(404, 'Non trovato');
}

// ── Porta pubblica ──
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock';
const PUBLIC_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const PAGE_STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;color:#fff;display:flex;justify-content:center}
main{width:100%;max-width:680px;padding:3rem 1.5rem;display:flex;flex-direction:column;align-items:center}
h1{font-size:2.6rem;font-weight:800;text-shadow:0 3px 8px rgba(0,0,0,.25);margin-bottom:.4rem}
p{color:rgba(255,255,255,.85);font-size:1.1rem;margin-bottom:1.8rem;text-align:center}
ul{list-style:none;width:100%;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:1rem}
a.card{display:flex;flex-direction:column;align-items:center;text-align:center;gap:.35rem;padding:1.5rem 1rem;background:#fff;border-radius:22px;color:inherit;text-decoration:none;box-shadow:0 6px 22px rgba(0,0,0,.15);height:100%}
a.card:hover{transform:translateY(-4px)}
.icon{width:72px;height:72px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:2.4rem;margin-bottom:.4rem}
.t0 .icon{background:#dbeafe}.t1 .icon{background:#fce7f3}.t2 .icon{background:#d1fae5}.t3 .icon{background:#fef3c7}
.name{font-size:1.3rem;font-weight:800;color:#6C63FF}
.desc{font-size:.9rem;color:#6b7280}
@media(max-width:480px){h1{font-size:2.1rem}ul{grid-template-columns:1fr}}`;

function sendPage(res, status, title, body) {
  res.writeHead(status, {
    ...PUBLIC_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(`<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main></body></html>`);
}

function notFound(res) {
  sendPage(res, 404, 'Gioco non trovato', '<h1>Ops!</h1><p>Questo link non funziona più. Chiedi un nuovo link alla logopedista.</p>');
}

// Pagina di scelta di un gruppo. Link relativi: funzionano qualunque sia il prefisso (/m/ o no).
function sendChoice(res, group, keys) {
  const cards = keys.map((key, i) => {
    const info = gameInfo(key);
    return `<li><a class="card t${i % 4}" href="${escapeHtml(group.token)}/${itemKey(group, key)}">`
      + `<span class="icon">${escapeHtml(info.icon)}</span><strong class="name">${escapeHtml(info.title)}</strong>`
      + (info.desc ? `<span class="desc">${escapeHtml(info.desc)}</span>` : '')
      + '</a></li>';
  }).join('');
  sendPage(res, 200, 'Giochi', `<h1>Giochi</h1><p>Scegli un gioco</p><ul>${cards}</ul>`);
}

// Script aggiunto ai giochi serviti dal link: i link che portano fuori dal gioco (es. "← Giochi")
// tornano alla pagina di scelta del gruppo; se il gruppo ha un gioco solo, vengono nascosti.
function injectedScript(back) {
  return `<script>(function(){var back=${JSON.stringify(back)};
function outside(a){var h=a.getAttribute('href');if(!h||h.charAt(0)==='#'||/^(javascript:|mailto:|tel:|sms:)/i.test(h))return false;
var u;try{u=new URL(h,location.href)}catch(e){return false}
if(u.origin!==location.origin)return false;return u.pathname!==location.pathname}
document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
if(!a||!outside(a))return;e.preventDefault();if(back)location.href=back},true);
if(!back){var hide=function(){var l=document.querySelectorAll('a[href]');for(var i=0;i<l.length;i++)if(outside(l[i]))l[i].style.display='none'};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hide);else hide()}})();</script>`;
}

function sendGame(res, key, back) {
  let html;
  try {
    html = fs.readFileSync(gamePath(key), 'utf8');
  } catch {
    return notFound(res);
  }
  const script = injectedScript(back);
  const head = html.match(/<head\b[^>]*>/i);
  const htmlTag = html.match(/<html\b[^>]*>/i);
  if (head) html = html.replace(head[0], head[0] + script);
  else if (htmlTag) html = html.replace(htmlTag[0], htmlTag[0] + script);
  else html = script + html;
  res.writeHead(200, { ...PUBLIC_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': SANDBOX });
  res.end(html);
}

function handlePublic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Metodo non consentito');
  const url = new URL(req.url, 'http://localhost');
  // /<codice>, /<codice>/<gioco> (con o senza /m/ davanti, a seconda dell'ingresso)
  const m = url.pathname.match(/^\/(?:m\/)?([A-Za-z0-9_-]{22})(\/([A-Za-z0-9_-]{12})?)?$/);
  const group = m && findGroup(m[1]);
  if (!group) return notFound(res);
  pruneGroups();
  const keys = group.games;
  if (keys.length === 0) return notFound(res);

  if (m[3]) {
    const key = keys.find((k) => itemKey(group, k) === m[3]);
    if (!key) return notFound(res);
    // Dal gioco si torna alla pagina di scelta: "../<codice>" relativo a /<codice>/<gioco>
    return sendGame(res, key, keys.length > 1 ? `../${group.token}` : null);
  }
  if (m[2]) {
    // "/<codice>/": niente barra finale, così i link relativi della pagina funzionano
    res.writeHead(301, { ...PUBLIC_HEADERS, Location: `../${group.token}` });
    return res.end();
  }
  if (keys.length === 1) return sendGame(res, keys[0], null);
  return sendChoice(res, group, keys);
}

// ── Avvio ──
function makeServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!e.status) console.error(e);
      if (res.headersSent) return res.end();
      sendJson(res, e.status || 500, { error: e.status ? e.message : 'Errore interno' });
    }
  });
  server.headersTimeout = 10 * 1000;
  server.requestTimeout = 60 * 1000;
  return server;
}

pruneGroups();

makeServer(handle).listen(PORT, () => {
  console.log(`Caricamento giochi sulla porta ${PORT}`);
  if (!PASSWORD) console.log('GIOCHI_PASSWORD non impostata: caricamento spento');
});
makeServer(handlePublic).listen(PUBLIC_PORT, () => {
  console.log(`Gruppi di giochi pubblici sulla porta ${PUBLIC_PORT}`);
  if (!PUBLIC_URL) console.log('GIOCHI_PUBLIC_URL non impostato: i link mostrano solo il codice');
});
