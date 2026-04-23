const grid = document.querySelector('#grid');
const statusText = document.querySelector('#statusText');
const sonarrText = document.querySelector('#sonarrText');
const sonarrSpinner = document.querySelector('#sonarrSpinner');
const loadMoreBtn = document.querySelector('#loadMoreBtn');
const refreshBtn = document.querySelector('#refreshBtn');
const quickSeasonButtons = document.querySelectorAll('[data-season-mode]:not([data-season-mode="more"])');
const moreToggleBtn = document.querySelector('#moreToggleBtn');
const advancedPanel = document.querySelector('#advancedPanel');
const seasonSelect = document.querySelector('#seasonSelect');
const yearInput = document.querySelector('#yearInput');
const searchInput = document.querySelector('#searchInput');
const sortChips = document.querySelector('#sortChips');
const cardTemplate = document.querySelector('#cardTemplate');
const listView = document.querySelector('#listView');
const detailView = document.querySelector('#detailView');
const backBtn = document.querySelector('#backBtn');
const detailExternalLink = document.querySelector('#detailExternalLink');
const detailBannerImage = document.querySelector('#detailBannerImage');
const detailPoster = document.querySelector('#detailPoster');
const detailTitle = document.querySelector('#detailTitle');
const detailMeta = document.querySelector('#detailMeta');
const detailAiring = document.querySelector('#detailAiring');
const detailSonarrState = document.querySelector('#detailSonarrState');
const detailDescription = document.querySelector('#detailDescription');
const detailChips = document.querySelector('#detailChips');
const detailStats = document.querySelector('#detailStats');
const detailAddBtn = document.querySelector('#detailAddBtn');
const detailResult = document.querySelector('#detailResult');
const sonarrInfoBtn = document.querySelector('#sonarrInfoBtn');
const sonarrLogDialog = document.querySelector('#sonarrLogDialog');
const sonarrLogContent = document.querySelector('#sonarrLogContent');
const sonarrLogClose = document.querySelector('#sonarrLogClose');
const typeSelect = document.querySelector('#typeSelect');
const sonarrInBtn = document.querySelector('#sonarrInBtn');
const sonarrOutBtn = document.querySelector('#sonarrOutBtn');

let page = 1;
let hasNextPage = true;
let loadingAnime = false;
let items = [];
let activeSort = 'TRENDING_DESC';
let meta = null;
let currentFilters = {
  ...getCurrentSeason(),
  type: 'ALL',
  sonarrState: 'ALL',
};
let sonarrStatusMap = new Map();
let radarrStatusMap = new Map();
let addingIds = new Set();
let sonarrLibrary = null;
let sonarrLibraryPromise = null;
let sonarrLibraryLoading = false;
let sonarrLibraryError = null;
let radarrLibrary = null;
let radarrLibraryPromise = null;
let radarrLibraryLoading = false;
let radarrLibraryError = null;
let loadMoreObserver = null;
let currentDetailAnime = null;
let currentDetailId = null;
let detailFetchToken = 0;
let searchTimer = null;
let sonarrDebugLog = [];
let AUTO_PREFETCH_MAX_PAGES = 4;
let autoLoadTimer = null;

const seasonLabel = (season) => ({ SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall', WINTER: 'Winter' }[season] || season);
const seasonOrder = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

function pushSonarrLog(entry) {
  const item = {
    time: new Date().toISOString(),
    ...entry,
  };
  sonarrDebugLog.unshift(item);
  sonarrDebugLog = sonarrDebugLog.slice(0, 50);

  if (sonarrLogContent) {
    sonarrLogContent.innerHTML = sonarrDebugLog.map((log) => {
      const payload = log.payload ? `<pre>${JSON.stringify(log.payload, null, 2)}</pre>` : '';
      return `<div class="sonarr-log-entry">
        <div class="sonarr-log-time">${log.time}</div>
        <div class="sonarr-log-message">${log.message}</div>
        ${payload}
      </div>`;
    }).join('');
  }
}

async function readApiResponse(response) {
  const raw = await response.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }
  }
  return { ok: response.ok, status: response.status, data };
}

function getCurrentSeason(date = new Date()) {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  if (month >= 3 && month <= 5) return { season: 'SPRING', seasonYear: year };
  if (month >= 6 && month <= 8) return { season: 'SUMMER', seasonYear: year };
  if (month >= 9 && month <= 11) return { season: 'FALL', seasonYear: year };
  return { season: 'WINTER', seasonYear: month === 12 ? year + 1 : year };
}

function shiftSeason(base, delta) {
  const index = seasonOrder.indexOf(base.season);
  const absolute = base.seasonYear * 4 + index + delta;
  const seasonIndex = ((absolute % 4) + 4) % 4;
  const seasonYear = Math.floor(absolute / 4);
  return { season: seasonOrder[seasonIndex], seasonYear };
}

function titleFor(item) {
  return item?.title?.english || item?.title?.romaji || item?.title?.native || 'Untitled';
}

function scoreFor(item) {
  return item?.averageScore || item?.meanScore || '—';
}

