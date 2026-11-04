// Checkout pricing tests against an in-memory MongoDB and a fake Stripe: node --test (npm test)
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.MAIL_DISABLED = 'true';
process.env.MOVIE_AUTO_REFRESH = 'false';
process.env.CLIENT_URL = 'http://localhost:4200';
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';

// Replace the Stripe SDK before the payment controller loads it; record every session created.
const createdSessions = [];
class FakeStripe {
  constructor() {
    this.checkout = {
      sessions: {
        create: async (params) => {
          createdSessions.push(params);
          return { id: `cs_test_${createdSessions.length}`, url: 'https://checkout.example/pay', expires_at: null };
        },
      },
    };
  }
}
require.cache[require.resolve('stripe')] = { exports: FakeStripe, loaded: true };

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const app = require('../src/server');
const User = require('../src/models/User');
const Event = require('../src/models/Event');
const StripeOrder = require('../src/models/StripeOrder');

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
  createdSessions.length = 0;
  await Promise.all([User.deleteMany({}), Event.deleteMany({}), StripeOrder.deleteMany({})]);
});

async function setup({ price = 250 } = {}) {
  const user = await User.create({
    name: 'Buyer',
    email: 'buyer@example.com',
    password: 'hashed-not-used',
    role: 'user',
    isEmailVerified: true,
  });
  const token = jwt.sign({ id: user._id.toString(), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  // A 18:30 IST show three days from now (validation runs in EVENT_TIMEZONE, default Asia/Kolkata).
  const day = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const showAt = new Date(`${day}T18:30:00+05:30`);
  const event = await Event.create({
    title: 'Test Show',
    description: 'A test event',
    date: showAt,
    startDate: new Date(`${day}T00:00:00.000Z`),
    endDate: new Date(`${day}T00:00:00.000Z`),
    showTimes: ['18:30'],
    venue: 'Hall 1',
    price,
    category: 'Movie',
    totalSeats: 100,
    createdBy: user._id,
  });
  return { token, event, showAt };
}

function checkout(token, body) {
  return request(app)
    .post('/api/payments/create-checkout-session')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

test('a client-sent unitAmount cannot lower the ticket price', async () => {
  const { token, event, showAt } = await setup({ price: 250 });

  const res = await checkout(token, { eventId: String(event._id), quantity: 2, showAt, unitAmount: 100 });

  assert.equal(res.status, 200, res.text);
  const [ticketLine] = createdSessions[0].line_items;
  assert.equal(ticketLine.price_data.unit_amount, 25000);
  assert.equal(ticketLine.quantity, 2);

  const order = await StripeOrder.findById(res.body.orderId);
  assert.equal(order.expectedAmount(), 50000);
});

test('snacks are priced by the server and added as line items', async () => {
  const { token, event, showAt } = await setup({ price: 250 });

  const res = await checkout(token, {
    eventId: String(event._id),
    quantity: 1,
    showAt,
    fnb: { fnb1: 2, fnb4: 1, fnb3: 0 },
  });

  assert.equal(res.status, 200, res.text);
  const lines = createdSessions[0].line_items.map((l) => [l.price_data.unit_amount, l.quantity]);
  assert.deepEqual(lines, [
    [25000, 1],
    [34000, 2],
    [15000, 1],
  ]);

  const order = await StripeOrder.findById(res.body.orderId);
  assert.equal(order.fnbAmount, 83000);
  assert.equal(order.expectedAmount(), 25000 + 83000);
});

test('unknown snacks and bad quantities are rejected', async () => {
  const { token, event, showAt } = await setup();

  const unknown = await checkout(token, { eventId: String(event._id), quantity: 1, showAt, fnb: { free: 1 } });
  assert.equal(unknown.status, 400);

  const negative = await checkout(token, { eventId: String(event._id), quantity: 1, showAt, fnb: { fnb1: -3 } });
  assert.equal(negative.status, 400);

  const tooMany = await checkout(token, { eventId: String(event._id), quantity: 50, showAt });
  assert.equal(tooMany.status, 400);

  assert.equal(createdSessions.length, 0);
});

test('checkout for a past show is rejected', async () => {
  const { token, event } = await setup();

  const res = await checkout(token, {
    eventId: String(event._id),
    quantity: 1,
    showAt: new Date(Date.now() - 60 * 60 * 1000),
  });

  assert.equal(res.status, 400);
  assert.equal(createdSessions.length, 0);
});

test('the snack catalog is public', async () => {
  const res = await request(app).get('/api/payments/fnb-catalog');
  assert.equal(res.status, 200);
  assert.ok(res.body.items.some((i) => i.id === 'fnb1' && i.price === 340));
});
