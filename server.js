import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

let fileConfig = {};

try {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
} catch (e) {
  console.warn('No config.json found, using env only');
}

const config = {
  sonarrUrl: process.env.SONARR_URL || fileConfig.sonarrUrl,
  sonarrApiKey: process.env.SONARR_API_KEY || fileConfig.sonarrApiKey,
  sonarrQualityProfileId: Number(process.env.SONARR_QUALITY_PROFILE_ID || fileConfig.sonarrQualityProfileId || 1),
  sonarrRootFolderPath: process.env.SONARR_ROOT_FOLDER_PATH || fileConfig.sonarrRootFolderPath,
  sonarrMonitorNewItems: process.env.SONARR_MONITOR_NEW_ITEMS || fileConfig.sonarrMonitorNewItems || "all",
  sonarrSeasonFolder: (process.env.SONARR_SEASON_FOLDER ?? fileConfig.sonarrSeasonFolder ?? true) === "true"
};

if (!config.sonarrUrl || !config.sonarrApiKey) {
  console.error("Missing Sonarr config!");
  process.exit(1);
}

const PORT = Number(process.env.PORT || 8787);
const SONARR_CACHE_TTL_MS = 5 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const sonarrCache = {
  key: null,
  fetchedAt: 0,
  series: [],
  promise: null,
};

const sonarrAuxCache = {
  key: null,
  fetchedAt: 0,
  rootFolders: [],
  qualityProfiles: [],
  promise: null,
};

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

function currentSeasonParts(date = new Date()) {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  if (month >= 3 && month <= 5) return { season: 'SPRING', seasonYear: year };
  if (month >= 6 && month <= 8) return { season: 'SUMMER', seasonYear: year };
  if (month >= 9 && month <= 11) return { season: 'FALL', seasonYear: year };
  return { season: 'WINTER', seasonYear: month === 12 ? year + 1 : year };
}

const ANILIST_LIST_QUERY = `
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int, $search: String, $sort: [MediaSort]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      hasNextPage
      currentPage
      lastPage
      total
    }
    media(
      type: ANIME,
      season: $season,
      seasonYear: $seasonYear,
      search: $search,
      sort: $sort,
      isAdult: false
    ) {
      id
      idMal
      title {
        romaji
        english
        native
      }
      synonyms
      coverImage {
        large
        extraLarge
        color
      }
      bannerImage
      episodes
      format
      status
      season
      seasonYear
      averageScore
      meanScore
      popularity
      trending
      genres
      tags {
        name
        rank
      }
      nextAiringEpisode {
        episode
        timeUntilAiring
        airingAt
      }
      startDate {
        year
        month
        day
      }
      siteUrl
    }
  }
}`;

const ANILIST_MEDIA_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title {
      romaji
      english
      native
    }
    description(asHtml: false)
    bannerImage
    coverImage {
      large
      extraLarge
      color
    }
    episodes
    duration
    format
    status
    season
    seasonYear
    averageScore
    meanScore
    popularity
    trending
    source
    genres
    tags {
      name
      rank
    }
    nextAiringEpisode {
      episode
      timeUntilAiring
      airingAt
    }
    startDate {
      year
      month
      day
    }
    studios {
      nodes {
        name
      }
    }
    siteUrl
  }
}`;

function pickTitle(item) {
  return item?.title?.english || item?.title?.romaji || item?.title?.native || 'Untitled';
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

function normalizeFolderPath(value) {
  return normalizeText(String(value || '').replace(/[\/]+$/g, ''));
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

function sameYearOrUnknown(left, right) {
  if (!left || !right) return true;
  return Math.abs(Number(left) - Number(right)) <= 1;
}

async function fetchAniList({ query, variables }) {
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const data = await response.json();
  if (!response.ok || data.errors) {
    throw new Error(data?.errors?.[0]?.message || `AniList request failed (${response.status})`);
  }
  return data.data;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function sonarrRequest(config, urlPath, options = {}) {
  const base = String(config.sonarrUrl || '').replace(/\/$/, '');
  const apiKey = config.sonarrApiKey;
  if (!base || !apiKey) {
    throw new Error('Sonarr is not configured yet. Add sonarrUrl and sonarrApiKey to config.json.');
  }

  const response = await fetch(`${base}${urlPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    throw new Error(typeof payload === 'string' ? payload : payload?.message || `Sonarr request failed (${response.status})`);
  }

  return payload;
}

