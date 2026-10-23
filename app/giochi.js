// Elenco automatico dei giochi, da due cartelle (elenchi JSON generati da nginx):
//   files/     giochi messi nella repo su GitHub
//   caricati/  giochi caricati da questa pagina (servizio "giochi", con password)
// Nome e icona arrivano dal gioco stesso: <title>...</title> e <meta name="icona" content="🐶">.
// Facoltativa anche una descrizione: <meta name="description" content="...">.
// In "Gestisci giochi": caricamento, eliminazione e gruppi di giochi con link per i genitori.

const $ = (id) => document.getElementById(id);
const DIRS = ["files/", "caricati/"];
const HTML = /\.html?$/i;

let admin = false;
let games = [];          // giochi mostrati, con titolo e icona
let groups = [];         // gruppi di giochi (solo in gestione)
let publicUrl = "";
let editing = null;      // gruppo in modifica

// Chiave di un gioco usata dal servizio: "files/x.html" o "caricati/x.html"
const keyOf = (g) => g.dir + g.file;

function showStatus(text) {
  $("status").textContent = text;
  $("status").hidden = !text;
}

function titleFromFile(name) {
  const base = name.replace(HTML, "").replace(/[-_]+/g, " ").trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function listDir(dir) {
  try {
    const res = await fetch(dir, { cache: "no-store" });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    return (await res.json())
      .filter((f) => f.type === "file" && HTML.test(f.name))
      .map((f) => ({ dir, file: f.name }));
  } catch {
    return null;
  }
}

async function readInfo(game) {
  try {
    const res = await fetch(game.dir + encodeURIComponent(game.file), { cache: "no-store" });
    if (!res.ok) return {};
    // DOMParser legge l'HTML senza eseguirne gli script
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const meta = (n) => (doc.querySelector(`meta[name="${n}"]`)?.getAttribute("content") || "").trim();
    return { title: doc.title.trim(), icon: meta("icona"), desc: meta("description") };
  } catch {
    return {};
  }
}

const gameTitle = (g) => (g.title || titleFromFile(g.file)).slice(0, 60);
const gameIcon = (g) => Array.from(g.icon || "🎮").slice(0, 4).join("");
// Testo per la ricerca: senza maiuscole né accenti ("memória" trova "Memoria")
const plain = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function card(game, i) {
  const li = document.createElement("li");
  li.style.animationDelay = `${i * 0.08}s`;
  li.dataset.search = plain(`${gameTitle(game)} ${titleFromFile(game.file)}`);

  const a = document.createElement("a");
  a.href = game.dir + encodeURIComponent(game.file);
  a.className = `card tone-${i % 4}`;

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = gameIcon(game);

  const name = document.createElement("strong");
  name.className = "name";
  name.textContent = gameTitle(game);

  a.append(icon, name);
  if (game.desc) {
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = game.desc.slice(0, 140);
    a.append(desc);
  }
  li.append(a);

  if (admin && game.dir === "caricati/") {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "remove";
    del.textContent = "✕";
    del.title = "Elimina questo gioco";
    del.setAttribute("aria-label", `Elimina ${name.textContent}`);
    del.addEventListener("click", () => removeGame(game, name.textContent));
    li.append(del);
  }
  return li;
}

async function loadGames() {
  const lists = await Promise.all(DIRS.map(listDir));
  if (lists.every((l) => l === null)) {
    showStatus("Non riesco a leggere l'elenco dei giochi. Riprova tra poco.");
    $("games").replaceChildren();
    games = [];
    applySearch();
    return;
  }
  const found = lists.flatMap((l) => l || []);
  if (found.length === 0) {
    showStatus("Ancora nessun gioco: arriveranno presto!");
    $("games").replaceChildren();
    games = [];
    applySearch();
    return;
  }
  showStatus("");
  games = await Promise.all(found.map(async (g) => ({ ...g, ...(await readInfo(g)) })));
  games.sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file, "it"));
  $("games").replaceChildren(...games.map(card));
  applySearch();
}

