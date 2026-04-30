import dotenv from 'dotenv';
import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
dotenv.config({ path: path.join(__dirname, '.env') });

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
  sonarrMonitorNewItems: process.env.SONARR_MONITOR_NEW_ITEMS || fileConfig.sonarrMonitorNewItems || 'all',
  sonarrSeasonFolder: (process.env.SONARR_SEASON_FOLDER ?? fileConfig.sonarrSeasonFolder ?? true) === 'true',

  radarrUrl: process.env.RADARR_URL || fileConfig.radarrUrl,
  radarrApiKey: process.env.RADARR_API_KEY || fileConfig.radarrApiKey,
  radarrQualityProfileId: Number(process.env.RADARR_QUALITY_PROFILE_ID || fileConfig.radarrQualityProfileId || 1),
  radarrRootFolderPath: process.env.RADARR_ROOT_FOLDER_PATH || fileConfig.radarrRootFolderPath,
  radarrMonitorNewItems: process.env.RADARR_MONITOR_NEW_ITEMS || fileConfig.radarrMonitorNewItems || 'all',

  defaultSeason: process.env.DEFAULTSEASON || fileConfig.defaultSeason || 'current season',
  defaultSort: process.env.DEFAULTSORT || fileConfig.defaultSort || 'Trending',
  alreadyInLib: process.env.ALREADYINLIB || fileConfig.alreadyInLib || 'None',
  defaultType: process.env.DEFAULTTYPE || fileConfig.defaultType || 'ALL',
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

const radarrCache = {
  key: null,
  fetchedAt: 0,
  series: [],
  promise: null,
};