function buildAddPayload(candidate, config, setup = {}) {
  const rootFolderPath = pickDefaultRootFolder(config, setup.rootFolders);
  const qualityProfileId = pickDefaultQualityProfile(config, setup.qualityProfiles);
  const seasonFolder = config.sonarrSeasonFolder !== false;
  const monitor = config.sonarrMonitorNewItems || 'all';

  const payload = {
    ...candidate,
    ...(qualityProfileId ? { qualityProfileId: Number(qualityProfileId) } : {}),
    ...(rootFolderPath ? { rootFolderPath: String(rootFolderPath).replace(/[\/]+$/g, '') } : {}),
    monitored: true,
    monitorNewItems: monitor,
    seasonFolder,
  };

  payload.seasons = Array.isArray(candidate.seasons)
    ? candidate.seasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        monitored: season.monitored ?? true,
      }))
    : [];

  payload.addOptions = {
    ...(candidate.addOptions || {}),
    monitor,
  };

  return payload;
}



async function loadSonarrSetup(config, { forceRefresh = false } = {}) {
  const key = `${String(config.sonarrUrl || '')}::${String(config.sonarrApiKey || '')}`;
  const now = Date.now();

  if (!forceRefresh && sonarrAuxCache.key === key && sonarrAuxCache.rootFolders.length && sonarrAuxCache.qualityProfiles.length && now - sonarrAuxCache.fetchedAt < SONARR_CACHE_TTL_MS) {
    return {
      rootFolders: sonarrAuxCache.rootFolders,
      qualityProfiles: sonarrAuxCache.qualityProfiles,
      cached: true,
      fetchedAt: sonarrAuxCache.fetchedAt,
    };
  }

  if (!forceRefresh && sonarrAuxCache.promise && sonarrAuxCache.key === key) {
    return sonarrAuxCache.promise;
  }

  const promise = (async () => {
    const [rootFolders, qualityProfiles] = await Promise.all([
      sonarrRequest(config, '/api/v3/rootfolder'),
      sonarrRequest(config, '/api/v3/qualityprofile'),
    ]);

    const folders = Array.isArray(rootFolders) ? rootFolders : [];
    const profiles = Array.isArray(qualityProfiles) ? qualityProfiles : [];
    sonarrAuxCache.key = key;
    sonarrAuxCache.rootFolders = folders;
    sonarrAuxCache.qualityProfiles = profiles;
    sonarrAuxCache.fetchedAt = Date.now();
    return { rootFolders: folders, qualityProfiles: profiles, cached: false, fetchedAt: sonarrAuxCache.fetchedAt };
  })();

  sonarrAuxCache.key = key;
  sonarrAuxCache.promise = promise;
  try {
    return await promise;
  } finally {
    if (sonarrAuxCache.promise === promise) sonarrAuxCache.promise = null;
  }
}

function pickDefaultRootFolder(config, rootFolders) {
  const preferred = String(config.sonarrRootFolderPath || config.sonarrAnimeRootFolderPath || '').trim();
  const folders = Array.isArray(rootFolders) ? rootFolders : [];
  const preferredKey = normalizeFolderPath(preferred);
  if (preferredKey) {
    const exact = folders.find((folder) => normalizeFolderPath(folder?.path) === preferredKey);
    if (exact?.path) return exact.path;
  }
  const animeFolder = folders.find((folder) => {
    const key = normalizeFolderPath(folder?.path);
    return key.includes('anime') && !key.includes('series');
  }) || folders.find((folder) => normalizeFolderPath(folder?.path).includes('anime'));
  if (animeFolder?.path) return animeFolder.path;
  return folders.find((folder) => folder?.path)?.path || preferred || '';
}

