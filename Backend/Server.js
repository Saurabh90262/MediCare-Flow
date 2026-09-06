/* ============================================================================
 * MediCare Flow - Backend API (complete, single file)
 * Multi-clinic appointment + queue platform. MERN / MongoDB Atlas.
 *
 * SETUP
 *   npm install express mongoose cors dotenv node-cron bcryptjs jsonwebtoken socket.io
 *   node Server.js        (or: nodemon Server.js)
 *
 * Backend/.env
 *   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?appName=MediCareFlow
 *   DB_NAME=medicareflow
 *   PORT=5000
 *   JWT_SECRET=any-long-random-string
 *   GOOGLE_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec
 *   TIMEZONE=Asia/Kolkata
 *   KEEPALIVE_MINUTES=14        (0 disables the Render keep-alive ping)
 *
 * This file is intentionally 100% ASCII so it can never be corrupted by an
 * editor saving it as ANSI / UTF-16 (that is what causes the mysterious
 * "SyntaxError: Invalid or unexpected token").
 *
 * WHAT WAS FIXED IN THIS REVISION
 *   1. PORT now defaults to 5000 so it matches the .env that is actually used.
 *   2. dbName is passed explicitly. A MongoDB Atlas URI with no database path
 *      silently writes everything into a database called "test" - now it goes
 *      to DB_NAME (default "medicareflow").
 *   3. Legacy indexes are reconciled on boot. Old single-clinic databases carry
 *      unique indexes such as key_1 or date_1_bookingNumber_1 that do NOT
 *      include clinicId; they throw E11000 duplicate key on the 2nd clinic.
 *      Those are dropped automatically. Appointments are never touched.
 *   4. Queue numbering uses an atomic counter that is seeded from existing
 *      appointments, so it cannot hand out a number that is already taken.
 *   5. findOneAndUpdate uses the Mongoose option { new: true }.
 *   6. Every failure path answers with JSON. Express used to answer HTML for
 *      404 / crashes, which is what made the frontend say "the API returned an
 *      invalid response".
 *   7. Dates are computed in a real timezone (TIMEZONE), not UTC, so "today"
 *      is correct in India after midnight UTC.
 *   8. Walk-in patients may be added without an email address.
 * ========================================================================== */

'use strict';

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const cron = require('node-cron');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

/* Socket.IO is loaded OPTIONALLY on purpose. If the package is not installed
   the API still boots exactly as before and every screen falls back to its
   polling timer, so a forgotten "npm install socket.io" can never take the
   queue offline. Check GET /api/health to see which mode is active. */
let SocketServer = null;
try {
  SocketServer = require('socket.io').Server;
} catch (_socketIoNotInstalled) {
  SocketServer = null;
}
let io = null;

/* ---------------------------------------------------------------- config -- */

const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.DB_NAME || 'medicareflow';
const JWT_SECRET = process.env.JWT_SECRET || 'medicare-flow-dev-secret-change-me';
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || '';
const TZ = process.env.TIMEZONE || 'Asia/Kolkata';
// Render injects RENDER_EXTERNAL_URL on its own; KEEPALIVE_URL overrides it.
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || '';
const KEEPALIVE_MINUTES = Number(process.env.KEEPALIVE_MINUTES || 14);

const BRAND = 'MediCare Flow';
const CLEANUP_DAYS = 15; // appointments older than this are deleted nightly
const BOOKING_DAYS = 5; // booking window = today + next 5 days
const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL = '12h';
const BCRYPT_ROUNDS = 10;

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));

// A bad JSON body must not produce an HTML error page.
app.use((err, _req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ success: false, message: 'Request body was not valid JSON.' });
  }
  return next(err);
});

/* ---------------------------------------------------------------- schemas -- */