// ── Ricerca per nome: nasconde i giochi che non corrispondono, senza ricrearli ──
function applySearch() {
  $("search-box").hidden = games.length === 0;
  const text = games.length ? $("search").value.trim() : "";
  const q = plain(text);
  let shown = 0;
  for (const li of $("games").children) {
    li.hidden = Boolean(q) && !li.dataset.search.includes(q);
    if (!li.hidden) shown++;
  }
  $("no-match").textContent = `Nessun gioco trovato per "${text}"`;
  $("no-match").hidden = !q || shown > 0;
}

$("search").addEventListener("input", applySearch);

// ── Gestione: password, caricamento, eliminazione ──
async function api(method, url, body, type) {
  const headers = { "X-Giochi": "1" };
  if (type) headers["Content-Type"] = type;
  const res = await fetch(url, { method, headers, body, credentials: "same-origin" });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // risposta senza corpo
  }
  if (!res.ok) {
    const e = new Error(data.error || "Servizio dei giochi non raggiungibile");
    e.status = res.status;
    throw e;
  }
  return data;
}

const json = (obj) => JSON.stringify(obj);

function message(text, kind) {
  const m = $("admin-msg");
  m.textContent = text;
  m.className = `msg ${kind || ""}`;
  m.hidden = !text;
}

async function openAdmin() {
  $("admin").hidden = false;
  $("manage").hidden = true;
  message("");
  let s = { enabled: false, auth: false };
  try {
    s = await (await fetch("api/session", { cache: "no-store" })).json();
  } catch {
    message("Il servizio di caricamento non risponde.", "error");
  }
  $("admin-off").hidden = s.enabled;
  $("login").hidden = !s.enabled || s.auth;
  $("upload").hidden = !s.auth;
  $("groups").hidden = !s.auth;
  $("logout").hidden = !s.auth;
  admin = Boolean(s.auth);
  if (s.enabled && !s.auth) $("password").focus();
  await loadGames();
  if (admin) await loadGroups();
  $("admin").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("manage").addEventListener("click", openAdmin);

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", "api/login", json({ password: $("password").value }), "application/json");
    $("password").value = "";
    await openAdmin();
  } catch (ex) {
    message(ex.message, "error");
  }
});

$("logout").addEventListener("click", async () => {
  await api("POST", "api/logout").catch(() => {});
  admin = false;
  $("admin").hidden = true;
  $("manage").hidden = false;
  await loadGames();
});

async function upload(file, replace) {
  const url = `api/upload?name=${encodeURIComponent(file.name)}${replace ? "&replace=1" : ""}`;
  return api("POST", url, file, "text/html");
}

$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  if (!file) return;
  message("Caricamento…");
  try {
    let res;
    try {
      res = await upload(file, false);
    } catch (ex) {
      if (ex.status !== 409 || !confirm(`${ex.message}. Vuoi sostituirlo?`)) throw ex;
      res = await upload(file, true);
    }
    message(`Caricato: ${res.name}. Lo trovi nell'elenco qui sopra; per mandarlo a un genitore aggiungilo a un gruppo.`, "ok");
    await loadGames();
  } catch (ex) {
    if (ex.status === 401) await openAdmin();
    message(ex.message, "error");
  } finally {
    $("file").value = "";
  }
});

async function removeGame(game, title) {
  if (!confirm(`Eliminare "${title}"? Verrà tolto anche dai gruppi.`)) return;
  try {
    await api("DELETE", `api/files/${encodeURIComponent(game.file)}`);
    message(`Eliminato: ${title}.`, "ok");
  } catch (ex) {
    message(ex.message, "error");
  }
  await loadGames();
  await loadGroups();
}

// ── Gruppi di giochi ──
async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fuori da HTTPS il browser non dà accesso agli appunti: si copia dalla casella
    input.select();
    return document.execCommand("copy");
  }
}

function setGroups(data) {
  groups = data.groups;
  publicUrl = data.publicUrl;
  renderGroups();
}

async function loadGroups() {
  try {
    setGroups(await api("GET", "api/groups"));
  } catch (ex) {
    message(ex.message, "error");
  }
}

function titleOfKey(key) {
  const g = games.find((x) => keyOf(x) === key);
  return g ? gameTitle(g) : key.slice(key.indexOf("/") + 1);
}

