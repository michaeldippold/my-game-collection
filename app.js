'use strict';

// ── Config ────────────────────────────────────────────────────────────────────
const OWNER  = 'michaeldippold';
const REPO   = 'my-game-collection';
const FILE   = 'games.json';
const BRANCH = 'main';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${BRANCH}`;
const PAT_KEY     = 'gcol_pat';
const VIEW_KEY    = 'gcol_view';
const BGG_KEY_KEY = 'gcol_bgg_key';

// BGG XML API2 base. If you hit CORS errors swap in a proxy:
// const BGG_BASE = 'https://corsproxy.io/?https://boardgamegeek.com/xmlapi2';
const BGG_BASE = 'https://boardgamegeek.com/xmlapi2';

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  data: { games: [], tags: [] },
  sha: null,
  pat:    localStorage.getItem(PAT_KEY)     || '',
  bggKey: localStorage.getItem(BGG_KEY_KEY) || '',
  activeTags: new Set(),
  view:  localStorage.getItem(VIEW_KEY) || 'grid',
  saving:  false,
  loading: true,
  error:   null,
};

// ── Base64 helpers (unicode-safe) ─────────────────────────────────────────────
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

// ── GitHub API ────────────────────────────────────────────────────────────────
async function loadData() {
  S.loading = true;
  S.error   = null;
  renderGamesArea();
  try {
    const headers = { Accept: 'application/vnd.github.v3+json' };
    if (S.pat) headers['Authorization'] = `token ${S.pat}`;
    const res = await fetch(API_URL, { headers });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} — is the repo public?`);
    const json = await res.json();
    S.sha = json.sha;
    S.data = JSON.parse(fromB64(json.content));
    S.data.games = S.data.games || [];
    S.data.tags  = S.data.tags  || [];
  } catch (e) {
    S.error = e.message;
  } finally {
    S.loading = false;
    renderApp();
  }
}

async function saveData() {
  if (!S.pat) { openSettingsModal(); return false; }
  S.saving = true;
  renderHeaderActions();
  try {
    const content = toB64(JSON.stringify(S.data, null, 2));
    const res = await fetch(API_URL, {
      method: 'PUT',
      headers: {
        Authorization: `token ${S.pat}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        message: `Update collection · ${new Date().toLocaleDateString()}`,
        content,
        sha: S.sha,
        branch: BRANCH,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Save failed (${res.status})`);
    }
    const json = await res.json();
    S.sha = json.content.sha;
    return true;
  } catch (e) {
    showToast(e.message, 'error');
    return false;
  } finally {
    S.saving = false;
    renderHeaderActions();
  }
}

// ── BGG API ───────────────────────────────────────────────────────────────────
function bggFetch(path, params = {}) {
  if (S.bggKey) params.apikey = S.bggKey;
  const qs = new URLSearchParams(params).toString();
  return fetch(`${BGG_BASE}${path}?${qs}`);
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'text/xml');
}

async function bggSearch(query) {
  const res = await bggFetch('/search', { query, type: 'boardgame' });
  if (!res.ok) throw new Error(`BGG returned ${res.status}`);
  const doc = parseXml(await res.text());
  // Check for parse error
  if (doc.querySelector('parsererror')) throw new Error('Unexpected BGG response — check your API key.');
  return [...doc.querySelectorAll('item')].slice(0, 10).map(el => ({
    id:   el.getAttribute('id'),
    name: el.querySelector('name[type="primary"]')?.getAttribute('value')
          ?? el.querySelector('name')?.getAttribute('value')
          ?? '?',
    year: el.querySelector('yearpublished')?.getAttribute('value') ?? null,
  }));
}