const radarrAuxCache = {
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

function getSeasonDateRange(season, year) {
  const ranges = {
    SPRING: { start: `${year}-03-01`, end: `${year}-05-31` },
    SUMMER: { start: `${year}-06-01`, end: `${year}-08-31` },
    FALL: { start: `${year}-09-01`, end: `${year}-11-30` },
    WINTER: { start: `${year}-12-01`, end: `${year + 1}-02-28` },
  };
  return ranges[season];
}

function daysBetween(now, endDate) {
  const ms = new Date(endDate).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function normalizeSetting(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
}

function defaultSeasonMode(value) {
  const v = normalizeSetting(value);
  if (v === 'last season' || v === 'previous season' || v === 'last' || v === 'previous') return 'previous';
  if (v === 'next season' || v === 'next') return 'next';
  return 'current';
}

function defaultSortValue(value) {
  const v = String(value || '').trim().toLowerCase();

  if (v === 'popular') return 'POPULARITY_DESC';
  if (v === 'top' || v === 'top rated' || v === 'score') return 'SCORE_DESC';
  if (v === 'newest' || v === 'new') return 'START_DATE_DESC';
  if (v === 'name' || v === 'a z' || v === 'title') return 'TITLE_ROMAJI';
  return 'TRENDING_DESC';
}

function alreadyInLibValue(value) {
  const v = String(value || '').trim().toLowerCase();

  if (v === 'true') return 'IN';
  if (v === 'false') return 'OUT';
  return 'ALL'; // None or anything else
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
    relations {
      edges {
        relationType
        node {
          id
          title {
            romaji
            english
            native
          }
        }
      }
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

    if (!['SEQUEL', 'PREQUEL', 'PARENT', 'SIDE_STORY', 'ADAPTATION'].includes(relationType)) {
      continue;
    }

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

async function apiRequest(baseUrl, apiKey, urlPath, options = {}) {
  const base = String(baseUrl || '')
    .replace(/\/$/, '')
    .replace(/\/api\/v3$/, '');

  if (!base || !apiKey) {
    throw new Error('API is not configured yet. Check base URL and API key.');
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
    throw new Error(typeof payload === 'string' ? payload : payload?.message || `Request failed (${response.status})`);
  }

  return payload;
}

async function sonarrRequest(config, urlPath, options = {}) {
  return apiRequest(config.sonarrUrl, config.sonarrApiKey, urlPath, options);
}

async function radarrRequest(config, urlPath, options = {}) {
  return apiRequest(config.radarrUrl, config.radarrApiKey, urlPath, options);
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

async function loadRadarrSetup(config, { forceRefresh = false } = {}) {
  const key = `${String(config.radarrUrl || '')}::${String(config.radarrApiKey || '')}`;
  const now = Date.now();

  if (!forceRefresh && radarrAuxCache.key === key && radarrAuxCache.rootFolders.length && radarrAuxCache.qualityProfiles.length && now - radarrAuxCache.fetchedAt < SONARR_CACHE_TTL_MS) {
    return {
      rootFolders: radarrAuxCache.rootFolders,
      qualityProfiles: radarrAuxCache.qualityProfiles,
      cached: true,
      fetchedAt: radarrAuxCache.fetchedAt,
    };
  }

  if (!forceRefresh && radarrAuxCache.promise && radarrAuxCache.key === key) {
    return radarrAuxCache.promise;
  }

  const promise = (async () => {
    const [rootFolders, qualityProfiles] = await Promise.all([
      radarrRequest(config, '/api/v3/rootfolder'),
      radarrRequest(config, '/api/v3/qualityprofile'),
    ]);

    const folders = Array.isArray(rootFolders) ? rootFolders : [];
    const profiles = Array.isArray(qualityProfiles) ? qualityProfiles : [];
    radarrAuxCache.key = key;
    radarrAuxCache.rootFolders = folders;
    radarrAuxCache.qualityProfiles = profiles;
    radarrAuxCache.fetchedAt = Date.now();
    return { rootFolders: folders, qualityProfiles: profiles, cached: false, fetchedAt: radarrAuxCache.fetchedAt };
  })();

  radarrAuxCache.key = key;
  radarrAuxCache.promise = promise;
  try {
    return await promise;
  } finally {
    if (radarrAuxCache.promise === promise) radarrAuxCache.promise = null;
  }
}

function pickDefaultRadarrRootFolder(config, rootFolders) {
  const preferred = String(config.radarrRootFolderPath || '').trim();
  const folders = Array.isArray(rootFolders) ? rootFolders : [];
  const preferredKey = normalizeFolderPath(preferred);
  if (preferredKey) {
    const exact = folders.find((folder) => normalizeFolderPath(folder?.path) === preferredKey);
    if (exact?.path) return exact.path;
  }

  const movieFolder = folders.find((folder) => {
    const key = normalizeFolderPath(folder?.path);
    return key.includes('movie') && !key.includes('anime');
  }) || folders.find((folder) => normalizeFolderPath(folder?.path).includes('movie'));

  if (movieFolder?.path) return movieFolder.path;
  return folders.find((folder) => folder?.path)?.path || preferred || '';
}

function buildRadarrAddPayload(candidate, config, setup = {}) {
  const rootFolderPath = pickDefaultRadarrRootFolder(config, setup.rootFolders);
  const qualityProfileId = pickDefaultQualityProfile(config, setup.qualityProfiles);

  return {
    ...candidate,
    ...(qualityProfileId ? { qualityProfileId: Number(qualityProfileId) } : {}),
    ...(rootFolderPath ? { rootFolderPath: String(rootFolderPath).replace(/[\/]+$/g, '') } : {}),
    monitored: true,
    minimumAvailability: candidate.minimumAvailability || 'released',
    addOptions: {
      ...(candidate.addOptions || {}),
      searchForMovie: true,
    },
  };
}

async function loadRadarrLibrary(config, { forceRefresh = false } = {}) {
  const key = `${String(config.radarrUrl || '')}::${String(config.radarrApiKey || '')}`;
  const now = Date.now();

  if (!forceRefresh && radarrCache.key === key && radarrCache.series.length && now - radarrCache.fetchedAt < SONARR_CACHE_TTL_MS) {
    return { series: radarrCache.series, index: buildSonarrIndex(radarrCache.series), cached: true, fetchedAt: radarrCache.fetchedAt };
  }

  if (!forceRefresh && radarrCache.promise && radarrCache.key === key) {
    return radarrCache.promise;
  }

  const promise = (async () => {
    const movies = await radarrRequest(config, '/api/v3/movie');
    const list = Array.isArray(movies) ? movies : [];
    radarrCache.key = key;
    radarrCache.series = list;
    radarrCache.fetchedAt = Date.now();
    return { series: list, index: buildSonarrIndex(list), cached: false, fetchedAt: radarrCache.fetchedAt };
  })();

  radarrCache.key = key;
  radarrCache.promise = promise;
  try {
    return await promise;
  } finally {
    if (radarrCache.promise === promise) {
      radarrCache.promise = null;
    }
  }
}

function getRadarrMatchForMovie(movie, library) {
  const { match, confidence } = findBestSeriesMatch(movie, library.index);
  const title = pickTitle(movie);

  return {
    movieId: movie.id,
    title,
    inRadarr: Boolean(match),
    matchConfidence: match ? confidence : 'none',
    radarrMovieId: match?.id ?? null,
    matchedTitle: match?.title ?? null,
    matchedPath: match?.path ?? null,
  };
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

function isInSonarrLibrary(anime, library) {
  const { match } = findBestSeriesMatch(anime, library.index);

  if (match) return true;

  // fallback: franchise matching (copy from your existing logic)
  const familyTitles = getSonarrFamilyTitles(anime);

  return library.series.some((series) => {
    const seriesTitles = [
      series?.title,
      series?.sortTitle,
      series?.titleSlug,
      ...(Array.isArray(series?.alternateTitles)
        ? series.alternateTitles.map((alt) => (typeof alt === 'string' ? alt : alt?.title)).filter(Boolean)
        : []),
    ]
      .map((t) => normalizeFranchiseTitle(t))
      .filter(Boolean);

    return familyTitles.some((ft) =>
      seriesTitles.includes(normalizeFranchiseTitle(ft))
    );
  });
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

  if (url.pathname === '/api/radarr/library' && req.method === 'GET') {
    try {
      const library = await loadRadarrLibrary(config, { forceRefresh: url.searchParams.get('refresh') === '1' });
      json(res, 200, {
        ok: true,
        count: library.index.count,
        fetchedAt: library.fetchedAt,
        cached: library.cached,
        series: library.series.map((movie) => ({
          id: movie.id,
          tvdbId: movie.tvdbId ?? null,
          title: movie.title ?? null,
          sortTitle: movie.sortTitle ?? null,
          titleSlug: movie.titleSlug ?? null,
          alternateTitles: Array.isArray(movie.alternateTitles)
            ? movie.alternateTitles.map((alt) => ({ title: typeof alt === 'string' ? alt : alt?.title ?? null })).filter((alt) => alt.title)
            : [],
          year: movie.year ?? null,
        })),
      });
    } catch (error) {
      json(res, 500, { ok: false, error: String(error.message || error) });
    }
    return;
  }

  if (url.pathname === '/api/radarr/add' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const movie = body?.anime || body?.movie;
      if (!movie) throw new Error('Missing movie payload.');

      const title = pickTitle(movie);
      const library = await loadRadarrLibrary(config);
      const { match } = findBestSeriesMatch(movie, library.index);
      if (match) {
        json(res, 200, { ok: true, alreadyExists: true, series: match });
        return;
      }

      const setup = await loadRadarrSetup(config);
      const resolvedRootFolder = pickDefaultRadarrRootFolder(config, setup.rootFolders);
      const lookupTerms = [...new Set([title, ...animeTitleVariants(movie)])].filter(Boolean);
      let candidates = [];
      for (const term of lookupTerms) {
        const lookup = await radarrRequest(config, `/api/v3/movie/lookup?term=${encodeURIComponent(term)}`);
        const next = Array.isArray(lookup) ? lookup : [];
        if (next.length) {
          candidates = next;
          break;
        }
      }

      if (!candidates.length) {
        throw new Error(`No Radarr lookup results for ${title}`);
      }

      const exactLookup = candidates.find((candidate) => {
        const candidateVariants = [
          normalizeText(candidate?.title),
          normalizeText(candidate?.sortTitle),
          normalizePath(candidate?.titleSlug),
          stripAnimeSuffixes(candidate?.title),
          stripAnimeSuffixes(candidate?.sortTitle),
          stripAnimeSuffixes(candidate?.titleSlug),
          ...(Array.isArray(candidate?.alternateTitles)
            ? candidate.alternateTitles.map((alt) => normalizeText(typeof alt === 'string' ? alt : alt?.title)).filter(Boolean)
            : []),
          ...(Array.isArray(candidate?.alternateTitles)
            ? candidate.alternateTitles.map((alt) => stripAnimeSuffixes(typeof alt === 'string' ? alt : alt?.title)).filter(Boolean)
            : []),
        ].filter(Boolean);
        return animeTitleVariants(movie).some((variant) => candidateVariants.includes(variant));
      });

      if (!exactLookup) {
        return json(res, 200, {
          ok: false,
          reason: 'NO_EXACT_MATCH',
          message: `No exact Radarr match found for "${title}"`,
          lookupTerms,
          lookupResults: candidates.slice(0, 5).map((candidate) => ({
            title: candidate?.title || null,
            sortTitle: candidate?.sortTitle || null,
            titleSlug: candidate?.titleSlug || null,
            year: candidate?.year || null,
            tvdbId: candidate?.tvdbId || null,
          })),
        });
      }

      const payload = buildRadarrAddPayload(exactLookup, { ...config, radarrRootFolderPath: resolvedRootFolder || config.radarrRootFolderPath }, setup);
      const result = await radarrRequest(config, '/api/v3/movie', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      radarrCache.fetchedAt = 0;
      radarrCache.series = [];
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

  if (url.pathname === '/api/anime') {
    const fallback = currentSeasonParts();
    const season = String(url.searchParams.get('season') || fallback.season).toUpperCase();
    const seasonYear = Number(url.searchParams.get('seasonYear') || fallback.seasonYear);
    const page = Math.max(1, Number(url.searchParams.get('page') || '1'));
    const perPage = Math.min(
      50,
      Math.max(
        1,
        Number(url.searchParams.get('perPage') || process.env.PER_PAGE || '20')
      )
    );
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
          ...(Array.isArray(candidate?.alternateTitles)
            ? candidate.alternateTitles
              .map((alt) => normalizeText(typeof alt === 'string' ? alt : alt?.title))
              .filter(Boolean)
            : []),
          ...(Array.isArray(candidate?.alternateTitles)
            ? candidate.alternateTitles
              .map((alt) => stripAnimeSuffixes(typeof alt === 'string' ? alt : alt?.title))
              .filter(Boolean)
            : []),
        ].filter(Boolean);
        return animeTitleVariants(anime).some((variant) => candidateVariants.includes(variant));
      });

      if (!exactLookup) {
        const familyTitles = getSonarrFamilyTitles(anime);

        const relatedExistingSeries = library.series.find((series) => {
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

          return familyTitles.some((familyTitle) =>
            seriesTitles.includes(normalizeFranchiseTitle(familyTitle))
          );
        });

        if (relatedExistingSeries) {
          return json(res, 200, {
            ok: true,
            alreadyExists: true,
            reason: 'RELATED_SERIES_EXISTS',
            message: `Already represented in Sonarr by "${relatedExistingSeries.title}"`,
            matchedSeries: {
              title: relatedExistingSeries.title,
              tvdbId: relatedExistingSeries.tvdbId ?? null,
              sortTitle: relatedExistingSeries.sortTitle ?? null,
              titleSlug: relatedExistingSeries.titleSlug ?? null,
            },
          });
        }

        return json(res, 200, {
          ok: false,
          reason: 'NO_EXACT_MATCH',
          message: `No exact Sonarr match found for "${title}"`,
          lookupTerms,
          lookupResults: candidates.slice(0, 5).map((candidate) => ({
            title: candidate?.title || null,
            sortTitle: candidate?.sortTitle || null,
            titleSlug: candidate?.titleSlug || null,
            year: candidate?.year || null,
            tvdbId: candidate?.tvdbId || null,
          })),
        });
      }
      const payload = buildAddPayload(exactLookup, { ...config, sonarrRootFolderPath: resolvedRootFolder || config.sonarrRootFolderPath }, setup);
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

  if (url.pathname === '/api/meta') {
    const { season, seasonYear } = currentSeasonParts();

    let sonarrRootFolderPath = String(config.sonarrRootFolderPath || config.sonarrAnimeRootFolderPath || '').trim();
    if (config.sonarrUrl && config.sonarrApiKey) {
      try {
        const setup = await loadSonarrSetup(config);
        sonarrRootFolderPath = pickDefaultRootFolder(config, setup.rootFolders) || sonarrRootFolderPath;
      } catch { }
    }

    let radarrRootFolderPath = String(config.radarrRootFolderPath || '').trim();
    if (config.radarrUrl && config.radarrApiKey) {
      try {
        const setup = await loadRadarrSetup(config);
        radarrRootFolderPath = pickDefaultRadarrRootFolder(config, setup.rootFolders) || radarrRootFolderPath;
      } catch { }
    }

    json(res, 200, {
      season,
      seasonYear,
      defaultSeason: defaultSeasonMode(config.defaultSeason),
      defaultSort: defaultSortValue(config.defaultSort),
      alreadyInLib: alreadyInLibValue(config.alreadyInLib),
      sonarrConfigured: Boolean(config.sonarrUrl && config.sonarrApiKey),
      sonarrRootFolderPath: sonarrRootFolderPath || null,
      radarrConfigured: Boolean(config.radarrUrl && config.radarrApiKey),
      radarrRootFolderPath: radarrRootFolderPath || null,
      autoloadPages: Number(process.env.AUTOLOAD_PAGES || 4),
      defaultType: String(config.defaultType || 'ALL').toUpperCase(),
    });
    return;
  }

  if (url.pathname === '/api/season-stats' && req.method === 'GET') {
    try {
      const now = new Date();
      const { season, seasonYear } = currentSeasonParts(now);

      const range = getSeasonDateRange(season, seasonYear);
      const daysLeft = daysBetween(now, range.end);

      // 1. Fetch seasonal anime
      let page = 1;
      let hasNextPage = true;
      let media = [];

      while (hasNextPage && page <= 5) { // safety limit
        const data = await fetchAniList({
          query: ANILIST_LIST_QUERY,
          variables: {
            page,
            perPage: 50,
            season,
            seasonYear,
            sort: ['POPULARITY_DESC']
          },
        });

        const pageData = data.Page.media || [];
        media = media.concat(pageData);

        hasNextPage = data.Page.pageInfo?.hasNextPage;
        page++;
      }

      const tv = media.filter((m) => m.format === 'TV');
      const movies = media.filter((m) => m.format === 'MOVIE');

      // 2. Load libraries
      const sonarrLib = await loadSonarrLibrary(config);
      const radarrLib = await loadRadarrLibrary(config);

      // 3. Count matches
      let sonarrIn = 0;
      let radarrIn = 0;

for (const anime of tv) {
  if (isInSonarrLibrary(anime, sonarrLib)) {
    sonarrIn++;
  }
}

      for (const movie of movies) {
        const match = getRadarrMatchForMovie(movie, radarrLib);
        if (match.inRadarr) radarrIn++;
      }

      const tvTotal = tv.length;
      const movieTotal = movies.length;

      const sonarrNotIn = tvTotal - sonarrIn;
      const radarrNotIn = movieTotal - radarrIn;

      json(res, 200, {
        season,
        seasonYear,
        seasonDisplay: `${seasonYear} ${season}`,
        daysLeft,

        tvTotal,
        movieTotal,

        tvInSonarr: `${sonarrIn} / ${tvTotal}`,
        moviesInRadarr: `${radarrIn} / ${movieTotal}`,

        sonarr: {
          inLibrary: sonarrIn,
          notInLibrary: sonarrNotIn,
          total: tvTotal,
        },
        radarr: {
          inLibrary: radarrIn,
          notInLibrary: radarrNotIn,
          total: movieTotal,
        },
      });
    } catch (error) {
      json(res, 500, { error: String(error.message || error) });
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
