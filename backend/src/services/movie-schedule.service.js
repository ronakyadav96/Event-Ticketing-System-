// services/movie-schedule.service.js
// Keeps the imported TMDB movie catalog bookable.
//
// Imported movies get a fixed 30-day run when they are imported. Once that window passes,
// every movie becomes "no upcoming shows" and nothing can be booked from the catalog or the
// AI assistant. Imported movies are an always-running catalog, so expired runs are rolled
// forward to [today, today + MOVIE_RUN_DAYS]. Creator-made events are never touched.

const https = require('https');
const Event = require('../models/Event');

const MOVIE_SOURCE_TYPE = 'tmdb_movie';
const MOVIE_RUN_DAYS = Number(process.env.MOVIE_RUN_DAYS || 30);
const TMDB_IMAGE_BASE_URL = (process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p/w500').replace(/\/+$/, '');

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Imported movies whose run has ended (or ends within `minDaysLeft` days).
function expiredMovieFilter(minDaysLeft = 0) {
  const threshold = todayUtc();
  threshold.setUTCDate(threshold.getUTCDate() + minDaysLeft);
  return { sourceType: MOVIE_SOURCE_TYPE, $or: [{ endDate: { $lt: threshold } }, { endDate: null }] };
}

/** Rolls expired imported movie runs forward. Returns the number of events updated. */
async function rollExpiredMovieSchedules({ minDaysLeft = 0 } = {}) {
  const startDate = todayUtc();
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + MOVIE_RUN_DAYS);
  const date = new Date(startDate);
  date.setUTCHours(18, 0, 0, 0);

  const result = await Event.updateMany(expiredMovieFilter(minDaysLeft), { $set: { startDate, endDate, date } });
  return Number(result.modifiedCount || 0);
}

function fetchTmdbPosterPath(movieId, apiKey) {
  const url = `https://api.themoviedb.org/3/movie/${encodeURIComponent(movieId)}?api_key=${apiKey}`;
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body).poster_path || null : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** Fills in missing posters for imported movies from TMDB. Returns { checked, updated }. */
async function backfillMoviePosters({ concurrency = 8, limit = 0, onProgress } = {}) {
  const apiKey = (process.env.TMDB_API_KEY || '').trim();
  if (!apiKey) throw new Error('TMDB_API_KEY is not set');

  const query = Event.find({
    sourceType: MOVIE_SOURCE_TYPE,
    sourceMovieId: { $nin: [null, ''] },
    $or: [{ imageUrl: { $in: [null, ''] } }, { imageUrl: { $exists: false } }],
  }).select('_id sourceMovieId');
  if (limit > 0) query.limit(limit);
  const pending = await query.lean();

  let next = 0;
  let updated = 0;
  async function worker() {
    while (next < pending.length) {
      const event = pending[next++];
      const posterPath = await fetchTmdbPosterPath(event.sourceMovieId, apiKey);
      if (posterPath) {
        const imageUrl = `${TMDB_IMAGE_BASE_URL}/${posterPath.replace(/^\/+/, '')}`;
        await Event.updateOne(
          { _id: event._id },
          { $set: { imageUrl, 'movieMeta.posterPath': posterPath, 'movieMeta.posterUrl': imageUrl } }
        );
        updated++;
      }
      if (onProgress && next % 200 === 0) onProgress(next, pending.length, updated);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { checked: pending.length, updated };
}

module.exports = {
  MOVIE_SOURCE_TYPE,
  expiredMovieFilter,
  rollExpiredMovieSchedules,
  backfillMoviePosters,
};
