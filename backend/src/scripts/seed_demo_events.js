// Demo catalog for the BookMyShow-style listing pages.
//
//   node src/scripts/seed_demo_events.js            → dry run (prints what would change)
//   node src/scripts/seed_demo_events.js --apply    → backup, normalise venues/cities, upsert demo events
//   node src/scripts/seed_demo_events.js --remove   → backup, delete every demo event (sourceType "demo")
//
// Demo events are tagged sourceType "demo" and keyed by title, so re-running is idempotent.
// Dates are relative to today, so the catalog always has shows today, this weekend and later.
// A JSON backup of every non-movie-import event is written to backend/backups/ before any write.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Event = require('../models/Event');
const User = require('../models/User');
const { zonedDateTimeToUtc } = require('../utils/showtime.util');

const APPLY = process.argv.includes('--apply');
const REMOVE = process.argv.includes('--remove');

const img = (id) => `https://images.unsplash.com/photo-${id}?w=600&h=900&fit=crop`;
const IMG = {
  crowdPhone: img('1501281668745-f7f57925c3b4'),
  stageGlow: img('1470229722913-7c0e2dbbafd3'),
  confetti: img('1514525253161-7a46d19cd819'),
  handsUp: img('1540039155733-5bb30b53aa14'),
  festival: img('1492684223066-81342ee5ff30'),
  purpleStage: img('1516450360452-9312f5e86fc7'),
  heartHands: img('1429962714451-bb934ecdc4ec'),
  goldLights: img('1459749411175-04bf5292ceea'),
  edm: img('1506157786151-b8491531f063'),
  micBokeh: img('1475721027785-f74eccf877e2'),
  micBlue: img('1507676184212-d03ab07a01bf'),
  micRetro: img('1511671782779-c97d3d27a1d4'),
  talkStage: img('1585699324551-f6c309eedeca'),
  conference: img('1505373877841-8d25f7d46678'),
  audience: img('1540575467063-178a50c2df87'),
  expo: img('1560439514-4e9645039924'),
  football: img('1574629810360-7efbbe195018'),
  cricket: img('1531415074968-036ba1b575da'),
  running: img('1461896836934-ffe607ba8211'),
  cycling: img('1517649763962-0c623066013b'),
  basketball: img('1546519638-68e109498ffc'),
  volleyball: img('1612872087720-bb876e2e67d1'),
  curtain: img('1503095396549-807759245b35'),
  painting: img('1513364776144-60967b0f800f'),
  crafts: img('1452860606245-08befc0ff44b'),
  yoga: img('1544367567-0f2fcb009e0b'),
};

