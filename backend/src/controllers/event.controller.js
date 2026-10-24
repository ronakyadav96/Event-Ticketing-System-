// controllers/event.controller.js
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const crypto = require('crypto');
const path = require('path');

const Event = require('../models/Event');
const User = require('../models/User');
const movieRecommendationService = require('../services/movie-recommendation.service');
const { getPosterUrl } = require('../services/poster.service');
const showtime = require('../utils/showtime.util');

// =======================
// GridFS Helper
// =======================
function getBucket() {
  if (!mongoose.connection?.db) return null;
  return new GridFSBucket(mongoose.connection.db, { bucketName: 'eventImages' });
}

// =======================
// URL Helpers
// =======================
function getBaseUrl(req) {
  const envBase = (process.env.BASE_URL || '').trim();

  if (envBase) return envBase.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function buildImagePath(eventId) {
  return `/api/events/${eventId}/image`;
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMovieId(input) {
  return String(input || '').trim();
}

function isValidObjectId(value) {
  if (!value) return false;
  return mongoose.Types.ObjectId.isValid(String(value));
}

function sanitizeEventDocumentForSave(event) {
  if (!event) return;

  if (event.imageFileId && !isValidObjectId(event.imageFileId)) {
    event.imageFileId = null;
  }

  if (!event.imageUrl) {
    event.imageUrl = '';
  }

  if (!Array.isArray(event.showTimes)) {
    event.showTimes = [];
  }
}

function getReadableSaveError(error) {
  if (!error) return 'Update failed';

  if (error.name === 'ValidationError' && error.errors) {
    const firstError = Object.values(error.errors)[0];
    return firstError?.message || error.message || 'Validation failed';
  }

  if (error.name === 'CastError') {
    const field = error.path || 'field';
    return `Invalid value for ${field}.`;
  }

  return error.message || 'Update failed';
}

const DEFAULT_CATEGORIES = [
  'Conference',
  'Workshop',
  'Seminar',
  'Concert',
  'Webinar',
  'Movie',
  'Comedy',
  'Sports',
  'Plays',
  'Activities',
];

function parseDateOnly(input) {
  const s = String(input || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseShowTimes(input) {
  if (!input) return [];

  let raw = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    try {
      raw = JSON.parse(trimmed);
    } catch {
      raw = trimmed.split(',').map((t) => t.trim());
    }
  }

  const list = Array.isArray(raw) ? raw : [raw];

  const seen = new Set();
  const out = [];

  for (const item of list) {
    const t = String(item || '').trim();
    if (!t) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }

  return out;
}

// Show times are wall-clock times in the event time zone (EVENT_TIMEZONE), not UTC.
function toHHmmFromDateUTC(d) {
  if (!d) return '';
  return showtime.hhmmInTz(d, showtime.getEventTimeZone());
}

function combineUtcDateAndTime(dateOnly, hhmm) {
  if (!dateOnly || !hhmm || !/^\d{1,2}:\d{2}$/.test(String(hhmm))) return null;
  const d = showtime.zonedDateTimeToUtc(dateOnly.toISOString().slice(0, 10), String(hhmm));
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// Optional listing fields (city, language, age rating, tagline, duration, featured) from a create/update body.
function listingFieldsFrom(body, { partial }) {
  const out = {};
  for (const key of ['city', 'language', 'ageRestriction', 'tagline']) {
    if (body[key] != null) out[key] = String(body[key]).trim();
    else if (!partial) out[key] = '';
  }
  if (body.durationMinutes != null && body.durationMinutes !== '') {
    const n = Number(body.durationMinutes);
    out.durationMinutes = Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (body.featured != null) out.featured = String(body.featured) === 'true' || body.featured === true;
  return out;
}

// =======================
// Upload Buffer to GridFS
// =======================
async function uploadBufferToGridFS(file) {
  const bucket = getBucket();
  if (!bucket) throw new Error('MongoDB not connected');

  const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
  const rand = crypto.randomBytes(16).toString('hex');
  const filename = `event-${Date.now()}-${rand}${ext}`;

  return await new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: file.mimetype,
    });

    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id));

    uploadStream.end(file.buffer);
  });
}