const clinicSchema = new mongoose.Schema(
  {
    clinicId: { type: String, required: true, unique: true, index: true },
    clinicName: { type: String, required: true, trim: true },
    doctorName: { type: String, required: true, trim: true },
    specialization: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },
    city: { type: String, default: '', trim: true },
    phone: { type: String, required: true, trim: true },
    photo: { type: String, default: '', trim: true },
    about: { type: String, default: '', trim: true },
    timings: { type: String, default: '', trim: true },
    adminUserId: { type: String, required: true, unique: true, trim: true, lowercase: true },
    adminEmail: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    resetCodeHash: { type: String, default: '' },
    resetExpires: { type: Date, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

clinicSchema.index({ clinicName: 'text', doctorName: 'text', specialization: 'text', city: 'text' });

// Every original MTSS field is preserved. clinicId + source are the additions.
const appointmentSchema = new mongoose.Schema(
  {
    clinicId: { type: String, required: true, index: true },
    bookingId: { type: String, required: true, unique: true },
    bookingNumber: { type: Number, required: true },
    name: { type: String, required: true, trim: true },
    gender: { type: String, enum: ['Male', 'Female', 'Other'], required: true },
    age: { type: Number, required: true, min: 1, max: 120 },
    weight: { type: Number, required: true, min: 1 },
    date: { type: String, required: true, index: true },
    mobile: { type: String, required: true, trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    address: { type: String, required: true, trim: true },
    quota: { type: String, enum: ['General', 'Emergency'], default: 'General', required: true },
    status: { type: String, enum: ['booked', 'visited', 'cancelled'], default: 'booked' },
    source: { type: String, enum: ['online', 'walk-in'], default: 'online' },
    // Set the moment a token is marked visited, cleared when reverted. This is
    // what makes "now serving" and the consultation-pace estimate possible.
    visitedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Deliberately NOT unique: the atomic counter guarantees ordering, and a unique
// index here only creates avoidable E11000 crashes under concurrent booking.
appointmentSchema.index({ clinicId: 1, date: 1, bookingNumber: 1 });
appointmentSchema.index({ clinicId: 1, date: 1, status: 1 });
appointmentSchema.index({ clinicId: 1, mobile: 1 });
appointmentSchema.index({ createdAt: 1 });
// Serves the live queue lookup: newest consultation for a clinic on a date.
appointmentSchema.index({ clinicId: 1, date: 1, visitedAt: -1 });

// Fresh collection name on purpose: an older build of this project left a
// unique "key_1" index behind in queuecounters, which breaks multi-tenant use.
const queueTokenSchema = new mongoose.Schema(
  {
    clinicId: { type: String, required: true },
    date: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'queuetokens' }
);

queueTokenSchema.index({ clinicId: 1, date: 1 }, { unique: true });

const Clinic = mongoose.model('Clinic', clinicSchema);
const Appointment = mongoose.model('Appointment', appointmentSchema);
const QueueToken = mongoose.model('QueueToken', queueTokenSchema);

/* ------------------------------------------------------- database startup -- */

mongoose.set('strictQuery', true);

// Drops leftover unique indexes from the single-clinic era. Data is untouched:
// only index definitions are removed, and only when they lack clinicId.
async function reconcileIndexes() {
  const keep = new Set(['_id_', 'bookingId_1']);
  try {
    const collections = await mongoose.connection.db.listCollections().toArray();
    const names = collections.map((c) => c.name);

    if (names.includes('appointments')) {
      const coll = mongoose.connection.collection('appointments');
      const indexes = await coll.indexes();
      for (const index of indexes) {
        const keys = Object.keys(index.key || {});
        const legacy = index.unique && !keep.has(index.name) && !keys.includes('clinicId');
        if (legacy) {
          await coll.dropIndex(index.name);
          console.log('[fix] Dropped legacy unique index appointments.' + index.name);
        }
      }
    }

    if (names.includes('queuecounters')) {
      const stale = await mongoose.connection.collection('queuecounters').countDocuments();
      console.log('[info] Old queuecounters collection found (' + stale + ' docs). It is no longer used and can be deleted from Atlas.');
    }

    await Promise.all([Clinic.syncIndexes(), Appointment.syncIndexes(), QueueToken.syncIndexes()]);
    console.log('[OK] Indexes verified');
  } catch (error) {
    console.error('[warn] Index reconciliation skipped:', error.message);
  }
}

async function connectDb(attempt = 1) {
  if (!MONGODB_URI) {
    console.error('[ERROR] MONGODB_URI is missing. Add it to Backend/.env, then restart.');
    return;
  }
  try {
    await mongoose.connect(MONGODB_URI, {
      dbName: DB_NAME,
      serverSelectionTimeoutMS: 20000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
    });
    console.log('[OK] MongoDB Atlas connected -> database "' + DB_NAME + '"');
    await reconcileIndexes();
    await runCleanup('startup');
  } catch (error) {
    console.error('[ERROR] MongoDB connection failed (attempt ' + attempt + '):', error.message);
    if (/IP|whitelist|ENOTFOUND|querySrv/i.test(error.message)) {
      console.error('        Hint: allow your current IP in Atlas -> Network Access, and check the URI.');
    }
    setTimeout(() => connectDb(attempt + 1), Math.min(30000, attempt * 5000));
  }
}

connectDb();

mongoose.connection.on('disconnected', () => console.warn('[warn] MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('[OK] MongoDB reconnected'));

const dbUp = () => mongoose.connection.readyState === 1;

// Any /api route except /api/health needs a live database.
app.use('/api', (req, res, next) => {
  if (req.originalUrl.startsWith('/api/health')) return next();
  if (dbUp()) return next();
  return res.status(503).json({
    success: false,
    message: 'Database is not connected yet. Check MONGODB_URI in Backend/.env and your Atlas IP access list.',
  });
});

/* ---------------------------------------------------------------- helpers -- */

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const esc = (value = '') =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));

const str = (value) => String(value === undefined || value === null ? '' : value).trim();

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Booking window: today through the next 5 days (today included so that
// walk-ins and same-day online bookings share one queue).
function getAvailableDates() {
  const start = todayStr();
  const out = [];
  for (let i = 0; i <= BOOKING_DAYS; i += 1) out.push(addDays(start, i));
  return out;
}

function dateLabel(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const nice = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(dt);
  const t = todayStr();
  if (ymd === t) return 'Today, ' + nice;
  if (ymd === addDays(t, 1)) return 'Tomorrow, ' + nice;
  return nice;
}

function longDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(dt);
}

function slugify(value) {
  return str(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function clinicCode(clinicId) {
  const letters = str(clinicId).replace(/[^a-z0-9]/gi, '').toUpperCase();
  return (letters.slice(0, 4) || 'MCFL').padEnd(4, 'X');
}

function newBookingId(clinicId) {
  return clinicCode(clinicId) + '-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}

function sixDigits() {
  return String(crypto.randomInt(100000, 1000000));
}

function publicClinic(clinic) {
  const raw = clinic && clinic.toObject ? clinic.toObject() : clinic || {};
  return {
    clinicId: raw.clinicId,
    clinicName: raw.clinicName,
    doctorName: raw.doctorName,
    specialization: raw.specialization,
    address: raw.address,
    city: raw.city || '',
    phone: raw.phone,
    photo: raw.photo || '',
    about: raw.about || '',
    timings: raw.timings || '',
    createdAt: raw.createdAt,
  };
}

function adminClinic(clinic) {
  const raw = clinic && clinic.toObject ? clinic.toObject() : clinic || {};
  return Object.assign(publicClinic(raw), { adminUserId: raw.adminUserId, adminEmail: raw.adminEmail });
}

/* ------------------------------------------------------------- validation -- */

// Same rules as the original single-clinic validateAppointmentForm().
function validateAppointmentForm(data, options = {}) {
  const walkIn = options.walkIn === true;
  const form = data || {};
  const name = str(form.name);
  const gender = str(form.gender);
  const age = Number(form.age);
  const weight = Number(form.weight);
  const date = str(form.date);
  const mobile = str(form.mobile);
  const email = str(form.email).toLowerCase();
  const address = str(form.address);
  const quota = str(form.quota);

  if (!name || name.length < 2) return 'Please enter the full name of the patient.';
  if (!['Male', 'Female', 'Other'].includes(gender)) return 'Please select a gender.';
  if (!Number.isFinite(age) || age < 1 || age > 120) return 'Age must be between 1 and 120.';
  if (!Number.isFinite(weight) || weight < 1) return 'Please enter a valid weight in kg.';
  if (!['General', 'Emergency'].includes(quota)) return 'Please choose General or Emergency quota.';
  if (!/^\d{10}$/.test(mobile)) return 'Mobile number must be exactly 10 digits.';
  if (!address || address.length < 4) return 'Please enter the patient address.';

  if (walkIn) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid email address, or leave it blank.';
    if (date !== todayStr()) return 'Walk-in patients can only be added to today\'s queue.';
  } else {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid email address (the OTP is sent there).';
    if (!getAvailableDates().includes(date)) return 'Appointments can only be booked from today up to the next ' + BOOKING_DAYS + ' days.';
  }
  return null;
}

function normalizeForm(form, source) {
  return {
    name: str(form.name),
    gender: str(form.gender),
    age: Number(form.age),
    weight: Number(form.weight),
    date: str(form.date),
    mobile: str(form.mobile),
    email: str(form.email).toLowerCase(),
    address: str(form.address),
    quota: str(form.quota) === 'Emergency' ? 'Emergency' : 'General',
    source: source === 'walk-in' ? 'walk-in' : 'online',
  };
}

function validateRegistration(body) {
  const required = ['clinicName', 'doctorName', 'specialization', 'address', 'phone', 'adminEmail', 'adminUserId', 'password'];
  for (const field of required) {
    if (!str(body[field])) return 'Please fill in every required field (' + field + ' is missing).';
  }
  if (!/^\d{10}$/.test(str(body.phone))) return 'Clinic phone number must be exactly 10 digits.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(body.adminEmail))) return 'Please enter a valid admin email address.';
  if (!/^[a-zA-Z0-9_.]{4,24}$/.test(str(body.adminUserId))) return 'Admin user ID must be 4-24 characters (letters, numbers, dot or underscore).';
  if (str(body.password).length < 6) return 'Password must be at least 6 characters long.';
  return null;
}

/* ------------------------------------------------- queue number generation -- */

// Seeds the counter from real appointments so a fresh counter can never reuse a
// number that already exists (e.g. after old counter docs were removed).
async function seedCounter(clinicId, date) {
  const existing = await QueueToken.findOne({ clinicId, date }).lean();
  if (existing) return;
  const last = await Appointment.find({ clinicId, date }).sort({ bookingNumber: -1 }).limit(1).lean();
  const start = last.length ? Number(last[0].bookingNumber) || 0 : 0;
  try {
    await QueueToken.updateOne({ clinicId, date }, { $setOnInsert: { clinicId, date, seq: start } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
}

// Atomic, sequential, per clinic per day. Walk-ins and online bookings share it.
async function getNextBookingNumber(clinicId, date) {
  await seedCounter(clinicId, date);
  const counter = await QueueToken.findOneAndUpdate(
    { clinicId, date },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return counter.seq;
}

async function createAppointment(clinicId, form, source, attempt = 1) {
  const data = normalizeForm(form, source);
  const bookingNumber = await getNextBookingNumber(clinicId, data.date);
  try {
    return await Appointment.create(Object.assign({ clinicId, bookingId: newBookingId(clinicId), bookingNumber }, data));
  } catch (error) {
    if (error.code === 11000 && attempt < 4) return createAppointment(clinicId, form, source, attempt + 1);
    throw error;
  }
}

/* ------------------------------------------------------------------ email -- */

// Unchanged mechanism: POST { to, subject, html } to the Google Apps Script
// web app. Only the branding is parameterised per clinic.
// Live mailer state, exposed by GET /api/health/mailer. Check this first when
// a registration or password-reset code does not arrive.
const mailer = { sent: 0, failed: 0, lastOkAt: null, lastTo: '', lastError: '' };

async function sendEmail({ to, subject, html }) {
  if (!to) {
    mailer.failed += 1;
    mailer.lastError = 'No recipient address was supplied.';
    return false;
  }
  if (!GOOGLE_SCRIPT_URL) {
    mailer.failed += 1;
    mailer.lastError = 'GOOGLE_SCRIPT_URL is missing from the backend .env file.';
    console.error('[ERROR] GOOGLE_SCRIPT_URL is not set - email skipped:', subject);
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ to, subject, html }),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      mailer.failed += 1;
      mailer.lastError =
        'Mailer responded with HTTP ' + response.status + '. Re-deploy the Apps Script web app with access set to "Anyone".';
      console.error('[ERROR] Mailer responded with HTTP ' + response.status);
      return false;
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_ignored) {
      payload = null;
    }
    if (payload && payload.success === false) {
      mailer.failed += 1;
      mailer.lastError = 'Mailer rejected the request: ' + (payload.error || 'unknown error');
      console.error('[ERROR] Mailer rejected the request:', payload.error || 'unknown error');
      return false;
    }
    mailer.sent += 1;
    mailer.lastOkAt = new Date().toISOString();
    mailer.lastTo = to;
    mailer.lastError = '';
    console.log('[mail] Sent to ' + to + ' :: ' + subject);
    return true;
  } catch (error) {
    mailer.failed += 1;
    mailer.lastError = error.name === 'AbortError' ? 'Mailer timed out after 20s.' : 'Mailer failed: ' + error.message;
    console.error('[ERROR] Mailer failed:', error.name === 'AbortError' ? 'timeout after 20s' : error.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const headerHTML = (clinic, accent = '#0f766e') => `
<div style="background:linear-gradient(135deg,${accent},#0ea5e9);padding:26px 30px;text-align:center;">
  <p style="margin:0 0 6px;color:#d1fae5;font:600 11px/1 Arial,sans-serif;letter-spacing:2px;">${esc(BRAND).toUpperCase()}</p>
  <h2 style="margin:0;color:#ffffff;font:700 22px/1.3 Georgia,serif;">${esc(clinic.clinicName)}</h2>
  <p style="margin:8px 0 0;color:#e0f2fe;font:400 13px/1.5 Arial,sans-serif;">${esc(clinic.doctorName)} &nbsp;|&nbsp; ${esc(clinic.specialization)}</p>
</div>`;

const footerHTML = (clinic) => `
<div style="background:#f1f5f9;padding:18px 30px;text-align:center;font:400 12px/1.7 Arial,sans-serif;color:#64748b;">
  <p style="margin:0 0 4px;color:#0f172a;font-weight:700;">${esc(clinic.clinicName)}</p>
  <p style="margin:0;">${esc(clinic.address)}</p>
  <p style="margin:0;">Phone: ${esc(clinic.phone)}</p>
  <p style="margin:10px 0 0;color:#94a3b8;">This is an automated message from ${esc(BRAND)}. Please do not reply.</p>
</div>`;

const shell = (clinic, body) =>
  `<div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;font-family:Arial,sans-serif;">${headerHTML(
    clinic
  )}${body}${footerHTML(clinic)}</div>`;

const row = (label, value, strong = false) => `
  <tr>
    <td style="padding:11px 16px;border-bottom:1px solid #eef2f6;color:#64748b;font-size:13px;">${esc(label)}</td>
    <td style="padding:11px 16px;border-bottom:1px solid #eef2f6;color:#0f172a;font-size:${strong ? '17px;font-weight:700' : '14px'};">${value}</td>
  </tr>`;

function otpEmail(clinic, form, otp) {
  return shell(
    clinic,
    `<div style="padding:30px;">
      <h3 style="margin:0 0 6px;color:#0f766e;font-size:19px;">Verify your appointment</h3>
      <p style="margin:0 0 18px;color:#475569;font-size:14px;line-height:1.7;">Hello ${esc(form.name)}, use the code below to confirm your booking at <b>${esc(
      clinic.clinicName
    )}</b>.</p>
      <div style="text-align:center;background:#f0fdfa;border:1px dashed #14b8a6;border-radius:12px;padding:22px;">
        <p style="margin:0 0 8px;color:#0f766e;font-size:12px;letter-spacing:1px;">YOUR ONE TIME PASSWORD</p>
        <p style="margin:0;font-size:34px;font-weight:700;letter-spacing:10px;color:#0f766e;">${esc(otp)}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:22px;">
        ${row('Patient', esc(form.name))}
        ${row('Appointment date', esc(longDate(form.date)))}
        ${row('Quota', esc(form.quota))}
      </table>
      <p style="margin:18px 0 0;color:#b45309;font-size:13px;">This code expires in 10 minutes. Never share it with anyone.</p>
    </div>`
  );
}

function confirmEmail(clinic, appointment) {
  const walkIn = appointment.source === 'walk-in';
  return shell(
    clinic,
    `<div style="padding:30px;">
      <h3 style="margin:0 0 6px;color:#059669;font-size:19px;">${walkIn ? 'You are in the queue' : 'Appointment confirmed'}</h3>
      <p style="margin:0 0 20px;color:#475569;font-size:14px;line-height:1.7;">Dear ${esc(
        appointment.name
      )}, your appointment has been registered successfully.</p>
      <div style="text-align:center;background:linear-gradient(135deg,#0f766e,#0ea5e9);border-radius:12px;padding:22px;">
        <p style="margin:0 0 6px;color:#d1fae5;font-size:12px;letter-spacing:1px;">YOUR QUEUE NUMBER</p>
        <p style="margin:0;font-size:44px;font-weight:700;color:#ffffff;line-height:1;">#${appointment.bookingNumber}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:22px;">
        ${row('Booking ID', esc(appointment.bookingId), true)}
        ${row('Patient', esc(appointment.name) + ' (' + esc(appointment.gender) + ', ' + appointment.age + ')')}
        ${row('Date', esc(longDate(appointment.date)))}
        ${row('Quota', appointment.quota === 'Emergency' ? '<span style="color:#dc2626;font-weight:700;">Emergency</span>' : 'General')}
        ${row('Doctor', esc(clinic.doctorName))}
      </table>
      <div style="margin-top:20px;background:#fffbeb;border-left:4px solid #f59e0b;padding:14px 16px;border-radius:8px;">
        <p style="margin:0;color:#92400e;font-size:13px;line-height:1.7;">Please arrive 15-20 minutes before your queue number is called, and carry this booking ID.</p>
      </div>
    </div>`
  );
}

function cancelEmail(clinic, appointment) {
  return shell(
    clinic,
    `<div style="padding:30px;">
      <h3 style="margin:0 0 6px;color:#dc2626;font-size:19px;">Appointment cancelled</h3>
      <p style="margin:0 0 18px;color:#475569;font-size:14px;line-height:1.7;">Dear ${esc(
        appointment.name
      )}, your appointment at <b>${esc(clinic.clinicName)}</b> has been cancelled by the clinic.</p>
      <table style="width:100%;border-collapse:collapse;">
        ${row('Booking ID', esc(appointment.bookingId))}
        ${row('Queue number', '#' + appointment.bookingNumber)}
        ${row('Date', esc(longDate(appointment.date)))}
      </table>
      <p style="margin:18px 0 0;color:#475569;font-size:13px;line-height:1.7;">You can book a new appointment any time from ${esc(
        BRAND
      )}. For help, call ${esc(clinic.phone)}.</p>
    </div>`
  );
}

function welcomeEmail(clinic) {
  return shell(
    clinic,
    `<div style="padding:30px;">
      <h3 style="margin:0 0 6px;color:#0f766e;font-size:19px;">Welcome to ${esc(BRAND)}</h3>
      <p style="margin:0 0 18px;color:#475569;font-size:14px;line-height:1.7;">${esc(
        clinic.clinicName
      )} is now listed publicly and patients can start booking appointments right away.</p>
      <table style="width:100%;border-collapse:collapse;">
        ${row('Admin user ID', esc(clinic.adminUserId), true)}
        ${row('Clinic page', '/clinic/' + esc(clinic.clinicId))}
        ${row('Specialization', esc(clinic.specialization))}
      </table>
      <p style="margin:18px 0 0;color:#475569;font-size:13px;line-height:1.7;">Keep your password safe. If you forget it, use "Forgot password" on the sign-in screen and a reset code will be emailed to this address.</p>
    </div>`
  );
}

function resetEmail(clinic, code) {
  return shell(
    clinic,
    `<div style="padding:30px;">
      <h3 style="margin:0 0 6px;color:#0f766e;font-size:19px;">Password reset code</h3>
      <p style="margin:0 0 18px;color:#475569;font-size:14px;line-height:1.7;">Use this code to set a new password for the ${esc(
        clinic.clinicName
      )} dashboard.</p>
      <div style="text-align:center;background:#f0fdfa;border:1px dashed #14b8a6;border-radius:12px;padding:22px;">
        <p style="margin:0;font-size:34px;font-weight:700;letter-spacing:10px;color:#0f766e;">${esc(code)}</p>
      </div>
      <p style="margin:18px 0 0;color:#b45309;font-size:13px;">The code expires in 15 minutes. If you did not request it, you can ignore this email.</p>
    </div>`
  );
}

/* ------------------------------------------------------------------- auth -- */

const otpStore = new Map();
const otpKey = (clinicId, email) => clinicId + '::' + str(email).toLowerCase();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of otpStore) if (value.expires < now) otpStore.delete(key);
}, 5 * 60 * 1000).unref();

function signToken(clinic) {
  return jwt.sign({ clinicId: clinic.clinicId, adminUserId: clinic.adminUserId, clinicName: clinic.clinicName }, JWT_SECRET, {
    expiresIn: SESSION_TTL,
  });
}

// Replaces the old shared x-admin-secret header with per-clinic JWT auth.
function clinicAuth(req, res, next) {
  const raw = str(req.headers.authorization || req.headers['x-auth-token']);
  const token = raw.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ success: false, message: 'Please sign in to open your clinic dashboard.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.clinicId) throw new Error('missing clinicId');
    req.admin = payload;
    req.clinicId = payload.clinicId; // the ONLY source of clinic scope
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
  }
}

/* --------------------------------------------------------- public routes -- */

app.get('/', (_req, res) =>
  res.json({
    success: true,
    service: BRAND + ' API',
    docs: '/api/health',
    database: dbUp() ? 'connected' : 'not connected',
  })
);

app.get('/api/health', (_req, res) =>
  res.json({
    success: true,
    service: BRAND + ' API',
    database: dbUp() ? 'connected' : MONGODB_URI ? 'connecting' : 'MONGODB_URI missing',
    dbName: DB_NAME,
    mailer: GOOGLE_SCRIPT_URL ? 'configured' : 'missing GOOGLE_SCRIPT_URL',
    timezone: TZ,
    today: todayStr(),
    port: PORT,
    realtime: io ? 'socket.io live' : 'polling only - run: npm install socket.io',
    liveViewers: io && io.engine ? io.engine.clientsCount : 0,
    keepAlive: keepAlive.enabled
      ? 'every ' + keepAlive.minutes + ' min (ok ' + keepAlive.pings + ', failed ' + keepAlive.failed + ')'
      : 'off',
    keepAliveTarget: keepAlive.target || null,
    lastKeepAliveAt: keepAlive.lastPingAt,
  })
);

app.get('/api/available-dates', (_req, res) =>
  res.json({
    success: true,
    today: todayStr(),
    dates: getAvailableDates().map((value) => ({ value, label: dateLabel(value) })),
  })
);

// Live "today's queue" snapshot for every clinic in one aggregation.
async function queueSnapshot(clinicIds) {
  const date = todayStr();
  if (!clinicIds.length) return {};
  const rows = await Appointment.aggregate([
    { $match: { clinicId: { $in: clinicIds }, date } },
    {
      $group: {
        _id: '$clinicId',
        booked: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] } },
        visited: { $sum: { $cond: [{ $eq: ['$status', 'visited'] }, 1, 0] } },
        waiting: { $sum: { $cond: [{ $eq: ['$status', 'booked'] }, 1, 0] } },
        nextToken: { $min: { $cond: [{ $eq: ['$status', 'booked'] }, '$bookingNumber', null] } },
      },
    },
  ]);
  const map = {};
  for (const r of rows) {
    map[r._id] = { booked: r.booked, visited: r.visited, waiting: r.waiting, nextToken: r.nextToken || null };
  }
  return map;
}

// Fallback pace used until at least two consultations have been completed.
const DEFAULT_CONSULT_MINUTES = 8;

// The heart of the live queue. "Now serving" is the most recently stamped
// visit rather than the highest token, so reverting a token or seeing an
// emergency case out of order still reports the correct current patient.
async function liveQueue(clinicId, date) {
  const rows = await Appointment.find({ clinicId, date })
    .select('bookingNumber status quota source visitedAt updatedAt')
    .sort({ bookingNumber: 1 })
    .lean();

  let maxToken = 0;
  let visited = 0;
  let waiting = 0;
  let cancelled = 0;
  let anchor = 0;
  const waitingTokens = [];
  const visits = [];

  for (const row of rows) {
    if (row.bookingNumber > maxToken) maxToken = row.bookingNumber;
    if (row.status === 'visited') {
      visited += 1;
      if (row.bookingNumber > anchor) anchor = row.bookingNumber;
      visits.push({ bookingNumber: row.bookingNumber, at: row.visitedAt || row.updatedAt || null });
    } else if (row.status === 'cancelled') {
      cancelled += 1;
    } else {
      waiting += 1;
      waitingTokens.push(row.bookingNumber);
    }
  }

  /* The up-next marker must never travel backwards. It is anchored to the
     HIGHEST token already visited rather than the lowest token still waiting,
     so marking a skipped token visited later on cannot drag the marker back up
     the queue. Tokens left behind are only offered once the doctor has run out
     of tokens ahead, and nextIsLeftover lets the UI say so. */
  waitingTokens.sort((a, b) => a - b);
  let nextToken = null;
  for (const token of waitingTokens) {
    if (token > anchor) {
      nextToken = token;
      break;
    }
  }
  const nextIsLeftover = nextToken === null && waitingTokens.length > 0;
  if (nextIsLeftover) nextToken = waitingTokens[0];

  // Prefer timestamps; fall back to the highest visited token for rows created
  // before visitedAt existed, so older data still shows something sensible.
  const stamped = visits.filter((v) => v.at).sort((a, b) => new Date(a.at) - new Date(b.at));
  let current = null;
  if (stamped.length) {
    current = stamped[stamped.length - 1];
  } else if (visits.length) {
    current = visits.slice().sort((a, b) => a.bookingNumber - b.bookingNumber).pop();
  }

  // Pace = median gap between consecutive consultations. Median (not mean)
  // because one lunch break would otherwise wreck every estimate. Gaps outside
  // 0.2-120 minutes are treated as noise/breaks and dropped.
  let paceMinutes = null;
  let paceSamples = 0;
  if (stamped.length >= 2) {
    const gaps = [];
    for (let i = 1; i < stamped.length; i += 1) {
      const mins = (new Date(stamped[i].at) - new Date(stamped[i - 1].at)) / 60000;
      if (mins > 0.2 && mins < 120) gaps.push(mins);
    }
    if (gaps.length) {
      gaps.sort((a, b) => a - b);
      const mid = Math.floor(gaps.length / 2);
      const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
      paceMinutes = Math.max(2, Math.min(45, Math.round(median)));
      paceSamples = gaps.length;
    }
  }

  return {
    date,
    dateLabel: dateLabel(date),
    maxToken,
    currentToken: current ? current.bookingNumber : null,
    lastVisitedAt: current && current.at ? new Date(current.at).toISOString() : null,
    nextToken,
    nextIsLeftover,
    anchorToken: anchor || null,
    total: rows.length,
    active: rows.length - cancelled,
    visited,
    waiting,
    cancelled,
    paceMinutes,
    paceSamples,
    defaultPaceMinutes: DEFAULT_CONSULT_MINUTES,
    serverTime: new Date().toISOString(),
    tokens: rows.map((row) => ({
      bookingNumber: row.bookingNumber,
      status: row.status,
      quota: row.quota,
      source: row.source,
    })),
  };
}

/* ------------------------------------------------------------- realtime -- */

// One room per clinic per day, so a clinic only ever wakes up its own viewers.
function queueRoom(clinicId, date) {
  return 'queue:' + clinicId + ':' + date;
}

// Pushes a fresh board to everyone watching this clinic/day. The payload is the
// same PII-free shape as GET /api/clinics/:clinicId/live - token numbers and
// statuses only, never names, mobiles or emails - so it is safe to broadcast to
// unauthenticated patients. Never throws: a broken socket must not fail a write.
async function broadcastQueue(clinicId, date, reason) {
  if (!io || !clinicId || !date) return;
  try {
    const live = await liveQueue(clinicId, date);
    io.to(queueRoom(clinicId, date)).emit('queue:update', {
      clinicId,
      date,
      reason: reason || 'change',
      live,
    });
  } catch (error) {
    console.error('[warn] Queue broadcast failed:', error.message);
  }
}

app.get(
  '/api/clinics',
  ah(async (req, res) => {
    const search = str(req.query.search);
    const specialization = str(req.query.specialization);
    const filter = { active: true };
    if (specialization && specialization !== 'All') filter.specialization = specialization;
    if (search) {
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ clinicName: rx }, { doctorName: rx }, { specialization: rx }, { address: rx }, { city: rx }];
    }
    const clinics = await Clinic.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const snapshot = await queueSnapshot(clinics.map((c) => c.clinicId));
    return res.json({
      success: true,
      count: clinics.length,
      clinics: clinics.map((c) =>
        Object.assign(publicClinic(c), {
          todayQueue: snapshot[c.clinicId] || { booked: 0, visited: 0, waiting: 0, nextToken: null },
        })
      ),
    });
  })
);

app.get(
  '/api/clinics/specializations',
  ah(async (_req, res) => {
    const values = await Clinic.distinct('specialization', { active: true });
    return res.json({ success: true, specializations: values.filter(Boolean).sort() });
  })
);

app.get(
  '/api/clinics/:clinicId',
  ah(async (req, res) => {
    const clinic = await Clinic.findOne({ clinicId: str(req.params.clinicId), active: true }).lean();
    if (!clinic) return res.status(404).json({ success: false, message: 'This clinic could not be found.' });
    const snapshot = await queueSnapshot([clinic.clinicId]);
    return res.json({
      success: true,
      clinic: Object.assign(publicClinic(clinic), {
        todayQueue: snapshot[clinic.clinicId] || { booked: 0, visited: 0, waiting: 0, nextToken: null },
      }),
      today: todayStr(),
      dates: getAvailableDates().map((value) => ({ value, label: dateLabel(value) })),
    });
  })
);

// Public live queue feed for the patient tracker. Deliberately carries no
// patient details - only token numbers, statuses and pace - so it is safe to
// poll without auth.
app.get(
  '/api/clinics/:clinicId/live',
  ah(async (req, res) => {
    const clinic = await Clinic.findOne({ clinicId: str(req.params.clinicId), active: true }).lean();
    if (!clinic) return res.status(404).json({ success: false, message: 'This clinic could not be found.' });

    const date = str(req.query.date) || todayStr();
    const live = await liveQueue(clinic.clinicId, date);

    return res.json({
      success: true,
      clinic: {
        clinicId: clinic.clinicId,
        clinicName: clinic.clinicName,
        doctorName: clinic.doctorName,
        specialization: clinic.specialization,
        address: clinic.address,
        phone: clinic.phone,
      },
      today: todayStr(),
      live,
    });
  })
);

// Patients have no accounts: a booking is looked up by mobile or booking ID.
app.get(
  '/api/lookup',
  ah(async (req, res) => {
    const mobile = str(req.query.mobile);
    const bookingId = str(req.query.bookingId).toUpperCase();
    if (!mobile && !bookingId) {
      return res.status(400).json({ success: false, message: 'Enter a 10-digit mobile number or a booking ID.' });
    }
    const query = bookingId ? { bookingId } : { mobile };
    if (mobile && !/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ success: false, message: 'Mobile number must be exactly 10 digits.' });
    }
    const rows = await Appointment.find(query).sort({ date: -1, bookingNumber: -1 }).limit(25).lean();
    if (!rows.length) return res.json({ success: true, count: 0, appointments: [] });

    const clinics = await Clinic.find({ clinicId: { $in: [...new Set(rows.map((r) => r.clinicId))] } }).lean();
    const byId = {};
    for (const c of clinics) byId[c.clinicId] = c;

    return res.json({
      success: true,
      count: rows.length,
      appointments: rows.map((r) => ({
        bookingId: r.bookingId,
        bookingNumber: r.bookingNumber,
        name: r.name,
        date: r.date,
        dateLabel: dateLabel(r.date),
        quota: r.quota,
        status: r.status,
        source: r.source,
        clinicId: r.clinicId,
        clinicName: byId[r.clinicId] ? byId[r.clinicId].clinicName : 'Clinic',
        doctorName: byId[r.clinicId] ? byId[r.clinicId].doctorName : '',
        address: byId[r.clinicId] ? byId[r.clinicId].address : '',
      })),
    });
  })
);