function pickDefaultQualityProfile(config, qualityProfiles) {
  const preferred = Number(config.sonarrQualityProfileId || 0);
  const profiles = Array.isArray(qualityProfiles) ? qualityProfiles : [];
  if (preferred && profiles.some((profile) => Number(profile?.id) === preferred)) return preferred;
  const defaultProfile = profiles.find((profile) => profile?.isDefault);
  if (defaultProfile?.id != null) return Number(defaultProfile.id);
  return profiles.find((profile) => profile?.id != null)?.id ?? preferred;
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
    const baseTitleKeyValue = stripAnimeSuffixes(series?.title);
    if (baseTitleKeyValue) index.byBaseTitle.set(baseTitleKeyValue, series);

    const sortTitleKey = normalizeText(series?.sortTitle);
    if (sortTitleKey) index.bySortTitle.set(sortTitleKey, series);
    const baseSortTitleKeyValue = stripAnimeSuffixes(series?.sortTitle);
    if (baseSortTitleKeyValue) index.byBaseSortTitle.set(baseSortTitleKeyValue, series);

    const slugKey = normalizePath(series?.titleSlug);
    if (slugKey) index.bySlug.set(slugKey, series);
    const baseSlugKeyValue = stripAnimeSuffixes(series?.titleSlug);
    if (baseSlugKeyValue) index.byBaseSlug.set(baseSlugKeyValue, series);

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

async function loadSonarrLibrary(config, { forceRefresh = false } = {}) {
  const key = `${String(config.sonarrUrl || '')}::${String(config.sonarrApiKey || '')}`;
  const now = Date.now();

  if (!forceRefresh && sonarrCache.key === key && sonarrCache.series.length && now - sonarrCache.fetchedAt < SONARR_CACHE_TTL_MS) {
    return { series: sonarrCache.series, index: buildSonarrIndex(sonarrCache.series), cached: true, fetchedAt: sonarrCache.fetchedAt };
  }

  if (!forceRefresh && sonarrCache.promise && sonarrCache.key === key) {
    return sonarrCache.promise;
  }

  const promise = (async () => {
    const series = await sonarrRequest(config, '/api/v3/series');
    const list = Array.isArray(series) ? series : [];
    sonarrCache.key = key;
    sonarrCache.series = list;
    sonarrCache.fetchedAt = Date.now();
    return { series: list, index: buildSonarrIndex(list), cached: false, fetchedAt: sonarrCache.fetchedAt };
  })();

  sonarrCache.key = key;
  sonarrCache.promise = promise;
  try {
    return await promise;
  } finally {
    if (sonarrCache.promise === promise) {
      sonarrCache.promise = null;
    }
  }
}

function findBestSeriesMatch(anime, index) {
  const titleVariants = animeTitleVariants(anime);
  const animeTvdbId = anime?.tvdbId != null ? String(anime.tvdbId) : null;
  const animeYear = anime?.startDate?.year ? Number(anime.startDate.year) : null;

  if (animeTvdbId && index.byTvdbId.has(animeTvdbId)) {
    return { match: index.byTvdbId.get(animeTvdbId), confidence: 'high' };
  }

  for (const variant of titleVariants) {
    const directMatch =
      index.byTitle.get(variant) ||
      index.bySortTitle.get(variant) ||
      index.bySlug.get(variant) ||
      index.byBaseTitle.get(variant) ||
      index.byBaseSortTitle.get(variant) ||
      index.byBaseSlug.get(variant) ||
      index.byAltTitle.get(variant) ||
      index.byBaseAltTitle.get(variant);
    if (directMatch && sameYearOrUnknown(animeYear, directMatch?.year)) {
      return { match: directMatch, confidence: 'high' };
    }
  }

  return { match: null, confidence: 'none' };
}

function getSonarrMatchForAnime(anime, library) {
  const { match, confidence } = findBestSeriesMatch(anime, library.index);
  const title = pickTitle(anime);

  return {
    animeId: anime.id,
    title,
    inSonarr: Boolean(match),
    matchConfidence: match ? confidence : 'none',
    sonarrSeriesId: match?.id ?? null,
    sonarrTvdbId: match?.tvdbId ?? null,
    matchedTitle: match?.title ?? null,
    matchedPath: match?.path ?? null,
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }

  if (url.pathname === '/api/meta') {
    const { season, seasonYear } = currentSeasonParts();
    let sonarrRootFolderPath = String(config.sonarrRootFolderPath || config.sonarrAnimeRootFolderPath || '').trim();
    if (config.sonarrUrl && config.sonarrApiKey) {
      try {
        const setup = await loadSonarrSetup(config);
        sonarrRootFolderPath = pickDefaultRootFolder(config, setup.rootFolders) || sonarrRootFolderPath;
      } catch {}
    }
    json(res, 200, {
      season,
      seasonYear,
      sonarrConfigured: Boolean(config.sonarrUrl && config.sonarrApiKey),
      sonarrRootFolderPath: sonarrRootFolderPath || null,
    });
    return;
  }

  if (url.pathname === '/api/anime') {
    const fallback = currentSeasonParts();
    const season = String(url.searchParams.get('season') || fallback.season).toUpperCase();
    const seasonYear = Number(url.searchParams.get('seasonYear') || fallback.seasonYear);
    const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
    const perPage = Math.min(25, Math.max(1, Number(url.searchParams.get('perPage') || '20')));
    const search = url.searchParams.get('search') || '';
    const sort = (url.searchParams.get('sort') || 'TRENDING_DESC')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const data = await fetchAniList({
        query: ANILIST_LIST_QUERY,
        variables: {
          page,
          perPage,
          season,
          seasonYear,
          search: search || undefined,
          sort: sort.length ? sort : ['TRENDING_DESC', 'POPULARITY_DESC'],
        },
      });
      json(res, 200, { ...data.Page, season, seasonYear });
    } catch (error) {
      json(res, 500, { error: String(error.message || error) });
    }
    return;
  }

  const animeDetailMatch = url.pathname.match(/^\/api\/anime\/(\d+)$/);
  if (animeDetailMatch && req.method === 'GET') {
    try {
      const id = Number(animeDetailMatch[1]);
      const data = await fetchAniList({
        query: ANILIST_MEDIA_QUERY,
        variables: { id },
      });
      json(res, 200, { ok: true, media: data.Media });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error.message || error) });
    }
    return;
  }

  if (url.pathname === '/api/sonarr/library' && req.method === 'GET') {
    try {
      const library = await loadSonarrLibrary(config, { forceRefresh: url.searchParams.get('refresh') === '1' });
      json(res, 200, {
        ok: true,
        count: library.index.count,
        fetchedAt: library.fetchedAt,
        cached: library.cached,
        series: library.series.map((series) => ({
          id: series.id,
          tvdbId: series.tvdbId ?? null,
          title: series.title ?? null,
          sortTitle: series.sortTitle ?? null,
          titleSlug: series.titleSlug ?? null,
          alternateTitles: Array.isArray(series.alternateTitles)
            ? series.alternateTitles.map((alt) => ({ title: typeof alt === 'string' ? alt : alt?.title ?? null })).filter((alt) => alt.title)
            : [],
          year: series.year ?? null,
        })),
      });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error.message || error) });
    }
    return;
  }

  if (url.pathname === '/api/sonarr/status' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const anime = Array.isArray(body?.anime) ? body.anime : [];
      if (!anime.length) throw new Error('Missing anime list.');

      const library = await loadSonarrLibrary(config, { forceRefresh: body?.refresh === true });
      const statuses = anime.map((entry) => getSonarrMatchForAnime(entry, library));
      json(res, 200, { ok: true, statuses, count: library.index.count, fetchedAt: library.fetchedAt });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error.message || error) });
    }
    return;
  }

  if (url.pathname === '/api/sonarr/add' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const anime = body?.anime;
      if (!anime) throw new Error('Missing anime payload.');

      const title = pickTitle(anime);
      const library = await loadSonarrLibrary(config);
      const { match } = findBestSeriesMatch(anime, library.index);
      if (match) {
        json(res, 200, { ok: true, alreadyExists: true, series: match });
        return;
      }

      const setup = await loadSonarrSetup(config);
      const resolvedRootFolder = pickDefaultRootFolder(config, setup.rootFolders);
      const lookupTerms = [...new Set([title, ...animeTitleVariants(anime)])].filter(Boolean);
      let candidates = [];
      for (const term of lookupTerms) {
        const lookup = await sonarrRequest(config, `/api/v3/series/lookup?term=${encodeURIComponent(term)}`);
        const next = Array.isArray(lookup) ? lookup : [];
        if (next.length) {
          candidates = next;
          break;
        }
      }
      if (!candidates.length) {
        throw new Error(`No Sonarr lookup results for ${title}`);
      }

      const exactLookup = candidates.find((candidate) => {
        const candidateVariants = [
          normalizeText(candidate?.title),
          normalizeText(candidate?.sortTitle),
          normalizePath(candidate?.titleSlug),
          stripAnimeSuffixes(candidate?.title),
          stripAnimeSuffixes(candidate?.sortTitle),
          stripAnimeSuffixes(candidate?.titleSlug),
          ...(Array.isArray(candidate?.alternateTitles) ? candidate.alternateTitles.map((alt) => normalizeText(typeof alt === 'string' ? alt : alt?.title)).filter(Boolean) : []),
          ...(Array.isArray(candidate?.alternateTitles) ? candidate.alternateTitles.map((alt) => stripAnimeSuffixes(typeof alt === 'string' ? alt : alt?.title)).filter(Boolean) : []),
        ].filter(Boolean);
        return animeTitleVariants(anime).some((variant) => candidateVariants.includes(variant));
      });

      const candidate = exactLookup || candidates[0];
      const payload = buildAddPayload(candidate, { ...config, sonarrRootFolderPath: resolvedRootFolder || config.sonarrRootFolderPath }, setup);
      const result = await sonarrRequest(config, '/api/v3/series', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      sonarrCache.fetchedAt = 0;
      sonarrCache.series = [];
      json(res, 200, {
        ok: true,
        alreadyExists: false,
        result,
        rootFolderPath: payload.rootFolderPath,
        qualityProfileId: payload.qualityProfileId,
      });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error.message || error) });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');

  const fullPath = path.join(publicDir, filePath);
  const ext = path.extname(fullPath).toLowerCase();

  try {
    const stat = await fsp.stat(fullPath);
    if (stat.isDirectory()) throw new Error('Directory');

    const content = await fsp.readFile(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
    });
    res.end(content);
    return;
  } catch {
    // Only SPA routes should fall back to index.html.
    // Missing assets should return 404 so the browser does not get HTML for CSS/JS.
    if (ext) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    try {
      const indexPath = path.join(publicDir, 'index.html');
      const content = await fsp.readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Failed to load index.html: ${error.message}`);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`NZB Anime Seasonal running on http://localhost:${PORT}`);
});
