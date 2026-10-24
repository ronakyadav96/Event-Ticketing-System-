const fs = require('fs');
const path = require('path');

const CACHE_TTL_MS = 10 * 60 * 1000;
const ARTIFACT_DIR =
  process.env.RECOMMENDER_DATA_DIR ||
  process.env.RECOMMENDER_OUTPUT_DIR ||
  path.join(__dirname, '..', 'data', 'movie-recommender');
const MOVIES_FILE = path.join(ARTIFACT_DIR, 'movies.json');
const NEIGHBORS_FILE = path.join(ARTIFACT_DIR, 'neighbors.json');
const METADATA_FILE = path.join(ARTIFACT_DIR, 'metadata.json');
const resultCache = new Map();

let indexState = null;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(' ') : [];
}

function getCacheKey(command, query, limit, page = 1) {
  return JSON.stringify([
    command,
    normalizeText(query),
    Number(limit) || 0,
    Number(page) || 1,
  ]);
}

function getCachedValue(key) {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedValue(key, value) {
  resultCache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureArtifactsPresent() {
  const missing = [MOVIES_FILE, NEIGHBORS_FILE].filter((filePath) => !fs.existsSync(filePath));
  if (!missing.length) return;

  throw new Error(
    `Movie recommender artifacts are missing. Run "npm run preprocess:movies" in event-ticketing-backend. Missing: ${missing
      .map((filePath) => path.basename(filePath))
      .join(', ')}`
  );
}

function loadIndex() {
  if (indexState) return indexState;

  ensureArtifactsPresent();

  const movies = readJson(MOVIES_FILE);
  const neighborsByMovieId = new Map(Object.entries(readJson(NEIGHBORS_FILE)));
  const metadata = fs.existsSync(METADATA_FILE) ? readJson(METADATA_FILE) : {};
  const movieById = new Map();
  const movieByNormalizedTitle = new Map();

  for (let index = 0; index < movies.length; index += 1) {
    const movie = movies[index];
    const prepared = {
      ...movie,
      movieId: String(movie.movieId || `title:${normalizeText(movie.title)}:${index}`).trim(),
      normalizedTitle: normalizeText(movie.normalizedTitle || movie.title),
      titleTokens: Array.isArray(movie.titleTokens) ? movie.titleTokens : tokenize(movie.title),
      tagTokens: Array.isArray(movie.tagTokens) ? movie.tagTokens : tokenize(movie.tags || ''),
      popularity: Number(movie.popularity) || 0,
      voteAverage: Number(movie.voteAverage) || 0,
      hasPoster: Boolean(movie.posterUrl),
    };
    prepared.discoveryCategory = getDiscoveryCategory(prepared);

    movieById.set(prepared.movieId, prepared);
    if (prepared.normalizedTitle && !movieByNormalizedTitle.has(prepared.normalizedTitle)) {
      movieByNormalizedTitle.set(prepared.normalizedTitle, prepared);
    }
  }

  indexState = {
    metadata,
    movies: Array.from(movieById.values()),
    movieById,
    movieByNormalizedTitle,
    neighborsByMovieId,
  };
  return indexState;
}

function includesAny(tokens, candidates) {
  return candidates.some((candidate) => tokens.includes(candidate));
}

function getDiscoveryCategory(movie) {
  const tokens = [
    ...(Array.isArray(movie?.titleTokens) ? movie.titleTokens : []),
    ...(Array.isArray(movie?.tagTokens) ? movie.tagTokens : []),
    ...tokenize(movie?.overview || ''),
  ];

  if (
    includesAny(tokens, [
      'scifi',
      'sciencefiction',
      'science',
      'space',
      'alien',
      'robot',
      'future',
      'spaceship',
      'interstellar',
      'time',
      'dystopia',
      'cyborg',
    ])
  ) {
    return 'Sci-Fi';
  }

  if (
    includesAny(tokens, [
      'thriller',
      'mystery',
      'crime',
      'detective',
      'psychological',
      'suspense',
      'murder',
      'investigation',
      'noir',
    ])
  ) {
    return 'Thriller';
  }

  if (
    includesAny(tokens, [
      'romance',
      'romantic',
      'love',
      'relationship',
      'couple',
      'marriage',
      'valentine',
      'heart',
    ])
  ) {
    return 'Romantic';
  }

  if (
    includesAny(tokens, [
      'action',
      'fight',
      'war',
      'battle',
      'superhero',
      'adventure',
      'hero',
      'mission',
      'explosion',
      'martial',
    ])
  ) {
    return 'Action';
  }

  if (
    includesAny(tokens, [
      'comedy',
      'funny',
      'humor',
      'laugh',
      'satire',
      'parody',
      'comic',
      'hilarious',
    ])
  ) {
    return 'Comedy';
  }

  return 'Drama';
}

function serializeMovie(movie) {
  if (!movie) return null;
  return {
    movieId: movie.movieId,
    title: movie.title,
    overview: movie.overview || '',
    releaseDate: movie.releaseDate || '',
    voteAverage: Number(movie.voteAverage) || 0,
    popularity: Number(movie.popularity) || 0,
    posterPath: movie.posterPath || '',
    posterUrl: movie.posterUrl || '',
    hasPoster: Boolean(movie.posterUrl),
    discoveryCategory: movie.discoveryCategory || 'Drama',
    similarityScore:
      typeof movie.similarityScore === 'number' ? Number(movie.similarityScore) : undefined,
  };
}

function boundedLevenshtein(a, b, maxDistance = 4) {
  if (a === b) return 0;
  if (!a.length) return b.length <= maxDistance ? b.length : Infinity;
  if (!b.length) return a.length <= maxDistance ? a.length : Infinity;
  if (Math.abs(a.length - b.length) > maxDistance) return Infinity;

  let prev = Array.from({ length: b.length + 1 }, (_, idx) => idx);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return Infinity;
    prev = curr;
  }

  return prev[b.length] <= maxDistance ? prev[b.length] : Infinity;
}

function getTokenOverlapScore(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidateSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateSet.has(token)) overlap += 1;
  }
  return overlap / queryTokens.length;
}