/* ----------------------------------------------------- clinic onboarding -- */
/* Registration is a two-step, email-verified flow:                           */
/*   1. POST /api/auth/register/send-otp - validates everything, emails a      */
/*      6-digit code and parks the payload in memory. NOTHING is written to    */
/*      MongoDB at this stage, so abandoned signups leave no rows behind.      */
/*   2. POST /api/auth/register/verify   - checks the code, then creates the   */
/*      clinic and returns the dashboard session.                             */
/* The old unverified POST /api/auth/register has been removed.               */

// adminUserId (lowercase) -> { data, otp, expires, attempts }
const pendingRegistrations = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingRegistrations) if (value.expires < now) pendingRegistrations.delete(key);
}, 5 * 60 * 1000).unref();

// clinic@example.com -> cl***@example.com : safe to show in the browser.
function maskEmail(value) {
  const email = str(value);
  const at = email.indexOf('@');
  if (at < 1) return email;
  return email.slice(0, Math.min(2, at)) + '***' + email.slice(at);
}

// Matches an admin user ID OR an admin email, case-insensitively.
function identifierQuery(raw) {
  const value = str(raw).trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  const exact = new RegExp('^' + lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  return { $or: [{ adminUserId: lower }, { adminEmail: lower }, { adminEmail: exact }] };
}

function registerOtpEmail(pending, code) {
  const pseudoClinic = {
    clinicName: str(pending.clinicName) || BRAND,
    doctorName: str(pending.doctorName),
    specialization: str(pending.specialization),
    address: str(pending.address),
    phone: str(pending.phone),
  };
  return shell(
    pseudoClinic,
    `<div style="padding:30px;">
      <h3 style="margin:0 0 6px;color:#0f766e;font-size:19px;">Verify your email address</h3>
      <p style="margin:0 0 18px;color:#475569;font-size:14px;line-height:1.7;">Use the code below to finish registering <b>${esc(
        pseudoClinic.clinicName
      )}</b> on ${esc(BRAND)}. The clinic account is created only after this code is verified.</p>
      <div style="text-align:center;background:#f0fdfa;border:1px dashed #14b8a6;border-radius:12px;padding:22px;">
        <p style="margin:0 0 8px;color:#0f766e;font-size:12px;letter-spacing:1px;">EMAIL VERIFICATION CODE</p>
        <p style="margin:0;font-size:34px;font-weight:700;letter-spacing:10px;color:#0f766e;">${esc(code)}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:22px;">
        ${row('Clinic', esc(pseudoClinic.clinicName))}
        ${row('Doctor', esc(pseudoClinic.doctorName))}
        ${row('Admin user ID', esc(str(pending.adminUserId).toLowerCase()), true)}
      </table>
      <p style="margin:18px 0 0;color:#b45309;font-size:13px;">This code expires in 10 minutes. If you did not start this registration, please ignore this email.</p>
    </div>`
  );
}

app.post(
  '/api/auth/register/send-otp',
  ah(async (req, res) => {
    const body = req.body || {};
    const problem = validateRegistration(body);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const wantedId = str(body.adminUserId).toLowerCase();
    if (await Clinic.exists({ adminUserId: wantedId })) {
      return res.status(409).json({ success: false, message: 'That admin user ID is already taken. Please choose another.' });
    }
    if (await Clinic.exists(identifierQuery(body.adminEmail) || { _id: null })) {
      return res.status(409).json({
        success: false,
        message: 'That admin email is already registered. Sign in instead, or use "Forgot password".',
      });
    }

    const code = sixDigits();
    const sent = await sendEmail({
      to: str(body.adminEmail),
      subject: 'Verify your email - ' + str(body.clinicName) + ' on ' + BRAND,
      html: registerOtpEmail(body, code),
    });
    if (!sent) {
      return res.status(502).json({
        success: false,
        message:
          'The verification email could not be sent (' +
          (mailer.lastError || 'mailer error') +
          '). Fix GOOGLE_SCRIPT_URL in the backend .env file and try again.',
      });
    }

    pendingRegistrations.set(wantedId, { data: body, otp: code, expires: Date.now() + OTP_TTL_MS, attempts: 0 });
    console.log('[register] Verification code sent to ' + str(body.adminEmail) + ' for ' + wantedId);

    return res.json({
      success: true,
      message: 'A 6-digit verification code has been emailed to ' + maskEmail(body.adminEmail) + '.',
      sentTo: maskEmail(body.adminEmail),
      expiresInMinutes: Math.round(OTP_TTL_MS / 60000),
    });
  })
);

app.post(
  '/api/auth/register/verify',
  ah(async (req, res) => {
    const adminUserId = str((req.body || {}).adminUserId).toLowerCase();
    const otp = str((req.body || {}).otp);
    const pending = pendingRegistrations.get(adminUserId);

    if (!pending || pending.expires < Date.now()) {
      pendingRegistrations.delete(adminUserId);
      return res.status(400).json({
        success: false,
        message: 'That verification code has expired. Go back, check your details and request a new code.',
      });
    }
    if (pending.attempts >= 5) {
      pendingRegistrations.delete(adminUserId);
      return res.status(429).json({ success: false, message: 'Too many incorrect codes. Please start the registration again.' });
    }
    if (pending.otp !== otp) {
      pending.attempts += 1;
      pendingRegistrations.set(adminUserId, pending);
      return res.status(400).json({ success: false, message: 'Incorrect code. ' + (5 - pending.attempts) + ' attempt(s) left.' });
    }

    const body = pending.data;
    pendingRegistrations.delete(adminUserId);

    if (await Clinic.exists({ adminUserId })) {
      return res.status(409).json({ success: false, message: 'That admin user ID is already taken. Please choose another.' });
    }

    let clinicId = slugify(body.clinicName) || 'clinic';
    if (await Clinic.exists({ clinicId })) clinicId = clinicId + '-' + crypto.randomBytes(2).toString('hex');

    const clinic = await Clinic.create({
      clinicId,
      clinicName: str(body.clinicName),
      doctorName: str(body.doctorName),
      specialization: str(body.specialization),
      address: str(body.address),
      city: str(body.city),
      phone: str(body.phone),
      photo: str(body.photo),
      about: str(body.about),
      timings: str(body.timings),
      adminUserId,
      adminEmail: str(body.adminEmail).toLowerCase(),
      passwordHash: await bcrypt.hash(str(body.password), BCRYPT_ROUNDS),
    });

    sendEmail({
      to: clinic.adminEmail,
      subject: 'Your clinic is live on ' + BRAND,
      html: welcomeEmail(clinic),
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: clinic.clinicName + ' is registered and listed publicly.',
      token: signToken(clinic),
      clinic: adminClinic(clinic),
    });
  })
);

app.post(
  '/api/auth/login',
  ah(async (req, res) => {
    const adminUserId = str((req.body || {}).adminUserId).toLowerCase();
    const password = str((req.body || {}).password);
    if (!adminUserId || !password) {
      return res.status(400).json({ success: false, message: 'Enter your user ID and password.' });
    }
    const clinic = await Clinic.findOne({ adminUserId });
    const ok = clinic && (await bcrypt.compare(password, clinic.passwordHash));
    if (!ok) return res.status(401).json({ success: false, message: 'Incorrect user ID or password.' });
    if (!clinic.active) return res.status(403).json({ success: false, message: 'This clinic account is disabled.' });

    return res.json({
      success: true,
      message: 'Welcome back, ' + clinic.clinicName + '.',
      token: signToken(clinic),
      clinic: adminClinic(clinic),
    });
  })
);

app.get(
  '/api/auth/me',
  clinicAuth,
  ah(async (req, res) => {
    const clinic = await Clinic.findOne({ clinicId: req.clinicId }).lean();
    if (!clinic) return res.status(404).json({ success: false, message: 'Clinic not found.' });
    return res.json({ success: true, clinic: adminClinic(clinic) });
  })
);

/* Mailer diagnostics: open http://localhost:5000/api/health/mailer whenever a  */
/* code does not arrive - it reports the exact reason the last send failed.     */
app.get('/api/health/mailer', (_req, res) =>
  res.json({
    success: true,
    scriptUrlConfigured: Boolean(GOOGLE_SCRIPT_URL),
    sent: mailer.sent,
    failed: mailer.failed,
    lastOkAt: mailer.lastOkAt,
    lastTo: mailer.lastTo ? maskEmail(mailer.lastTo) : '',
    lastError: mailer.lastError,
  })
);

app.post(
  '/api/admin/test-email',
  clinicAuth,
  ah(async (req, res) => {
    const clinic = await Clinic.findOne({ clinicId: req.clinicId });
    if (!clinic) return res.status(404).json({ success: false, message: 'Clinic not found.' });
    const sent = await sendEmail({
      to: clinic.adminEmail,
      subject: 'Test email from ' + BRAND,
      html: shell(
        clinic,
        '<div style="padding:30px;"><h3 style="margin:0 0 6px;color:#059669;font-size:19px;">Your mailer works</h3>' +
          '<p style="margin:0;color:#475569;font-size:14px;line-height:1.7;">If you can read this, the Google Apps Script mailer is wired up correctly, so registration codes, OTPs, confirmations and password-reset codes will all reach this inbox.</p></div>'
      ),
    });
    if (!sent) return res.status(502).json({ success: false, message: 'Send failed: ' + (mailer.lastError || 'unknown error') });
    return res.json({ success: true, message: 'Test email sent to ' + maskEmail(clinic.adminEmail) + '.' });
  })
);

/* Accepts the admin user ID OR the registered admin email. The old version   */
/* matched adminUserId only and replied with a generic success when nothing    */
/* matched, so entering the email produced a fake "code sent" and no email.   */
app.post(
  '/api/auth/forgot-password',
  ah(async (req, res) => {
    const body = req.body || {};
    const query = identifierQuery(body.identifier || body.adminUserId || body.adminEmail);
    if (!query) {
      return res.status(400).json({ success: false, message: 'Enter your admin user ID or the admin email you registered with.' });
    }

    const clinic = await Clinic.findOne(query);
    if (!clinic) {
      return res.status(404).json({
        success: false,
        message: 'No clinic admin account matches that user ID or email. Check the spelling, or register your clinic first.',
      });
    }
    if (!clinic.adminEmail) {
      return res.status(400).json({ success: false, message: 'This clinic has no admin email on file, so a reset code cannot be emailed.' });
    }

    const code = sixDigits();
    clinic.resetCodeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    clinic.resetExpires = new Date(Date.now() + RESET_TTL_MS);
    await clinic.save();

    const sent = await sendEmail({
      to: clinic.adminEmail,
      subject: 'Password reset code - ' + clinic.clinicName,
      html: resetEmail(clinic, code),
    });
    if (!sent) {
      return res.status(502).json({
        success: false,
        message:
          'The reset email could not be sent (' +
          (mailer.lastError || 'mailer error') +
          '). Check GOOGLE_SCRIPT_URL in the backend .env file.',
      });
    }
    console.log('[reset] Code emailed to ' + clinic.adminEmail + ' for ' + clinic.adminUserId);

    return res.json({
      success: true,
      message: 'A 6-digit reset code has been emailed to ' + maskEmail(clinic.adminEmail) + '.',
      sentTo: maskEmail(clinic.adminEmail),
      expiresInMinutes: Math.round(RESET_TTL_MS / 60000),
    });
  })
);

app.post(
  '/api/auth/reset-password',
  ah(async (req, res) => {
    const body = req.body || {};
    const query = identifierQuery(body.identifier || body.adminUserId || body.adminEmail);
    const code = str(body.code);
    const password = str(body.password);

    if (!query || !code || !password) {
      return res.status(400).json({
        success: false,
        message: 'Admin user ID (or admin email), the reset code and a new password are all required.',
      });
    }
    if (password.length < 6) return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });

    const clinic = await Clinic.findOne(query);
    const valid =
      clinic &&
      clinic.resetCodeHash &&
      clinic.resetExpires &&
      clinic.resetExpires.getTime() > Date.now() &&
      (await bcrypt.compare(code, clinic.resetCodeHash));

    if (!valid) return res.status(400).json({ success: false, message: 'That reset code is invalid or has expired. Request a new one.' });

    clinic.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    clinic.resetCodeHash = '';
    clinic.resetExpires = null;
    await clinic.save();

    return res.json({ success: true, message: 'Password updated. You can sign in now.', token: signToken(clinic), clinic: adminClinic(clinic) });
  })
);

