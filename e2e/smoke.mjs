// End-to-end smoke test of the running app (frontend :4200, backend :5001, AI service :8000),
// driven in the local Chrome install, for every role: guest, user, creator and superadmin.
//
//   cd e2e && npm install && npm run smoke
//
// Signed-in roles use short-lived tokens signed with backend/.env JWT_SECRET for the first
// existing account of each role (looked up read-only in MongoDB; no passwords needed). The creator check creates one event tagged
// "[e2e …]" in its title and deletes it again at the end.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = dotenv.parse(readFileSync(path.join(ROOT, 'backend', '.env')));
const APP = process.env.APP_URL || 'http://localhost:4200';
const API = process.env.API_URL || 'http://localhost:5001';
const CHAT_TIMEOUT = 45000;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function json(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** First existing account with this role (read-only lookup in MongoDB). */
async function accountFor(db, role) {
  const u = await db.collection('users').findOne({ role }, { projection: { name: 1, email: 1, role: 1 } });
  if (!u) throw new Error(`No ${role} account found`);
  return { id: String(u._id), role, name: u.name, email: u.email };
}

function sign(user) {
  return jwt.sign({ id: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '30m' });
}

async function pageAs(browser, user, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  if (user) {
    const token = sign(user);
    await context.addInitScript(
      ([t, u]) => {
        localStorage.setItem('token', t);
        localStorage.setItem('user', JSON.stringify(u));
      },
      [token, { id: user.id, _id: user.id, name: user.name, email: user.email, role: user.role }]
    );
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('   page error:', e.message.slice(0, 160)));
  return page;
}

/** Sends a chat message and waits for the assistant (navigation or a reply bubble). */
async function ask(page, text) {
  if (!(await page.$('.panel'))) await page.click('.launcher');
  await page.waitForSelector('app-chat-input textarea');
  const before = page.url();
  const bubbles = await page.$$eval('app-message-bubble', (els) => els.length);
  await page.fill('app-chat-input textarea', text);
  await page.keyboard.press('Enter');
  await page
    .waitForFunction(
      ([url, n]) => location.href !== url || document.querySelectorAll('app-message-bubble').length > n + 1,
      [before, bubbles],
      { timeout: CHAT_TIMEOUT }
    )
    .catch(() => {});
  await page.waitForTimeout(1500);
  return decodeURIComponent(page.url().replace(APP, ''));
}

async function lastReply(page) {
  if (!(await page.$('.panel'))) await page.click('.launcher');
  await page.waitForTimeout(500);
  return page.$$eval('app-message-bubble .content', (els) => (els.length ? els[els.length - 1].innerText : ''));
}

async function guest(browser) {
  console.log('\n— Guest');
  const page = await pageAs(browser, null);
  await page.goto(APP, { waitUntil: 'networkidle' });
  const rows = await page.$$eval('.row-section h2', (els) => els.map((e) => e.innerText));
  check('home shows live-event rows', rows.some((r) => r.startsWith('Popular Events')), rows.slice(0, 4).join(' | '));

  await page.click('app-search-box input');
  await page.keyboard.type('laugh', { delay: 40 });
  await page.waitForSelector('.dropdown .item', { timeout: 10000 }).catch(() => {});
  const suggestions = await page.$$eval('.dropdown .item-title', (els) => els.map((e) => e.innerText));
  check('search dropdown suggests events', suggestions.length > 0, suggestions.slice(0, 3).join(', '));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/explore\?q=laugh/, { timeout: 10000 }).catch(() => {});
  check('Enter opens the results page', page.url().includes('/explore?q=laugh'));

  const url = await ask(page, 'show me comedy events');
  const chatOpen = !!(await page.$('.panel'));
  check('chat search opens results in the app', url.startsWith('/explore') && url.includes('category=Comedy'), url);
  check('chat widget closes on results', !chatOpen);

  const hi = await ask(page, 'is weekend kuch funny dikhao');
  check('Hinglish request → weekend comedy results', hi.includes('category=Comedy') && hi.includes('from='), hi);
  const reply = await lastReply(page);
  check('Hinglish request gets a Hinglish reply', /mile|mila|dikha/.test(reply), reply.split('\n')[0]);

  const book = await ask(page, 'book Laugh Riot Live');
  check('guest booking goes to sign-in, then back to booking', book.startsWith('/login?returnUrl=/book/'), book);
  await page.context().close();
}

async function user(browser, account) {
  console.log(`\n— User (${account.name})`);
  const page = await pageAs(browser, account);
  await page.goto(APP, { waitUntil: 'networkidle' });
  const url = await ask(page, 'Laugh Riot Live ke tickets book karo');
  check('chat booking opens the booking page', url.startsWith('/book/'), url);
  await page.waitForSelector('.showtime-slot-btn', { timeout: 15000 }).catch(() => {});
  const slots = await page.$$('.showtime-slot-btn');
  check('booking page lists showtimes', slots.length > 0, `${slots.length} slots`);

  await page.goto(`${APP}/history`, { waitUntil: 'networkidle' });
  check('bookings history page loads', !(await page.$('.state-box.error')));
  await page.context().close();
}

async function creator(browser, account) {
  console.log(`\n— Creator (${account.name})`);
  const token = sign(account);
  const title = `Magic Night [e2e ${Date.now() % 100000}]`;
  const today = new Date().toISOString().slice(0, 10);
  const form = new FormData();
  Object.entries({
    title, description: 'Close-up magic and mind reading.', category: 'Magic', venue: 'E2E Hall', city: 'Mumbai',
    price: '299', totalSeats: '50', startDate: today, endDate: today, showTimes: JSON.stringify(['23:30']),
  }).forEach(([k, v]) => form.append(k, v));
  const created = await json(`${API}/api/events`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const id = created.body?._id || created.body?.id;
  check('creator can create an event', created.status === 201 && !!id, `status ${created.status}`);

  try {
    const page = await pageAs(browser, account);
    await page.goto(`${APP}/creator-dashboard`, { waitUntil: 'networkidle' });
    check('creator dashboard loads', !page.url().includes('/login'), page.url().replace(APP, ''));
    await page.goto(APP, { waitUntil: 'networkidle' });
    const url = await ask(page, 'magic show dikhao');
    await page.waitForTimeout(1500);
    const titles = await page.$$eval('app-poster-card .title', (els) => els.map((e) => e.innerText));
    check('chatbot finds the new event right away (first result)', titles[0] === title, `${url} → ${titles.slice(0, 3).join(', ')}`);
    await page.context().close();
  } finally {
    if (id) {
      const del = await json(`${API}/api/events/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      check('test event cleaned up', del.status === 200);
    }
  }
}

async function superadmin(browser, account) {
  console.log(`\n— Superadmin (${account.name})`);
  const page = await pageAs(browser, account);
  await page.goto(`${APP}/superadmin-dashboard`, { waitUntil: 'networkidle' });
  check('superadmin dashboard loads', !page.url().includes('/login'), page.url().replace(APP, ''));
  await page.context().close();
}

const mongo = await MongoClient.connect(env.MONGO_URI);
const db = mongo.db();
const [admin, creatorAcc, userAcc] = await Promise.all(['superadmin', 'creator', 'user'].map((r) => accountFor(db, r)));
await mongo.close();

const browser = await chromium.launch({ channel: process.env.E2E_BROWSER || 'chrome' });
try {
  await guest(browser);
  await user(browser, userAcc);
  await creator(browser, creatorAcc);
  await superadmin(browser, admin);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