function scoreMovie(movie, normalizedQuery, queryTokens) {
  if (!normalizedQuery) return 0;

  let score = 0;
  const title = movie.normalizedTitle;
  const tagOverlap = getTokenOverlapScore(queryTokens, movie.tagTokens);
  const titleOverlap = getTokenOverlapScore(queryTokens, movie.titleTokens);

  if (title === normalizedQuery) score += 1000;
  else if (title.startsWith(normalizedQuery)) score += 800;
  else if (title.includes(normalizedQuery)) score += 600;
  else if (normalizedQuery.includes(title) && title.length > 2) score += 500;

  score += titleOverlap * 250;
  score += tagOverlap * 120;

  const distance = boundedLevenshtein(normalizedQuery, title, normalizedQuery.length > 12 ? 5 : 3);
  if (
    distance !== Infinity &&
    (title[0] === normalizedQuery[0] || titleOverlap > 0 || title.includes(normalizedQuery.slice(0, 3)))
  ) {
    score += 120 - distance * 25;
  }

  if (!score && !titleOverlap && !tagOverlap) {
    return -1;
  }

  score += Math.min(movie.popularity, 100) * 0.35;
  score += Math.min(movie.voteAverage, 10) * 1.5;
  return score;
}

function sortByScore(items) {
  return items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.movie.popularity || 0) !== (a.movie.popularity || 0)) {
      return (b.movie.popularity || 0) - (a.movie.popularity || 0);
    }
    return String(a.movie.title || '').localeCompare(String(b.movie.title || ''));
  });
}

function searchIndex(normalizedQuery, limit = 8) {
  const { movies, movieByNormalizedTitle } = loadIndex();
  const exact = movieByNormalizedTitle.get(normalizedQuery) || null;
  const queryTokens = tokenize(normalizedQuery);
  const scored = [];

  for (const movie of movies) {
    const score = movie === exact ? 9999 : scoreMovie(movie, normalizedQuery, queryTokens);
    if (score <= 0) continue;
    scored.push({ movie, score });
  }

  if (!scored.length && exact) {
    scored.push({ movie: exact, score: 9999 });
  }

  sortByScore(scored);
  const results = [];
  const seen = new Set();
  for (const entry of scored) {
    if (seen.has(entry.movie.movieId)) continue;
    seen.add(entry.movie.movieId);
    results.push(entry.movie);
    if (results.length >= limit) break;
  }

  return {
    exact,
    results,
    closestMatch: results[0] || null,
  };
}

