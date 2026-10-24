require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const Event = require('../models/Event');
const User = require('../models/User');

const PYTHON = process.env.RECOMMENDER_PYTHON || 'python';
const SCRIPT_PATH = path.join(__dirname, 'import_movies_as_events.py');
const TMDB_IMAGE_BASE_URL = (process.env.TMDB_IMAGE_BASE_URL || 'https://image.tmdb.org/t/p/w500').replace(/\/+$/, '');
const DEFAULT_SHOW_TIMES = ['18:00', '21:00'];
const DEFAULT_PRICE = 250;
const DEFAULT_TOTAL_SEATS = 250;

function getSchedule() {
  const now = new Date();
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 30);
  const legacyDate = new Date(startDate);
  legacyDate.setUTCHours(18, 0, 0, 0);
  return { startDate, endDate, legacyDate };
}

function runPython(limit = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [SCRIPT_PATH, String(limit || 0)], {
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', () => {
      try {
        const payload = JSON.parse(stdout.trim() || '{}');
        if (!payload?.ok) {
          return reject(new Error(payload?.message || stderr.trim() || 'Movie import payload invalid.'));
        }
        resolve(payload.records || []);
      } catch (error) {
        reject(new Error(stderr.trim() || error.message));
      }
    });
  });
}

async function getOwner() {
  const admin = await User.findOne({ role: 'superadmin' }).select('_id');
  if (admin?._id) return admin._id;

  const creator = await User.findOne({ role: 'creator' }).select('_id');
  if (creator?._id) return creator._id;

  throw new Error('No superadmin or creator user found for movie event ownership.');
}

async function upsertMovieEvents(records) {
  const ownerId = await getOwner();
  const { startDate, endDate, legacyDate } = getSchedule();
  const operations = [];

  for (const record of records) {
    const sourceMovieId = String(record?.sourceMovieId || '').trim();
    const title = String(record?.title || '').trim();
    if (!sourceMovieId || !title) continue;

    const posterPath = String(record?.movieMeta?.posterPath || '').trim();
    const imageUrl = posterPath ? `${TMDB_IMAGE_BASE_URL}/${posterPath.replace(/^\/+/, '')}` : '';

    const update = {
      title,
      description: String(record?.description || '').trim(),
      date: legacyDate,
      startDate,
      endDate,
      showTimes: DEFAULT_SHOW_TIMES,
      venue: 'PVR Cinemas',
      price: DEFAULT_PRICE,
      totalSeats: DEFAULT_TOTAL_SEATS,
      category: 'Movie',
      locationType: 'In-person',
      imageUrl,
      registrationTemplate: 'standard',
      designTemplate: 'movie',
      imagePreset: 'preset-a',
      designConfig: {},
      customFields: [],
      sourceType: 'tmdb_movie',
      sourceMovieId,
      movieMeta: {
        tags: String(record?.movieMeta?.tags || '').trim(),
        releaseDate: String(record?.movieMeta?.releaseDate || '').trim(),
        posterPath,
        posterUrl: imageUrl,
        voteAverage: Number(record?.movieMeta?.voteAverage || 0),
        popularity: Number(record?.movieMeta?.popularity || 0),
      },
    };

    operations.push({
      updateOne: {
        filter: { sourceMovieId },
        update: {
          $set: update,
          $setOnInsert: {
            createdBy: ownerId,
            bookedSeats: 0,
          },
        },
        upsert: true,
      },
    });
  }

  if (!operations.length) {
    return { created: 0, updated: 0 };
  }

  const result = await Event.bulkWrite(operations, { ordered: false });
  return {
    created: Number(result.upsertedCount || 0),
    updated: Number(result.modifiedCount || 0),
  };
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI missing');
  }

  const limit = Number.parseInt(process.argv[2], 10) || 0;
  await mongoose.connect(process.env.MONGO_URI);
  const records = await runPython(limit);
  const summary = await upsertMovieEvents(records);
  console.log(JSON.stringify({ ok: true, imported: records.length, ...summary }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
