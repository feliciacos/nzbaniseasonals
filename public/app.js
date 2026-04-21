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
const selectionSummary = document.querySelector('#selectionSummary');
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

let page = 1;
let hasNextPage = true;
let loadingAnime = false;
let items = [];
let activeSort = 'TRENDING_DESC';
let meta = null;
let currentFilters = getCurrentSeason();
let sonarrStatusMap = new Map();
let addingIds = new Set();
let sonarrLibrary = null;
let sonarrLibraryPromise = null;
let sonarrLibraryLoading = false;
let sonarrLibraryError = null;
let loadMoreObserver = null;
let currentDetailAnime = null;
let currentDetailId = null;
let detailFetchToken = 0;
let searchTimer = null;

const seasonLabel = (season) => ({ SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall', WINTER: 'Winter' }[season] || season);
const seasonOrder = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

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
    const mins = Math.max(0, Math.round(item.nextAiringEpisode.timeUntilAiring / 60));
    return `Ep ${item.nextAiringEpisode.episode} in ${formatCountdown(mins)}`;
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

  for (const item of list) {
    const chip = document.createElement('span');
    chip.className = 'chip-item';
    chip.textContent = item;
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

function getVisibleItems() {
  const query = searchInput.value.trim();
  return items.filter((item) => matchesSearchQuery(item, query));
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

  const variants = animeTitleVariants(item);
  for (const variant of variants) {
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
    sonarrText.textContent = 'Loading Sonarr data...';
    return;
  }
  sonarrSpinner.hidden = true;
  if (!meta?.sonarrConfigured) {
    sonarrText.textContent = 'Sonarr not configured yet';
  } else if (sonarrLibraryError) {
    sonarrText.textContent = `Sonarr check failed: ${sonarrLibraryError}`;
  } else if (sonarrLibrary) {
    sonarrText.textContent = 'Sonarr library synced';
  } else {
    sonarrText.textContent = 'Sonarr ready';
  }
}

function syncSelectionSummary() {
  selectionSummary.textContent = `${seasonLabel(currentFilters.season)} ${currentFilters.seasonYear} · ${activeSort.replace('_DESC', '').toLowerCase()}`;
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
    const isActive = choice?.season === currentFilters.season && choice?.seasonYear === currentFilters.seasonYear;
    button.classList.toggle('active', isActive);
  });

  moreToggleBtn.classList.toggle('active', advancedPanel.hidden === false);
}

function setFilters(nextFilters, { closeAdvanced = false } = {}) {
  currentFilters = { ...nextFilters };
  seasonSelect.value = currentFilters.season;
  yearInput.value = String(currentFilters.seasonYear);
  if (closeAdvanced) {
    advancedPanel.hidden = true;
    moreToggleBtn.setAttribute('aria-expanded', 'false');
  }
  updateQuickButtons();
  syncSelectionSummary();
  fetchAnime(true);
}

function sonarrStateForItem(item) {
  if (addingIds.has(item.id)) return { state: 'adding', text: 'Adding...', disabled: true };
  const known = sonarrStatusMap.get(item.id);
  if (item.sonarrAdded || known?.inSonarr) return { state: 'added', text: 'Added', disabled: true };
  if (!meta?.sonarrConfigured) return { state: 'unconfigured', text: 'Sonarr not set', disabled: true };
  if (sonarrLibraryLoading && !sonarrStatusMap.has(item.id)) return { state: 'checking', text: 'Checking...', disabled: true };
  return { state: 'ready', text: 'Add to Sonarr', disabled: false };
}

function setButtonState(addBtn, resultEl, item) {
  const state = sonarrStateForItem(item);
  addBtn.disabled = state.disabled;
  addBtn.classList.toggle('is-added', state.state === 'added');
  addBtn.classList.toggle('is-loading', state.state === 'checking' || state.state === 'adding');
  addBtn.textContent = state.text;
  resultEl.textContent = item.sonarrAdded || state.state === 'added'
    ? 'Already in Sonarr'
    : state.state === 'checking'
      ? 'Waiting for Sonarr data...'
      : '';
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
      addingIds.add(item.id);
      renderVisibleView();
      try {
        const response = await fetch('/api/sonarr/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ anime: item }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || 'Sonarr add failed');
        item.sonarrAdded = true;
        if (data.result?.id) {
          const addedSeries = {
            id: data.result.id,
            title: data.result.title || titleFor(item),
            tvdbId: data.result.tvdbId ?? null,
            sortTitle: data.result.sortTitle ?? null,
            titleSlug: data.result.titleSlug ?? null,
            year: data.result.year ?? item.startDate?.year ?? null,
          };
          if (sonarrLibrary?.series) {
            sonarrLibrary.series = [addedSeries, ...sonarrLibrary.series];
            sonarrLibrary.index = buildSonarrIndex(sonarrLibrary.series);
          }
        }
        await refreshSonarrStatuses();
      } catch (error) {
        result.textContent = `Error: ${error.message}`;
      } finally {
        addingIds.delete(item.id);
        await refreshSonarrStatuses();
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
  const sonarrState = item ? sonarrStateForItem(item) : { state: 'checking', text: 'Checking...', disabled: true };
  detailSonarrState.textContent = meta?.sonarrConfigured ? (sonarrLibraryLoading && !item?.sonarrAdded ? 'Checking Sonarr...' : (sonarrState.state === 'added' ? 'Already in Sonarr' : 'Ready to add')) : 'Sonarr not configured';

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
    ? `Episode ${item.nextAiringEpisode.episode} in ${formatCountdown(Math.max(0, Math.round(item.nextAiringEpisode.timeUntilAiring / 60)))}`
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

  const state = item ? sonarrStateForItem(item) : null;
  detailAddBtn.disabled = loading || !item || state?.disabled;
  detailAddBtn.classList.toggle('is-added', state?.state === 'added');
  detailAddBtn.classList.toggle('is-loading', state?.state === 'checking' || state?.state === 'adding' || loading);
  detailAddBtn.textContent = state?.state === 'added' ? 'Added' : state?.state === 'adding' ? 'Adding...' : 'Add to Sonarr';
  detailResult.textContent = item ? (item.sonarrAdded || state?.state === 'added' ? 'Already in Sonarr' : state?.state === 'checking' ? 'Waiting for Sonarr data...' : '') : '';
}

function renderVisibleView() {
  if (isDetailRoute()) {
    renderDetail(currentDetailAnime || items.find((item) => String(item.id) === String(currentDetailId)) || null, { loading: !currentDetailAnime });
  } else {
    renderItems();
  }
}

function recomputeSonarrStatuses() {
  if (!sonarrLibrary) {
    sonarrStatusMap = new Map();
    renderVisibleView();
    return;
  }

  const nextMap = new Map();
  for (const item of items) {
    const match = getSonarrMatch(item);
    nextMap.set(item.id, {
      animeId: item.id,
      inSonarr: Boolean(match),
      matchedTitle: match?.title || null,
      sonarrSeriesId: match?.id ?? null,
      sonarrTvdbId: match?.tvdbId ?? null,
    });
  }
  sonarrStatusMap = nextMap;
  renderVisibleView();
}

async function refreshSonarrStatuses() {
  recomputeSonarrStatuses();
}

async function loadMeta() {
  const response = await fetch('/api/meta');
  meta = await response.json();
  currentFilters = { ...meta };
  seasonSelect.value = meta.season;
  yearInput.value = meta.seasonYear;
  updateQuickButtons();
  syncSelectionSummary();
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
      recomputeSonarrStatuses();
      updateStatusLine();
    });

  return sonarrLibraryPromise;
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

    const params = new URLSearchParams({
      page: String(page),
      perPage: '20',
      sort: activeSort,
      season: currentFilters.season,
      seasonYear: String(currentFilters.seasonYear),
    });
    const response = await fetch(`/api/anime?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load anime');

    items = items.concat((data.media || []).map((item) => ({ ...item, sonarrAdded: false })));
    hasNextPage = Boolean(data.pageInfo?.hasNextPage);
    page += 1;
    renderVisibleView();
    statusText.textContent = `${seasonLabel(data.season)} ${data.seasonYear} · ${items.length} titles loaded`;
    loadMoreBtn.disabled = !hasNextPage;
    loadMoreBtn.textContent = hasNextPage ? 'Load more' : 'No more results';

    if (sonarrLibrary) {
      recomputeSonarrStatuses();
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
  activeSort = button.dataset.sort;
  sortChips.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('active', chip === button));
  syncSelectionSummary();
  fetchAnime(true);
});

loadMoreBtn.addEventListener('click', () => fetchAnime(false));
refreshBtn.addEventListener('click', async () => {
  await loadSonarrLibrary().catch(() => null);
  fetchAnime(true);
});

backBtn.addEventListener('click', () => {
  if (location.hash) location.hash = '';
  else showListView();
});

detailAddBtn.addEventListener('click', async () => {
  const item = currentDetailAnime;
  if (!item || detailAddBtn.disabled) return;
  addingIds.add(item.id);
  renderDetail(item, { loading: false });
  try {
    const response = await fetch('/api/sonarr/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anime: item }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Sonarr add failed');
    item.sonarrAdded = true;
    if (data.result?.id) {
      const addedSeries = {
        id: data.result.id,
        title: data.result.title || titleFor(item),
        tvdbId: data.result.tvdbId ?? null,
        sortTitle: data.result.sortTitle ?? null,
        titleSlug: data.result.titleSlug ?? null,
        year: data.result.year ?? item.startDate?.year ?? null,
      };
      if (sonarrLibrary?.series) {
        sonarrLibrary.series = [addedSeries, ...sonarrLibrary.series];
        sonarrLibrary.index = buildSonarrIndex(sonarrLibrary.series);
      }
    }
    detailResult.textContent = 'Added to Sonarr';
  } catch (error) {
    detailResult.textContent = `Error: ${error.message}`;
  } finally {
    addingIds.delete(item.id);
    await refreshSonarrStatuses();
  }
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderVisibleView(), 120);
});
seasonSelect.addEventListener('change', () => {
  setFilters({ season: seasonSelect.value, seasonYear: Number(yearInput.value) }, { closeAdvanced: false });
});
yearInput.addEventListener('change', () => {
  setFilters({ season: seasonSelect.value, seasonYear: Number(yearInput.value) }, { closeAdvanced: false });
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
  currentFilters = getCurrentSeason();
  seasonSelect.value = currentFilters.season;
  yearInput.value = String(currentFilters.seasonYear);
  advancedPanel.hidden = true;
  moreToggleBtn.setAttribute('aria-expanded', 'false');
  updateQuickButtons();
  setupLoadMoreObserver();
  void loadSonarrLibrary();
  await fetchAnime(true);
  handleRoute();
})();