// =======================
// CREATE EVENT
// =======================
exports.createEvent = async (req, res) => {
  try {
    if (!req.user || !['creator', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Not authorized to create events' });
    }

    const {
      title,
      description,
      date,
      startDate,
      endDate,
      showTimes,
      venue,
      price,
      totalSeats,
      category,
      locationType,
      registrationTemplate,
      designTemplate,
      imagePreset,
      designConfig,
      customFields,
    } = req.body;

    if (!title || !venue || price == null || totalSeats == null || !category) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    const parsedStartDate = parseDateOnly(startDate);
    const parsedEndDate = parseDateOnly(endDate);
    const parsedShowTimes = parseShowTimes(showTimes);

    let legacyDate = date ? new Date(date) : null;
    if (legacyDate && Number.isNaN(legacyDate.getTime())) legacyDate = null;

    // Backward compatibility: allow old payload with only `date`
    const hasSchedule = Boolean(parsedStartDate && parsedEndDate);

    if (hasSchedule) {
      if (parsedEndDate.getTime() < parsedStartDate.getTime()) {
        return res.status(400).json({ message: 'endDate must be after startDate' });
      }

      if (!legacyDate && parsedShowTimes.length) {
        legacyDate = combineUtcDateAndTime(parsedStartDate, parsedShowTimes[0]);
      }
    }

    if (!legacyDate) {
      return res.status(400).json({ message: 'date missing/invalid' });
    }

    const scheduleStart = hasSchedule ? parsedStartDate : parseDateOnly(legacyDate.toISOString().slice(0, 10));
    const scheduleEnd = hasSchedule ? parsedEndDate : scheduleStart;
    const times = parsedShowTimes.length ? parsedShowTimes : [toHHmmFromDateUTC(legacyDate)];

    let imageFileId = null;

    if (req.file) {
      imageFileId = await uploadBufferToGridFS(req.file);
    }

    const parsedCustomFields = parseCustomFields(customFields);
    const parsedDesignConfig = parseJsonObject(designConfig);

    const event = await Event.create({
      title: String(title).trim(),
      description: description ? String(description).trim() : '',
      date: legacyDate,
      startDate: scheduleStart,
      endDate: scheduleEnd,
      showTimes: times,
      venue: String(venue).trim(),
      price: Number(price),
      totalSeats: Number(totalSeats),
      category: String(category).trim(),
      locationType: locationType ? String(locationType).trim() : '',
      ...listingFieldsFrom(req.body, { partial: false }),
      bookedSeats: 0,
      createdBy: req.user.id, // ownership
      imageFileId,
      imageUrl: imageFileId ? buildImagePath(undefined) : '',
      registrationTemplate: registrationTemplate || 'standard',
      designTemplate: designTemplate || 'clean-hero',
      imagePreset: imagePreset || 'preset-a',
      designConfig: parsedDesignConfig,
      customFields: parsedCustomFields,
    });

    if (imageFileId) {
      event.imageUrl = buildImagePath(event._id);
      await event.save();
    }

    return res.status(201).json(event);

  } catch (error) {
    console.error('CREATE EVENT ERROR ❌', error);
    return res.status(500).json({ message: 'Server error while creating event' });
  }
};

// Genre matching against movie tags. Imported movie tags are stemmed tokens
// ("sciencefict", "comedi", "romanc"), so match token prefixes of a few stem candidates,
// plus whole-word matches in title/description/category.
function genreStemCandidates(genre) {
  const compact = String(genre || '').toLowerCase().replace(/[^a-z]/g, '');
  if (compact.length < 3) return [];
  const out = new Set([compact]);
  if (compact.endsWith('y')) out.add(`${compact.slice(0, -1)}i`);
  if (compact.endsWith('e')) out.add(compact.slice(0, -1));
  if (compact.endsWith('ation')) out.add(compact.slice(0, -5));
  if (compact.endsWith('ion')) out.add(compact.slice(0, -3));
  if (compact.endsWith('s')) out.add(compact.slice(0, -1));
  return [...out].filter((c) => c.length >= 4);
}

function buildGenreFilter(genre) {
  const words = new RegExp(`\\b${escapeRegex(genre).replace(/[\s-]+/g, '[\\s-]*')}\\b`, 'i');
  const stems = genreStemCandidates(genre);
  const or = [{ title: words }, { description: words }, { category: words }];
  if (stems.length) {
    or.push({ 'movieMeta.tags': new RegExp(`(^|\\s)(${stems.map(escapeRegex).join('|')})`, 'i') });
  }
  return { $or: or };
}

function searchTerms(raw) {
  const words = String(raw || '')
    .toLowerCase()
    .split(/[\s,;:!?"()]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  const unique = [...new Set(words)].slice(0, 8);
  return unique.length ? unique : [String(raw).trim()];
}

function startOfTodayUtc() {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

const MOVIE_CATEGORY = /^movies?$/i;

const SORTS = {
  relevance: { _score: -1, 'movieMeta.popularity': -1, startDate: 1, _id: 1 },
  date: { isUpcoming: -1, startDate: 1, _id: 1 },
  dateDesc: { startDate: -1, _id: 1 },
  priceAsc: { isUpcoming: -1, price: 1, _id: 1 },
  priceDesc: { isUpcoming: -1, price: -1, _id: 1 },
  popular: { isUpcoming: -1, featured: -1, 'movieMeta.popularity': -1, bookedSeats: -1, _id: 1 },
};

// Ranked, stably ordered search. Score: exact title > title prefix > title contains > each query
// word found in the title; events with upcoming shows and featured events rank higher; ties break
// on popularity, date and _id so that page N+1 never repeats page N.
async function rankedSearch(filter, rawQuery, page, limit, sortKey = 'relevance') {
  const today = startOfTodayUtc();
  const q = String(rawQuery || '').trim().toLowerCase();
  const titleLower = { $toLower: '$title' };
  const isUpcoming = { $gte: [{ $ifNull: ['$endDate', '$date'] }, today] };
  const titleScore = q
    ? {
        $add: [
          { $cond: [{ $eq: [titleLower, q] }, 100, 0] },
          { $cond: [{ $eq: [{ $indexOfCP: [titleLower, q] }, 0] }, 40, 0] },
          { $cond: [{ $gte: [{ $indexOfCP: [titleLower, q] }, 0] }, 20, 0] },
          ...searchTerms(q).map((t) => ({ $cond: [{ $gte: [{ $indexOfCP: [titleLower, t] }, 0] }, 15, 0] })),
        ],
      }
    : 0;

  const [result] = await Event.aggregate([
    { $match: filter },
    {
      $addFields: {
        isUpcoming,
        _score: {
          $add: [titleScore, { $cond: [isUpcoming, 30, 0] }, { $cond: [{ $eq: ['$featured', true] }, 10, 0] }],
        },
      },
    },
    { $sort: SORTS[sortKey] || SORTS.relevance },
    {
      $facet: {
        data: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: { _score: 0, __v: 0 } }],
        total: [{ $count: 'n' }],
      },
    },
  ]);

  const total = result?.total?.[0]?.n || 0;
  const data = (result?.data || []).map((e) => ({ ...e, id: e._id }));
  return { data, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// Builds the Mongo filter for every public listing/search option (all optional, all combinable):
// q, category (comma list), live, city, genre, venue, title, minPrice, maxPrice, from, to,
// upcoming, exclude, sourceMovieId, sourceType.
function buildEventFilter(query) {
  const filter = {};
  const and = [];

  const categories = String(query.category || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && c.toLowerCase() !== 'all');
  if (categories.length === 1) {
    filter.category = new RegExp(`^${escapeRegex(categories[0])}$`, 'i');
  } else if (categories.length > 1) {
    filter.category = { $in: categories.map((c) => new RegExp(`^${escapeRegex(c)}$`, 'i')) };
  }

  // live=true: everything except movies (BookMyShow's "Events" section).
  if (String(query.live || '').toLowerCase() === 'true') {
    and.push({ category: { $not: MOVIE_CATEGORY } });
  }

  const sourceMovieId = normalizeMovieId(query.sourceMovieId);
  if (sourceMovieId) filter.sourceMovieId = sourceMovieId;
  const sourceType = String(query.sourceType || '').trim();
  if (sourceType) filter.sourceType = new RegExp(`^${escapeRegex(sourceType)}$`, 'i');

  // Every query word must match some field.
  const rawQuery = String(query.q || query.query || '').trim();
  if (rawQuery) {
    for (const term of searchTerms(rawQuery)) {
      const termRegex = new RegExp(escapeRegex(term), 'i');
      and.push({
        $or: [
          { title: termRegex },
          { venue: termRegex },
          { city: termRegex },
          { category: termRegex },
          { description: termRegex },
          { sourceMovieId: termRegex },
          { 'movieMeta.tags': termRegex },
        ],
      });
    }
  }

  // An event without a city is shown everywhere.
  const city = String(query.city || '').trim();
  if (city && city.toLowerCase() !== 'all') {
    and.push({ $or: [{ city: new RegExp(`^${escapeRegex(city)}$`, 'i') }, { city: { $in: ['', null] } }] });
  }

  const genre = String(query.genre || '').trim();
  if (genre) and.push(buildGenreFilter(genre));

  const venue = String(query.venue || '').trim();
  if (venue) filter.venue = new RegExp(escapeRegex(venue), 'i');

  const title = String(query.title || '').trim();
  if (title) filter.title = new RegExp(`^${escapeRegex(title)}$`, 'i');

  const maxPrice = query.maxPrice === undefined || query.maxPrice === '' ? NaN : Number(query.maxPrice);
  const minPrice = query.minPrice === undefined || query.minPrice === '' ? NaN : Number(query.minPrice);
  if (Number.isFinite(maxPrice) || Number.isFinite(minPrice)) {
    filter.price = {};
    if (Number.isFinite(maxPrice)) filter.price.$lte = maxPrice;
    if (Number.isFinite(minPrice)) filter.price.$gte = minPrice;
  }

  // Date window: event runs on at least one day inside [from, to].
  const from = parseDateOnly(query.from);
  const to = parseDateOnly(query.to);
  if (from) and.push({ $or: [{ endDate: { $gte: from } }, { endDate: null, date: { $gte: from } }] });
  if (to) and.push({ $or: [{ startDate: { $lte: to } }, { startDate: null, date: { $lte: to } }] });

  if (String(query.upcoming || '').toLowerCase() === 'true') {
    and.push({ $or: [{ endDate: { $gte: startOfTodayUtc() } }, { endDate: null, date: { $gte: new Date() } }] });
  }

  const exclude = String(query.exclude || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id)); // aggregate() does not cast strings
  if (exclude.length) filter._id = { $nin: exclude };

  if (and.length) filter.$and = and;
  return { filter, rawQuery };
}

// =======================
// GET ALL EVENTS (PUBLIC)
// =======================
exports.getAllEvents = async (req, res) => {
  try {
    const { filter, rawQuery } = buildEventFilter(req.query);

    const pageRaw = parseInt(req.query.page, 10);
    const limitRaw = parseInt(req.query.limit, 10);
    const paged = 'page' in req.query || 'limit' in req.query;
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 10;

    // Text searches are always relevance-ranked; listings use the requested sort.
    const requestedSort = String(req.query.sort || '').trim();
    const sortKey = SORTS[requestedSort] ? requestedSort : rawQuery ? 'relevance' : '';

    if (!paged && !sortKey) {
      // Legacy unpaged list (dashboards).
      const events = await Event.find(filter).sort({ date: 1 }).limit(100);
      return res.json(events);
    }

    return res.json(await rankedSearch(filter, rawQuery, page, limit, sortKey || 'date'));
  } catch (error) {
    console.error('GET ALL EVENTS ERROR ❌', error);
    return res.status(500).json({ message: 'Failed to fetch events' });
  }
};

// =======================
// SEARCH SUGGESTIONS (PUBLIC) — header search dropdown
// GET /api/events/suggest?q=&city=
// =======================
function suggestionOf(e) {
  return {
    id: String(e._id),
    title: e.title,
    category: e.category,
    venue: e.venue,
    city: e.city || '',
    price: e.price,
    startDate: e.startDate || e.date,
    endDate: e.endDate || e.startDate || e.date,
    imageUrl: e.imageUrl || e.movieMeta?.posterUrl || '',
    rating: e.movieMeta?.voteAverage || null,
    isUpcoming: e.isUpcoming,
  };
}

exports.getSuggestions = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ query: q, events: [], movies: [] });
    const city = req.query.city;
    const live = buildEventFilter({ q, city, live: 'true' }).filter;
    const movies = buildEventFilter({ q, city, category: 'Movie' }).filter;
    const [ev, mv] = await Promise.all([rankedSearch(live, q, 1, 5), rankedSearch(movies, q, 1, 5)]);
    return res.json({
      query: q,
      events: ev.data.map(suggestionOf),
      movies: mv.data.map(suggestionOf),
      totalEvents: ev.total,
      totalMovies: mv.total,
    });
  } catch (error) {
    console.error('GET SUGGESTIONS ERROR ❌', error);
    return res.status(500).json({ message: 'Failed to fetch suggestions' });
  }
};