async function bggThing(id) {
  let res = await bggFetch('/thing', { id, stats: 1 });
  // BGG sometimes queues requests and returns 202
  if (res.status === 202) {
    await delay(2500);
    res = await bggFetch('/thing', { id, stats: 1 });
  }
  if (!res.ok) throw new Error(`BGG returned ${res.status}`);
  const doc  = parseXml(await res.text());
  if (doc.querySelector('parsererror')) throw new Error('Unexpected BGG response.');
  const item = doc.querySelector('item');
  if (!item) throw new Error('Game not found on BGG.');
  const rawWeight = item.querySelector('averageweight')?.getAttribute('value');
  return {
    bgg_id:        id,
    name:          item.querySelector('name[type="primary"]')?.getAttribute('value') ?? '',
    thumbnail_url: item.querySelector('thumbnail')?.textContent.trim() || null,
    image_url:     item.querySelector('image')?.textContent.trim()     || null,
    year:          parseInt(item.querySelector('yearpublished')?.getAttribute('value'))  || null,
    minPlayers:    parseInt(item.querySelector('minplayers')?.getAttribute('value'))     || null,
    maxPlayers:    parseInt(item.querySelector('maxplayers')?.getAttribute('value'))     || null,
    minPlaytime:   parseInt(item.querySelector('minplaytime')?.getAttribute('value'))   || null,
    maxPlaytime:   parseInt(item.querySelector('maxplaytime')?.getAttribute('value'))   || null,
    weight:        rawWeight ? Math.round(parseFloat(rawWeight) * 100) / 100 : null,
  };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Wire up BGG search input inside the currently-open modal
let bggSearchTimer;
function wireBggSearch() {
  const input = document.getElementById('bgg-q');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(bggSearchTimer);
    const q = input.value.trim();
    const box = document.getElementById('bgg-results');
    if (!box) return;
    if (q.length < 2) { box.innerHTML = ''; box.classList.remove('open'); return; }
    box.innerHTML = '<div class="bgg-status">Searching…</div>';
    box.classList.add('open');
    bggSearchTimer = setTimeout(async () => {
      try {
        const results = await bggSearch(q);
        if (!results.length) {
          box.innerHTML = '<div class="bgg-status">No results found.</div>';
          return;
        }
        box.innerHTML = results.map(g => `
          <div class="bgg-result" onclick="selectBggGame('${esc(g.id)}')">
            <span class="bgg-result-name">${esc(g.name)}</span>
            ${g.year ? `<span class="bgg-result-year">${esc(g.year)}</span>` : ''}
          </div>`).join('');
      } catch (e) {
        box.innerHTML = `<div class="bgg-status error">⚠ ${esc(e.message)}</div>`;
      }
    }, 400);
  });
  input.focus();
}

