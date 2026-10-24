// services/poster.service.js
// Fetches movie poster URLs and metadata from OMDb API with TMDB fallback and an in-memory 24h cache.
// All external calls happen server-side so API keys are NEVER exposed to the browser or frontend.

const http = require('http');
const https = require('https');

const OMDB_API_KEY = (process.env.OMDB_API_KEY || '').trim();
const TMDB_API_KEY = (process.env.TMDB_API_KEY || '').trim();
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache: normalizedKey -> { data, expiresAt }
const posterCache = new Map();
const omdbDataCache = new Map();

function normalizeCacheKey(title, year = '', imdbId = '') {
  if (imdbId) return `imdb:${String(imdbId).trim().toLowerCase()}`;
  const t = String(title || '').trim().toLowerCase();
  const y = String(year || '').trim();
  return y ? `title:${t}|${y}` : `title:${t}`;
}

function getCached(cacheMap, key) {
  const entry = cacheMap.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheMap.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(cacheMap, key, data) {
  cacheMap.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function fetchJson(url) {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, { timeout: 4500 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout for ${url}`));
    });
  });
}

/**
 * Fetch full movie metadata from OMDb API.
 * Uses key e47d6ad3 and caches results for 24h.
 */
async function getOmdbMovieData(title, year = '', imdbId = '') {
  if (!title && !imdbId) return null;
  if (!OMDB_API_KEY) return null;

  const key = normalizeCacheKey(title, year, imdbId);
  const cached = getCached(omdbDataCache, key);
  if (cached !== null) return cached;

  try {
    let url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}`;
    if (imdbId) {
      url += `&i=${encodeURIComponent(imdbId.trim())}`;
    } else {
      url += `&t=${encodeURIComponent(title.trim())}`;
      if (year) url += `&y=${encodeURIComponent(String(year).trim())}`;
    }

    const data = await fetchJson(url);
    if (data && data.Response === 'True') {
      const posterUrl = (data.Poster && data.Poster !== 'N/A') ? data.Poster : '';
      const payload = {
        title: data.Title,
        year: data.Year,
        rated: data.Rated,
        released: data.Released,
        runtime: data.Runtime,
        genre: data.Genre,
        director: data.Director,
        actors: data.Actors,
        plot: data.Plot,
        posterUrl,
        imdbRating: data.imdbRating,
        imdbID: data.imdbID,
        boxOffice: data.BoxOffice,
      };
      setCache(omdbDataCache, key, payload);
      if (posterUrl) {
        setCache(posterCache, key, posterUrl);
      }
      return payload;
    }
    return null;
  } catch (err) {
    console.warn(`[poster.service] OMDb lookup failed for "${title || imdbId}":`, err.message);
    return null;
  }
}

/**
 * Look up a movie poster URL by title, year, or imdbId.
 * Checks: 1. Memory Cache -> 2. OMDb API -> 3. TMDB API.
 * Returns a full poster URL string, or '' if not found.
 */
async function getPosterUrl(title, year = '', imdbId = '') {
  if (!title && !imdbId) return '';

  const key = normalizeCacheKey(title, year, imdbId);
  const cached = getCached(posterCache, key);
  if (cached !== null) return cached;

  // 1. Try OMDb API first
  if (OMDB_API_KEY) {
    const omdbData = await getOmdbMovieData(title, year, imdbId);
    if (omdbData && omdbData.posterUrl) {
      setCache(posterCache, key, omdbData.posterUrl);
      return omdbData.posterUrl;
    }
  }

  // 2. Fallback to TMDB API if title is available and TMDB is configured
  if (TMDB_API_KEY && title) {
    try {
      const query = encodeURIComponent(title.trim());
      const yearParam = year ? `&year=${encodeURIComponent(year)}` : '';
      const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${query}${yearParam}&page=1&include_adult=false`;

      const data = await fetchJson(url);
      const results = Array.isArray(data?.results) ? data.results : [];
      const exactMatch = results.find(
        (r) => String(r?.title || '').trim().toLowerCase() === title.trim().toLowerCase()
      );
      const best = exactMatch || results[0] || null;
      const posterPath = String(best?.poster_path || '').trim();
      const posterUrl = posterPath ? `${TMDB_IMAGE_BASE}${posterPath}` : '';

      if (posterUrl) {
        setCache(posterCache, key, posterUrl);
        return posterUrl;
      }
    } catch (err) {
      console.warn(`[poster.service] TMDB fallback failed for "${title}":`, err.message);
    }
  }

  // Cache empty string with short TTL or allow retry
  return '';
}

/**
 * Enrich an array of movie objects with posterUrl from OMDb/TMDB.
 * Modifies items in-place and returns the enriched array.
 */
async function enrichMoviesWithPosters(movies) {
  if (!Array.isArray(movies) || !movies.length) return movies;

  await Promise.all(
    movies.map(async (movie) => {
      if (movie.posterUrl) return; // Already has a poster
      const year = extractYear(movie.releaseDate || '');
      const imdbId = movie.imdbId || movie.imdbID || '';
      movie.posterUrl = await getPosterUrl(movie.title || '', year, imdbId);
      movie.hasPoster = !!movie.posterUrl;
    })
  );

  return movies;
}

function extractYear(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

module.exports = {
  getPosterUrl,
  getOmdbMovieData,
  enrichMoviesWithPosters
};