exports.getMovieEventBySource = async (req, res) => {
  try {
    const sourceMovieId = normalizeMovieId(req.params.movieId || req.query.sourceMovieId);
    if (!sourceMovieId) {
      return res.status(400).json({ message: 'sourceMovieId is required' });
    }

    let event = await Event.findOne({ sourceMovieId }).sort({ updatedAt: -1, createdAt: -1 });
    if (!event) {
      // Look up movie from catalog to auto-materialize a real bookable event document
      try {
        const moviePayload = await movieRecommendationService.getMovieById(sourceMovieId);
        const m = moviePayload?.movie;
        if (m) {
          const creator =
            (await User.findOne({ role: { $in: ['creator', 'admin', 'superadmin'] } })) ||
            (await User.findOne());

          if (creator) {
            const posterUrl =
              m.posterUrl ||
              (await getPosterUrl(m.title, (m.releaseDate || '').slice(0, 4))) ||
              '';
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(10, 0, 0, 0);

            event = await Event.create({
              title: m.title,
              description:
                m.overview ||
                `Experience ${m.title} in cinema with Dolby Atmos sound and 4K digital projection.`,
              date: tomorrow,
              startDate: tomorrow,
              endDate: new Date(tomorrow.getTime() + 7 * 86400000),
              showTimes: ['10:00', '13:15', '16:30', '19:45', '22:30'],
              venue: 'PVR ICON: Phoenix Palladium, Lower Parel',
              price: 250,
              category: 'Movie',
              totalSeats: 120,
              bookedSeats: 15,
              imageUrl: posterUrl,
              sourceMovieId: String(sourceMovieId),
              sourceType: 'tmdb',
              createdBy: creator._id,
              movieMeta: {
                movieTitle: m.title,
                releaseDate: m.releaseDate || '',
                posterUrl: posterUrl,
                voteAverage: m.voteAverage || 8.5,
              },
            });
          }
        }
      } catch (autoErr) {
        console.warn('Auto-materializing movie event failed:', autoErr.message);
      }
    }

    if (!event) {
      return res.status(404).json({ message: 'Movie event not found' });
    }

    return res.json(event);
  } catch (error) {
    console.error('GET MOVIE EVENT BY SOURCE ERROR', error);
    return res.status(500).json({ message: 'Failed to fetch movie event' });
  }
};

