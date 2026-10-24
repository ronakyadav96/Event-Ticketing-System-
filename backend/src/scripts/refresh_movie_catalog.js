// Makes the imported movie catalog bookable again: rolls expired runs forward and fills in
// missing posters from TMDB. A JSON backup of every field it changes is written first.
//
//   npm run refresh:movies                 # schedules + posters
//   npm run refresh:movies -- --no-posters # schedules only
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Event = require('../models/Event');
const {
  MOVIE_SOURCE_TYPE,
  expiredMovieFilter,
  rollExpiredMovieSchedules,
  backfillMoviePosters,
} = require('../services/movie-schedule.service');

async function writeBackup() {
  const docs = await Event.find({
    sourceType: MOVIE_SOURCE_TYPE,
    $or: [expiredMovieFilter(), { imageUrl: { $in: [null, ''] } }],
  })
    .select('_id date startDate endDate imageUrl movieMeta.posterPath movieMeta.posterUrl')
    .lean();
  const dir = path.join(__dirname, '..', '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `movie-catalog-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(docs));
  return { file, count: docs.length };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI missing');
  const withPosters = !process.argv.includes('--no-posters');

  await mongoose.connect(process.env.MONGO_URI);
  const backup = await writeBackup();
  console.log(`Backup of ${backup.count} events written to ${backup.file}`);

  const rolled = await rollExpiredMovieSchedules();
  console.log(`Schedules rolled forward: ${rolled}`);

  if (withPosters) {
    const posters = await backfillMoviePosters({
      onProgress: (done, total, updated) => console.log(`  posters ${done}/${total} (found ${updated})`),
    });
    console.log(`Posters: checked ${posters.checked}, updated ${posters.updated}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