async function selectBggGame(id) {
  const box = document.getElementById('bgg-results');
  if (box) box.innerHTML = '<div class="bgg-status">Loading details…</div>';

  try {
    const g = await bggThing(id);

    // Fill all form fields
    const set = (elId, val) => { const el = document.getElementById(elId); if (el && val != null) el.value = val; };
    set('f-bgg-id',    g.bgg_id);
    set('f-thumbnail', g.thumbnail_url || '');
    set('f-name',      g.name);
    set('f-year',      g.year);
    set('f-weight',    g.weight);
    set('f-minp',      g.minPlayers);
    set('f-maxp',      g.maxPlayers);
    set('f-mint',      g.minPlaytime);
    set('f-maxt',      g.maxPlaytime);

    // Update thumbnail preview
    const preview = document.getElementById('thumb-preview');
    if (preview) {
      preview.innerHTML = g.thumbnail_url
        ? `<img src="${esc(g.thumbnail_url)}" alt="${esc(g.name)}" />`
        : '';
      preview.classList.toggle('has-image', !!g.thumbnail_url);
    }

    if (box) {
      box.innerHTML = `<div class="bgg-status success">✓ ${esc(g.name)} loaded — adjust tags below and save.</div>`;
    }
    // Clear search input
    const input = document.getElementById('bgg-q');
    if (input) input.value = '';

  } catch (e) {
    if (box) box.innerHTML = `<div class="bgg-status error">⚠ ${esc(e.message)}</div>`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}
function getTag(id) {
  return S.data.tags.find(t => t.id === id);
}
function getFilteredGames() {
  if (S.activeTags.size === 0) return S.data.games;
  return S.data.games.filter(g =>
    [...S.activeTags].every(tid => g.tags.includes(tid))
  );
}
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function weightDots(w) {
  const n = Math.min(5, Math.max(0, Math.round(parseFloat(w) || 0)));
  return `<span class="dots">${'●'.repeat(n)}<span class="dot-empty">${'○'.repeat(5 - n)}</span></span>`;
}
function metaStr(game) {
  const parts = [];
  if (game.year) parts.push(game.year);
  if (game.minPlayers) {
    parts.push(game.minPlayers === game.maxPlayers
      ? `${game.minPlayers}p`
      : `${game.minPlayers}–${game.maxPlayers}p`);
  }
  if (game.minPlaytime) {
    parts.push(game.minPlaytime === game.maxPlaytime
      ? `${game.minPlaytime}m`
      : `${game.minPlaytime}–${game.maxPlaytime}m`);
  }
  return parts.join(' · ') || '—';
}
function getInitials(name) {
  const words = name.split(/\s+/).filter(w => w.length > 2);
  return (words.length >= 2
    ? words.slice(0, 2).map(w => w[0]).join('')
    : name.slice(0, 2)).toUpperCase();
}
const PLACEHOLDER_COLORS = [
  '#1a2a4a','#2d1a4a','#1a3a3a','#3d1a3a','#1a3d20','#2d2a10',
  '#1e3060','#38186a','#163838','#4a1a38',
];
function placeholderColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return PLACEHOLDER_COLORS[Math.abs(h) % PLACEHOLDER_COLORS.length];
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderApp() {
  renderHeaderActions();
  renderFilterBar();
  renderGamesArea();
}

function renderHeaderActions() {
  const el = document.getElementById('header-actions');
  if (!el) return;
  el.innerHTML = `
    ${S.pat
      ? `<button class="btn-primary" onclick="openAddModal()" ${S.saving ? 'disabled' : ''}>
           ${S.saving ? 'Saving…' : '+ Add Game'}
         </button>`
      : ''}
    <button class="btn-icon" onclick="openSettingsModal()"
            title="${S.pat ? 'Settings' : 'Set GitHub PAT to enable editing'}">
      ${S.pat ? '⚙️' : '🔒'}
    </button>
  `;
}

function renderFilterBar() {
  const el = document.getElementById('filter-bar');
  if (!el) return;
  const canEdit = !!S.pat;

  const pills = S.data.tags.map(tag => {
    const active = S.activeTags.has(tag.id) ? 'active' : '';
    return `
      <span class="tag-pill ${active}">
        <span onclick="toggleTag('${esc(tag.id)}')">${esc(tag.name)}</span>
        ${canEdit
          ? `<span class="tag-del" onclick="confirmDeleteTag('${esc(tag.id)}')" title="Delete tag">×</span>`
          : ''}
      </span>`;
  }).join('');

  el.innerHTML = `
    <div class="filter-left">
      <div class="tag-pills">${pills}</div>
      ${S.activeTags.size > 0
        ? `<button class="btn-clear" onclick="clearFilters()">Clear</button>`
        : ''}
    </div>
    <div class="filter-right">
      ${canEdit ? `<button class="btn-add-tag" onclick="openAddTagModal()">+ Tag</button>` : ''}
      <div class="view-toggle">
        <button class="${S.view === 'grid' ? 'active' : ''}" onclick="setView('grid')" title="Grid">⊞</button>
        <button class="${S.view === 'list' ? 'active' : ''}" onclick="setView('list')" title="List">☰</button>
      </div>
    </div>
  `;
}

function renderGamesArea() {
  const el = document.getElementById('games-area');
  if (!el) return;
  if (S.loading) {
    el.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading collection…</span></div>`;
    return;
  }
  if (S.error) {
    el.innerHTML = `<div class="error-state"><p>⚠ ${esc(S.error)}</p><button onclick="loadData()">Retry</button></div>`;
    return;
  }
  const games = getFilteredGames();
  if (games.length === 0) {
    el.innerHTML = `<div class="empty-state">${
      S.activeTags.size > 0
        ? 'No games match those filters. <button class="btn-clear" onclick="clearFilters()" style="margin-left:8px">Clear filters</button>'
        : S.pat
          ? 'No games yet — hit <strong>+ Add Game</strong> to start!'
          : 'No games yet.'
    }</div>`;
    return;
  }
  if (S.view === 'grid') {
    el.innerHTML = `<div class="game-grid">${games.map(renderCard).join('')}</div>`;
  } else {
    el.innerHTML = `
      <table class="game-list">
        <thead><tr>
          <th>Name</th><th>Year</th><th>Players</th><th>Time</th><th>Weight</th><th>Tags</th>
          ${S.pat ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${games.map(renderRow).join('')}</tbody>
      </table>`;
  }
}

function renderCard(game) {
  const color    = placeholderColor(game.name);
  const initials = getInitials(game.name);
  const tagHtml  = game.tags
    .map(tid => getTag(tid)).filter(Boolean)
    .map(t => `<span class="tag-chip">${esc(t.name)}</span>`).join('');
  const click = S.pat ? `onclick="openEditModal('${esc(game.id)}')"` : '';
  return `
    <div class="game-card" ${click}>
      <div class="card-image" style="background:${color}">
        ${game.thumbnail_url
          ? `<img src="${esc(game.thumbnail_url)}" alt="${esc(game.name)}" loading="lazy"
                  onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`
          : ''}
        <span class="card-initials" ${game.thumbnail_url ? 'style="display:none"' : ''}>${esc(initials)}</span>
      </div>
      <div class="card-body">
        <div class="card-name">${esc(game.name)}</div>
        <div class="card-meta">${esc(metaStr(game))}</div>
        <div class="card-weight">${weightDots(game.weight)}</div>
        ${tagHtml ? `<div class="card-tags">${tagHtml}</div>` : ''}
      </div>
    </div>`;
}

function renderRow(game) {
  const players = game.minPlayers
    ? (game.minPlayers === game.maxPlayers ? `${game.minPlayers}` : `${game.minPlayers}–${game.maxPlayers}`)
    : '—';
  const time = game.minPlaytime
    ? (game.minPlaytime === game.maxPlaytime ? `${game.minPlaytime}m` : `${game.minPlaytime}–${game.maxPlaytime}m`)
    : '—';
  const tags = game.tags.map(tid => getTag(tid)).filter(Boolean)
    .map(t => `<span class="tag-chip small">${esc(t.name)}</span>`).join('');
  const actions = S.pat
    ? `<td><button class="btn-edit" onclick="openEditModal('${esc(game.id)}')">Edit</button></td>`
    : '';
  return `
    <tr>
      <td class="game-name-cell">${esc(game.name)}</td>
      <td>${game.year || '—'}</td>
      <td>${players}</td>
      <td>${time}</td>
      <td>${weightDots(game.weight)}</td>
      <td><div class="card-tags">${tags || '—'}</div></td>
      ${actions}
    </tr>`;
}

// ── Modals ────────────────────────────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  clearTimeout(bggSearchTimer);
}

// Settings (PAT + BGG key)
function openSettingsModal() {
  openModal(`
    <h2>Settings</h2>

    <div class="settings-section">
      <h3>GitHub Access</h3>
      <p class="modal-hint">
        A <strong>Personal Access Token</strong> with <code>repo</code> write scope lets you add and
        edit games. Friends can view without one.
        <a href="https://github.com/settings/tokens/new?description=my-game-collection&scopes=repo"
           target="_blank" rel="noopener">Create token ↗</a>
      </p>
      <label>
        <span>Personal Access Token</span>
        <input id="pat-input" type="password" value="${esc(S.pat)}" placeholder="ghp_…" autocomplete="off" />
      </label>
    </div>

    <div class="settings-section">
      <h3>BoardGameGeek API</h3>
      <p class="modal-hint">
        Your BGG API key enables game search and auto-fills details &amp; cover images when adding games.
        Stored only in your browser — never committed to the repo.
      </p>
      <label>
        <span>BGG API Key</span>
        <input id="bgg-key-input" type="password" value="${esc(S.bggKey)}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" />
      </label>
    </div>

    <div class="modal-actions" style="margin-top:24px">
      <button class="btn-primary" onclick="saveSettings()">Save</button>
      ${(S.pat || S.bggKey)
        ? `<button class="btn-danger" onclick="clearSettings()">Clear All</button>`
        : ''}
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `);
}
function saveSettings() {
  const pat = (document.getElementById('pat-input')?.value    || '').trim();
  const bgg = (document.getElementById('bgg-key-input')?.value || '').trim();
  S.pat    = pat;
  S.bggKey = bgg;
  pat ? localStorage.setItem(PAT_KEY,     pat) : localStorage.removeItem(PAT_KEY);
  bgg ? localStorage.setItem(BGG_KEY_KEY, bgg) : localStorage.removeItem(BGG_KEY_KEY);
  closeModal();
  renderApp();
  showToast('Settings saved.');
}
function clearSettings() {
  S.pat = ''; S.bggKey = '';
  localStorage.removeItem(PAT_KEY);
  localStorage.removeItem(BGG_KEY_KEY);
  closeModal();
  renderApp();
  showToast('Settings cleared. View-only mode.');
}

// Add Tag
function openAddTagModal() {
  openModal(`
    <h2>Add Tag</h2>
    <label>
      <span>Tag name</span>
      <input id="new-tag-input" type="text" placeholder="e.g. Solo, Abstract, Party…" maxlength="40" />
    </label>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn-primary" onclick="submitTag()">Add Tag</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `);
  setTimeout(() => document.getElementById('new-tag-input')?.focus(), 50);
}

// Confirm delete tag
function confirmDeleteTag(id) {
  const tag = getTag(id);
  if (!tag) return;
  const usedBy = S.data.games.filter(g => g.tags.includes(id)).length;
  openModal(`
    <h2>Delete Tag?</h2>
    <p class="modal-hint">
      Remove <strong>${esc(tag.name)}</strong>?
      ${usedBy > 0
        ? `It will be removed from <strong>${usedBy} game${usedBy !== 1 ? 's' : ''}</strong>.`
        : 'It is not assigned to any games.'}
    </p>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn-danger" onclick="deleteTag('${esc(id)}')">Delete</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

// Add Game
function openAddModal() {
  openModal(`
    <h2>Add Game</h2>
    ${gameForm(null)}
    <div class="modal-actions">
      <button class="btn-primary" onclick="submitGame(null)">Add Game</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `);
  wireBggSearch();
}

// Edit Game
function openEditModal(id) {
  const game = S.data.games.find(g => g.id === id);
  if (!game) return;
  openModal(`
    <h2>Edit Game</h2>
    ${gameForm(game)}
    <div class="modal-actions">
      <button class="btn-primary" onclick="submitGame('${esc(id)}')">Save Changes</button>
      <button class="btn-danger" onclick="confirmDeleteGame('${esc(id)}')">Delete</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `);
  wireBggSearch();
}

// Confirm delete game
function confirmDeleteGame(id) {
  const game = S.data.games.find(g => g.id === id);
  if (!game) return;
  openModal(`
    <h2>Remove from Collection?</h2>
    <p class="modal-hint">Remove <strong>${esc(game.name)}</strong>? This cannot be undone.</p>
    <div class="modal-actions" style="margin-top:20px">
      <button class="btn-danger" onclick="deleteGame('${esc(id)}')">Remove</button>
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

// Shared game form HTML
function gameForm(game) {
  const v = (field, fallback = '') => esc(game?.[field] ?? fallback);
  const hasBgg = !!S.bggKey;

  const tagChecks = S.data.tags.map(tag => {
    const checked = (game?.tags || []).includes(tag.id) ? 'checked' : '';
    return `
      <label class="tag-check">
        <input type="checkbox" name="tags" value="${esc(tag.id)}" ${checked} />
        ${esc(tag.name)}
      </label>`;
  }).join('');

  const thumbUrl = game?.thumbnail_url || '';

  return `
    ${hasBgg ? `
    <div class="bgg-search-wrap">
      <label>
        <span>Search BoardGameGeek</span>
        <input id="bgg-q" type="text" placeholder="Start typing a game name…" autocomplete="off" />
      </label>
      <div id="bgg-results"></div>
    </div>
    <div class="form-divider"></div>
    ` : ''}

    <div class="thumb-and-form">
      <div id="thumb-preview" class="${thumbUrl ? 'has-image' : ''}">
        ${thumbUrl ? `<img src="${esc(thumbUrl)}" alt="cover" />` : ''}
      </div>

      <div class="form-grid">
        <label class="full">
          <span>Name *</span>
          <input id="f-name" type="text" value="${v('name')}" placeholder="Game name" />
        </label>
        <label>
          <span>Year</span>
          <input id="f-year" type="number" value="${v('year')}" placeholder="2024" min="1900" max="2100" />
        </label>
        <label>
          <span>Weight (1–5)</span>
          <input id="f-weight" type="number" value="${v('weight')}" placeholder="2.5" min="1" max="5" step="0.1" />
        </label>
        <label>
          <span>Min Players</span>
          <input id="f-minp" type="number" value="${v('minPlayers')}" placeholder="1" min="1" max="20" />
        </label>
        <label>
          <span>Max Players</span>
          <input id="f-maxp" type="number" value="${v('maxPlayers')}" placeholder="4" min="1" max="20" />
        </label>
        <label>
          <span>Min Playtime (min)</span>
          <input id="f-mint" type="number" value="${v('minPlaytime')}" placeholder="30" min="1" />
        </label>
        <label>
          <span>Max Playtime (min)</span>
          <input id="f-maxt" type="number" value="${v('maxPlaytime')}" placeholder="90" min="1" />
        </label>
      </div>
    </div>

    <!-- Hidden BGG fields -->
    <input type="hidden" id="f-bgg-id"    value="${v('bgg_id')}" />
    <input type="hidden" id="f-thumbnail" value="${esc(thumbUrl)}" />

    <div class="form-tags">
      <span>Tags</span>
      <div class="tag-checks">${tagChecks || '<span style="color:var(--text-dim);font-size:13px">No tags yet — add some from the filter bar.</span>'}</div>
    </div>
  `;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function submitGame(existingId) {
  const name = document.getElementById('f-name')?.value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }

  const tags = [...document.querySelectorAll('input[name="tags"]:checked')].map(el => el.value);
  const gameData = {
    id:            existingId || genId(),
    name,
    bgg_id:        document.getElementById('f-bgg-id')?.value    || null,
    thumbnail_url: document.getElementById('f-thumbnail')?.value || null,
    year:          parseInt(document.getElementById('f-year')?.value)     || null,
    weight:        parseFloat(document.getElementById('f-weight')?.value) || null,
    minPlayers:    parseInt(document.getElementById('f-minp')?.value)     || null,
    maxPlayers:    parseInt(document.getElementById('f-maxp')?.value)     || null,
    minPlaytime:   parseInt(document.getElementById('f-mint')?.value)     || null,
    maxPlaytime:   parseInt(document.getElementById('f-maxt')?.value)     || null,
    tags,
  };

  if (existingId) {
    const idx = S.data.games.findIndex(g => g.id === existingId);
    if (idx !== -1) S.data.games[idx] = gameData;
  } else {
    S.data.games.push(gameData);
  }
  S.data.games.sort((a, b) => a.name.localeCompare(b.name));

  closeModal();
  renderGamesArea();
  const ok = await saveData();
  if (ok) showToast(existingId ? 'Game updated!' : `${name} added!`);
}

async function deleteGame(id) {
  const name = S.data.games.find(g => g.id === id)?.name || 'Game';
  S.data.games = S.data.games.filter(g => g.id !== id);
  closeModal();
  renderGamesArea();
  const ok = await saveData();
  if (ok) showToast(`${name} removed.`);
}

async function submitTag() {
  const name = document.getElementById('new-tag-input')?.value.trim();
  if (!name) return;
  if (S.data.tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
    showToast('That tag already exists', 'error'); return;
  }
  S.data.tags.push({ id: genId(), name });
  S.data.tags.sort((a, b) => a.name.localeCompare(b.name));
  closeModal();
  renderFilterBar();
  const ok = await saveData();
  if (ok) showToast(`Tag "${name}" added!`);
}

async function deleteTag(id) {
  const tag = getTag(id);
  S.activeTags.delete(id);
  S.data.tags  = S.data.tags.filter(t => t.id !== id);
  S.data.games = S.data.games.map(g => ({ ...g, tags: g.tags.filter(tid => tid !== id) }));
  closeModal();
  renderFilterBar();
  renderGamesArea();
  const ok = await saveData();
  if (ok && tag) showToast(`Tag "${tag.name}" deleted.`);
}

function toggleTag(id) {
  S.activeTags.has(id) ? S.activeTags.delete(id) : S.activeTags.add(id);
  renderFilterBar();
  renderGamesArea();
}
function clearFilters() {
  S.activeTags.clear();
  renderFilterBar();
  renderGamesArea();
}
function setView(view) {
  S.view = view;
  localStorage.setItem(VIEW_KEY, view);
  renderFilterBar();
  renderGamesArea();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if (e.key !== 'Enter') return;
    if (!document.getElementById('modal-overlay').classList.contains('open')) return;
    if (document.activeElement?.id === 'new-tag-input') submitTag();
    if (document.activeElement?.id === 'pat-input')     saveSettings();
    if (document.activeElement?.id === 'bgg-key-input') saveSettings();
  });
  loadData();
});