/* -------------------------------------------------------- booking (OTP) -- */

app.post(
  '/api/booking/send-otp',
  ah(async (req, res) => {
    const body = req.body || {};
    const clinicId = str(body.clinicId);
    const form = body.form || body.formData || {};

    const clinic = await Clinic.findOne({ clinicId, active: true });
    if (!clinic) return res.status(404).json({ success: false, message: 'This clinic could not be found.' });

    const problem = validateAppointmentForm(form);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const duplicate = await Appointment.findOne({
      clinicId,
      date: str(form.date),
      mobile: str(form.mobile),
      status: { $ne: 'cancelled' },
    }).lean();
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'This mobile number already has appointment #' + duplicate.bookingNumber + ' on that date at this clinic.',
      });
    }

    const otp = sixDigits();
    otpStore.set(otpKey(clinicId, form.email), {
      otp,
      form: normalizeForm(form, 'online'),
      expires: Date.now() + OTP_TTL_MS,
      attempts: 0,
    });

    const sent = await sendEmail({
      to: str(form.email),
      subject: 'OTP ' + otp + ' - verify your appointment at ' + clinic.clinicName,
      html: otpEmail(clinic, normalizeForm(form, 'online'), otp),
    });

    if (!sent) {
      otpStore.delete(otpKey(clinicId, form.email));
      return res.status(502).json({
        success: false,
        message: 'We could not send the OTP email. Check GOOGLE_SCRIPT_URL in the backend .env file and try again.',
      });
    }

    return res.json({ success: true, message: 'A 6-digit OTP has been sent to ' + str(form.email) + '.', expiresInMinutes: 10 });
  })
);