function formatCountdown(minutes) {
  const mins = Math.max(0, Math.round(Number(minutes) || 0));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function airingLabel(item) {
  if (item?.status === 'RELEASING' && item?.nextAiringEpisode) {
    const hours = Math.max(0, Math.round(Number(item.nextAiringEpisode.timeUntilAiring || 0) / 3600));
    return `Ep ${item.nextAiringEpisode.episode} in ${hours}h`;
  }
  if (item?.status === 'FINISHED') return 'Finished';
  if (item?.status === 'NOT_YET_RELEASED') return 'Upcoming';
  return item?.status || 'Unknown';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizePath(value) {
  return normalizeText(String(value || '').replace(/[\/]/g, ' '));
}

function stripAnimeSuffixes(value) {
  let text = normalizeText(value);
  if (!text) return '';

  const suffixPatterns = [
    /\b(?:the\s+)?final\s+season\b$/,
    /\b(?:the\s+)?final\s+chapters?\b$/,
    /\b(?:the\s+)?final\s+chapter\b$/,
    /\b(?:final)\b$/,
    /\b(?:season|part|cour|chapter|arc)\s+(?:[0-9]+|[ivxlcdm]+)\b$/,
    /\b(?:[0-9]+(?:st|nd|rd|th)?|[ivxlcdm]+)\s+(?:season|part|cour|chapter|arc)\b$/,
    /\b(?:season|part|cour|chapter|arc)\b$/,
    /\b(?:[0-9]+(?:st|nd|rd|th)?|[ivxlcdm]+)\b$/,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of suffixPatterns) {
      const next = text.replace(pattern, '').trim();
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
  }

  return text;
}

function chipify(items, container) {
  if (!container) return;
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  container.innerHTML = '';

  const maxVisible = container.classList.contains('mini') ? 2 : list.length;
  const visible = list.slice(0, maxVisible);
  const hiddenCount = list.length - visible.length;

  for (const item of visible) {
    const chip = document.createElement('span');
    chip.className = 'chip-item';
    chip.textContent = item;
    container.appendChild(chip);
  }

  if (hiddenCount > 0) {
    const chip = document.createElement('span');
    chip.className = 'chip-item';
    chip.textContent = `+${hiddenCount}`;
    container.appendChild(chip);
  }
}

function searchHaystack(item) {
  return [
    titleFor(item),
    item?.title?.english,
    item?.title?.romaji,
    item?.title?.native,
    ...(Array.isArray(item?.synonyms) ? item.synonyms : []),
    ...(Array.isArray(item?.genres) ? item.genres : []),
    ...((Array.isArray(item?.tags) ? item.tags : []).map((tag) => tag?.name).filter(Boolean)),
    item?.description,
    item?.source,
  ]
    .filter(Boolean)
    .map(normalizeText)
    .join(' | ');
}

function matchesSearchQuery(item, query) {
  const q = normalizeText(query);
  if (!q) return true;
  const haystack = searchHaystack(item);
  return q.split(' ').every((token) => haystack.includes(token));
}

function matchesFilters(item) {
  if (!matchesSearchQuery(item, searchInput.value.trim())) return false;

  if (currentFilters.type && currentFilters.type !== 'ALL' && item.format !== currentFilters.type) {
    return false;
  }

  const statusMap = item?.format === 'MOVIE' ? radarrStatusMap : sonarrStatusMap;
  const inLibrary = Boolean(item.sonarrAdded || item.radarrAdded || statusMap.get(item.id)?.inLibrary);

  if (currentFilters.sonarrState === 'IN' && !inLibrary) return false;
  if (currentFilters.sonarrState === 'OUT' && inLibrary) return false;

  return true;
}

function getVisibleItems() {
  return items.filter(matchesFilters);
}

async function ensureMorePagesLoaded(maxPages = AUTO_PREFETCH_MAX_PAGES) {
  let attempts = 0;

  while (attempts < maxPages && hasNextPage) {
    await new Promise(requestAnimationFrame);

    if (loadingAnime) return;

    const top = loadMoreBtn?.getBoundingClientRect().top ?? Infinity;
    if (top >= window.innerHeight + 250) return;

    attempts += 1;
    await fetchAnime(false);
  }
}

function scheduleAutoLoadMore() {
  clearTimeout(autoLoadTimer);
  autoLoadTimer = setTimeout(() => {
    void ensureMorePagesLoaded();
  }, 0);
}

async function refreshAnime(reset = true) {
  await fetchAnime(reset);
  await ensureMorePagesLoaded();
}

async function ensureVisibleItems(maxPages = AUTO_PREFETCH_MAX_PAGES) {
  let attempts = 0;

  while (
    attempts < maxPages &&
    !loadingAnime &&
    hasNextPage &&
    getVisibleItems().length === 0
  ) {
    attempts += 1;
    await fetchAnime(false);
  }
}

function animeTitleVariants(anime) {
  const titles = [
    anime?.title?.english,
    anime?.title?.romaji,
    anime?.title?.native,
    ...(Array.isArray(anime?.synonyms) ? anime.synonyms : []),
  ];
  const keys = new Set();

  for (const value of titles) {
    const full = normalizeText(value);
    const base = stripAnimeSuffixes(value);
    if (full) keys.add(full);
    if (base) keys.add(base);
  }

  return [...keys];
}

function managerForItem(item) {
  return item?.format === 'MOVIE' ? 'radarr' : 'sonarr';
}

function managerLabelForItem(item) {
  return managerForItem(item) === 'radarr' ? 'Radarr' : 'Sonarr';
}

function statusMapForItem(item) {
  return managerForItem(item) === 'radarr' ? radarrStatusMap : sonarrStatusMap;
}

function libraryForItem(item) {
  return managerForItem(item) === 'radarr' ? radarrLibrary : sonarrLibrary;
}

function libraryLoadingForItem(item) {
  return managerForItem(item) === 'radarr' ? radarrLibraryLoading : sonarrLibraryLoading;
}

function libraryConfiguredForItem(item) {
  return managerForItem(item) === 'radarr' ? meta?.radarrConfigured : meta?.sonarrConfigured;
}

function normalizeFranchiseTitle(value = '') {
  return normalizeText(String(value))
    .replace(/\b(1st|2nd|3rd|4th|\d+(st|nd|rd|th))\s+stage\b/gi, '')
    .replace(/\bseason\s*\d+\b/gi, '')
    .replace(/\bpart\s*\d+\b/gi, '')
    .replace(/\s*[:\-–—]\s*.*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSonarrFamilyTitles(anime) {
  const titles = new Set(animeTitleVariants(anime));

  const relations = anime?.relations?.edges || [];
  for (const edge of relations) {
    const relationType = String(edge?.relationType || '').toUpperCase();
    if (!['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'ADAPTATION'].includes(relationType)) continue;

    const node = edge?.node;
    if (!node) continue;

    const relatedTitles = [
      node?.title?.romaji,
      node?.title?.english,
      node?.title?.native,
    ].filter(Boolean);

    for (const title of relatedTitles) {
      titles.add(normalizeText(title));
      titles.add(normalizeFranchiseTitle(title));
    }
  }

  return [...titles].filter(Boolean);
}

function buildSonarrIndex(seriesList) {
  const index = {
    byTvdbId: new Map(),
    byTitle: new Map(),
    byBaseTitle: new Map(),
    bySortTitle: new Map(),
    byBaseSortTitle: new Map(),
    bySlug: new Map(),
    byBaseSlug: new Map(),
    byAltTitle: new Map(),
    byBaseAltTitle: new Map(),
    count: Array.isArray(seriesList) ? seriesList.length : 0,
  };

  for (const series of Array.isArray(seriesList) ? seriesList : []) {
    if (series?.tvdbId != null) index.byTvdbId.set(String(series.tvdbId), series);
    const titleKey = normalizeText(series?.title);
    if (titleKey) index.byTitle.set(titleKey, series);
    const baseTitle = stripAnimeSuffixes(series?.title);
    if (baseTitle) index.byBaseTitle.set(baseTitle, series);
    const sortTitleKey = normalizeText(series?.sortTitle);
    if (sortTitleKey) index.bySortTitle.set(sortTitleKey, series);
    const baseSortTitle = stripAnimeSuffixes(series?.sortTitle);
    if (baseSortTitle) index.byBaseSortTitle.set(baseSortTitle, series);
    const slugKey = normalizePath(series?.titleSlug);
    if (slugKey) index.bySlug.set(slugKey, series);
    const baseSlug = stripAnimeSuffixes(series?.titleSlug);
    if (baseSlug) index.byBaseSlug.set(baseSlug, series);

    const alternateTitles = Array.isArray(series?.alternateTitles) ? series.alternateTitles : [];
    for (const alt of alternateTitles) {
      const altTitle = typeof alt === 'string' ? alt : alt?.title;
      const altKey = normalizeText(altTitle);
      const altBaseKey = stripAnimeSuffixes(altTitle);
      if (altKey && !index.byAltTitle.has(altKey)) index.byAltTitle.set(altKey, series);
      if (altBaseKey && !index.byBaseAltTitle.has(altBaseKey)) index.byBaseAltTitle.set(altBaseKey, series);
    }
  }

  return index;
}

function getSonarrMatch(item) {
  if (!sonarrLibrary) return null;

  const animeTvdbId = item?.tvdbId != null ? String(item.tvdbId) : null;
  if (animeTvdbId && sonarrLibrary.index.byTvdbId.has(animeTvdbId)) {
    return sonarrLibrary.index.byTvdbId.get(animeTvdbId);
  }

  const exactVariants = animeTitleVariants(item);
  for (const variant of exactVariants) {
    const candidate =
      sonarrLibrary.index.byTitle.get(variant) ||
      sonarrLibrary.index.bySortTitle.get(variant) ||
      sonarrLibrary.index.bySlug.get(variant) ||
      sonarrLibrary.index.byBaseTitle.get(variant) ||
      sonarrLibrary.index.byBaseSortTitle.get(variant) ||
      sonarrLibrary.index.byBaseSlug.get(variant) ||
      sonarrLibrary.index.byAltTitle.get(variant) ||
      sonarrLibrary.index.byBaseAltTitle.get(variant);
    if (candidate) return candidate;
  }

  const familyTitles = getSonarrFamilyTitles(item);
  if (!familyTitles.length) return null;

  for (const series of sonarrLibrary.series || []) {
    const seriesTitles = [
      series?.title,
      series?.sortTitle,
      series?.titleSlug,
      ...(Array.isArray(series?.alternateTitles)
        ? series.alternateTitles.map((alt) => (typeof alt === 'string' ? alt : alt?.title)).filter(Boolean)
        : []),
    ]
      .map((title) => normalizeFranchiseTitle(title))
      .filter(Boolean);

    if (familyTitles.some((familyTitle) => seriesTitles.includes(normalizeFranchiseTitle(familyTitle)))) {
      return series;
    }
  }

  return null;
}

function getRadarrMatch(item) {
  if (!radarrLibrary) return null;

  const movieTvdbId = item?.tvdbId != null ? String(item.tvdbId) : null;
  if (movieTvdbId && radarrLibrary.index.byTvdbId.has(movieTvdbId)) {
    return radarrLibrary.index.byTvdbId.get(movieTvdbId);
  }

  const variants = animeTitleVariants(item);
  for (const variant of variants) {
    const candidate =
      radarrLibrary.index.byTitle.get(variant) ||
      radarrLibrary.index.bySortTitle.get(variant) ||
      radarrLibrary.index.bySlug.get(variant) ||
      radarrLibrary.index.byBaseTitle.get(variant) ||
      radarrLibrary.index.byBaseSortTitle.get(variant) ||
      radarrLibrary.index.byBaseSlug.get(variant) ||
      radarrLibrary.index.byAltTitle.get(variant) ||
      radarrLibrary.index.byBaseAltTitle.get(variant);
    if (candidate) return candidate;
  }

  return null;
}

function cleanHtml(text) {
  if (!text) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = String(text).replace(/<br\s*\/?>(\n)?/gi, '\n');
  return (tmp.textContent || tmp.innerText || '').trim();
}

function updateStatusLine() {
  if (sonarrLibraryLoading) {
    sonarrSpinner.hidden = false;
    sonarrText.textContent = 'Loading sonarr...';
    return;
  }

  if (radarrLibraryLoading) {
    sonarrSpinner.hidden = false;
    sonarrText.textContent = 'Loading radarr...';
    return;
  }

  sonarrSpinner.hidden = true;

  const sonarrReady = Boolean(meta?.sonarrConfigured);
  const radarrReady = Boolean(meta?.radarrConfigured);

  if (!sonarrReady && !radarrReady) {
    sonarrText.textContent = 'No libraries configured';
    return;
  }

  if (sonarrLibraryError || radarrLibraryError) {
    sonarrText.textContent = `Library sync failed: ${sonarrLibraryError || radarrLibraryError}`;
    return;
  }

  if (sonarrReady && radarrReady) {
    sonarrText.textContent = 'Synced Libraries';
    return;
  }

  if (sonarrReady) {
    sonarrText.textContent = 'Sonarr synced';
    return;
  }

  if (radarrReady) {
    sonarrText.textContent = 'Radarr synced';
    return;
  }
}

const sortLabels = {
  TRENDING_DESC: 'Trending',
  POPULARITY_DESC: 'Popular',
  SCORE_DESC: 'Top',
  START_DATE_DESC: 'Newest',
  TITLE_ROMAJI: 'Name',
};

function syncStatusText() {
  const sortLabel = sortLabels[activeSort] || activeSort;
  statusText.textContent = `${seasonLabel(currentFilters.season)} ${currentFilters.seasonYear} - ${sortLabel} - ${items.length} titles loaded`;
}

function syncSortButtons() {
  sortChips.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.sort === activeSort);
  });
}

async function setSort(nextSort) {
  if (activeSort === nextSort) return;
  activeSort = nextSort;
  syncSortButtons();
  syncStatusText();
  await refreshAnime(true);
}

function syncSonarrFilterButtons() {
  sonarrInBtn?.classList.toggle('active', currentFilters.sonarrState === 'IN');
  sonarrOutBtn?.classList.toggle('active', currentFilters.sonarrState === 'OUT');
}

async function setSonarrFilter(nextValue) {
  currentFilters.sonarrState = nextValue;
  syncSonarrFilterButtons();
  syncStatusText();
  await refreshAnime(true);
}

function updateQuickButtons() {
  const current = getCurrentSeason();
  const choices = {
    previous: shiftSeason(current, -1),
    current,
    next: shiftSeason(current, 1),
  };

  quickSeasonButtons.forEach((button) => {
    const mode = button.dataset.seasonMode;
    const choice = choices[mode];
    const isActive =
      choice?.season === currentFilters.season &&
      choice?.seasonYear === currentFilters.seasonYear;
    button.classList.toggle('active', isActive);
  });

  moreToggleBtn.classList.toggle('active', advancedPanel.hidden === false);
}

async function setFilters(nextFilters, { closeAdvanced = false } = {}) {
  currentFilters = { ...currentFilters, ...nextFilters };
  seasonSelect.value = currentFilters.season;
  yearInput.value = String(currentFilters.seasonYear);
  typeSelect.value = currentFilters.type || 'ALL';
  syncSonarrFilterButtons();

  if (closeAdvanced) {
    advancedPanel.hidden = true;
    moreToggleBtn.setAttribute('aria-expanded', 'false');
  }

  updateQuickButtons();
  syncStatusText();
  await refreshAnime(true);
}

function libraryStateForItem(item) {
  const manager = managerForItem(item);
  const label = manager === 'radarr' ? 'Radarr' : 'Sonarr';
  const statusMap = statusMapForItem(item);
  const loading = libraryLoadingForItem(item);
  const configured = libraryConfiguredForItem(item);

  if (addingIds.has(item.id)) return { state: 'adding', text: `Adding to ${label}...`, disabled: true, manager };
  const known = statusMap.get(item.id);
  if (item.sonarrAdded || item.radarrAdded || known?.inLibrary) return { state: 'added', text: `Already in ${label}`, disabled: true, manager };
  if (!configured) return { state: 'unconfigured', text: `${label} not set`, disabled: true, manager };
  if (loading && !statusMap.has(item.id)) return { state: 'checking', text: 'Checking...', disabled: true, manager };
  return { state: 'ready', text: `Add to ${label}`, disabled: false, manager };
}

function setButtonState(addBtn, resultEl, item) {
  const state = libraryStateForItem(item);
  addBtn.disabled = state.disabled;
  addBtn.classList.toggle('is-added', state.state === 'added');
  addBtn.classList.toggle('is-loading', state.state === 'checking' || state.state === 'adding');
  addBtn.classList.toggle('is-radarr', state.manager === 'radarr');
  addBtn.classList.toggle('is-sonarr', state.manager === 'sonarr');
  addBtn.textContent = state.text;
  resultEl.textContent = '';
}

function renderItems() {
  const visibleItems = getVisibleItems();
  grid.innerHTML = '';
  if (!visibleItems.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state card';
    empty.textContent = searchInput.value.trim() ? 'No titles match this search.' : 'No titles loaded yet.';
    grid.appendChild(empty);
    return;
  }

  for (const item of visibleItems) {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    const poster = node.querySelector('.poster');
    const title = node.querySelector('.title');
    const metaEl = node.querySelector('.meta');
    const summary = node.querySelector('.summary');
    const badge = node.querySelector('[data-field="airing"]');
    const genres = node.querySelector('[data-field="genres"]');
    const result = node.querySelector('.result');
    const addBtn = node.querySelector('.add-btn');
    const externalLink = node.querySelector('.external-link');

    poster.src = item.coverImage?.extraLarge || item.coverImage?.large || '';
    poster.alt = `${titleFor(item)} poster`;
    title.textContent = titleFor(item);
    metaEl.textContent = [item.format, item.episodes ? `${item.episodes} eps` : null, `Score ${scoreFor(item)}`, `Popularity ${item.popularity?.toLocaleString?.() ?? item.popularity}`]
      .filter(Boolean)
      .join(' • ');
    summary.textContent = item.status === 'RELEASING'
      ? 'currently airing'
      : item.status === 'NOT_YET_RELEASED'
        ? 'upcoming'
        : 'seasonal pick';
    badge.textContent = airingLabel(item);
    chipify(item.genres || [], genres);
    externalLink.href = item.siteUrl;

    setButtonState(addBtn, result, item);

    const openDetail = () => navigateToAnime(item.id);
    node.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input, select, textarea')) return;
      openDetail();
    });
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail();
      }
    });

    addBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (addBtn.disabled) return;

      const manager = managerForItem(item);
      const endpoint = manager === 'radarr' ? '/api/radarr/add' : '/api/sonarr/add';

      let addSucceeded = false;
      addingIds.add(item.id);
      renderVisibleView();

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anime: item, movie: item }),
        });

        const api = await readApiResponse(response);
        const data = api.data || {};

        if (!api.ok || !data.ok) {
          pushSonarrLog({
            message: `Add failed for ${titleFor(item)}`,
            payload: {
              status: api.status,
              response: data,
            },
          });
          result.textContent = data.message || data.error || `Error: ${managerLabelForItem(item)} add failed`;
          return;
        }

        addSucceeded = true;

        if (manager === 'radarr') item.radarrAdded = true;
        else item.sonarrAdded = true;

        const library = manager === 'radarr' ? radarrLibrary : sonarrLibrary;
        if (data.result?.id && library?.series) {
          const addedSeries = {
            id: data.result.id,
            title: data.result.title || titleFor(item),
            tvdbId: data.result.tvdbId ?? null,
            sortTitle: data.result.sortTitle ?? null,
            titleSlug: data.result.titleSlug ?? null,
            year: data.result.year ?? item.startDate?.year ?? null,
          };
          library.series = [addedSeries, ...library.series];
          library.index = buildSonarrIndex(library.series);
        }

        pushSonarrLog({
          message: `Added to ${managerLabelForItem(item)}: ${titleFor(item)}`,
          payload: {
            status: api.status,
            response: data,
          },
        });
        result.textContent = `Added to ${managerLabelForItem(item)}`;
      } catch (error) {
        pushSonarrLog({
          message: `Unexpected add error for ${titleFor(item)}`,
          payload: { error: String(error.message || error) },
        });
        result.textContent = `Error: ${error.message}`;
      } finally {
        addingIds.delete(item.id);
        if (addSucceeded) {
          await refreshLibraryStatuses();
        }
      }
    });

    grid.appendChild(node);
  }
}

