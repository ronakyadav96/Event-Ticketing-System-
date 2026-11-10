// Creates the first superadmin account.
// Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... npm run seed:admin
// (or set both in .env)

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const User = require('../models/User');

async function seedAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  const name = (process.env.SEED_ADMIN_NAME || 'Super Admin').trim();

  if (!email || password.length < 8) {
    console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 8 characters) before seeding.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`User ${email} already exists (role: ${existing.role}); nothing changed.`);
    return;
  }

  await User.create({
    name,
    email,
    password: await bcrypt.hash(password, 10),
    role: 'superadmin',
    isEmailVerified: true,
  });

  console.log(`Superadmin ${email} created successfully`);
}

seedAdmin()
  .catch((err) => {
    console.error('Seeding failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