app.post(
  '/api/booking/verify',
  ah(async (req, res) => {
    const body = req.body || {};
    const clinicId = str(body.clinicId);
    const email = str(body.email).toLowerCase();
    const otp = str(body.otp);

    const key = otpKey(clinicId, email);
    const pending = otpStore.get(key);

    if (!pending || pending.expires < Date.now()) {
      otpStore.delete(key);
      return res.status(400).json({ success: false, message: 'That OTP has expired. Please request a new one.' });
    }
    if (pending.attempts >= 5) {
      otpStore.delete(key);
      return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new OTP.' });
    }
    if (pending.otp !== otp) {
      pending.attempts += 1;
      otpStore.set(key, pending);
      return res.status(400).json({ success: false, message: 'Incorrect OTP. ' + (5 - pending.attempts) + ' attempt(s) left.' });
    }

    const clinic = await Clinic.findOne({ clinicId, active: true });
    if (!clinic) return res.status(404).json({ success: false, message: 'This clinic could not be found.' });

    otpStore.delete(key);
    const appointment = await createAppointment(clinicId, pending.form, 'online');

    sendEmail({
      to: appointment.email,
      subject: 'Appointment confirmed - queue #' + appointment.bookingNumber + ' at ' + clinic.clinicName,
      html: confirmEmail(clinic, appointment),
    }).catch(() => {});

    broadcastQueue(clinicId, appointment.date, 'new-booking').catch(() => {});

    return res.json({
      success: true,
      message: 'Appointment booked successfully.',
      appointment: {
        bookingId: appointment.bookingId,
        bookingNumber: appointment.bookingNumber,
        name: appointment.name,
        date: appointment.date,
        dateLabel: dateLabel(appointment.date),
        longDate: longDate(appointment.date),
        quota: appointment.quota,
        status: appointment.status,
        email: appointment.email,
        mobile: appointment.mobile,
      },
      clinic: publicClinic(clinic),
    });
  })
);