function navigateToAnime(id) {
  location.hash = `#anime/${id}`;
}

function renderDetail(item, { loading = false } = {}) {
  currentDetailAnime = item || null;
  currentDetailId = item?.id || currentDetailId;

  const titleText = item ? titleFor(item) : 'Loading...';
  detailTitle.textContent = item ? titleText : 'Loading anime...';
  detailExternalLink.href = item?.siteUrl || '#';
  detailExternalLink.toggleAttribute('aria-disabled', !item);
  detailBannerImage.src = item?.bannerImage || item?.coverImage?.extraLarge || item?.coverImage?.large || '';
  detailBannerImage.alt = item ? `${titleText} banner` : 'Banner';
  detailPoster.src = item?.coverImage?.extraLarge || item?.coverImage?.large || '';
  detailPoster.alt = item ? `${titleText} poster` : 'Poster';
  detailMeta.textContent = item
    ? [item.format, item.episodes ? `${item.episodes} eps` : null, `Score ${scoreFor(item)}`, `Popularity ${item.popularity?.toLocaleString?.() ?? item.popularity}`]
      .filter(Boolean)
      .join(' • ')
    : loading
      ? 'Loading details...'
      : '';

  detailAiring.textContent = item ? airingLabel(item) : '';
  const sonarrState = item ? libraryStateForItem(item) : { state: 'checking', text: 'Checking...', disabled: true };
  detailSonarrState.textContent = item
    ? (sonarrState.state === 'added'
      ? `Already in ${managerLabelForItem(item)}`
      : `Ready to add to ${managerLabelForItem(item)}`)
    : 'Sonarr not configured';

  const description = cleanHtml(item?.description || '');
  detailDescription.textContent = description || (loading ? 'Loading details...' : 'No description available.');

  const tagData = [
    ...(item?.genres || []),
    ...((item?.tags || []).slice(0, 6).map((tag) => tag.name)),
  ];
  chipify(tagData, detailChips);

  const studios = item?.studios?.nodes?.map((studio) => studio?.name).filter(Boolean).join(', ') || '—';
  const seasonText = item?.season ? `${seasonLabel(item.season)} ${item.seasonYear || ''}`.trim() : '—';
  const sourceText = item?.source || '—';
  const statusTextValue = item?.status || '—';
  const nextAiring = item?.nextAiringEpisode
    ? `Episode ${item.nextAiringEpisode.episode} in ${formatCountdown(Math.max(0, Math.ceil(item.nextAiringEpisode.timeUntilAiring / 60)))}`
    : '—';

  detailStats.innerHTML = '';
  const rows = [
    ['Season', seasonText],
    ['Source', sourceText],
    ['Status', statusTextValue],
    ['Studios', studios],
    ['Next airing', nextAiring],
    ['AniList ID', item?.id ?? '—'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'detail-stat-row';
    const left = document.createElement('div');
    left.textContent = label;
    const right = document.createElement('div');
    right.textContent = value;
    row.append(left, right);
    detailStats.appendChild(row);
  }

  const state = item ? libraryStateForItem(item) : null;
  detailAddBtn.disabled = loading || !item || state?.disabled;
  detailAddBtn.classList.toggle('is-added', state?.state === 'added');
  detailAddBtn.classList.toggle('is-loading', state?.state === 'checking' || state?.state === 'adding' || loading);
  detailAddBtn.classList.toggle('is-radarr', state?.manager === 'radarr');
  detailAddBtn.classList.toggle('is-sonarr', state?.manager === 'sonarr');
  detailAddBtn.textContent = state?.text || 'Add';
  detailResult.textContent = '';
}

function renderVisibleView() {
  if (isDetailRoute()) {
    renderDetail(currentDetailAnime || items.find((item) => String(item.id) === String(currentDetailId)) || null, { loading: !currentDetailAnime });
  } else {
    renderItems();
  }
}

function recomputeLibraryStatuses() {
  const nextSonarrMap = new Map();
  const nextRadarrMap = new Map();

  for (const item of items) {
    const sonarrMatch = sonarrLibrary ? getSonarrMatch(item) : null;
    const radarrMatch = radarrLibrary ? getRadarrMatch(item) : null;

    nextSonarrMap.set(item.id, {
      inLibrary: Boolean(sonarrMatch),
      matchedTitle: sonarrMatch?.title || null,
      libraryId: sonarrMatch?.id ?? null,
      tvdbId: sonarrMatch?.tvdbId ?? null,
    });

    nextRadarrMap.set(item.id, {
      inLibrary: Boolean(radarrMatch),
      matchedTitle: radarrMatch?.title || null,
      libraryId: radarrMatch?.id ?? null,
      tvdbId: radarrMatch?.tvdbId ?? null,
    });
  }

  sonarrStatusMap = nextSonarrMap;
  radarrStatusMap = nextRadarrMap;
  renderVisibleView();
}

async function refreshLibraryStatuses() {
  recomputeLibraryStatuses();
}

async function loadMeta() {
  const response = await fetch('/api/meta');
  meta = await response.json();
  AUTO_PREFETCH_MAX_PAGES = Number(meta?.autoloadPages || 4);

  const baseSeason = getCurrentSeason();
  const defaultSeasonMode = meta?.defaultSeason || 'current';

  const initialSeason =
    defaultSeasonMode === 'previous' ? shiftSeason(baseSeason, -1)
      : defaultSeasonMode === 'next' ? shiftSeason(baseSeason, 1)
        : baseSeason;

  currentFilters = {
    season: initialSeason.season,
    seasonYear: Number(initialSeason.seasonYear),
    type: meta?.defaultType || 'ALL',
    sonarrState: meta?.alreadyInLib || 'ALL',
  };

  activeSort = meta?.defaultSort || 'TRENDING_DESC';

  seasonSelect.value = currentFilters.season;
  yearInput.value = String(currentFilters.seasonYear);
  typeSelect.value = currentFilters.type || 'ALL';
  syncSonarrFilterButtons();
  syncSortButtons();
  updateQuickButtons();
  syncStatusText();
}

async function loadSonarrLibrary() {
  if (!meta?.sonarrConfigured) {
    sonarrLibraryLoading = false;
    updateStatusLine();
    return null;
  }

  if (sonarrLibraryPromise) return sonarrLibraryPromise;

  sonarrLibraryLoading = true;
  sonarrLibraryError = null;
  updateStatusLine();

  sonarrLibraryPromise = fetch('/api/sonarr/library')
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Failed to load Sonarr library');
      const series = Array.isArray(data.series) ? data.series : [];
      sonarrLibrary = {
        series,
        fetchedAt: data.fetchedAt || Date.now(),
        index: buildSonarrIndex(series),
      };
      return sonarrLibrary;
    })
    .catch((error) => {
      sonarrLibraryError = error.message;
      sonarrLibrary = null;
      throw error;
    })
    .finally(() => {
      sonarrLibraryLoading = false;
      sonarrLibraryPromise = null;
      recomputeLibraryStatuses();
      updateStatusLine();
    });

  return sonarrLibraryPromise;
}

