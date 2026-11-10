// API tests against an in-memory MongoDB: node --test (npm test)
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.MAIL_DISABLED = 'true';
process.env.MOVIE_AUTO_REFRESH = 'false';
process.env.CLIENT_URL = 'http://localhost:4200';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const app = require('../src/server');
const User = require('../src/models/User');
const Event = require('../src/models/Event');
const Booking = require('../src/models/Booking');

let mongo;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Event.deleteMany({}), Booking.deleteMany({})]);
});

async function createUser(role = 'user', email = `${role}@example.com`) {
  const user = await User.create({
    name: role,
    email,
    password: await bcrypt.hash('secret123', 10),
    role,
    isEmailVerified: true,
  });
  const token = jwt.sign({ id: user._id.toString(), role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { user, token };
}

// ---------- CORS ----------

test('CORS allows configured origins only', async () => {
  const allowed = await request(app).get('/').set('Origin', 'http://localhost:4200');
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:4200');

  const blocked = await request(app).get('/').set('Origin', 'https://evil.example');
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);
});

test('the open test-email endpoint is gone', async () => {
  const res = await request(app).post('/api/auth/test-email').send({ email: 'x@example.com' });
  assert.equal(res.status, 404);
});

// ---------- Auth ----------

test('register rejects short passwords', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'A', email: 'a@example.com', password: '123' });
  assert.equal(res.status, 400);
});

test('OTP locks after 5 wrong attempts, even for the right code', async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ name: 'A', email: 'a@example.com', password: 'secret123' });
  assert.equal(reg.status, 201);
  const otp = reg.body.otp;
  const wrong = otp === '111111' ? '222222' : '111111';

  for (let i = 0; i < 5; i += 1) {
    const r = await request(app).post('/api/auth/verify-otp').send({ email: 'a@example.com', otp: wrong });
    assert.equal(r.status, 400);
  }
  const locked = await request(app).post('/api/auth/verify-otp').send({ email: 'a@example.com', otp });
  assert.equal(locked.status, 429);

  // A fresh OTP unlocks verification.
  const resend = await request(app).post('/api/auth/resend-otp').send({ email: 'a@example.com' });
  const ok = await request(app).post('/api/auth/verify-otp').send({ email: 'a@example.com', otp: resend.body.otp });
  assert.equal(ok.status, 200);
});

test('forgot + reset password lets the user log in with the new password', async () => {
  await createUser('user', 'u@example.com');

  const forgot = await request(app).post('/api/auth/forgot-password').send({ email: 'u@example.com' });
  assert.equal(forgot.status, 200);
  assert.match(forgot.body.otp, /^\d{6}$/);

  const reset = await request(app)
    .post('/api/auth/reset-password')
    .send({ email: 'u@example.com', otp: forgot.body.otp, password: 'newpass456' });
  assert.equal(reset.status, 200);

  const oldLogin = await request(app).post('/api/auth/login').send({ email: 'u@example.com', password: 'secret123' });
  assert.equal(oldLogin.status, 401);
  const newLogin = await request(app).post('/api/auth/login').send({ email: 'u@example.com', password: 'newpass456' });
  assert.equal(newLogin.status, 200);
  assert.ok(newLogin.body.token);

  // The OTP is single-use.
  const reuse = await request(app)
    .post('/api/auth/reset-password')
    .send({ email: 'u@example.com', otp: forgot.body.otp, password: 'another789' });
  assert.equal(reuse.status, 400);
});

test('forgot-password does not reveal whether an email is registered', async () => {
  const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
  assert.equal(res.status, 200);
  assert.equal(res.body.otp, undefined);
});

test('a deleted user token is rejected', async () => {
  const { user, token } = await createUser();
  await User.deleteOne({ _id: user._id });

  const res = await request(app).get('/api/bookings/my').set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 401);
});

// ---------- Bookings ----------

async function createPaidBooking(owner) {
  const creator = await createUser('creator');
  const event = await Event.create({
    title: 'Show',
    date: new Date(Date.now() + 10 * 86400000),
    venue: 'Hall',
    price: 200,
    category: 'Concert',
    totalSeats: 100,
    bookedSeats: 2,
    createdBy: creator.user._id,
  });
  const booking = await Booking.create({
    user: owner._id,
    event: event._id,
    seats: 2,
    ticketId: 'TKT-TEST-1',
    paymentStatus: 'PAID',
  });
  return { event, booking };
}

test('a user cannot delete their paid booking to skip the refund policy', async () => {
  const { user, token } = await createUser();
  const { event, booking } = await createPaidBooking(user);

  const res = await request(app).delete(`/api/bookings/${booking._id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 403);
  assert.ok(await Booking.findById(booking._id));
  assert.equal((await Event.findById(event._id)).bookedSeats, 2);
});

test('a superadmin can delete a booking and its seats are released', async () => {
  const { user } = await createUser();
  const admin = await createUser('superadmin');
  const { event, booking } = await createPaidBooking(user);

  const res = await request(app).delete(`/api/bookings/${booking._id}`).set('Authorization', `Bearer ${admin.token}`);
  assert.equal(res.status, 200);
  assert.equal(await Booking.findById(booking._id), null);
  assert.equal((await Event.findById(event._id)).bookedSeats, 0);
});