/* ------------------------------------------- admin dashboard (per clinic) -- */
/* Every query below is filtered by req.clinicId, which comes ONLY from the     */
/* verified JWT. A clinic can never read or write another clinic's data.       */

app.get(
  '/api/admin/stats',
  clinicAuth,
  ah(async (req, res) => {
    const date = str(req.query.date) || todayStr();
    const base = { clinicId: req.clinicId, date };

    const [total, visited, cancelled, emergency, walkIns, nextRow] = await Promise.all([
      Appointment.countDocuments(Object.assign({}, base, { status: { $ne: 'cancelled' } })),
      Appointment.countDocuments(Object.assign({}, base, { status: 'visited' })),
      Appointment.countDocuments(Object.assign({}, base, { status: 'cancelled' })),
      Appointment.countDocuments(Object.assign({}, base, { status: { $ne: 'cancelled' }, quota: 'Emergency' })),
      Appointment.countDocuments(Object.assign({}, base, { status: { $ne: 'cancelled' }, source: 'walk-in' })),
      Appointment.find(Object.assign({}, base, { status: 'booked' })).sort({ bookingNumber: 1 }).limit(1).lean(),
    ]);

    return res.json({
      success: true,
      date,
      dateLabel: dateLabel(date),
      total,
      visited,
      remaining: Math.max(0, total - visited),
      cancelled,
      emergency,
      walkIns,
      nextToken: nextRow.length ? nextRow[0].bookingNumber : null,
    });
  })
);