async function loadRadarrLibrary() {
  if (!meta?.radarrConfigured) {
    radarrLibraryLoading = false;
    updateStatusLine();
    return null;
  }

  if (radarrLibraryPromise) return radarrLibraryPromise;

  radarrLibraryLoading = true;
  radarrLibraryError = null;
  updateStatusLine();

  radarrLibraryPromise = fetch('/api/radarr/library')
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Failed to load Radarr library');
      const series = Array.isArray(data.series) ? data.series : [];
      radarrLibrary = {
        series,
        fetchedAt: data.fetchedAt || Date.now(),
        index: buildSonarrIndex(series),
      };
      return radarrLibrary;
    })
    .catch((error) => {
      radarrLibraryError = error.message;
      radarrLibrary = null;
      throw error;
    })
    .finally(() => {
      radarrLibraryLoading = false;
      radarrLibraryPromise = null;
      recomputeLibraryStatuses();
      updateStatusLine();
    });

  return radarrLibraryPromise;
}

async function fetchAnime(reset = false) {
  if (loadingAnime) return;
  loadingAnime = true;
  statusText.textContent = reset ? 'Loading season...' : 'Loading more...';

  try {
    if (reset) {
      page = 1;
      hasNextPage = true;
      items = [];
      sonarrStatusMap = new Map();
      addingIds = new Set();
    }

    const fallback = getCurrentSeason();
    const season = currentFilters.season || fallback.season;
    const seasonYear = Number(currentFilters.seasonYear || fallback.seasonYear);

    const params = new URLSearchParams({
      page: String(page),
      perPage: '20',
      sort: activeSort,
      season,
      seasonYear: String(seasonYear),
    });
    const response = await fetch(`/api/anime?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load anime');

    const nextItems = (data.media || []).map((item) => ({ ...item, sonarrAdded: false }));
    const merged = reset ? nextItems : items.concat(nextItems);
    const deduped = new Map();
    for (const item of merged) {
      if (!deduped.has(item.id)) deduped.set(item.id, item);
    }
    items = [...deduped.values()];

    hasNextPage = Boolean(data.pageInfo?.hasNextPage);
    page += 1;
    renderVisibleView();
    syncStatusText();
    loadMoreBtn.disabled = !hasNextPage;
    loadMoreBtn.textContent = hasNextPage ? 'Load more' : 'No more results';

    if (sonarrLibrary) {
      recomputeLibraryStatuses();
    } else if (meta?.sonarrConfigured && !sonarrLibraryPromise) {
      void loadSonarrLibrary();
    } else {
      updateStatusLine();
    }
  } catch (error) {
    statusText.textContent = `Error: ${error.message}`;
    renderVisibleView();
  } finally {
    loadingAnime = false;
    scheduleAutoLoadMore();
  }
}

function isDetailRoute() {
  return /^#anime\/\d+$/.test(location.hash || '');
}

async function openAnimeDetail(id, { pushState = true } = {}) {
  currentDetailId = Number(id);
  if (pushState) {
    location.hash = `#anime/${id}`;
    return;
  }

  listView.hidden = true;
  detailView.hidden = false;

  const cached = items.find((item) => String(item.id) === String(id));
  if (cached) {
    renderDetail(cached, { loading: true });
  } else {
    renderDetail(null, { loading: true });
  }

  const token = ++detailFetchToken;
  try {
    const response = await fetch(`/api/anime/${id}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Failed to load anime details');
    const media = data.media || null;
    if (token !== detailFetchToken) return;
    currentDetailAnime = {
      ...(cached || {}),
      ...(media || {}),
      id: media?.id ?? cached?.id ?? Number(id),
    };
    renderDetail(currentDetailAnime, { loading: false });
  } catch (error) {
    if (token !== detailFetchToken) return;
    renderDetail(cached || null, { loading: false });
    detailResult.textContent = `Error: ${error.message}`;
  }
}

function showListView() {
  detailFetchToken += 1;
  listView.hidden = false;
  detailView.hidden = true;
  currentDetailAnime = null;
  currentDetailId = null;
  renderVisibleView();
}

function handleRoute() {
  if (isDetailRoute()) {
    void openAnimeDetail(Number(location.hash.split('/')[1]), { pushState: false });
  } else {
    showListView();
  }
}

quickSeasonButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.seasonMode;
    const current = getCurrentSeason();
    const nextFilters =
      mode === 'previous' ? shiftSeason(current, -1)
        : mode === 'next' ? shiftSeason(current, 1)
          : current;
    setFilters(nextFilters, { closeAdvanced: false });
  });
});

moreToggleBtn.addEventListener('click', () => {
  advancedPanel.hidden = !advancedPanel.hidden;
  moreToggleBtn.setAttribute('aria-expanded', String(!advancedPanel.hidden));
  updateQuickButtons();
});

sortChips.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-sort]');
  if (!button) return;
  void setSort(button.dataset.sort);
});

loadMoreBtn.addEventListener('click', () => {
  void refreshAnime(false);
});

refreshBtn.addEventListener('click', async () => {
  if (meta?.sonarrConfigured) {
    await loadSonarrLibrary().catch(() => null);
  }
  if (meta?.radarrConfigured) {
    await loadRadarrLibrary().catch(() => null);
  }
  await refreshAnime(true);
});

backBtn.addEventListener('click', () => {
  if (location.hash) location.hash = '';
  else showListView();
});

detailAddBtn.addEventListener('click', async () => {
  const item = currentDetailAnime;
  if (!item || detailAddBtn.disabled) return;

  const manager = managerForItem(item);
  const endpoint = manager === 'radarr' ? '/api/radarr/add' : '/api/sonarr/add';

  let addSucceeded = false;
  addingIds.add(item.id);
  detailResult.textContent = `Checking ${managerLabelForItem(item)} match...`;
  pushSonarrLog({
    message: `Add request started for ${titleFor(item)}`,
    payload: { animeId: item.id, title: titleFor(item), manager },
  });
  renderDetail(item, { loading: false });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anime: item, movie: item }),
    });

    const api = await readApiResponse(response);
    const data = api.data || {};

    if (!api.ok || !data.ok) {
      pushSonarrLog({
        message: `Add failed for ${titleFor(item)}`,
        payload: {
          status: api.status,
          response: data,
        },
      });
      detailResult.textContent = data.message || data.error || `Error: ${managerLabelForItem(item)} add failed`;
      return;
    }

    addSucceeded = true;

    if (manager === 'radarr') item.radarrAdded = true;
    else item.sonarrAdded = true;

    if (data.result?.id) {
      const library = manager === 'radarr' ? radarrLibrary : sonarrLibrary;
      const addedSeries = {
        id: data.result.id,
        title: data.result.title || titleFor(item),
        tvdbId: data.result.tvdbId ?? null,
        sortTitle: data.result.sortTitle ?? null,
        titleSlug: data.result.titleSlug ?? null,
        year: data.result.year ?? item.startDate?.year ?? null,
      };
      if (library?.series) {
        library.series = [addedSeries, ...library.series];
        library.index = buildSonarrIndex(library.series);
      }
    }

    pushSonarrLog({
      message: `Added to ${managerLabelForItem(item)}: ${titleFor(item)}`,
      payload: {
        status: api.status,
        response: data,
      },
    });
    detailResult.textContent = `Added to ${managerLabelForItem(item)}`;
  } catch (error) {
    pushSonarrLog({
      message: `Unexpected add error for ${titleFor(item)}`,
      payload: { error: String(error.message || error) },
    });
    detailResult.textContent = `Error: ${error.message}`;
  } finally {
    addingIds.delete(item.id);
    if (addSucceeded) {
      await refreshLibraryStatuses();
    }
  }
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void refreshAnime(true);
  }, 120);
});

seasonSelect.addEventListener('change', () => {
  setFilters({ season: seasonSelect.value, seasonYear: Number(yearInput.value) }, { closeAdvanced: false });
});
yearInput.addEventListener('change', () => {
  setFilters({ season: seasonSelect.value, seasonYear: Number(yearInput.value) }, { closeAdvanced: false });
});

sonarrInfoBtn?.addEventListener('click', () => {
  if (!sonarrLogDialog) return;
  if (typeof sonarrLogDialog.showModal === 'function') sonarrLogDialog.showModal();
});

sonarrLogClose?.addEventListener('click', () => {
  if (sonarrLogDialog?.open) sonarrLogDialog.close();
});

typeSelect.addEventListener('change', () => {
  void setFilters({ type: typeSelect.value }, { closeAdvanced: false });
});

sonarrInBtn.addEventListener('click', () => {
  void setSonarrFilter(currentFilters.sonarrState === 'IN' ? 'ALL' : 'IN');
});

sonarrOutBtn.addEventListener('click', () => {
  void setSonarrFilter(currentFilters.sonarrState === 'OUT' ? 'ALL' : 'OUT');
});

function setupLoadMoreObserver() {
  if (!('IntersectionObserver' in window) || !loadMoreBtn) return;
  if (loadMoreObserver) loadMoreObserver.disconnect();

  loadMoreObserver = new IntersectionObserver((entries) => {
    const [entry] = entries;
    if (!entry?.isIntersecting) return;
    if (!hasNextPage || loadingAnime) return;
    void fetchAnime(false);
  }, {
    root: null,
    rootMargin: '250px',
    threshold: 0.05,
  });

  loadMoreObserver.observe(loadMoreBtn);
}

window.addEventListener('hashchange', handleRoute);

(async () => {
  await loadMeta();
  advancedPanel.hidden = true;
  moreToggleBtn.setAttribute('aria-expanded', 'false');
  updateQuickButtons();
  setupLoadMoreObserver();

  if (meta?.sonarrConfigured) {
    await loadSonarrLibrary().catch(() => null);
  }
  if (meta?.radarrConfigured) {
    await loadRadarrLibrary().catch(() => null);
  }

  updateStatusLine();
  await refreshAnime(true);
  handleRoute();
})();
