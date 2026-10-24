const movieRecommendationService = require('../services/movie-recommendation.service');
const { getPosterUrl, getOmdbMovieData, enrichMoviesWithPosters } = require('../services/poster.service');

function readPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

exports.listMovies = async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();
    const page = readPositiveInt(req.query.page, 1, 5000);
    const limit = readPositiveInt(req.query.limit, 12, 40);
    const payload = await movieRecommendationService.listMovies(query, page, limit);
    // Enrich movies with TMDB poster URLs (cached server-side)
    if (Array.isArray(payload?.data)) {
      await enrichMoviesWithPosters(payload.data);
    }
    return res.json(payload);
  } catch (error) {
    console.error('MOVIE LIST ERROR', error);
    return res.status(500).json({ message: error.message || 'Movie list failed.' });
  }
};

exports.searchMovies = async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();

    if (!query) {
      return res.status(400).json({ message: 'Search query is required.' });
    }

    const limit = readPositiveInt(req.query.limit, 8, 20);
    const payload = await movieRecommendationService.searchMovies(query, limit);
    // Enrich search results with TMDB posters
    if (Array.isArray(payload?.results)) {
      await enrichMoviesWithPosters(payload.results);
    }
    if (payload?.closestMatch) {
      await enrichMoviesWithPosters([payload.closestMatch]);
    }
    return res.json(payload);
  } catch (error) {
    console.error('MOVIE SEARCH ERROR', error);
    return res.status(500).json({ message: error.message || 'Movie search failed.' });
  }
};

exports.getMovieById = async (req, res) => {
  try {
    const movieId = String(req.params.movieId || '').trim();
    if (!movieId) {
      return res.status(400).json({ message: 'Movie id is required.' });
    }

    const payload = await movieRecommendationService.getMovieById(movieId);
    // Enrich the single movie with a TMDB poster
    if (payload?.movie) {
      await enrichMoviesWithPosters([payload.movie]);
    }
    return res.json(payload);
  } catch (error) {
    console.error('MOVIE DETAIL ERROR', error);
    const status = /not found/i.test(error.message || '') ? 404 : 500;
    return res.status(status).json({ message: error.message || 'Movie detail failed.' });
  }
};

exports.getRecommendations = async (req, res) => {
  try {
    const title = String(req.query.title || '').trim();

    if (!title) {
      return res.status(400).json({ message: 'Movie title is required.' });
    }

    const limit = readPositiveInt(req.query.limit, 6, 20);
    const payload = await movieRecommendationService.getRecommendations(title, limit);

    // Enrich all recommendations and the selected/closest movie with TMDB posters
    const toEnrich = [
      ...(Array.isArray(payload?.recommendations) ? payload.recommendations : []),
      ...(payload?.selected ? [payload.selected] : []),
      ...(payload?.closestMatch ? [payload.closestMatch] : []),
    ];
    if (toEnrich.length) await enrichMoviesWithPosters(toEnrich);

    return res.json(payload);
  } catch (error) {
    console.error('MOVIE RECOMMENDATION ERROR', error);
    return res.status(500).json({ message: error.message || 'Movie recommendation failed.' });
  }
};

// GET /api/movies/poster?title=Inception&year=2010&imdbId=tt1375666
// Proxies OMDb/TMDB poster lookups server-side so API keys are NEVER exposed to the browser.
// Results are cached for 24 hours per title/imdbId.
exports.getPoster = async (req, res) => {
  try {
    const title = String(req.query.title || '').trim();
    const year = String(req.query.year || '').trim();
    const imdbId = String(req.query.imdbId || req.query.i || '').trim();

    if (!title && !imdbId) {
      return res.status(400).json({ message: 'title or imdbId query param is required.' });
    }

    const posterUrl = await getPosterUrl(title, year, imdbId);
    return res.json({ posterUrl });
  } catch (error) {
    console.error('POSTER LOOKUP ERROR', error);
    return res.status(500).json({ message: error.message || 'Poster lookup failed.' });
  }
};

// GET /api/movies/omdb?title=Inception&year=2010 OR ?imdbId=tt1375666
// Secure server-side proxy for OMDb metadata.
exports.getOmdbDetails = async (req, res) => {
  try {
    const title = String(req.query.title || req.query.t || '').trim();
    const year = String(req.query.year || req.query.y || '').trim();
    const imdbId = String(req.query.imdbId || req.query.i || '').trim();

    if (!title && !imdbId) {
      return res.status(400).json({ message: 'title or imdbId is required.' });
    }

    const movieData = await getOmdbMovieData(title, year, imdbId);
    if (!movieData) {
      return res.status(404).json({ message: 'Movie details not found in OMDb.' });
    }

    return res.json(movieData);
  } catch (error) {
    console.error('OMDB DETAIL ERROR', error);
    return res.status(500).json({ message: error.message || 'OMDb detail lookup failed.' });
  }
};