app.get(
  '/api/admin/analytics',
  clinicAuth,
  ah(async (req, res) => {
    const startDate = str(req.query.startDate);
    const endDate = str(req.query.endDate);
    const base = { clinicId: req.clinicId };
    if (startDate || endDate) {
      base.date = {};
      if (startDate) base.date.$gte = startDate;
      if (endDate) base.date.$lte = endDate;
    }

    const [total, visited, cancelled, visitedGeneral, visitedEmergency, remainingGeneral, remainingEmergency, walkIns, online] =
      await Promise.all([
        Appointment.countDocuments(Object.assign({}, base, { status: { $ne: 'cancelled' } })),
        Appointment.countDocuments(Object.assign({}, base, { status: 'visited' })),
        Appointment.countDocuments(Object.assign({}, base, { status: 'cancelled' })),
        Appointment.countDocuments(Object.assign({}, base, { status: 'visited', quota: 'General' })),
        Appointment.countDocuments(Object.assign({}, base, { status: 'visited', quota: 'Emergency' })),
        Appointment.countDocuments(Object.assign({}, base, { status: 'booked', quota: 'General' })),
        Appointment.countDocuments(Object.assign({}, base, { status: 'booked', quota: 'Emergency' })),
        Appointment.countDocuments(Object.assign({}, base, { status: { $ne: 'cancelled' }, source: 'walk-in' })),
        Appointment.countDocuments(Object.assign({}, base, { status: { $ne: 'cancelled' }, source: 'online' })),
      ]);

    const trendRows = await Appointment.aggregate([
      { $match: base },
      {
        $group: {
          _id: '$date',
          total: { $sum: { $cond: [{ $ne: ['$status', 'cancelled'] }, 1, 0] } },
          visited: { $sum: { $cond: [{ $eq: ['$status', 'visited'] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          emergency: { $sum: { $cond: [{ $eq: ['$quota', 'Emergency'] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 60 },
    ]);

    return res.json({
      success: true,
      range: { startDate: startDate || null, endDate: endDate || null },
      total,
      visited,
      remaining: Math.max(0, total - visited),
      cancelled,
      visitedGeneral,
      visitedEmergency,
      remainingGeneral,
      remainingEmergency,
      walkIns,
      online,
      trend: trendRows.map((r) => ({
        date: r._id,
        label: dateLabel(r._id),
        total: r.total,
        visited: r.visited,
        cancelled: r.cancelled,
        emergency: r.emergency,
      })),
    });
  })
);

app.get(
  '/api/admin/appointments',
  clinicAuth,
  ah(async (req, res) => {
    const { date, startDate, endDate, search, status, quota, source } = req.query;
    const query = { clinicId: req.clinicId };

    if (str(date)) query.date = str(date);
    else if (str(startDate) || str(endDate)) {
      query.date = {};
      if (str(startDate)) query.date.$gte = str(startDate);
      if (str(endDate)) query.date.$lte = str(endDate);
    }

    if (str(status)) query.status = str(status) === 'active' ? { $ne: 'cancelled' } : str(status);
    if (str(quota)) query.quota = str(quota);
    if (str(source)) query.source = str(source);

    if (str(search)) {
      const rx = { $regex: str(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ name: rx }, { email: rx }, { mobile: rx }, { bookingId: rx }];
    }

    const appointments = await Appointment.find(query).sort({ date: -1, bookingNumber: 1 }).limit(500).lean();

    return res.json({
      success: true,
      count: appointments.length,
      appointments: appointments.map((a) => Object.assign({}, a, { dateLabel: dateLabel(a.date) })),
    });
  })
);

async function setStatus(req, res, status) {
  const id = str(req.params.id);
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'Invalid appointment id.' });

  const appointment = await Appointment.findOneAndUpdate(
    { _id: id, clinicId: req.clinicId }, // clinic scope enforced here
    // Stamp the visit time so the live queue knows who is being seen now, and
    // clear it on revert/cancel so a stale timestamp cannot win "now serving".
    status === 'visited' ? { status, visitedAt: new Date() } : { status, visitedAt: null },
    { new: true }
  );
  if (!appointment) return res.status(404).json({ success: false, message: 'Appointment not found for this clinic.' });

  if (status === 'cancelled' && appointment.email) {
    const clinic = await Clinic.findOne({ clinicId: req.clinicId }).lean();
    if (clinic) {
      sendEmail({
        to: appointment.email,
        subject: 'Appointment cancelled - ' + clinic.clinicName,
        html: cancelEmail(clinic, appointment),
      }).catch(() => {});
    }
  }

  // Wake up every live viewer before answering. Fire-and-forget: the write is
  // already committed, so a socket problem must never fail the request.
  broadcastQueue(req.clinicId, appointment.date, status).catch(() => {});

  const words = { visited: 'marked as visited', booked: 'reverted to unvisited', cancelled: 'cancelled' };
  return res.json({
    success: true,
    message: 'Appointment #' + appointment.bookingNumber + ' ' + words[status] + '.',
    appointment: Object.assign(appointment.toObject(), { dateLabel: dateLabel(appointment.date) }),
  });
}

// Pebble grid feed: every token from 1..maxToken for the date, including gaps
// (marked "empty") so the dial-pad layout never skips a position.
app.get(
  '/api/admin/queue',
  clinicAuth,
  ah(async (req, res) => {
    const date = str(req.query.date) || todayStr();
    const live = await liveQueue(req.clinicId, date);
    const rows = await Appointment.find({ clinicId: req.clinicId, date }).sort({ bookingNumber: 1 }).lean();

    const byToken = {};
    for (const row of rows) {
      byToken[row.bookingNumber] = {
        id: String(row._id),
        bookingId: row.bookingId,
        bookingNumber: row.bookingNumber,
        name: row.name,
        gender: row.gender,
        age: row.age,
        mobile: row.mobile,
        email: row.email,
        quota: row.quota,
        status: row.status,
        source: row.source,
        weight: row.weight,
        address: row.address,
        date: row.date,
        dateLabel: dateLabel(row.date),
        visitedAt: row.visitedAt || null,
      };
    }

    const tokens = [];
    for (let n = 1; n <= live.maxToken; n += 1) {
      tokens.push(byToken[n] || { bookingNumber: n, status: 'empty' });
    }

    const summary = Object.assign({}, live);
    delete summary.tokens;

    return res.json({ success: true, date, dateLabel: dateLabel(date), live: summary, tokens });
  })
);

app.put('/api/admin/appointments/:id/visited', clinicAuth, ah((req, res) => setStatus(req, res, 'visited')));
app.put('/api/admin/appointments/:id/unvisited', clinicAuth, ah((req, res) => setStatus(req, res, 'booked')));
app.put('/api/admin/appointments/:id/cancel', clinicAuth, ah((req, res) => setStatus(req, res, 'cancelled')));

app.get(
  '/api/admin/appointments/:id',
  clinicAuth,
  ah(async (req, res) => {
    const id = str(req.params.id);
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: 'Invalid appointment id.' });
    const appointment = await Appointment.findOne({ _id: id, clinicId: req.clinicId }).lean();
    if (!appointment) return res.status(404).json({ success: false, message: 'Appointment not found for this clinic.' });
    return res.json({ success: true, appointment: Object.assign({}, appointment, { dateLabel: dateLabel(appointment.date) }) });
  })
);

// Reception walk-in entry: shares the exact same per-clinic-per-day counter as
// online bookings, so both are interleaved in one queue by arrival order.
app.post(
  '/api/admin/walk-in',
  clinicAuth,
  ah(async (req, res) => {
    // The panel posts { form: {...} } (same shape as /api/booking/send-otp),
    // but older/direct callers may post the fields flat. Accept either.
    const body = req.body || {};
    const submitted = body.form || body.formData || body;
    const form = Object.assign({}, submitted, { date: todayStr() });
    const problem = validateAppointmentForm(form, { walkIn: true });
    if (problem) return res.status(400).json({ success: false, message: problem });

    const clinic = await Clinic.findOne({ clinicId: req.clinicId });
    if (!clinic) return res.status(404).json({ success: false, message: 'Clinic not found.' });

    const appointment = await createAppointment(req.clinicId, form, 'walk-in');

    if (appointment.email) {
      sendEmail({
        to: appointment.email,
        subject: 'You are in the queue - token #' + appointment.bookingNumber + ' at ' + clinic.clinicName,
        html: confirmEmail(clinic, appointment),
      }).catch(() => {});
    }

    broadcastQueue(req.clinicId, appointment.date, 'walk-in').catch(() => {});

    return res.status(201).json({
      success: true,
      message: appointment.name + ' added to today\'s queue as token #' + appointment.bookingNumber + '.',
      appointment: Object.assign(appointment.toObject(), { dateLabel: dateLabel(appointment.date) }),
    });
  })
);

app.put(
  '/api/admin/profile',
  clinicAuth,
  ah(async (req, res) => {
    const body = req.body || {};
    const updates = {};
    const editable = ['clinicName', 'doctorName', 'specialization', 'address', 'city', 'phone', 'photo', 'about', 'timings', 'adminEmail'];
    for (const field of editable) {
      if (body[field] !== undefined) updates[field] = str(body[field]);
    }
    if (updates.phone && !/^\d{10}$/.test(updates.phone)) {
      return res.status(400).json({ success: false, message: 'Clinic phone number must be exactly 10 digits.' });
    }
    if (updates.adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.adminEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid admin email address.' });
    }
    if (updates.clinicName === '') return res.status(400).json({ success: false, message: 'Clinic name cannot be empty.' });

    const clinic = await Clinic.findOneAndUpdate({ clinicId: req.clinicId }, updates, { new: true, runValidators: true });
    if (!clinic) return res.status(404).json({ success: false, message: 'Clinic not found.' });

    return res.json({ success: true, message: 'Clinic profile updated.', clinic: adminClinic(clinic) });
  })
);

app.put(
  '/api/admin/password',
  clinicAuth,
  ah(async (req, res) => {
    const currentPassword = str((req.body || {}).currentPassword);
    const newPassword = str((req.body || {}).newPassword);
    if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });

    const clinic = await Clinic.findOne({ clinicId: req.clinicId });
    if (!clinic) return res.status(404).json({ success: false, message: 'Clinic not found.' });
    if (!(await bcrypt.compare(currentPassword, clinic.passwordHash))) {
      return res.status(401).json({ success: false, message: 'Your current password is incorrect.' });
    }

    clinic.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await clinic.save();
    return res.json({ success: true, message: 'Password changed successfully.' });
  })
);

/* ------------------------------------------------------- scheduled clean-up -- */

async function runCleanup(trigger) {
  if (!dbUp()) return;
  try {
    const cutoff = new Date(Date.now() - CLEANUP_DAYS * 24 * 60 * 60 * 1000);
    const removed = await Appointment.deleteMany({ createdAt: { $lt: cutoff } });
    const staleDate = addDays(todayStr(), -CLEANUP_DAYS);
    const counters = await QueueToken.deleteMany({ date: { $lt: staleDate } });
    if (removed.deletedCount || counters.deletedCount) {
      console.log(
        '[cleanup] (' +
          trigger +
          ') removed ' +
          removed.deletedCount +
          ' appointment(s) older than ' +
          CLEANUP_DAYS +
          ' days and ' +
          counters.deletedCount +
          ' stale queue counter(s).'
      );
    }
  } catch (error) {
    console.error('[ERROR] Cleanup failed:', error.message);
  }
}

cron.schedule('0 0 * * *', () => runCleanup('nightly cron'), { timezone: TZ });

/* ------------------------------------------------------- error handling -- */

app.use('/api', (req, res) =>
  res.status(404).json({ success: false, message: 'No API route matches ' + req.method + ' ' + req.originalUrl })
);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Not found. This server only exposes /api routes.' }));

// Always JSON, never an HTML stack trace (that is what breaks the frontend).
app.use((error, _req, res, _next) => {
  console.error('[ERROR]', error.stack || error.message);
  if (error.name === 'ValidationError') {
    const first = Object.values(error.errors || {})[0];
    return res.status(400).json({ success: false, message: first ? first.message : 'Some fields were invalid.' });
  }
  if (error.code === 11000) {
    return res.status(409).json({ success: false, message: 'That record already exists.' });
  }
  return res.status(500).json({ success: false, message: 'Something went wrong on the server. Please try again.' });
});

process.on('unhandledRejection', (reason) => console.error('[ERROR] Unhandled rejection:', reason && reason.message ? reason.message : reason));
process.on('uncaughtException', (error) => console.error('[ERROR] Uncaught exception:', error.message));

/* -------------------------------------------------------------- start up -- */

const server = http.createServer(app);

/* ------------------------------------------------- realtime queue sockets -- */

if (SocketServer) {
  io = new SocketServer(server, {
    // The frontend is served from a different origin in dev (5173 -> 5000).
    cors: { origin: true, methods: ['GET', 'POST'], credentials: false },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.on('connection', (socket) => {
    /* A viewer watches exactly one clinic/day board at a time. Joining a new
       board leaves the previous one, so switching clinics or dates can never
       leave a socket subscribed to a queue nobody is looking at. */
    socket.on('queue:join', async (payload) => {
      const clinicId = str(payload && payload.clinicId);
      const date = str(payload && payload.date) || todayStr();
      if (!clinicId) return;

      for (const room of Array.from(socket.rooms)) {
        if (room !== socket.id) socket.leave(room);
      }
      socket.join(queueRoom(clinicId, date));

      // Send the current board immediately so a new viewer never waits for the
      // next change to see something.
      try {
        const live = await liveQueue(clinicId, date);
        socket.emit('queue:update', { clinicId, date, reason: 'join', live });
      } catch (_error) {
        socket.emit('queue:error', { message: 'That queue could not be loaded.' });
      }
    });

    socket.on('queue:leave', () => {
      for (const room of Array.from(socket.rooms)) {
        if (room !== socket.id) socket.leave(room);
      }
    });
  });
}

/* ------------------------------------------------------------ keep-alive -- */

/* Render free instances spin down after ~15 minutes with no inbound traffic.
   This pings our own public /api/health on a timer, so the instance keeps
   receiving real requests through the Render edge and never goes cold.

   Two honest limits, worth knowing before relying on it:
     1. It only works while the process is ALREADY awake. If the instance does
        sleep - a deploy, a crash, a missed window - nothing in here can wake
        it back up. Only a real visitor or an external pinger can do that.
     2. Staying up 24/7 uses roughly 730 of the 750 free instance-hours Render
        grants per account per month. That fits ONE always-on free service.
        A second one will exhaust the quota and suspend both.

   Set KEEPALIVE_MINUTES=0 to turn this off without touching code. */

const keepAlive = {
  enabled: false,
  target: '',
  minutes: 0,
  pings: 0,
  failed: 0,
  lastPingAt: null,
  lastError: null,
};

let keepAliveBusy = false;

async function pingSelf() {
  if (keepAliveBusy) return; // a slow response must never let pings stack up
  keepAliveBusy = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(keepAlive.target, {
      method: 'GET',
      headers: { 'User-Agent': BRAND + ' keep-alive' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const recovered = keepAlive.lastError !== null;
    keepAlive.pings += 1;
    keepAlive.lastPingAt = new Date().toISOString();
    keepAlive.lastError = null;
    // Deliberately quiet: a log line every 14 minutes forever would bury the
    // logs that actually matter. Only the first ping and recoveries speak up.
    if (keepAlive.pings === 1 || recovered) {
      console.log('[OK] Keep-alive ping succeeded -> ' + keepAlive.target);
    }
  } catch (error) {
    keepAlive.failed += 1;
    keepAlive.lastError = error.name === 'AbortError' ? 'Ping timed out after 15s.' : error.message;
    console.warn('[warn] Keep-alive ping failed:', keepAlive.lastError);
  } finally {
    clearTimeout(timer);
    keepAliveBusy = false;
  }
}

function startKeepAlive() {
  if (!KEEPALIVE_URL) return; // local dev, or RENDER_EXTERNAL_URL not provided
  if (!(KEEPALIVE_MINUTES > 0)) return; // explicitly disabled

  const base = KEEPALIVE_URL.replace(/\/+$/, '');
  // Pinging localhost would loop inside the box and keep nothing awake.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(base)) return;

  keepAlive.enabled = true;
  keepAlive.minutes = KEEPALIVE_MINUTES;
  keepAlive.target = base + '/api/health';

  // The first ping waits a minute so it never competes with cold-start work.
  setTimeout(pingSelf, 60 * 1000);
  setInterval(pingSelf, KEEPALIVE_MINUTES * 60 * 1000);
}

server.listen(PORT, () => {
  startKeepAlive();
  console.log('');
  console.log('  ' + BRAND + ' API');
  console.log('  ------------------------------------------------------');
  console.log('  Server      http://localhost:' + PORT);
  console.log('  Health      http://localhost:' + PORT + '/api/health');
  console.log('  Database    ' + (MONGODB_URI ? DB_NAME + ' (connecting...)' : 'MONGODB_URI missing in .env'));
  console.log('  Mailer      ' + (GOOGLE_SCRIPT_URL ? 'Google Apps Script configured' : 'GOOGLE_SCRIPT_URL missing in .env'));
  console.log('  Realtime    ' + (io ? 'Socket.IO live on /socket.io' : 'polling only - run: npm install socket.io'));
  console.log('  Timezone    ' + TZ + '  (today = ' + todayStr() + ')');
  console.log('  Cleanup     appointments older than ' + CLEANUP_DAYS + ' days, daily at midnight');
  console.log('  Booking     today + next ' + BOOKING_DAYS + ' days');
  console.log(
    '  Keep-alive  ' +
      (keepAlive.enabled
        ? 'every ' + keepAlive.minutes + ' min -> ' + keepAlive.target
        : 'off (set KEEPALIVE_URL, or deploy on Render)')
  );
  console.log('');
});
