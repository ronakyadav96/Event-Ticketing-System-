const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI);

async function seedAdmin() {
  const adminExists = await User.findOne({ role: 'admin' });

  if (adminExists) {
    console.log('Admin already exists');
    process.exit();
  }

  const hashedPassword = await bcrypt.hash('admin123', 10);

  await User.create({
    name: 'Admin',
    email: 'admin@event.com',
    password: hashedPassword,
    role: 'admin'
  });

  console.log('Admin created successfully');
  process.exit();
}

seedAdmin();