function button(text, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn small ${cls || ""}`;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function renderGroups() {
  $("no-public").hidden = Boolean(publicUrl);
  const list = $("group-list");
  list.replaceChildren();
  if (groups.length === 0) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = "Nessun gruppo: creane uno per mandare dei giochi a un genitore.";
    list.append(li);
  }
  for (const g of groups) {
    const li = document.createElement("li");
    li.className = "group-item";

    const name = document.createElement("strong");
    name.textContent = g.label || "Senza nome";
    const meta = document.createElement("span");
    meta.className = "meta";
    const n = g.games.length;
    meta.textContent = n
      ? `${n} ${n === 1 ? "gioco" : "giochi"}: ${g.games.map(titleOfKey).join(", ")}`
      : "Nessun gioco (quelli scelti sono stati eliminati): il link non funziona";

    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = g.url || `Codice ${g.token} (manca GIOCHI_PUBLIC_URL sul Pi)`;
    input.setAttribute("aria-label", "Link per il genitore");

    const row = document.createElement("div");
    row.className = "row";
    const copy = button("Copia link", "", async () => {
      copy.textContent = (await copyText(input.value, input)) ? "Copiato!" : "Copia a mano";
      setTimeout(() => (copy.textContent = "Copia link"), 1800);
    });
    copy.disabled = !g.url;
    row.append(
      copy,
      button("Modifica", "ghost", () => openGroupEditor(g)),
      button("Elimina", "danger", () => removeGroup(g)),
    );

    li.append(name, meta, input, row);
    list.append(li);
  }
}

function openGroupEditor(group) {
  editing = group || null;
  $("group-title").textContent = group ? "Modifica gruppo" : "Nuovo gruppo";
  $("group-label").value = group ? group.label : "";
  $("group-rotate").hidden = !group;

  const box = $("group-games");
  box.replaceChildren();
  const selected = new Set(group ? group.games : []);
  for (const game of games) {
    const label = document.createElement("label");
    label.className = "group-game";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = keyOf(game);
    cb.checked = selected.has(keyOf(game));
    const icon = document.createElement("span");
    icon.className = "gi";
    icon.textContent = gameIcon(game);
    const text = document.createElement("span");
    text.textContent = gameTitle(game);
    label.append(cb, icon, text);
    box.append(label);
  }
  if (games.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Non ci sono ancora giochi.";
    box.append(p);
  }
  $("group-form").hidden = false;
  $("group-add").hidden = true;
  $("group-label").focus();
}

function closeGroupEditor() {
  $("group-form").hidden = true;
  $("group-add").hidden = false;
  editing = null;
}

$("group-add").addEventListener("click", () => openGroupEditor(null));
$("group-cancel").addEventListener("click", closeGroupEditor);

$("group-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = json({
    label: $("group-label").value,
    games: [...document.querySelectorAll("#group-games input:checked")].map((c) => c.value),
  });
  const wasEditing = Boolean(editing);
  try {
    const data = editing
      ? await api("PUT", `api/groups/${editing.token}`, body, "application/json")
      : await api("POST", "api/groups", body, "application/json");
    closeGroupEditor();
    setGroups(data);
    message(wasEditing ? "Gruppo aggiornato." : "Gruppo creato: copia il link e mandalo al genitore.", "ok");
  } catch (ex) {
    message(ex.message, "error");
  }
});

$("group-rotate").addEventListener("click", async () => {
  if (!editing) return;
  if (!confirm("Creare un nuovo link per il gruppo? Quello vecchio smetterà subito di funzionare.")) return;
  try {
    const data = await api("POST", `api/groups/${editing.token}/rotate`, json({}), "application/json");
    closeGroupEditor();
    setGroups(data);
    message("Nuovo link creato.", "ok");
  } catch (ex) {
    message(ex.message, "error");
  }
});

async function removeGroup(group) {
  if (!confirm(`Eliminare il gruppo "${group.label || "Senza nome"}"? Il suo link smetterà di funzionare (i giochi restano).`)) return;
  try {
    setGroups(await api("DELETE", `api/groups/${group.token}`));
    message("Gruppo eliminato.", "ok");
  } catch (ex) {
    message(ex.message, "error");
  }
}

loadGames();