// =======================
// GET CATEGORIES (PUBLIC)
// =======================
exports.getCategories = async (req, res) => {
  try {
    const distinct = await Event.distinct('category');
    const merged = Array.from(
      new Set(
        [...DEFAULT_CATEGORIES, ...(distinct || [])]
          .map((c) => String(c || '').trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    return res.json({ categories: merged });
  } catch (error) {
    console.error('GET CATEGORIES ERROR ❌', error);
    return res.status(500).json({ message: 'Failed to fetch categories' });
  }
};

// =======================
// GET MY EVENTS (CREATOR)
// =======================
exports.getMyEvents = async (req, res) => {
  try {
    if (!req.user || req.user.role !== 'creator') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const events = await Event.find({ createdBy: req.user.id });
    return res.json(events);

  } catch (error) {
    console.error('GET MY EVENTS ERROR ❌', error);
    return res.status(500).json({ message: 'Failed to fetch events' });
  }
};

// =======================
// GET EVENT BY ID
// =======================
exports.getEventById = async (req, res) => {
  try {
    const eventId = req.params.id;

    if (!isValidObjectId(eventId)) {
      return res.status(400).json({ message: 'Invalid event ID' });
    }

    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ message: 'Event not found' });
    }

    const doc = event.toJSON();

    // If the event has no image, try to fetch one from TMDB using
    // the movie title stored in movieMeta (or the event title itself).
    // Results are cached 24h server-side — no external API key exposed to browser.
    if (!doc.imageUrl && !doc.imageFileId) {
      const lookupTitle =
        doc.movieMeta?.movieTitle ||
        doc.movieMeta?.title ||
        doc.title ||
        '';
      const lookupYear = extractYearFromString(
        doc.movieMeta?.releaseDate || doc.date || ''
      );

      const posterUrl = await getPosterUrl(lookupTitle, lookupYear);
      if (posterUrl) {
        doc.imageUrl = posterUrl;
        if (!doc.movieMeta) doc.movieMeta = {};
        doc.movieMeta.posterUrl = posterUrl;
      }
    }

    return res.json(doc);

  } catch (error) {
    console.error('GET EVENT BY ID ERROR ❌', error);
    return res.status(400).json({ message: 'Invalid event ID' });
  }
};