// [title, category, city, venue, price, startInDays, runDays, showTimes, image, language, age, minutes, tagline, description, featured]
const DEMO = [
  ['Laugh Riot Live', 'Comedy', 'Mumbai', 'Canvas Laugh Club, Lower Parel', 499, 0, 30, ['19:00', '21:30'], IMG.micBokeh, 'Hinglish', '16+', 90, 'A brand-new hour of observational stand-up', 'An all-new stand-up special packed with stories about Mumbai locals, family WhatsApp groups and everything in between.', true],
  ['Desi Dad Jokes', 'Comedy', 'Delhi-NCR', 'The Laugh Store, Saket', 399, 1, 20, ['20:00'], IMG.micBlue, 'Hindi', '16+', 75, 'Stand-up about growing up in a desi household', 'A relatable, family-friendly-ish set about parents, cousins and the eternal question: "beta, shaadi kab?"', false],
  ['Open Mic Night', 'Comedy', 'Bengaluru', 'The Humming Tree, Indiranagar', 199, 0, 60, ['20:30'], IMG.micRetro, 'English', '18+', 120, 'Ten comics, ten minutes each', "Bengaluru's favourite weekly open mic: new voices, new jokes, and the occasional surprise headliner.", false],
  ['Crowd Work Special', 'Comedy', 'Pune', 'Pagdandi Comedy Lounge, Baner', 349, 3, 25, ['19:30'], IMG.talkStage, 'Hinglish', '16+', 80, 'No script. Just you, the audience', 'An unscripted improv and crowd-work show where every night is different.', false],
  ['Corporate Comedy Hour', 'Comedy', 'Hyderabad', 'Phoenix Arena, HITEC City', 299, 5, 15, ['18:30'], IMG.micBokeh, 'English', '16+', 60, 'Jokes about meetings that should have been emails', 'A sharp set for anyone who has survived appraisal season.', false],

  ['Sunburn Arena Night', 'Concert', 'Mumbai', 'NSCI Dome, Worli', 1499, 2, 3, ['18:00'], IMG.edm, 'English', '18+', 300, 'Electronic music under the dome', 'A night of electronic music with headline DJs, immersive lights and a massive sound system.', true],
  ['Sufi Under The Stars', 'Concert', 'Delhi-NCR', 'Jawaharlal Nehru Stadium Lawns', 999, 6, 2, ['19:00'], IMG.goldLights, 'Hindi, Urdu', '5+', 180, 'An evening of qawwali and Sufi classics', 'Timeless Sufi poetry and qawwali performed live with a full ensemble.', true],
  ['Indie Rock Festival', 'Concert', 'Bengaluru', 'Palace Grounds', 1299, 8, 2, ['16:00'], IMG.festival, 'English', '16+', 360, 'Six bands. One stage. All day', 'A full-day indie and rock festival featuring the best independent bands from across India.', false],
  ['Bollywood Retro Night', 'Concert', 'Pune', 'Phoenix Marketcity Amphitheatre', 799, 1, 10, ['20:00'], IMG.heartHands, 'Hindi', '5+', 150, 'Sing along to the greatest hits of the 70s, 80s and 90s', 'A live band recreates the golden era of Bollywood music: bring your voice.', false],
  ['Classical Strings Evening', 'Concert', 'Chennai', 'Music Academy, Mylapore', 599, 4, 5, ['18:30'], IMG.stageGlow, 'Instrumental', 'All ages', 120, 'Violin and veena in conversation', 'A Carnatic and Hindustani jugalbandi featuring strings, percussion and improvisation.', false],
  ['Hip-Hop Cypher Live', 'Concert', 'Mumbai', 'Antisocial, Khar', 699, 9, 2, ['21:00'], IMG.purpleStage, 'Hindi, English', '18+', 180, 'Desi hip-hop, live and loud', 'Rappers and beatboxers take turns in a high-energy live cypher.', false],

  ['Mumbai Super League Final', 'Sports', 'Mumbai', 'Mumbai Football Arena, Andheri', 349, 7, 1, ['19:30'], IMG.football, 'English', 'All ages', 120, 'The title decider', 'The two best clubs of the season meet in the final. Expect a full house.', true],
  ['T20 Corporate Cup', 'Sports', 'Bengaluru', 'KSCA Ground, Alur', 249, 2, 4, ['10:00', '15:00'], IMG.cricket, 'English', 'All ages', 180, 'Office teams battle it out on the pitch', 'Sixteen corporate teams compete in a fast-paced T20 knockout.', false],
  ['City Half Marathon', 'Sports', 'Delhi-NCR', 'Jawaharlal Nehru Stadium', 1200, 14, 1, ['05:30'], IMG.running, 'English', '12+', 240, 'Run 5K, 10K or 21K', 'Register for the 5K fun run, 10K or the half marathon. Medals for every finisher.', false],
  ['3x3 Basketball Showdown', 'Sports', 'Hyderabad', 'Gachibowli Indoor Stadium', 199, 3, 2, ['17:00'], IMG.basketball, 'English', 'All ages', 150, 'Street basketball, pro rules', 'Fast 3x3 games, slam-dunk contest and live DJ between matches.', false],
  ['Cyclothon Sunday', 'Sports', 'Pune', 'Sinhagad Road Start Point', 499, 8, 1, ['06:00'], IMG.cycling, 'English', '12+', 180, '25K and 50K rides through the hills', 'A scenic, fully supported group ride with hydration points and breakfast at the finish.', false],
  ['Beach Volleyball Open', 'Sports', 'Chennai', 'Elliot\'s Beach, Besant Nagar', 149, 5, 2, ['16:00'], IMG.volleyball, 'English', 'All ages', 180, 'Sun, sand and spikes', 'Amateur and pro pairs compete on the beach. Spectator entry includes refreshments.', false],

  ['Pottery for Beginners', 'Workshop', 'Mumbai', 'Clay Studio, Bandra', 1499, 1, 30, ['11:00', '16:00'], IMG.crafts, 'English, Hindi', '12+', 180, 'Make your first bowl on the wheel', 'A hands-on wheel-throwing workshop. All materials and firing included.', false],
  ['Acrylic Painting Workshop', 'Workshop', 'Bengaluru', 'Artspace, Koramangala', 999, 0, 30, ['11:00'], IMG.painting, 'English', '10+', 150, 'Paint a sunset canvas to take home', 'A guided step-by-step painting session for complete beginners.', false],
  ['Startup Pitch Masterclass', 'Workshop', 'Delhi-NCR', 'WeWork Cyber City, Gurugram', 799, 4, 1, ['14:00'], IMG.audience, 'English', '16+', 180, 'Craft a pitch investors remember', 'Learn to structure your story, design your deck and handle tough investor questions.', false],

  ['AI & Product Summit', 'Seminar', 'Bengaluru', 'Bangalore International Exhibition Centre', 2499, 10, 2, ['09:30'], IMG.conference, 'English', '16+', 480, 'Two days of talks on building with AI', 'Founders, engineers and product leaders share what works when shipping AI products.', true],
  ['Personal Finance 101', 'Seminar', 'Mumbai', 'Nehru Centre, Worli', 0, 2, 1, ['17:00'], IMG.expo, 'Hindi, English', '16+', 120, 'Budgeting, saving and investing basics', 'A free seminar covering budgeting, emergency funds, SIPs and avoiding common money mistakes.', false],

  ['The Last Letter', 'Plays', 'Mumbai', 'Prithvi Theatre, Juhu', 599, 1, 21, ['19:30'], IMG.curtain, 'Hindi', '12+', 110, 'A family drama told across three generations', 'An award-winning Hindi play about a letter that changes a family forever.', true],
  ['Shakespeare Unplugged', 'Plays', 'Delhi-NCR', 'Kamani Auditorium, Mandi House', 499, 6, 10, ['19:00'], IMG.curtain, 'English', '12+', 100, 'Hamlet, reimagined for today', 'A modern, fast-paced adaptation of Hamlet with live music.', false],

  ['Sunrise Yoga by the Lake', 'Activities', 'Pune', 'Pashan Lake Promenade', 299, 0, 45, ['06:30'], IMG.yoga, 'English, Hindi', 'All ages', 75, 'Start your weekend mindfully', 'A guided outdoor yoga and breathwork session. Mats provided.', false],
  ['Music Festival Camping', 'Activities', 'Hyderabad', 'Shamirpet Lake Campsite', 2999, 12, 2, ['15:00'], IMG.confetti, 'English', '18+', 1440, 'Two days of music, camping and bonfires', 'An overnight camping experience with live acoustic sets, bonfire and stargazing.', false],
];