function resolveMovie(query) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return {
      exactMatch: false,
      selected: null,
      suggestions: [],
      normalizedQuery,
    };
  }

  const { exact, results, closestMatch } = searchIndex(normalizedQuery, 10);
  return {
    exactMatch: Boolean(exact && exact.normalizedTitle === normalizedQuery),
    selected: exact || closestMatch || null,
    suggestions: results,
    normalizedQuery,
  };
}

function pickRecommendations(movieId, limit) {
  const { movieById, neighborsByMovieId } = loadIndex();
  const neighbors = neighborsByMovieId.get(String(movieId)) || [];
  const recommendations = [];

  for (const neighbor of neighbors) {
    const movie = movieById.get(String(neighbor.movieId));
    if (!movie) continue;
    recommendations.push({
      ...movie,
      similarityScore: Number(neighbor.score) || 0,
    });
    if (recommendations.length >= limit) break;
  }

  return recommendations;
}

function searchMovies(query, limit = 8) {
  const cacheKey = getCacheKey('search', query, limit);
  const cached = getCachedValue(cacheKey);
  if (cached) return Promise.resolve(cached);

  const normalizedQuery = normalizeText(query);
  const { exactMatch, selected, suggestions } = resolveMovie(normalizedQuery);
  const payload = {
    ok: true,
    query: String(query || '').trim(),
    normalizedQuery,
    exactMatch,
    closestMatch: selected ? serializeMovie(selected) : undefined,
    results: suggestions.slice(0, limit).map(serializeMovie),
  };

  setCachedValue(cacheKey, payload);
  return Promise.resolve(payload);
}

function listMovies(query = '', page = 1, limit = 12) {
  const cacheKey = getCacheKey('list', query, limit, page);
  const cached = getCachedValue(cacheKey);
  if (cached) return Promise.resolve(cached);

  const { movies } = loadIndex();
  const normalizedQuery = normalizeText(query);
  let filtered;

  if (normalizedQuery) {
    filtered = searchIndex(normalizedQuery, Math.min(500, movies.length)).results;
  } else {
    filtered = [...movies].sort((a, b) => {
      if ((b.popularity || 0) !== (a.popularity || 0)) {
        return (b.popularity || 0) - (a.popularity || 0);
      }
      return String(a.title || '').localeCompare(String(b.title || ''));
    });
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const start = (page - 1) * limit;
  const data = filtered.slice(start, start + limit);
  const payload = {
    ok: true,
    data: data.map(serializeMovie),
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
  };

  setCachedValue(cacheKey, payload);
  return Promise.resolve(payload);
}

function getRecommendations(title, limit = 6) {
  const cacheKey = getCacheKey('recommend', title, limit);
  const cached = getCachedValue(cacheKey);
  if (cached) return Promise.resolve(cached);

  const { exactMatch, selected, suggestions } = resolveMovie(title);
  if (!selected) {
    const payload = {
      ok: true,
      matchedTitle: '',
      exactMatch: false,
      selected: undefined,
      closestMatch: undefined,
      recommendations: [],
      suggestions: [],
    };
    setCachedValue(cacheKey, payload);
    return Promise.resolve(payload);
  }

  const recommendations = pickRecommendations(selected.movieId, limit);
  const payload = {
    ok: true,
    matchedTitle: selected.title,
    exactMatch,
    selected: serializeMovie(selected),
    closestMatch: exactMatch ? undefined : serializeMovie(selected),
    recommendations: recommendations.map(serializeMovie),
    suggestions: (exactMatch ? suggestions.slice(0, 5) : suggestions.slice(0, 8)).map(serializeMovie),
    metadata: loadIndex().metadata,
  };

  setCachedValue(cacheKey, payload);
  return Promise.resolve(payload);
}

function getMovieById(movieId) {
  const { movieById } = loadIndex();
  const movie = movieById.get(String(movieId || '').trim());
  if (!movie) {
    return Promise.reject(new Error('Movie not found in dataset.'));
  }

  return Promise.resolve({
    ok: true,
    movie: serializeMovie(movie),
  });
}

module.exports = {
  listMovies,
  getMovieById,
  searchMovies,
  getRecommendations,
};

// Fail fast on startup and keep the first request warm.
loadIndex();