function extractYearFromString(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : '';
}

// =======================
// UPDATE EVENT
// =======================
exports.updateEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // 🔒 Ownership Check
    if (
      req.user.role === 'creator' &&
      event.createdBy.toString() !== req.user.id
    ) {
      return res.status(403).json({ message: 'Not authorized to update this event' });
    }

    const updates = {};

    if (req.body.title != null) updates.title = String(req.body.title).trim();
    if (req.body.description != null) updates.description = String(req.body.description).trim();

    // Schedule fields (optional)
    const parsedStartDate = parseDateOnly(req.body.startDate);
    const parsedEndDate = parseDateOnly(req.body.endDate);
    const parsedShowTimes = parseShowTimes(req.body.showTimes);

    if (parsedStartDate && parsedEndDate && parsedEndDate.getTime() < parsedStartDate.getTime()) {
      return res.status(400).json({ message: 'endDate must be after startDate' });
    }

    if (req.body.date != null) {
      const d = new Date(req.body.date);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'Invalid date' });
      updates.date = d;
    }

    if (parsedStartDate) updates.startDate = parsedStartDate;
    if (parsedEndDate) updates.endDate = parsedEndDate;
    if (parsedShowTimes.length) updates.showTimes = parsedShowTimes;

    const nextStartDate = parsedStartDate || event.startDate;
    const nextShowTimes = parsedShowTimes.length ? parsedShowTimes : event.showTimes;

    // If schedule is sent without `date`, keep legacy date aligned with startDate + first showTime (fallback)
    if (
      (parsedStartDate || parsedEndDate || parsedShowTimes.length) &&
      req.body.date == null &&
      nextStartDate &&
      Array.isArray(nextShowTimes) &&
      nextShowTimes.length
    ) {
      const combined = combineUtcDateAndTime(nextStartDate, nextShowTimes[0]);
      if (combined) updates.date = combined;
    }

    if (req.body.venue != null) updates.venue = String(req.body.venue).trim();
    if (req.body.price != null) updates.price = Number(req.body.price);
    if (req.body.totalSeats != null) updates.totalSeats = Number(req.body.totalSeats);
    if (req.body.category != null) updates.category = String(req.body.category).trim();
    if (req.body.locationType != null) updates.locationType = String(req.body.locationType).trim();
    if (req.body.registrationTemplate != null) updates.registrationTemplate = String(req.body.registrationTemplate);
    if (req.body.designTemplate != null) updates.designTemplate = String(req.body.designTemplate);
    if (req.body.imagePreset != null) updates.imagePreset = String(req.body.imagePreset);
    if (req.body.designConfig != null) updates.designConfig = parseJsonObject(req.body.designConfig);
    if (req.body.customFields != null) updates.customFields = parseCustomFields(req.body.customFields);
    Object.assign(updates, listingFieldsFrom(req.body, { partial: true }));
    if (req.file) {
      const newId = await uploadBufferToGridFS(req.file);
      updates.imageFileId = newId;
      updates.imageUrl = buildImagePath(event._id);
    }

    const updatedEvent = await Event.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      {
        new: true,
        runValidators: true,
      }
    );

    sanitizeEventDocumentForSave(updatedEvent);
    return res.json(updatedEvent);

  } catch (error) {
    console.error('UPDATE EVENT ERROR ❌', error);
    return res.status(400).json({ message: getReadableSaveError(error) });
  }
};