const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const designFor = (category) =>
  ({ Comedy: 'comedy', Concert: 'concert', Sports: 'bold-split', Plays: 'editorial' }[category] || 'clean-hero');

// Normalise legacy venue spellings ("city mall" / "city Mall" / "CINEMA HALL").
const titleCase = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

function demoDoc(row, ownerId) {
  const [title, category, city, venue, price, startIn, runDays, showTimes, imageUrl, language, age, minutes, tagline, description, featured] = row;
  const startDate = addDays(today, startIn);
  const endDate = addDays(startDate, Math.max(0, runDays - 1));
  return {
    title,
    category,
    city,
    venue,
    price,
    startDate,
    endDate,
    showTimes,
    date: zonedDateTimeToUtc(startDate.toISOString().slice(0, 10), showTimes[0]),
    imageUrl,
    language,
    ageRestriction: age,
    durationMinutes: minutes,
    tagline,
    description,
    featured,
    totalSeats: 160,
    designTemplate: designFor(category),
    sourceType: 'demo',
    createdBy: ownerId,
  };
}

async function backup() {
  const dir = path.join(__dirname, '..', '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const docs = await Event.find({ venue: { $ne: 'PVR Cinemas' } }).lean();
  const file = path.join(dir, `events-before-demo-seed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(docs, null, 2));
  console.log(`Backup: ${docs.length} events → ${file}`);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const mode = REMOVE ? 'REMOVE' : APPLY ? 'APPLY' : 'DRY RUN';
  console.log(`Mode: ${mode}`);

  if (REMOVE) {
    await backup();
    const r = await Event.deleteMany({ sourceType: 'demo' });
    console.log(`Deleted ${r.deletedCount} demo events.`);
    return mongoose.disconnect();
  }

  const owner = await User.findOne({ role: 'superadmin' }).select('_id');
  if (!owner) throw new Error('No superadmin user found to own the demo events.');

  // 1) Venue / city clean-up for hand-created events (the 4,800 imported movies are untouched).
  const legacy = await Event.find({ venue: { $ne: 'PVR Cinemas' }, sourceType: { $ne: 'demo' } });
  const fixes = [];
  for (const e of legacy) {
    const venue = titleCase(e.venue).replace(/,\s*Venu$/i, '');
    const city = e.city || (/^movies?$/i.test(e.category) ? '' : 'Mumbai');
    if (venue !== e.venue || city !== (e.city || '')) fixes.push({ e, venue, city });
  }
  fixes.forEach(({ e, venue, city }) => console.log(`  fix: "${e.title}" venue "${e.venue}" → "${venue}", city → "${city || '(all)'}"`));

  // 2) Demo events.
  const docs = DEMO.map((row) => demoDoc(row, owner._id));
  console.log(`  ${docs.length} demo events (${[...new Set(docs.map((d) => d.category))].join(', ')})`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to write.');
    return mongoose.disconnect();
  }

  await backup();
  for (const { e, venue, city } of fixes) {
    await Event.updateOne({ _id: e._id }, { $set: { venue, city } });
  }
  for (const doc of docs) {
    await Event.updateOne({ sourceType: 'demo', title: doc.title }, { $set: doc }, { upsert: true });
  }
  console.log(`Applied: ${fixes.length} venue/city fixes, ${docs.length} demo events upserted.`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