// =======================
// DELETE EVENT
// =======================
exports.deleteEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    if (
      req.user.role === 'creator' &&
      event.createdBy.toString() !== req.user.id
    ) {
      return res.status(403).json({ message: 'Not authorized to delete this event' });
    }

    await event.deleteOne();
    return res.json({ message: 'Event deleted successfully' });

  } catch (error) {
    console.error('DELETE EVENT ERROR ❌', error);
    return res.status(400).json({ message: 'Delete failed' });
  }
};

// =======================
// BOOK SEATS (USER)
// =======================
function parseCustomFields(input) {
  if (!input) return [];
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((f) => ({
        label: String(f?.label || '').trim(),
        type: String(f?.type || 'text'),
        required: Boolean(f?.required),
        options: Array.isArray(f?.options) ? f.options.map((o) => String(o)) : [],
      }))
      .filter((f) => f.label);
  } catch {
    return [];
  }
}

function parseJsonObject(input) {
  if (!input) return {};
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}





// =======================
// AI ASSISTANT: AUTHORITATIVE BOOKING DATA
// =======================
const { listShowSlots, isBookableSlot, getEventTimeZone } = require('../utils/showtime.util');
const { buildSeatLayout, MAX_SEATS_PER_BOOKING } = require('../utils/seat-map.util');
const seatReservations = require('../services/seat-reservation.service');

// GET /api/events/facets — values that actually exist in the catalog.
// categories / venues: plain lists (used by the AI assistant); categoryCounts: upcoming events per
// category; cities; priceRange — used by the explore page filters.
exports.getFacets = async (req, res) => {
  try {
    const today = startOfTodayUtc();
    const upcoming = { $or: [{ endDate: { $gte: today } }, { endDate: null, date: { $gte: today } }] };
    const [categories, venues, cities, counts, prices] = await Promise.all([
      Event.distinct('category'),
      Event.distinct('venue'),
      Event.distinct('city'),
      Event.aggregate([{ $match: upcoming }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
      Event.aggregate([{ $match: upcoming }, { $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }]),
    ]);
    // Case-insensitive de-duplication ("city mall" / "City Mall"), keeping the first spelling.
    const clean = (list) => {
      const seen = new Map();
      for (const v of list || []) {
        const t = String(v || '').trim();
        if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
      }
      return [...seen.values()].sort((a, b) => a.localeCompare(b));
    };
    return res.json({
      categories: clean(categories),
      venues: clean(venues),
      cities: clean(cities),
      categoryCounts: Object.fromEntries(counts.filter((c) => c._id).map((c) => [c._id, c.n])),
      priceRange: { min: prices[0]?.min ?? 0, max: prices[0]?.max ?? 0 },
    });
  } catch (error) {
    console.error('GET FACETS ERROR ❌', error);
    return res.status(500).json({ message: 'Failed to fetch facets' });
  }
};

// GET /api/events/:id/schedule — every future bookable show slot.
exports.getEventSchedule = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Event not found' });
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const slots = listShowSlots(event);
    return res.json({
      eventId: String(event._id),
      title: event.title,
      venue: event.venue,
      timeZone: getEventTimeZone(),
      price: event.price,
      currency: 'inr',
      maxSeatsPerBooking: MAX_SEATS_PER_BOOKING,
      dates: [...new Set(slots.map((s) => s.date))],
      slots,
    });
  } catch (error) {
    console.error('GET EVENT SCHEDULE ERROR ❌', error);
    return res.status(500).json({ message: 'Failed to fetch schedule' });
  }
};

// GET /api/events/:id/availability?showAt=ISO — seat map with live BOOKED / LOCKED state.
exports.getSeatAvailability = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Event not found' });
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    const showAt = req.query.showAt ? new Date(String(req.query.showAt)) : null;
    if (!showAt || !isBookableSlot(event, showAt)) {
      return res.status(400).json({ message: 'showAt must be one of the event\'s upcoming show times' });
    }

    const layout = buildSeatLayout(event.totalSeats);
    const { booked, locked } = await seatReservations.getSeatStates(event._id, showAt);
    const unavailable = new Set([...booked, ...locked]);
    const totalSeatIds = layout.flatMap((r) => r.seats);
    // Capacity counter also covers quantity-only bookings made without seat numbers.
    const capacityLeft = Math.max(0, Number(event.totalSeats || 0) - Number(event.bookedSeats || 0));
    const available = totalSeatIds.filter((s) => !unavailable.has(s));

    return res.json({
      eventId: String(event._id),
      showAt: showAt.toISOString(),
      price: event.price,
      currency: 'inr',
      maxSeatsPerBooking: MAX_SEATS_PER_BOOKING,
      rows: layout,
      booked,
      locked,
      availableCount: Math.min(available.length, capacityLeft),
      available: capacityLeft > 0 ? available : [],
    });
  } catch (error) {
    console.error('GET SEAT AVAILABILITY ERROR ❌', error);
    return res.status(500).json({ message: 'Failed to fetch seat availability' });
  }
};
