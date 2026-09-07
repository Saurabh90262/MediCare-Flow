/* ============================================================================
 * MediCare Flow - Frontend (complete, single file)
 *
 * WHY THE PREVIOUS VERSION LOOKED BROKEN
 * The file you sent references ~120 CSS class names (hero, clinic-grid,
 * admin-side, stat-grid, table-wrap ...) but ships no stylesheet at all, so the
 * browser renders raw unstyled HTML. Every style this app needs is now injected
 * from inside this file, so it renders correctly with no extra CSS file and no
 * Tailwind build step.
 *
 * SETUP
 *   npm create vite@latest frontend -- --template react
 *   npm install
 *   Replace src/App.jsx with this file, then: npm run dev
 *
 * Optional frontend/.env
 *   VITE_API_URL=http://localhost:5000/api
 *
 * This file is 100% ASCII on purpose, so no editor encoding can corrupt it.
 * ========================================================================== */

import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ------------------------------------------------------------- constants -- */

const API =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || 'http://localhost:5000/api';

const BRAND = 'MediCare Flow';
const TOKEN_KEY = 'mcf_token';
const CLINIC_KEY = 'mcf_clinic';

const STEPS = ['Details', 'Verify OTP', 'Confirmed'];

const EMPTY_FORM = {
  quota: 'General',
  name: '',
  gender: '',
  age: '',
  weight: '',
  date: '',
  mobile: '',
  email: '',
  address: '',
};

const SPECIALIZATIONS = [
  'General Physician',
  'Multi-specialty',
  'Cardiology',
  'Dentistry',
  'Dermatology',
  'Diabetology',
  'ENT',
  'Eye Care',
  'Gastroenterology',
  'Gynaecology',
  'Neurology',
  'Oncology',
  'Orthopaedics',
  'Paediatrics',
  'Physiotherapy',
  'Psychiatry',
  'Pulmonology',
  'Urology',
];

/* --------------------------------------------------------------- storage -- */

const getToken = () => {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch (_e) {
    return '';
  }
};

const setToken = (value) => {
  try {
    if (value) window.localStorage.setItem(TOKEN_KEY, value);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch (_e) {
    /* storage blocked - session simply will not persist */
  }
};

const getStoredClinic = () => {
  try {
    return JSON.parse(window.localStorage.getItem(CLINIC_KEY) || 'null');
  } catch (_e) {
    return null;
  }
};

const setStoredClinic = (clinic) => {
  try {
    if (clinic) window.localStorage.setItem(CLINIC_KEY, JSON.stringify(clinic));
    else window.localStorage.removeItem(CLINIC_KEY);
  } catch (_e) {
    /* ignore */
  }
};

/* The owner session is stored under its OWN keys. Keeping it separate from the
   clinic session means signing out of one never touches the other, and a
   clinic token can never be sent to an owner-only route by accident. */
const OWNER_TOKEN_KEY = 'mcf_owner_token';
const OWNER_KEY = 'mcf_owner';

const getOwnerToken = () => {
  try {
    return window.localStorage.getItem(OWNER_TOKEN_KEY) || '';
  } catch (_error) {
    return '';
  }
};

const setOwnerToken = (value) => {
  try {
    if (value) window.localStorage.setItem(OWNER_TOKEN_KEY, value);
    else window.localStorage.removeItem(OWNER_TOKEN_KEY);
  } catch (_error) {
    /* ignore */
  }
};

const getStoredOwner = () => {
  try {
    return JSON.parse(window.localStorage.getItem(OWNER_KEY) || 'null');
  } catch (_error) {
    return null;
  }
};

const setStoredOwner = (value) => {
  try {
    if (value) window.localStorage.setItem(OWNER_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(OWNER_KEY);
  } catch (_error) {
    /* ignore */
  }
};

/* ------------------------------------------------------------ api client -- */

async function api(path, options = {}) {
  const { method = 'GET', body, auth = false, owner = false } = options;
  const headers = { 'Content-Type': 'application/json' };
  // owner beats auth: the two sessions are never mixed on one request.
  if (owner) headers.Authorization = 'Bearer ' + getOwnerToken();
  else if (auth) headers.Authorization = 'Bearer ' + getToken();

  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (_networkError) {
    return {
      success: false,
      message: 'Cannot reach the API at ' + API + '. Start the backend (node Server.js) and check the port.',
    };
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_parseError) {
    return {
      success: false,
      message: 'The API returned a non-JSON response (HTTP ' + response.status + '). Is VITE_API_URL pointing at the backend?',
    };
  }

  if (!response.ok) {
    return {
      success: false,
      status: response.status,
      unauthorized: response.status === 401,
      message: data.message || 'Request failed (HTTP ' + response.status + ').',
    };
  }
  return data;
}

/* ============================================================================
 * REALTIME - Socket.IO, with automatic fallback to polling
 *
 * The client library is fetched from the backend's own /socket.io/socket.io.js,
 * which Socket.IO serves automatically. That means THE FRONTEND NEEDS NO NEW
 * NPM PACKAGE - only the backend runs "npm install socket.io". It also can
 * never version-drift from the server, and it works with no internet access.
 *
 * If the script or the connection fails, loadSocketIo resolves null, every
 * screen keeps its polling timer and nothing breaks.
 * ========================================================================== */

const API_ORIGIN = API.replace(/\/api\/?$/, '');

let socketScript = null;

function loadSocketIo() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  if (window.io) return Promise.resolve(window.io);
  if (socketScript) return socketScript;
  socketScript = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = API_ORIGIN + '/socket.io/socket.io.js';
    tag.async = true;
    tag.onload = () => resolve(window.io || null);
    tag.onerror = () => resolve(null);
    document.head.appendChild(tag);
  });
  return socketScript;
}

/* Subscribes to one clinic/day queue board.
   Returns true while the socket is connected, so callers can relax their
   polling interval into a mere safety net. onUpdate is kept in a ref so a new
   render never tears down and rebuilds the connection. */
function useQueueSocket(clinicId, date, onUpdate) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onUpdate);
  handler.current = onUpdate;

  useEffect(() => {
    if (!clinicId) return undefined;
    let socket = null;
    let cancelled = false;

    loadSocketIo().then((factory) => {
      if (cancelled || !factory) return;
      socket = factory(API_ORIGIN, {
        transports: ['websocket', 'polling'],
        reconnectionDelay: 1200,
        reconnectionDelayMax: 6000,
        timeout: 8000,
      });
      socket.on('connect', () => {
        setConnected(true);
        socket.emit('queue:join', { clinicId, date: date || '' });
      });
      socket.on('disconnect', () => setConnected(false));
      socket.on('connect_error', () => setConnected(false));
      socket.on('queue:update', (payload) => {
        if (handler.current) handler.current(payload);
      });
    });

    return () => {
      cancelled = true;
      setConnected(false);
      if (socket) {
        socket.off('queue:update');
        socket.emit('queue:leave');
        socket.disconnect();
      }
    };
  }, [clinicId, date]);

  return connected;
}

/* --------------------------------------------------------------- helpers -- */

const todayISO = () => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const fmtDate = (value) => {
  if (!value) return '-';
  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return String(value);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
};

const fmtLongDate = (value) => {
  if (!value) return '-';
  const [y, m, d] = String(value).split('-').map(Number);
  if (!y || !m || !d) return String(value);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

const initials = (value = '') =>
  String(value)
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase() || 'C';

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/* ----------------------------------------------------------------- icons -- */

function Icon({ name, size = 18, className = '' }) {
  const shapes = {
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.2-3.2" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    check: <path d="M20 6L9 17l-5-5" />,
    close: (
      <>
        <path d="M18 6L6 18" />
        <path d="M6 6l12 12" />
      </>
    ),
    right: (
      <>
        <path d="M5 12h14" />
        <path d="M13 6l6 6-6 6" />
      </>
    ),
    left: (
      <>
        <path d="M19 12H5" />
        <path d="M11 18l-6-6 6-6" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M8 3v4M16 3v4M3 11h18" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.6" />
        <path d="M4.5 20c1.4-3.6 4.1-5.2 7.5-5.2s6.1 1.6 7.5 5.2" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M2.5 20c1.2-3.2 3.6-4.6 6.5-4.6s5.3 1.4 6.5 4.6" />
        <path d="M16.5 5.6a3.2 3.2 0 010 5.6M18 15.6c2 .7 3.2 2.1 3.8 4.4" />
      </>
    ),
    stetho: (
      <>
        <path d="M6 3v6a4 4 0 008 0V3" />
        <path d="M10 13v3a5 5 0 0010 0v-2" />
        <circle cx="20" cy="11" r="2" />
      </>
    ),
    pin: (
      <>
        <path d="M12 21s7-5.6 7-11a7 7 0 10-14 0c0 5.4 7 11 7 11z" />
        <circle cx="12" cy="10" r="2.6" />
      </>
    ),
    phone: <path d="M5 4h3.5l1.6 4-2 1.4a12 12 0 005.5 5.5l1.4-2 4 1.6V19a1.5 1.5 0 01-1.7 1.5A16 16 0 013.5 5.7A1.5 1.5 0 015 4z" />,
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M4 7l8 6 8-6" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3l7 3v6c0 4.6-3 7.9-7 9-4-1.1-7-4.4-7-9V6l7-3z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
    chart: (
      <>
        <path d="M4 20h16" />
        <path d="M7 20v-7M12 20V6M17 20v-4" />
      </>
    ),
    list: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <circle cx="4" cy="6" r="1.2" />
        <circle cx="4" cy="12" r="1.2" />
        <circle cx="4" cy="18" r="1.2" />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="7" height="7" rx="2" />
        <rect x="13" y="4" width="7" height="7" rx="2" />
        <rect x="4" y="13" width="7" height="7" rx="2" />
        <rect x="13" y="13" width="7" height="7" rx="2" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3M12 18v3M4.5 7.5l2 1.2M17.5 15.3l2 1.2M4.5 16.5l2-1.2M17.5 8.7l2-1.2" />
      </>
    ),
    logout: (
      <>
        <path d="M15 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8" />
        <path d="M18 12H10M15 9l3 3-3 3" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    refresh: (
      <>
        <path d="M20 12a8 8 0 10-3 6.2" />
        <path d="M20 5v5h-5" />
      </>
    ),
    alert: (
      <>
        <path d="M12 4l9 16H3l9-16z" />
        <path d="M12 10v4M12 17h.01" />
      </>
    ),
    ticket: (
      <>
        <rect x="3" y="6" width="18" height="12" rx="3" />
        <path d="M9 6v12" strokeDasharray="2 2" />
      </>
    ),
    spark: <path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6L12 3z" />,
    ban: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M6.5 6.5l11 11" />
      </>
    ),
    undo: (
      <>
        <path d="M4 12a8 8 0 113 6.2" />
        <path d="M4 5v5h5" />
      </>
    ),
    activity: <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />,
    building: (
      <>
        <rect x="5" y="4" width="14" height="17" rx="2" />
        <path d="M9 9h2M13 9h2M9 13h2M13 13h2M10 21v-4h4v4" />
      </>
    ),
  };

  return (
    <svg
      className={'ico ' + className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name] || null}
    </svg>
  );
}

function Cross({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z" fill="currentColor" />
    </svg>
  );
}

/* ============================================================================
 * STYLES - injected once at runtime. Everything the UI needs lives here, so
 * the app never depends on an external CSS file being wired up correctly.
 * ========================================================================== */

const CSS_BASE = `
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap');

:root{
  --pr:#0f766e; --pr2:#115e59; --pr3:#0ea5e9; --pr4:#14b8a6;
  --gr:#059669; --gr2:#10b981; --amber:#f59e0b; --red:#dc2626; --red2:#b91c1c;
  --violet:#7c3aed; --text:#0f172a; --muted:#64748b; --light:#94a3b8;
  --bg:#f5f8fa; --card:#ffffff; --border:#e3e9ef; --border2:#eef2f6;
  --grad:linear-gradient(135deg,#0f766e 0%,#0ea5e9 100%);
  --grad2:linear-gradient(135deg,#059669 0%,#14b8a6 100%);
  --sh1:0 1px 2px rgba(15,23,42,.05);
  --sh2:0 4px 14px rgba(15,23,42,.07);
  --sh3:0 14px 40px rgba(15,23,42,.11);
  --sh4:0 26px 60px rgba(15,23,42,.16);
  --r1:10px; --r2:14px; --r3:20px; --r4:28px;
  --ease:cubic-bezier(.22,1,.36,1);
  --nav:70px;
}

*,*::before,*::after{box-sizing:border-box}

html{-webkit-text-size-adjust:100%}

body{
  margin:0; background:var(--bg); color:var(--text);
  font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  font-size:15px; line-height:1.65; -webkit-font-smoothing:antialiased;
}

#root{min-height:100vh; display:flex; flex-direction:column}

img{max-width:100%; display:block}
svg.ico{flex:none}

h1,h2,h3,h4{font-family:'Sora',system-ui,sans-serif; color:var(--text); margin:0; line-height:1.2; letter-spacing:-.02em}
h1{font-size:clamp(30px,5vw,50px); font-weight:800}
h2{font-size:clamp(22px,3vw,32px); font-weight:700}
h3{font-size:19px; font-weight:700}
h4{font-size:16px; font-weight:600}
p{margin:0}

button{font:inherit; color:inherit; cursor:pointer; border:0; background:none}
button:disabled{cursor:not-allowed}
a{color:var(--pr); text-decoration:none}

.mcf{flex:1; display:flex; flex-direction:column; min-height:100vh}
.container{width:100%; max-width:1200px; margin:0 auto; padding:0 22px}
.container-sm{width:100%; max-width:880px; margin:0 auto; padding:0 22px}
.section{padding:70px 0}
.section-tight{padding:44px 0}
.stack{display:flex; flex-direction:column; gap:14px}
.row{display:flex; align-items:center; gap:12px; flex-wrap:wrap}
.spread{display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap}
.grow{flex:1; min-width:0}
.center{text-align:center}
.muted{color:var(--muted)}
.small{font-size:13px}
.tiny{font-size:12px}
.mono{font-variant-numeric:tabular-nums}
.nowrap{white-space:nowrap}
.truncate{overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0}

.eyebrow{
  display:inline-flex; align-items:center; gap:7px; font-size:11px; font-weight:700;
  letter-spacing:.16em; text-transform:uppercase; color:var(--pr);
}
.eyebrow-light{color:rgba(255,255,255,.82)}

.sec-head{display:flex; align-items:flex-end; justify-content:space-between; gap:26px; flex-wrap:wrap; margin-bottom:30px}
.sec-head p.lead{color:var(--muted); margin-top:10px; max-width:56ch; font-size:15px}

/* ------------------------------------------------------------- buttons -- */
.btn{
  display:inline-flex; align-items:center; justify-content:center; gap:9px;
  padding:12px 20px; border-radius:var(--r1); font-weight:600; font-size:14.5px;
  transition:transform .18s var(--ease), box-shadow .22s var(--ease), background .2s, color .2s, border-color .2s;
  white-space:nowrap; border:1px solid transparent; position:relative; overflow:hidden;
}
.btn:active:not(:disabled){transform:translateY(1px) scale(.995)}
.btn:disabled{opacity:.58}
.btn:focus-visible{outline:2px solid var(--pr3); outline-offset:2px}

.btn-primary{background:var(--grad); color:#fff; box-shadow:0 8px 20px rgba(15,118,110,.26)}
.btn-primary:hover:not(:disabled){transform:translateY(-2px); box-shadow:0 14px 30px rgba(15,118,110,.34)}
.btn-primary::after{
  content:''; position:absolute; inset:0; background:linear-gradient(120deg,transparent,rgba(255,255,255,.28),transparent);
  transform:translateX(-110%); transition:transform .6s var(--ease);
}
.btn-primary:hover:not(:disabled)::after{transform:translateX(110%)}

.btn-dark{background:#0f172a; color:#fff}
.btn-dark:hover:not(:disabled){background:#1e293b; transform:translateY(-2px)}

.btn-soft{background:#e8f5f3; color:var(--pr2); border-color:#cdeae5}
.btn-soft:hover:not(:disabled){background:#d7ede9; transform:translateY(-2px)}

.btn-outline{background:#fff; color:var(--text); border-color:var(--border)}
.btn-outline:hover:not(:disabled){border-color:var(--pr4); color:var(--pr); box-shadow:var(--sh2); transform:translateY(-2px)}

.btn-ghost{background:transparent; color:var(--muted)}
.btn-ghost:hover:not(:disabled){background:#eef2f6; color:var(--text)}

.btn-danger{background:#fff1f1; color:var(--red2); border-color:#fbd5d5}
.btn-danger:hover:not(:disabled){background:var(--red); color:#fff; border-color:var(--red)}

.btn-white{background:#fff; color:var(--pr2)}
.btn-white:hover:not(:disabled){transform:translateY(-2px); box-shadow:var(--sh3)}

.btn-sm{padding:8px 13px; font-size:13px; border-radius:9px; gap:6px}
.btn-lg{padding:15px 26px; font-size:16px; border-radius:12px}
.btn-block{width:100%}
.btn-link{color:var(--pr); font-weight:600; font-size:13.5px; padding:6px 2px; display:inline-flex; align-items:center; gap:6px}
.btn-link:hover{color:var(--pr2); text-decoration:underline}
.btn-icon{width:38px; height:38px; padding:0; border-radius:10px; border:1px solid var(--border); background:#fff; color:var(--muted); display:inline-flex; align-items:center; justify-content:center}
.btn-icon:hover{color:var(--text); border-color:var(--light)}

/* --------------------------------------------------------------- forms -- */
.field{display:flex; flex-direction:column; gap:7px; min-width:0}
.field > label, .lbl{font-size:12.5px; font-weight:600; color:#334155; letter-spacing:.01em}
.field .req{color:var(--red)}
.hint{font-size:12px; color:var(--light)}

.input,.select,.textarea{
  width:100%; padding:12px 14px; font:inherit; font-size:14.5px; color:var(--text);
  background:#fff; border:1.5px solid var(--border); border-radius:var(--r1);
  transition:border-color .18s, box-shadow .18s, background .18s; min-width:0;
}
.textarea{resize:vertical; min-height:86px; line-height:1.6}
.select{
  appearance:none; cursor:pointer; padding-right:40px;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.2' stroke-linecap='round'><path d='M6 9l6 6 6-6'/></svg>");
  background-repeat:no-repeat; background-position:right 13px center;
}
.input::placeholder,.textarea::placeholder{color:#b6c2cf}
.input:hover,.select:hover,.textarea:hover{border-color:#cbd5e1}
.input:focus,.select:focus,.textarea:focus{
  outline:none; border-color:var(--pr4); background:#fbfffe;
  box-shadow:0 0 0 4px rgba(20,184,166,.14);
}
.input:disabled,.select:disabled,.textarea:disabled{background:#f4f7f9; color:var(--muted); cursor:not-allowed}
.input.bad,.select.bad,.textarea.bad{border-color:#f0a9a9; background:#fffafa}

.grid2{display:grid; grid-template-columns:1fr 1fr; gap:16px}
.grid3{display:grid; grid-template-columns:repeat(3,1fr); gap:16px}
.form-grid{display:flex; flex-direction:column; gap:16px}

.input-icon{position:relative; display:flex; align-items:center; min-width:0}
.input-icon .ico{position:absolute; left:14px; color:var(--light); pointer-events:none}
.input-icon .input{padding-left:42px}

/* ------------------------------------------------------ alerts + badges -- */
.alert{
  display:flex; align-items:flex-start; gap:10px; padding:12px 15px; border-radius:var(--r1);
  font-size:13.5px; line-height:1.6; border:1px solid transparent; animation:fadeUp .3s var(--ease);
}
.alert .ico{margin-top:2px}
.alert-err{background:#fff2f2; color:#9f1239; border-color:#f9d2d2}
.alert-ok{background:#effcf6; color:#065f46; border-color:#c8f0dd}
.alert-info{background:#eff8ff; color:#0c4a6e; border-color:#cbe6fb}
.alert-warn{background:#fffbeb; color:#92400e; border-color:#fbe7ba}

.badge{
  display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border-radius:999px;
  font-size:11.5px; font-weight:700; letter-spacing:.02em; white-space:nowrap;
}
.badge-booked{background:#eff6ff; color:#1d4ed8}
.badge-visited{background:#ecfdf5; color:#047857}
.badge-cancelled{background:#fef2f2; color:#b91c1c}
.badge-general{background:#f0fdfa; color:var(--pr2)}
.badge-emergency{background:#fef2f2; color:#b91c1c}
.badge-online{background:#f5f3ff; color:#6d28d9}
.badge-walkin{background:#fff7ed; color:#c2410c}
.badge-soft{background:#f1f5f9; color:var(--muted)}

.dot{width:7px; height:7px; border-radius:50%; background:currentColor; flex:none}
.live-dot{position:relative; width:8px; height:8px; border-radius:50%; background:var(--gr2); flex:none}
.live-dot::after{content:''; position:absolute; inset:-4px; border-radius:50%; border:2px solid rgba(16,185,129,.4); animation:ping 1.8s ease-out infinite}

/* ---------------------------------------------------------------- cards -- */
.card{background:var(--card); border:1px solid var(--border); border-radius:var(--r3); box-shadow:var(--sh1)}
.card-pad{padding:26px}
.panel{background:var(--card); border:1px solid var(--border); border-radius:var(--r3); box-shadow:var(--sh1); overflow:hidden}
.panel-head{display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding:20px 24px; border-bottom:1px solid var(--border2)}
.panel-head h3{font-size:17px}
.panel-body{padding:24px}

/* ---------------------------------------------------------------- toast -- */
.toast-wrap{position:fixed; inset:auto 0 24px; z-index:120; display:flex; flex-direction:column; align-items:center; gap:10px; pointer-events:none; padding:0 16px}
.toast{
  display:flex; align-items:center; gap:11px; max-width:520px; padding:13px 18px;
  border-radius:14px; background:#0f172a; color:#fff; font-size:14px; font-weight:500;
  box-shadow:var(--sh4); animation:toastIn .34s var(--ease); pointer-events:auto;
}
.toast b{width:22px; height:22px; border-radius:50%; display:grid; place-items:center; flex:none; background:rgba(255,255,255,.16)}
.toast-ok b{background:var(--gr2)}
.toast-err b{background:var(--red)}
.toast-info b{background:var(--pr3)}

/* ---------------------------------------------------------------- modal -- */
.modal-back{
  position:fixed; inset:0; z-index:130; background:rgba(15,23,42,.5); backdrop-filter:blur(5px);
  display:flex; align-items:flex-start; justify-content:center; padding:24px 16px; overflow-y:auto;
  animation:fade .22s ease;
}
.modal{
  width:100%; max-width:560px; margin:auto; background:#fff; border-radius:var(--r4);
  box-shadow:var(--sh4); animation:pop .32s var(--ease); overflow:hidden;
}
.modal-wide{max-width:760px}
.modal-head{display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 24px; border-bottom:1px solid var(--border2)}
.modal-body{padding:24px; max-height:min(70vh,720px); overflow-y:auto}
.modal-foot{display:flex; justify-content:flex-end; gap:10px; padding:16px 24px; border-top:1px solid var(--border2); background:#fafcfd; flex-wrap:wrap}

/* ------------------------------------------------------------- skeleton -- */
.sk{background:linear-gradient(90deg,#eef2f6 25%,#f7fafc 50%,#eef2f6 75%); background-size:200% 100%; animation:shimmer 1.3s linear infinite; border-radius:8px}
.sk-line{height:12px; margin-bottom:9px}
.sk-card{height:270px; border-radius:var(--r3)}

.spinner{width:16px; height:16px; border:2px solid rgba(255,255,255,.35); border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; flex:none}
.spinner-dark{border-color:rgba(15,118,110,.25); border-top-color:var(--pr)}
.loading-block{display:flex; align-items:center; justify-content:center; gap:12px; padding:64px 20px; color:var(--muted); font-size:14px}

.empty{text-align:center; padding:56px 24px}
.empty-ico{width:62px; height:62px; margin:0 auto 16px; border-radius:20px; display:grid; place-items:center; background:#f0fdfa; color:var(--pr)}
.empty h3{margin-bottom:8px}
.empty p{color:var(--muted); max-width:44ch; margin:0 auto 20px}

/* ------------------------------------------------------------ animation -- */
@keyframes fadeUp{from{opacity:0; transform:translateY(14px)} to{opacity:1; transform:none}}
@keyframes fade{from{opacity:0} to{opacity:1}}
@keyframes pop{from{opacity:0; transform:translateY(18px) scale(.97)} to{opacity:1; transform:none}}
@keyframes toastIn{from{opacity:0; transform:translateY(20px) scale(.96)} to{opacity:1; transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes shimmer{from{background-position:200% 0} to{background-position:-200% 0}}
@keyframes ping{0%{transform:scale(.6); opacity:.9} 80%,100%{transform:scale(1.5); opacity:0}}
@keyframes float{0%,100%{transform:translateY(0)} 50%{transform:translateY(-12px)}}
@keyframes drift{0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(22px,-26px) scale(1.07)}}
@keyframes sweep{from{transform:translateX(-100%)} to{transform:translateX(100%)}}
@keyframes ringPop{0%{transform:scale(.5); opacity:0} 60%{transform:scale(1.08)} 100%{transform:scale(1); opacity:1}}
@keyframes growBar{from{transform:scaleY(0)} to{transform:scaleY(1)}}

.reveal{opacity:0; transform:translateY(20px)}
.reveal.in{opacity:1; transform:none; transition:opacity .6s var(--ease), transform .6s var(--ease)}
.pg{animation:fadeUp .42s var(--ease)}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms !important; animation-iteration-count:1 !important; transition-duration:.001ms !important}
  .reveal{opacity:1; transform:none}
}
`;

const CSS_SITE = `
/* ------------------------------------------------------------------- nav -- */
.nav{position:sticky; top:0; z-index:90; background:rgba(255,255,255,.86); backdrop-filter:blur(14px); border-bottom:1px solid rgba(226,232,240,.9)}
.nav-in{height:var(--nav); display:flex; align-items:center; justify-content:space-between; gap:18px}
.brand{display:inline-flex; align-items:center; gap:10px; font-family:'Sora',sans-serif; font-weight:800; font-size:17.5px; letter-spacing:-.02em; color:var(--text)}
.brand-mark{width:36px; height:36px; border-radius:11px; background:var(--grad); color:#fff; display:grid; place-items:center; box-shadow:0 6px 16px rgba(15,118,110,.3); transition:transform .3s var(--ease)}
.brand:hover .brand-mark{transform:rotate(-8deg) scale(1.06)}
.brand i{font-style:normal; color:var(--pr)}
.nav-links{display:flex; align-items:center; gap:4px}
.nav-links button{padding:9px 14px; border-radius:9px; font-size:14px; font-weight:500; color:#475569; transition:background .18s, color .18s}
.nav-links button:hover{background:#eef4f7; color:var(--text)}
.nav-actions{display:flex; align-items:center; gap:10px}
.nav-burger{display:none}
.nav-drop{display:none}

/* ------------------------------------------------------------------ hero -- */
.hero{position:relative; overflow:hidden; background:#06282b; color:#fff; padding:84px 0 96px}
.hero-orb{position:absolute; border-radius:50%; filter:blur(70px); opacity:.5; pointer-events:none}
.hero-orb.a{width:460px; height:460px; background:#0f766e; top:-160px; left:-110px; animation:drift 16s ease-in-out infinite}
.hero-orb.b{width:420px; height:420px; background:#0ea5e9; bottom:-180px; right:-90px; animation:drift 20s ease-in-out infinite reverse}
.hero-orb.c{width:300px; height:300px; background:#14b8a6; top:40%; left:52%; animation:drift 24s ease-in-out infinite}
.hero-grid-lines{position:absolute; inset:0; background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px); background-size:46px 46px; mask-image:radial-gradient(circle at 30% 30%,#000,transparent 72%)}
.hero-in{position:relative; display:grid; grid-template-columns:1.08fr .92fr; gap:56px; align-items:center}
.hero-copy h1{color:#fff; margin:16px 0 18px}
.hero-copy h1 em{font-style:normal; background:linear-gradient(100deg,#5eead4,#7dd3fc); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent}
.hero-copy .lead{color:rgba(226,242,240,.78); font-size:16.5px; max-width:52ch}
.hero-cta{display:flex; gap:12px; margin:30px 0 26px; flex-wrap:wrap}
.hero-stats{display:flex; gap:30px; flex-wrap:wrap; padding-top:24px; border-top:1px solid rgba(255,255,255,.12)}
.hero-stats div b{display:block; font-family:'Sora',sans-serif; font-size:22px; font-weight:700; color:#5eead4}
.hero-stats div span{font-size:12.5px; color:rgba(226,242,240,.66)}

.hero-panel{position:relative; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.16); border-radius:var(--r4); padding:26px; backdrop-filter:blur(14px); box-shadow:var(--sh4); animation:float 7s ease-in-out infinite}
.hero-panel-head{display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:20px}
.hero-panel-head span{font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:rgba(226,242,240,.7); font-weight:700}
.hero-token{background:#fff; color:var(--text); border-radius:var(--r3); padding:20px; text-align:center; box-shadow:var(--sh3)}
.hero-token small{font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); font-weight:700}
.hero-token b{display:block; font-family:'Sora',sans-serif; font-size:52px; font-weight:800; line-height:1.05; margin:6px 0; background:var(--grad); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent}
.hero-token p{font-size:13px; color:var(--muted)}
.hero-rows{margin-top:16px; display:flex; flex-direction:column; gap:9px}
.hero-row{display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px; border-radius:12px; background:rgba(255,255,255,.08); font-size:13.5px; color:rgba(240,253,250,.9); transition:background .2s, transform .2s var(--ease)}
.hero-row:hover{background:rgba(255,255,255,.15); transform:translateX(3px)}
.hero-row b{color:#5eead4; font-weight:600}

/* ------------------------------------------------------------- features -- */
.feat-grid{display:grid; grid-template-columns:repeat(3,1fr); gap:20px}
.feat{background:#fff; border:1px solid var(--border); border-radius:var(--r3); padding:26px; transition:transform .28s var(--ease), box-shadow .28s var(--ease), border-color .28s}
.feat:hover{transform:translateY(-6px); box-shadow:var(--sh3); border-color:#cdeae5}
.feat-ico{width:46px; height:46px; border-radius:14px; display:grid; place-items:center; background:#f0fdfa; color:var(--pr); margin-bottom:16px; transition:transform .28s var(--ease)}
.feat:hover .feat-ico{transform:scale(1.1) rotate(-6deg)}
.feat h4{margin-bottom:8px}
.feat p{color:var(--muted); font-size:14px}

.steps-strip{display:grid; grid-template-columns:repeat(3,1fr); gap:20px; counter-reset:s}
.step-item{position:relative; padding:24px; background:#fff; border:1px solid var(--border); border-radius:var(--r3); transition:transform .28s var(--ease), box-shadow .28s var(--ease)}
.step-item:hover{transform:translateY(-5px); box-shadow:var(--sh3)}
.step-num{width:34px; height:34px; border-radius:11px; background:var(--grad); color:#fff; font-family:'Sora',sans-serif; font-weight:700; display:grid; place-items:center; margin-bottom:14px; font-size:15px}
.step-item h4{margin-bottom:6px}
.step-item p{font-size:14px; color:var(--muted)}

/* ------------------------------------------------------------ directory -- */
.dir-tools{display:flex; gap:12px; align-items:center; flex-wrap:wrap; width:100%; max-width:520px}
.dir-tools .input-icon{flex:1; min-width:220px}
.chips{display:flex; gap:8px; overflow-x:auto; padding:4px 0 12px; margin-bottom:22px; scrollbar-width:thin}
.chip{padding:8px 15px; border-radius:999px; border:1.5px solid var(--border); background:#fff; font-size:13px; font-weight:600; color:var(--muted); white-space:nowrap; transition:all .2s var(--ease)}
.chip:hover{border-color:var(--pr4); color:var(--pr)}
.chip.on{background:var(--pr); border-color:var(--pr); color:#fff; box-shadow:0 6px 16px rgba(15,118,110,.24)}

.clinic-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:22px}
.cc{position:relative; display:flex; flex-direction:column; background:#fff; border:1px solid var(--border); border-radius:var(--r3); padding:22px; overflow:hidden; transition:transform .3s var(--ease), box-shadow .3s var(--ease), border-color .3s}
.cc::before{content:''; position:absolute; inset:0 0 auto; height:4px; background:var(--grad); opacity:0; transition:opacity .3s}
.cc:hover{transform:translateY(-7px); box-shadow:var(--sh3); border-color:#cdeae5}
.cc:hover::before{opacity:1}
.cc-top{display:flex; align-items:flex-start; gap:14px; margin-bottom:16px}
.cc-av{width:56px; height:56px; border-radius:16px; flex:none; overflow:hidden; background:var(--grad); color:#fff; display:grid; place-items:center; font-family:'Sora',sans-serif; font-weight:700; font-size:19px; box-shadow:0 8px 18px rgba(15,118,110,.24)}
.cc-av img{width:100%; height:100%; object-fit:cover}
.cc-head{min-width:0; flex:1}
.cc-head h3{font-size:17.5px; margin-bottom:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.cc-head p{font-size:13.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.cc-tags{display:flex; gap:7px; flex-wrap:wrap; margin-bottom:14px}
.cc-meta{display:flex; flex-direction:column; gap:8px; font-size:13px; color:var(--muted); margin-bottom:16px}
.cc-meta div{display:flex; gap:8px; align-items:flex-start}
.cc-meta .ico{margin-top:3px; color:var(--light); flex:none}
.cc-q{display:flex; gap:10px; padding:13px 15px; border-radius:var(--r2); background:linear-gradient(135deg,#f0fdfa,#eff8ff); border:1px solid #ddf1ee; margin-bottom:16px}
.cc-q > div{flex:1; text-align:center; min-width:0}
.cc-q b{display:block; font-family:'Sora',sans-serif; font-size:20px; font-weight:700; color:var(--pr2); line-height:1.2}
.cc-q span{font-size:11px; color:var(--muted); font-weight:600; letter-spacing:.03em}
.cc-foot{margin-top:auto; display:flex; gap:10px}

/* -------------------------------------------------------------- booking -- */
.bp{padding:26px 0 70px}
.crumb{display:inline-flex; align-items:center; gap:7px; font-size:13.5px; font-weight:600; color:var(--muted); padding:8px 0; margin-bottom:14px; transition:color .18s, gap .18s}
.crumb:hover{color:var(--pr); gap:10px}

.bp-banner{position:relative; overflow:hidden; background:#06282b; color:#fff; border-radius:var(--r4); padding:30px 32px; display:flex; gap:22px; align-items:center; flex-wrap:wrap; box-shadow:var(--sh3); margin-bottom:26px}
.bp-banner .hero-orb.a{width:330px; height:330px; top:-140px; left:-80px}
.bp-banner .hero-orb.b{width:280px; height:280px; bottom:-140px; right:-60px}
.bp-av{position:relative; width:76px; height:76px; border-radius:22px; flex:none; overflow:hidden; background:rgba(255,255,255,.14); border:1px solid rgba(255,255,255,.24); display:grid; place-items:center; font-family:'Sora',sans-serif; font-size:25px; font-weight:700}
.bp-av img{width:100%; height:100%; object-fit:cover}
.bp-id{position:relative; flex:1; min-width:240px}
.bp-id h1{color:#fff; font-size:clamp(23px,3.2vw,33px); margin:8px 0 8px}
.bp-id p{color:rgba(226,242,240,.78); font-size:14px; display:flex; gap:8px; align-items:flex-start}
.bp-live{position:relative; display:flex; gap:12px; flex-wrap:wrap}
.bp-live > div{background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.16); border-radius:var(--r2); padding:12px 18px; text-align:center; min-width:92px}
.bp-live b{display:block; font-family:'Sora',sans-serif; font-size:24px; font-weight:700; color:#5eead4; line-height:1.2}
.bp-live span{font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:rgba(226,242,240,.7); font-weight:600}

.bp-layout{display:grid; grid-template-columns:320px 1fr; gap:26px; align-items:start}
.bp-aside{position:sticky; top:calc(var(--nav) + 22px); display:flex; flex-direction:column; gap:18px}
.bp-aside h2{font-size:22px; margin:12px 0 10px}
.bp-aside .lead{font-size:14px; color:var(--muted)}

.steps{display:flex; flex-direction:column; gap:0; margin-top:6px}
.step-row{display:flex; gap:14px; align-items:flex-start; position:relative; padding-bottom:22px}
.step-row:last-child{padding-bottom:0}
.step-row::before{content:''; position:absolute; left:16px; top:34px; bottom:0; width:2px; background:var(--border); border-radius:2px}
.step-row:last-child::before{display:none}
.step-row.done::before{background:var(--gr2)}
.step-dot{width:34px; height:34px; border-radius:50%; flex:none; display:grid; place-items:center; background:#fff; border:2px solid var(--border); color:var(--light); font-weight:700; font-size:13.5px; transition:all .3s var(--ease); z-index:1}
.step-row.on .step-dot{border-color:var(--pr); background:var(--pr); color:#fff; box-shadow:0 0 0 5px rgba(15,118,110,.14); transform:scale(1.06)}
.step-row.done .step-dot{border-color:var(--gr2); background:var(--gr2); color:#fff}
.step-txt b{display:block; font-size:14.5px; font-weight:600; color:var(--muted); transition:color .25s; font-family:'Sora',sans-serif}
.step-row.on .step-txt b,.step-row.done .step-txt b{color:var(--text)}
.step-txt span{font-size:12.5px; color:var(--light)}

.trust{display:flex; flex-direction:column; gap:11px; padding:18px; border-radius:var(--r3); background:#fff; border:1px solid var(--border)}
.trust div{display:flex; gap:10px; font-size:13px; color:var(--muted); align-items:flex-start}
.trust .ico{color:var(--gr); margin-top:2px; flex:none}

.form-card{background:#fff; border:1px solid var(--border); border-radius:var(--r4); padding:30px; box-shadow:var(--sh2); animation:fadeUp .4s var(--ease)}
.form-card h2{font-size:23px; margin:12px 0 6px}
.form-card > .lead{color:var(--muted); font-size:14px; margin-bottom:24px}

.quota-grid{display:grid; grid-template-columns:1fr 1fr; gap:14px}
.quota{
  position:relative; text-align:left; padding:16px 16px 16px 54px; border-radius:var(--r2);
  border:1.8px solid var(--border); background:#fff; transition:all .24s var(--ease); overflow:hidden;
}
.quota:hover{border-color:var(--pr4); transform:translateY(-3px); box-shadow:var(--sh2)}
.quota b{display:block; font-size:14.5px; font-weight:700; font-family:'Sora',sans-serif}
.quota span{font-size:12.5px; color:var(--muted)}
.quota-mark{position:absolute; left:16px; top:50%; transform:translateY(-50%); width:24px; height:24px; border-radius:50%; border:2px solid var(--border); display:grid; place-items:center; transition:all .24s var(--ease)}
.quota-mark i{width:9px; height:9px; border-radius:50%; background:transparent; transition:background .24s}
.quota.on{border-color:var(--pr); background:#f0fdfa; box-shadow:0 8px 22px rgba(15,118,110,.14)}
.quota.on .quota-mark{border-color:var(--pr)}
.quota.on .quota-mark i{background:var(--pr)}
.quota.em:hover{border-color:#f6a8a8}
.quota.em.on{border-color:var(--red); background:#fff5f5; box-shadow:0 8px 22px rgba(220,38,38,.14)}
.quota.em.on .quota-mark{border-color:var(--red)}
.quota.em.on .quota-mark i{background:var(--red)}
.quota.em.on b{color:var(--red2)}

/* ------------------------------------------------------------------ otp -- */
.otp-card{text-align:center}
.otp-ico{width:62px; height:62px; margin:0 auto 16px; border-radius:20px; background:#eff8ff; color:var(--pr3); display:grid; place-items:center}
.otp-boxes{display:flex; gap:10px; justify-content:center; margin:24px 0 6px; flex-wrap:wrap}
.otp-box{
  width:52px; height:62px; text-align:center; font-family:'Sora',sans-serif; font-size:24px; font-weight:700;
  border:1.8px solid var(--border); border-radius:var(--r2); background:#fff; color:var(--text);
  transition:all .2s var(--ease); padding:0;
}
.otp-box:focus{outline:none; border-color:var(--pr); box-shadow:0 0 0 4px rgba(20,184,166,.16); transform:translateY(-2px)}
.otp-box.filled{border-color:var(--pr4); background:#f0fdfa}
.otp-timer{font-size:13px; color:var(--muted); margin-bottom:18px}
.otp-timer b{color:var(--pr); font-variant-numeric:tabular-nums}

/* -------------------------------------------------------------- success -- */
.done-card{text-align:center; animation:fadeUp .45s var(--ease)}
.done-ring{width:88px; height:88px; margin:0 auto 20px; border-radius:50%; background:var(--grad2); color:#fff; display:grid; place-items:center; box-shadow:0 16px 34px rgba(5,150,105,.3); animation:ringPop .55s var(--ease)}
.token-box{position:relative; overflow:hidden; margin:24px 0; padding:28px; border-radius:var(--r4); background:#06282b; color:#fff; box-shadow:var(--sh3)}
.token-box::after{content:''; position:absolute; inset:0; background:linear-gradient(115deg,transparent,rgba(255,255,255,.16),transparent); animation:sweep 3.4s ease-in-out infinite}
.token-box small{font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:rgba(226,242,240,.72); font-weight:700}
.token-box b{display:block; font-family:'Sora',sans-serif; font-size:66px; font-weight:800; line-height:1.02; margin:8px 0 10px; background:linear-gradient(100deg,#5eead4,#7dd3fc); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent}
.token-box p{color:rgba(226,242,240,.85); font-size:14px}
.recap{display:grid; grid-template-columns:1fr 1fr; gap:1px; background:var(--border2); border:1px solid var(--border); border-radius:var(--r2); overflow:hidden; text-align:left}
.recap div{background:#fff; padding:14px 16px; min-width:0}
.recap span{display:block; font-size:11.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--light); font-weight:700; margin-bottom:3px}
.recap b{font-size:14px; font-weight:600; word-break:break-word}

/* ----------------------------------------------------------------- auth -- */
.auth{flex:1; display:grid; grid-template-columns:.85fr 1.15fr; min-height:100vh}
.auth-side{position:relative; overflow:hidden; background:#06282b; color:#fff; padding:54px 46px; display:flex; flex-direction:column; justify-content:space-between}
.auth-side .brand{color:#fff; position:relative}
.auth-side h2{color:#fff; font-size:clamp(26px,3vw,36px); margin:18px 0 14px}
.auth-side h2 em{font-style:normal; background:linear-gradient(100deg,#5eead4,#7dd3fc); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent}
.auth-side p{color:rgba(226,242,240,.76); font-size:15px; max-width:40ch}
.auth-pts{position:relative; display:flex; flex-direction:column; gap:14px; margin-top:26px}
.auth-pt{display:flex; gap:12px; align-items:flex-start; font-size:14px; color:rgba(240,253,250,.9)}
.auth-pt .ico{color:#5eead4; margin-top:3px; flex:none}
.auth-body{position:relative; z-index:1}
.auth-main{display:flex; align-items:center; justify-content:center; padding:44px 26px; background:var(--bg)}
.auth-card{width:100%; max-width:520px; background:#fff; border:1px solid var(--border); border-radius:var(--r4); padding:34px; box-shadow:var(--sh2); animation:fadeUp .4s var(--ease)}
.auth-card h2{font-size:25px; margin:12px 0 6px}
.auth-card > .lead{color:var(--muted); font-size:14px; margin-bottom:24px}
.auth-foot{margin-top:20px; padding-top:18px; border-top:1px solid var(--border2); display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:13.5px; color:var(--muted); align-items:center}
.divider{display:flex; align-items:center; gap:12px; margin:22px 0; color:var(--light); font-size:11.5px; font-weight:700; letter-spacing:.12em; text-transform:uppercase}
.divider::before,.divider::after{content:''; height:1px; flex:1; background:var(--border)}

/* ---------------------------------------------------------------- track -- */
.track-list{display:flex; flex-direction:column; gap:14px}
.track-item{display:flex; gap:16px; align-items:center; padding:18px; border:1px solid var(--border); border-radius:var(--r3); background:#fff; transition:transform .24s var(--ease), box-shadow .24s var(--ease); flex-wrap:wrap}
.track-item:hover{transform:translateX(4px); box-shadow:var(--sh2)}
.track-token{width:64px; height:64px; border-radius:18px; flex:none; background:linear-gradient(135deg,#f0fdfa,#eff8ff); border:1px solid #ddf1ee; display:grid; place-items:center; font-family:'Sora',sans-serif; font-weight:800; font-size:21px; color:var(--pr2)}

/* --------------------------------------------------------------- footer -- */
.ft{background:#06282b; color:rgba(226,242,240,.72); padding:52px 0 26px; margin-top:auto}
.ft-grid{display:grid; grid-template-columns:1.4fr 1fr 1fr; gap:36px; padding-bottom:30px; border-bottom:1px solid rgba(255,255,255,.1)}
.ft .brand{color:#fff}
.ft p{font-size:14px; margin-top:14px; max-width:44ch}
.ft h4{color:#fff; font-size:13px; letter-spacing:.1em; text-transform:uppercase; margin-bottom:14px}
.ft-links{display:flex; flex-direction:column; gap:9px; align-items:flex-start}
.ft-links button{font-size:14px; color:rgba(226,242,240,.72); transition:color .18s, transform .18s}
.ft-links button:hover{color:#5eead4; transform:translateX(3px)}
.ft-base{padding-top:22px; display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap; font-size:13px}
`;

const CSS_ADMIN = `
/* ------------------------------------------------------------ dashboard -- */
.adm{flex:1; display:grid; grid-template-columns:262px 1fr; min-height:100vh; background:var(--bg)}
.adm-side{position:sticky; top:0; height:100vh; display:flex; flex-direction:column; gap:20px; padding:22px 18px; background:#06282b; color:rgba(226,242,240,.78); overflow-y:auto}
.adm-side .brand{color:#fff; font-size:16px}
.adm-clinic{display:flex; gap:12px; align-items:center; padding:14px; border-radius:var(--r2); background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.12); min-width:0}
.adm-clinic .cc-av{width:42px; height:42px; border-radius:12px; font-size:15px; box-shadow:none}
.adm-clinic div{min-width:0}
.adm-clinic b{display:block; color:#fff; font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.adm-clinic span{font-size:12px; color:rgba(226,242,240,.62); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block}
.adm-nav{display:flex; flex-direction:column; gap:4px}
.adm-nav button{
  display:flex; align-items:center; gap:11px; width:100%; padding:11px 14px; border-radius:var(--r1);
  font-size:14px; font-weight:500; color:rgba(226,242,240,.76); transition:all .2s var(--ease); text-align:left;
}
.adm-nav button:hover{background:rgba(255,255,255,.09); color:#fff; transform:translateX(3px)}
.adm-nav button.on{background:var(--grad); color:#fff; font-weight:600; box-shadow:0 8px 20px rgba(15,118,110,.32)}
.adm-nav .count{margin-left:auto; font-size:11.5px; font-weight:700; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.16)}
.adm-side-foot{margin-top:auto; display:flex; flex-direction:column; gap:8px; padding-top:16px; border-top:1px solid rgba(255,255,255,.1)}
.adm-side-foot button{display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:var(--r1); font-size:13.5px; color:rgba(226,242,240,.72); transition:all .2s}
.adm-side-foot button:hover{background:rgba(255,255,255,.09); color:#fff}

.adm-main{min-width:0; display:flex; flex-direction:column}
.adm-top{position:sticky; top:0; z-index:40; display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding:16px 26px; background:rgba(245,248,250,.9); backdrop-filter:blur(12px); border-bottom:1px solid var(--border)}
.adm-top h1{font-size:clamp(19px,2.4vw,25px)}
.adm-top .sub{font-size:13.5px; color:var(--muted)}
.adm-top-actions{display:flex; align-items:center; gap:10px; flex-wrap:wrap}
.date-pick{display:flex; align-items:center; gap:8px; padding:7px 12px; border-radius:var(--r1); background:#fff; border:1px solid var(--border); font-size:13.5px; color:var(--muted)}
.date-pick input{border:0; font:inherit; font-size:13.5px; color:var(--text); background:none; outline:none; padding:2px 0; min-width:118px}
.adm-body{padding:26px; display:flex; flex-direction:column; gap:22px; min-width:0}
.adm-burger{display:none}

/* ---------------------------------------------------------------- stats -- */
.stat-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:16px}
.stat{position:relative; overflow:hidden; display:flex; gap:14px; align-items:center; padding:20px; background:#fff; border:1px solid var(--border); border-radius:var(--r3); box-shadow:var(--sh1); transition:transform .26s var(--ease), box-shadow .26s var(--ease)}
.stat:hover{transform:translateY(-5px); box-shadow:var(--sh3)}
.stat::before{content:''; position:absolute; inset:auto 0 0 0; height:3px; background:currentColor; opacity:.85; transform:scaleX(0); transform-origin:left; transition:transform .35s var(--ease)}
.stat:hover::before{transform:scaleX(1)}
.stat-ico{width:46px; height:46px; border-radius:14px; flex:none; display:grid; place-items:center; background:currentColor; transition:transform .3s var(--ease)}
.stat-ico .ico{color:#fff}
.stat:hover .stat-ico{transform:scale(1.08) rotate(-6deg)}
.stat-txt{min-width:0}
.stat-txt small{display:block; font-size:12px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--muted)}
.stat-txt b{display:block; font-family:'Sora',sans-serif; font-size:31px; font-weight:800; line-height:1.15; color:var(--text); font-variant-numeric:tabular-nums}
.stat-txt span{font-size:12px; color:var(--light)}
.c-teal{color:var(--pr)} .c-green{color:var(--gr)} .c-amber{color:var(--amber)} .c-red{color:var(--red)} .c-blue{color:var(--pr3)} .c-violet{color:var(--violet)}

.next-card{display:flex; align-items:center; gap:20px; padding:22px 26px; border-radius:var(--r3); background:#06282b; color:#fff; box-shadow:var(--sh3); flex-wrap:wrap; position:relative; overflow:hidden}
.next-card .hero-orb.a{width:260px; height:260px; top:-120px; left:-40px; opacity:.45}
.next-card b{position:relative; font-family:'Sora',sans-serif; font-size:44px; font-weight:800; line-height:1; background:linear-gradient(100deg,#5eead4,#7dd3fc); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent}
.next-card .nc-txt{position:relative; flex:1; min-width:200px}
.next-card .nc-txt small{font-size:11px; letter-spacing:.16em; text-transform:uppercase; color:rgba(226,242,240,.7); font-weight:700}
.next-card .nc-txt p{font-size:14.5px; color:rgba(226,242,240,.88); margin-top:4px}

/* -------------------------------------------------------------- filters -- */
.filters{display:grid; grid-template-columns:minmax(200px,1.6fr) repeat(3,minmax(130px,1fr)) auto; gap:10px; align-items:center}
.filters .btn-icon{justify-self:start}

/* ---------------------------------------------------------------- table -- */
.table-wrap{overflow-x:auto; -webkit-overflow-scrolling:touch}
.tbl{width:100%; border-collapse:collapse; font-size:14px; min-width:940px}
.tbl thead th{
  text-align:left; padding:13px 18px; font-size:11.5px; font-weight:700; letter-spacing:.08em;
  text-transform:uppercase; color:var(--muted); background:#fafcfd; border-bottom:1px solid var(--border);
  white-space:nowrap; position:sticky; top:0; z-index:2;
}
.tbl tbody tr{border-bottom:1px solid var(--border2); transition:background .18s}
.tbl tbody tr:hover{background:#f7fbfc}
.tbl tbody tr:last-child{border-bottom:0}
.tbl td{padding:14px 18px; vertical-align:middle}
.tbl td.tok{width:78px}
.tok-chip{display:inline-grid; place-items:center; width:46px; height:46px; border-radius:14px; background:linear-gradient(135deg,#f0fdfa,#eff8ff); border:1px solid #ddf1ee; font-family:'Sora',sans-serif; font-weight:800; font-size:15px; color:var(--pr2)}
.tok-chip.em{background:linear-gradient(135deg,#fff5f5,#fff1f1); border-color:#fbd5d5; color:var(--red2)}
.who b{display:block; font-weight:600; font-size:14px}
.who span{font-size:12.5px; color:var(--muted)}
.contact{font-size:13px}
.contact b{display:block; font-weight:600}
.contact span{color:var(--muted); font-size:12.5px; word-break:break-all}
.row-actions{display:flex; gap:7px; flex-wrap:wrap; justify-content:flex-end}
.no-data{padding:44px 18px !important; text-align:center; color:var(--muted)}

/* ------------------------------------------------------------ analytics -- */
.an-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:16px}
.an-tile{padding:18px; border-radius:var(--r2); background:#fafcfd; border:1px solid var(--border2); transition:transform .24s var(--ease), box-shadow .24s var(--ease)}
.an-tile:hover{transform:translateY(-4px); box-shadow:var(--sh2); background:#fff}
.an-tile small{display:block; font-size:11.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--muted); margin-bottom:6px}
.an-tile b{font-family:'Sora',sans-serif; font-size:26px; font-weight:800; line-height:1.15; font-variant-numeric:tabular-nums}
.an-tile p{font-size:12.5px; color:var(--light)}

/* -- clickable drill-down cards (overview stats + analytics tiles) -------- */
/* Cards stay <div role="button"> so the original .c-* tone colors keep driving
   currentColor for .stat-ico and .stat::before. Only additive rules below. */
.stat.tap,.an-tile.tap{cursor:pointer}
.stat.tap:focus-visible,.an-tile.tap:focus-visible{outline:2px solid var(--pr4); outline-offset:3px}
.stat .tap-cue,.an-tile .tap-cue{display:inline-flex; align-items:center; gap:5px; margin-top:9px; font-size:11px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--pr); opacity:0; transform:translateY(4px); transition:opacity .24s var(--ease), transform .24s var(--ease)}
.stat.tap:hover .tap-cue,.an-tile.tap:hover .tap-cue,.stat.tap:focus-visible .tap-cue,.an-tile.tap:focus-visible .tap-cue{opacity:1; transform:none}
.hint-bar{display:flex; align-items:center; gap:9px; padding:11px 15px; margin-bottom:18px; border-radius:var(--r2); background:#f0fdfa; border:1px solid #ccfbf1; color:var(--pr2); font-size:13px; font-weight:600}

/* -- appointments grouped by day ----------------------------------------- */
.day-stack{display:flex; flex-direction:column; gap:18px}
.day-group{border:1px solid var(--border); border-radius:var(--r3); overflow:hidden; background:#fff; box-shadow:var(--sh1)}
.day-head{display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:13px 18px; background:var(--grad); color:#fff}
.day-head h4{margin:0; font-family:'Sora',sans-serif; font-size:14.5px; font-weight:700; display:flex; align-items:center; gap:8px}
.day-head .ico{color:#fff}
.day-chips{display:flex; gap:7px; flex-wrap:wrap}
.day-chip{font-size:11.5px; font-weight:700; padding:4px 11px; border-radius:999px; background:rgba(255,255,255,.19); border:1px solid rgba(255,255,255,.26)}
.tok-struck{text-decoration:line-through; opacity:.55}

/* -- quota split bar ------------------------------------------------------ */
.split-bar{display:flex; height:12px; border-radius:999px; overflow:hidden; background:var(--border2)}
.split-bar i{display:block; transition:width .7s var(--ease)}
.split-legend{display:flex; gap:18px; flex-wrap:wrap; margin-top:11px; font-size:12.5px; color:var(--muted)}
.split-legend span{display:flex; align-items:center; gap:7px}
.split-legend em{width:11px; height:11px; border-radius:3px; display:block}
.tbl-drill{min-width:780px}

.bars{display:flex; flex-direction:column; gap:16px}
.bar-row .bar-top{display:flex; justify-content:space-between; gap:12px; font-size:13.5px; margin-bottom:7px}
.bar-row .bar-top b{font-weight:600}
.bar-track{height:10px; border-radius:999px; background:#eef2f6; overflow:hidden}
.bar-fill{height:100%; border-radius:999px; transition:width .8s var(--ease)}
.bf-teal{background:var(--grad)} .bf-green{background:var(--grad2)} .bf-red{background:linear-gradient(135deg,#dc2626,#f97316)} .bf-amber{background:linear-gradient(135deg,#f59e0b,#fbbf24)} .bf-violet{background:linear-gradient(135deg,#7c3aed,#a78bfa)}

.trend{display:flex; align-items:flex-end; gap:8px; height:190px; padding:16px 4px 0; overflow-x:auto}
.trend-col{flex:1; min-width:34px; display:flex; flex-direction:column; align-items:center; gap:8px; height:100%}
.trend-bar{width:100%; max-width:34px; flex:1; display:flex; flex-direction:column; justify-content:flex-end; gap:3px}
.trend-seg{border-radius:6px 6px 0 0; transform-origin:bottom; animation:growBar .6s var(--ease); transition:filter .2s}
.trend-col:hover .trend-seg{filter:brightness(1.12)}
.trend-seg.v{background:var(--grad2)}
.trend-seg.w{background:linear-gradient(180deg,#7dd3fc,#38bdf8)}
.trend-lbl{font-size:10.5px; color:var(--light); text-align:center; white-space:nowrap; font-weight:600}
.legend{display:flex; gap:16px; flex-wrap:wrap; font-size:12.5px; color:var(--muted)}
.legend span{display:inline-flex; align-items:center; gap:6px}
.legend i{width:11px; height:11px; border-radius:4px; display:inline-block}

/* ------------------------------------------------------------- settings -- */
.set-grid{display:grid; grid-template-columns:1fr 1fr; gap:22px; align-items:start}
.kv{display:grid; grid-template-columns:auto 1fr; gap:10px 16px; font-size:13.5px}
.kv dt{color:var(--muted); font-weight:600}
.kv dd{margin:0; word-break:break-word}
.copy-row{display:flex; gap:8px; align-items:center; padding:12px 14px; border-radius:var(--r1); background:#fafcfd; border:1px dashed var(--border); font-size:13px; word-break:break-all}

/* ----------------------------------------------------------- responsive -- */
@media (max-width:1080px){
  .hero-in{grid-template-columns:1fr; gap:40px}
  .hero-panel{max-width:440px}
  .bp-layout{grid-template-columns:1fr}
  .bp-aside{position:static}
  .feat-grid,.steps-strip{grid-template-columns:1fr 1fr}
  .auth{grid-template-columns:1fr}
  .auth-side{padding:38px 26px; min-height:auto}
  .auth-side .auth-pts{display:none}
  .set-grid{grid-template-columns:1fr}
  .adm{grid-template-columns:1fr}
  .adm-side{
    position:fixed; inset:0 auto 0 0; width:270px; z-index:110; height:100vh;
    transform:translateX(-102%); transition:transform .32s var(--ease); box-shadow:var(--sh4);
  }
  .adm-side.open{transform:none}
  .adm-burger{display:inline-flex}
  .adm-scrim{position:fixed; inset:0; z-index:105; background:rgba(15,23,42,.5); backdrop-filter:blur(3px); animation:fade .2s ease}
}
@media (max-width:860px){
  .nav-links{display:none}
  .nav-actions .btn-outline{display:none}
  .nav-burger{display:inline-flex}
  .nav-drop{display:block; border-top:1px solid var(--border); background:#fff; padding:12px 0 16px; animation:fadeUp .26s var(--ease)}
  .nav-drop .container{display:flex; flex-direction:column; gap:6px}
  .nav-drop button{text-align:left; padding:12px 14px; border-radius:var(--r1); font-size:14.5px; font-weight:500}
  .nav-drop button:hover{background:#eef4f7}
  .section{padding:52px 0}
  .hero{padding:60px 0 70px}
  .feat-grid,.steps-strip{grid-template-columns:1fr}
  .filters{grid-template-columns:1fr 1fr}
  .filters .input-icon{grid-column:1/-1}
  .recap{grid-template-columns:1fr}
  .ft-grid{grid-template-columns:1fr; gap:26px}
  .adm-body{padding:18px}
  .adm-top{padding:14px 18px}

  /* table becomes stacked cards - this is what keeps mobile aligned */
  .table-wrap{overflow:visible}
  .tbl{min-width:0; display:block}
  .tbl thead{display:none}
  .tbl tbody{display:flex; flex-direction:column; gap:12px}
  .tbl tbody tr{display:block; border:1px solid var(--border); border-radius:var(--r2); padding:14px; background:#fff}
  .tbl tbody tr:hover{background:#fff}
  .tbl td{display:flex; align-items:center; justify-content:space-between; gap:14px; padding:7px 0; border:0; text-align:right}
  .tbl td::before{content:attr(data-label); font-size:11px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--light); text-align:left; flex:none}
  .tbl td.tok{width:auto}
  .tbl td.tok::before{align-self:center}
  .who,.contact{text-align:right}
  .row-actions{justify-content:flex-end}
  .tbl td.no-data{display:block; text-align:center}
  .tbl td.no-data::before{display:none}
}
@media (max-width:620px){
  .container,.container-sm{padding:0 16px}
  .quota-grid,.grid2,.grid3{grid-template-columns:1fr}
  .form-card,.auth-card{padding:22px; border-radius:var(--r3)}
  .bp-banner{padding:22px; border-radius:var(--r3)}
  .otp-box{width:44px; height:56px; font-size:21px}
  .token-box b{font-size:52px}
  .stat-txt b{font-size:27px}
  .filters{grid-template-columns:1fr}
  .clinic-grid{grid-template-columns:1fr}
  .hero-stats{gap:20px}
  .modal-body{padding:18px}
}
`;

const CSS_QUEUE = `
.row-between{display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap}
/* ======================= INTELLIGENT LIVE QUEUE TRACKING ================== */
.lq{display:flex; flex-direction:column; gap:18px}

/* -- now serving hero ------------------------------------------------------ */
.lq-hero{position:relative; overflow:hidden; padding:26px; border-radius:var(--r4); background:var(--grad); color:#fff; box-shadow:var(--sh3)}
.lq-hero::before{content:''; position:absolute; width:300px; height:300px; right:-100px; top:-150px; border-radius:50%; background:rgba(255,255,255,.12)}
.lq-hero::after{content:''; position:absolute; width:190px; height:190px; left:-70px; bottom:-115px; border-radius:50%; background:rgba(255,255,255,.08)}
.lq-hero-in{position:relative; z-index:1; display:flex; gap:26px; align-items:center; flex-wrap:wrap}
.lq-dial{width:138px; height:138px; flex:none; border-radius:50%; display:grid; place-items:center; text-align:center; background:rgba(255,255,255,.17); border:2px solid rgba(255,255,255,.45); animation:lqBreathe 3.4s var(--ease) infinite}
@keyframes lqBreathe{0%,100%{box-shadow:0 0 0 10px rgba(255,255,255,.07), inset 0 3px 24px rgba(255,255,255,.22)}50%{box-shadow:0 0 0 19px rgba(255,255,255,.03), inset 0 3px 24px rgba(255,255,255,.32)}}
.lq-dial b{display:block; font-family:'Sora',sans-serif; font-size:54px; font-weight:800; line-height:1; letter-spacing:-.02em; font-variant-numeric:tabular-nums}
.lq-dial small{display:block; font-size:10px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; opacity:.9; margin-top:6px}
.lq-hero-txt{flex:1; min-width:220px}
.lq-hero-txt h2{font-family:'Sora',sans-serif; font-size:clamp(20px,3vw,27px); font-weight:800; margin:0 0 7px; color:#fff}
.lq-hero-txt p{font-size:13.5px; opacity:.93; margin:0; line-height:1.55}
.lq-pills{display:flex; gap:10px; flex-wrap:wrap; margin-top:17px}
.lq-pill{display:inline-flex; align-items:center; gap:7px; padding:8px 13px; border-radius:999px; background:rgba(255,255,255,.18); border:1px solid rgba(255,255,255,.3); font-size:12.5px; font-weight:600}
.lq-pill b{font-weight:800; font-variant-numeric:tabular-nums}

/* -- live indicator -------------------------------------------------------- */
.lq-live{display:inline-flex; align-items:center; gap:7px; font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase}
.lq-dot{width:9px; height:9px; border-radius:50%; flex:none; background:#34d399; animation:lqBlip 1.7s ease-out infinite}
@keyframes lqBlip{0%{box-shadow:0 0 0 0 rgba(52,211,153,.75)}70%{box-shadow:0 0 0 10px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.lq-dot.off{background:var(--light); animation:none}

/* -- the pebble dial pad --------------------------------------------------- */
.lq-pad{display:grid; grid-template-columns:repeat(auto-fill,minmax(84px,1fr)); gap:16px}
.lq-cell{display:flex; flex-direction:column; align-items:center; gap:7px; min-width:0}
.lq-cap{max-width:100%; padding:2px 7px; border:0; border-radius:7px; background:transparent; font-family:inherit; font-size:10.5px; font-weight:600; color:var(--muted); text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; transition:color .18s var(--ease), background .18s var(--ease)}
.lq-cap:hover,.lq-cap:focus-visible{color:var(--pr2); background:#f0fdfa; text-decoration:underline}
.lq-cap.dim{color:var(--light); cursor:default}
.lq-cap.dim:hover{color:var(--light); background:transparent; text-decoration:none}
.lq-peb{position:relative; width:100%; max-width:104px; aspect-ratio:1/1; padding:0; border:0; border-radius:50%; cursor:pointer; display:grid; place-items:center; font-family:'Sora',sans-serif; font-size:25px; font-weight:800; line-height:1; color:#fff; font-variant-numeric:tabular-nums; -webkit-tap-highlight-color:transparent; transition:transform .26s var(--ease), box-shadow .26s var(--ease), filter .26s var(--ease)}
/* glossy highlight = the pebble read */
.lq-peb::before{content:''; position:absolute; inset:0; border-radius:50%; background:radial-gradient(circle at 31% 25%, rgba(255,255,255,.62), rgba(255,255,255,.08) 45%, rgba(255,255,255,0) 67%); pointer-events:none}
/* glitter read = a diagonal light sheen sweeping across fixed sparkle specks.
   Deliberately NOT a ring travelling around the rim. */
.lq-peb::after{content:''; position:absolute; inset:0; border-radius:50%; opacity:0; pointer-events:none; background:linear-gradient(102deg, transparent 30%, rgba(255,255,255,.16) 42%, rgba(255,255,255,.92) 50%, rgba(255,255,255,.16) 58%, transparent 70%), radial-gradient(circle at 26% 30%, rgba(255,255,255,.95) 0 1.7px, transparent 2.3px), radial-gradient(circle at 73% 24%, rgba(255,255,255,.9) 0 1.3px, transparent 1.9px), radial-gradient(circle at 66% 73%, rgba(255,255,255,.92) 0 1.6px, transparent 2.2px), radial-gradient(circle at 32% 69%, rgba(255,255,255,.85) 0 1.2px, transparent 1.8px), radial-gradient(circle at 51% 46%, rgba(255,255,255,.8) 0 1.1px, transparent 1.7px); background-repeat:no-repeat; background-size:230% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%, 100% 100%; background-position:-150% 0, 0 0, 0 0, 0 0, 0 0, 0 0; transition:opacity .24s var(--ease)}
.lq-peb:hover::after,.lq-peb:focus-visible::after{animation:lqGlint 1.25s var(--ease) infinite}
@keyframes lqGlint{0%{opacity:.2; background-position:-150% 0, 0 0, 0 0, 0 0, 0 0, 0 0}18%{opacity:1}80%{opacity:1}100%{opacity:.2; background-position:150% 0, 0 0, 0 0, 0 0, 0 0, 0 0}}
.lq-peb:hover{transform:translateY(-5px) scale(1.05)}
.lq-peb:active{transform:translateY(-1px) scale(.96)}
.lq-peb span{position:relative; z-index:1; text-shadow:0 1px 3px rgba(15,23,42,.3)}
.lq-peb i{position:absolute; z-index:2; top:5px; right:5px; width:20px; height:20px; border-radius:50%; display:grid; place-items:center; background:#fff; color:var(--red); font-size:10px; font-style:normal; font-weight:800; box-shadow:var(--sh1)}
.lq-peb u{position:absolute; z-index:2; left:50%; bottom:11px; transform:translateX(-50%); font-size:8.5px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; text-decoration:none; opacity:.92}

.lq-peb.wait{background:linear-gradient(145deg,#22d3ee 0%,#0ea5e9 52%,#0369a1 100%); box-shadow:0 9px 20px rgba(3,105,161,.35), inset 0 -3px 11px rgba(3,105,161,.42)}
.lq-peb.done{background:linear-gradient(145deg,#4ade80 0%,#10b981 52%,#047857 100%); box-shadow:0 9px 20px rgba(4,120,87,.35), inset 0 -3px 11px rgba(4,120,87,.42)}
.lq-peb.emg{background:linear-gradient(145deg,#fca5a5 0%,#ef4444 52%,#b91c1c 100%); box-shadow:0 9px 20px rgba(185,28,28,.35), inset 0 -3px 11px rgba(185,28,28,.42)}
.lq-peb.void{background:linear-gradient(145deg,#e2e8f0 0%,#cbd5e1 60%,#94a3b8 100%); color:#64748b; box-shadow:inset 0 -3px 11px rgba(100,116,139,.24); cursor:not-allowed}
.lq-peb.void span{text-decoration:line-through; text-shadow:none}
.lq-peb.void:hover{transform:none}
.lq-peb.void::after{display:none}
.lq-peb.gap{background:#f8fafc; border:2px dashed var(--border); color:var(--light); box-shadow:none; cursor:not-allowed}
.lq-peb.gap span{text-shadow:none}
.lq-peb.gap:hover{transform:none}
.lq-peb.gap::before,.lq-peb.gap::after{display:none}
/* the token being consulted right now */
.lq-peb.now{animation:lqNow 2s var(--ease) infinite}
@keyframes lqNow{0%,100%{box-shadow:0 9px 22px rgba(4,120,87,.42), 0 0 0 0 rgba(16,185,129,.62), inset 0 -3px 11px rgba(4,120,87,.42)}50%{box-shadow:0 9px 22px rgba(4,120,87,.42), 0 0 0 16px rgba(16,185,129,0), inset 0 -3px 11px rgba(4,120,87,.42)}}
.lq-peb.next{outline:3px dashed rgba(245,158,11,.95); outline-offset:4px}
.lq-peb.mine{outline:4px solid var(--violet); outline-offset:5px}
.lq-peb.busy{filter:saturate(.4) brightness(1.06); pointer-events:none}
.lq-peb.busy::after{display:none}

/* -- toolbar + legend ------------------------------------------------------ */
.lq-bar{display:flex; gap:14px; align-items:center; justify-content:space-between; flex-wrap:wrap}
.lq-legend{display:flex; gap:15px; flex-wrap:wrap; align-items:center}
.lq-key{display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:600; color:var(--muted)}
.lq-swatch{width:15px; height:15px; border-radius:50%; flex:none; box-shadow:inset 0 -2px 5px rgba(15,23,42,.2)}
.lq-tip{display:flex; gap:10px; align-items:flex-start; padding:13px 15px; border-radius:var(--r2); background:#f0fdfa; border:1px solid #ccece7; color:var(--pr2); font-size:12.5px; line-height:1.6}
.lq-toggle{display:inline-flex; align-items:center; gap:9px; padding:8px 14px; border-radius:999px; border:1px solid var(--border); background:#fff; font-size:12.5px; font-weight:600; color:var(--text); cursor:pointer; transition:box-shadow .2s var(--ease), border-color .2s var(--ease)}
.lq-toggle:hover{box-shadow:var(--sh2)}
.lq-toggle.on{border-color:var(--pr4); background:#f0fdfa; color:var(--pr2)}

/* -- patient facing tracker ------------------------------------------------ */
.tk-grid{display:grid; grid-template-columns:1.05fr .95fr; gap:18px; align-items:start}
.tk-card{padding:22px; border-radius:var(--r3); background:#fff; border:1px solid var(--border); box-shadow:var(--sh1)}
.tk-mine{text-align:center; padding:28px 22px}
.tk-ring{position:relative; width:152px; height:152px; margin:0 auto 18px; border-radius:50%; display:grid; place-items:center; background:conic-gradient(var(--pr) calc(var(--p) * 1%), #eef2f6 0)}
.tk-ring::after{content:''; position:absolute; inset:12px; border-radius:50%; background:#fff}
.tk-ring-in{position:relative; z-index:1}
.tk-ring-in b{display:block; font-family:'Sora',sans-serif; font-size:44px; font-weight:800; line-height:1; color:var(--text); font-variant-numeric:tabular-nums}
.tk-ring-in small{display:block; font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin-top:5px}
.tk-eta{display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:18px}
.tk-eta div{padding:13px 10px; border-radius:var(--r1); background:#f8fafc; border:1px solid var(--border2)}
.tk-eta b{display:block; font-family:'Sora',sans-serif; font-size:21px; font-weight:800; line-height:1.2; color:var(--text); font-variant-numeric:tabular-nums}
.tk-eta small{display:block; font-size:10px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--muted); margin-top:4px}
.tk-state{display:flex; gap:10px; align-items:center; margin-top:17px; padding:14px 16px; border-radius:var(--r2); font-size:13.5px; font-weight:600; text-align:left; line-height:1.5}
.tk-state.turn{background:linear-gradient(135deg,#ecfdf5,#d1fae5); border:1px solid #a7f3d0; color:#065f46}
.tk-state.soon{background:linear-gradient(135deg,#fffbeb,#fef3c7); border:1px solid #fde68a; color:#92400e}
.tk-state.wait{background:#f0f9ff; border:1px solid #bae6fd; color:#075985}
.tk-state.done{background:#f8fafc; border:1px solid var(--border); color:var(--muted)}
.tk-state.void{background:#fef2f2; border:1px solid #fecaca; color:var(--red2)}
.tk-strip{display:flex; gap:10px; overflow-x:auto; padding:8px 2px 12px}
.tk-strip .lq-cell{width:62px; flex:none}
.tk-strip .lq-peb{max-width:62px; font-size:19px; cursor:default}
.tk-strip .lq-peb u{display:none}
.tk-mini{display:flex; gap:12px; align-items:center; width:100%; padding:13px 15px; border-radius:var(--r2); border:1px solid var(--border); background:#fff; cursor:pointer; text-align:left; transition:transform .2s var(--ease), box-shadow .2s var(--ease)}
.tk-mini:hover{transform:translateX(3px); box-shadow:var(--sh2)}
.tk-mini.on{border-color:var(--pr4); background:#f0fdfa; box-shadow:0 0 0 3px rgba(20,184,166,.14)}
.tk-mini b{display:block; font-size:13.5px; font-weight:700; color:var(--text)}
.tk-mini small{display:block; font-size:11.5px; color:var(--muted)}
.tk-tok{width:46px; height:46px; flex:none; border-radius:14px; display:grid; place-items:center; font-family:'Sora',sans-serif; font-size:17px; font-weight:800; background:linear-gradient(135deg,#f0fdfa,#eff8ff); border:1px solid #ddf1ee; color:var(--pr2)}

@media (max-width:900px){
  .tk-grid{grid-template-columns:1fr}
}
@media (max-width:620px){
  .lq-pad{grid-template-columns:repeat(auto-fill,minmax(70px,1fr)); gap:13px}
  .lq-peb{font-size:21px}
  .lq-hero{padding:20px}
  .lq-dial{width:116px; height:116px}
  .lq-dial b{font-size:44px}
  .tk-eta{grid-template-columns:1fr}
}
`;

/* ============================================================================
 * ADAPTIVE LAYER
 *
 * Concatenated LAST so it always wins the cascade and can never be disturbed
 * by, or disturb, the rules above it. Ladder of breakpoints:
 *   1600+  ultra-wide monitors      1280   laptops
 *   1080   small laptop / tablet    900    tablet portrait
 *   768    large phone / landscape  600    phone
 *   400    small phone              short/touch/print special cases
 * ========================================================================== */

/* ============================================================================
 * MASTER ADMIN PANEL - platform owner console
 * Reuses the existing .adm shell, .stat cards, .tbl tables and .btn system so
 * the owner panel is visually identical to a clinic dashboard. Status colour is
 * carried on the card via currentColor, exactly like .stat does.
 * ========================================================================== */

const CSS_OWNER = `
.own-gate{
  min-height:100vh; display:grid; place-items:center; padding:24px;
  background:
    radial-gradient(1100px 560px at 12% -12%, rgba(14,165,233,.20), transparent 60%),
    radial-gradient(900px 500px at 112% 8%, rgba(124,58,237,.18), transparent 55%),
    #06282b;
}
.own-gate-card{width:100%; max-width:430px; background:#fff; border-radius:var(--r4); padding:32px; box-shadow:var(--sh4); animation:fadeUp .45s var(--ease)}
.own-gate-card h2{font-size:22px; margin:14px 0 6px}
.own-gate-card > .lead{color:var(--muted); font-size:13.5px; margin-bottom:22px; line-height:1.65}
.own-gate-foot{margin-top:18px; padding-top:16px; border-top:1px solid var(--border2); font-size:12.5px; color:var(--light); line-height:1.7}

.own-bar{display:flex; align-items:center; gap:12px; flex-wrap:wrap}
.own-bar .input-icon{flex:1 1 260px; min-width:0}
.own-seg{display:inline-flex; padding:4px; gap:4px; background:#fff; border:1px solid var(--border); border-radius:999px; box-shadow:var(--sh1)}
.own-seg button{display:flex; align-items:center; gap:7px; padding:8px 15px; border-radius:999px; font-size:13px; font-weight:600; color:var(--muted); transition:all .22s var(--ease)}
.own-seg button:hover{color:var(--text)}
.own-seg button.on{background:var(--grad); color:#fff; box-shadow:0 6px 16px rgba(15,118,110,.28)}

.own-grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(318px,1fr)); gap:18px}
.own-card{
  position:relative; overflow:hidden; display:flex; flex-direction:column; gap:14px; padding:20px;
  background:#fff; border:1px solid var(--border); border-radius:var(--r3); box-shadow:var(--sh1);
  transition:transform .26s var(--ease), box-shadow .26s var(--ease);
}
.own-card:hover{transform:translateY(-4px); box-shadow:var(--sh3)}
.own-card::before{content:''; position:absolute; inset:0 0 auto 0; height:3px; background:currentColor; opacity:.9}
.own-card.pend{color:var(--amber)}
.own-card.appr{color:var(--gr)}
.own-card.rej{color:var(--red)}
.own-card.hid{color:var(--pr3)}
.own-card-top{display:flex; gap:13px; align-items:center; min-width:0}
.own-card-top .cc-av{width:48px; height:48px; border-radius:14px; font-size:16px; flex:none; box-shadow:none}
.own-card-id{min-width:0; flex:1}
.own-card-id b{display:block; font-family:'Sora',sans-serif; font-size:15.5px; color:var(--text); font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.own-card-id span{display:block; font-size:12.5px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.own-meta{display:flex; flex-direction:column; gap:7px}
.own-meta div{display:flex; gap:9px; align-items:flex-start; font-size:12.5px; color:var(--muted); min-width:0}
.own-meta .ico{flex:none; margin-top:1px; color:var(--light)}
.own-meta span{min-width:0; word-break:break-word}
.own-tags{display:flex; gap:7px; flex-wrap:wrap; align-items:center}
.own-actions{display:flex; gap:8px; flex-wrap:wrap; margin-top:auto; padding-top:14px; border-top:1px solid var(--border2)}

.own-st{display:inline-flex; align-items:center; gap:6px; padding:4px 11px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; white-space:nowrap}
.own-st.pend{background:#fef3c7; color:#92400e}
.own-st.appr{background:#dcfce7; color:#166534}
.own-st.rej{background:#fee2e2; color:#991b1b}
.own-st.hid{background:#e0f2fe; color:#075985}

.own-empty{padding:54px 24px; text-align:center; background:#fff; border:1px dashed var(--border); border-radius:var(--r3); color:var(--muted)}
.own-empty .ico{color:var(--light); margin-bottom:12px}
.own-empty b{display:block; font-family:'Sora',sans-serif; color:var(--text); font-size:16.5px; margin-bottom:6px}
.own-note{background:#fffbeb; border:1px solid #fcd34d; border-radius:var(--r2); padding:13px 16px; font-size:13px; color:#92400e; line-height:1.65}
.own-cell-sub{display:block; font-size:11.5px; color:var(--light)}

/* Approval banner shown to a CLINIC inside its own dashboard. */
.lst-banner{display:flex; gap:13px; align-items:flex-start; padding:16px 18px; border-radius:var(--r2); font-size:13.5px; line-height:1.65; animation:fadeUp .4s var(--ease)}
.lst-banner .ico{flex:none; margin-top:2px}
.lst-banner b{display:block; font-size:14.5px; margin-bottom:3px}
.lst-banner.pend{background:#fffbeb; border:1px solid #fcd34d; color:#92400e}
.lst-banner.rej{background:#fef2f2; border:1px solid #fca5a5; color:#991b1b}
.lst-banner.hid{background:#f0f9ff; border:1px solid #7dd3fc; color:#075985}

@media (max-width:520px){
  .own-grid{grid-template-columns:1fr}
  .own-seg{width:100%}
  .own-seg button{flex:1; justify-content:center}
  .own-gate-card{padding:24px}
}
`;

const CSS_RESP = `
/* long emails, addresses and booking ids must wrap, never widen the page */
.kv dd,.tk-mini b,.tk-mini small,.who b,.contact span,.lq-cap,.adm-clinic{overflow-wrap:anywhere; word-break:break-word}
img,svg,video,canvas{max-width:100%}
input,select,textarea,button{max-width:100%}
/* overflow:clip (not hidden) kills sideways scroll WITHOUT breaking the
   sticky sidebar and sticky admin topbar, which overflow:hidden would. */
@supports (overflow:clip){
  html,body{overflow-x:clip}
}
/* real viewport height on mobile, where 100vh hides behind the URL bar */
@supports (height:100dvh){
  .auth,.adm{min-height:100dvh}
  .adm-side{height:100dvh}
}

@media (min-width:1600px){
  .container{max-width:1400px}
  .container-sm{max-width:960px}
  .lq-pad{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}
}

@media (max-width:1280px){
  .adm{grid-template-columns:232px 1fr}
  .adm-body{padding:20px}
  .ft-grid{gap:24px}
}

@media (max-width:1080px){
  .lq-hero-in{gap:20px}
  .tk-grid{gap:16px}
}

@media (max-width:900px){
  .container,.container-sm{padding:0 18px}
  .stat-grid{grid-template-columns:repeat(auto-fit,minmax(168px,1fr)); gap:13px}
  .an-grid{grid-template-columns:repeat(auto-fit,minmax(178px,1fr)); gap:13px}
  .lq-pad{grid-template-columns:repeat(auto-fill,minmax(78px,1fr)); gap:14px}
  .adm-top{padding:13px 18px}
  .adm-body{padding:18px}
  .panel-head{padding:17px 18px}
  .panel-body{padding:18px}
}

@media (max-width:768px){
  :root{--nav:62px}
  .container,.container-sm{padding:0 16px}
  .lq-hero{padding:18px}
  .lq-hero-in{flex-direction:column; align-items:flex-start; gap:16px}
  .lq-dial{width:106px; height:106px}
  .lq-dial b{font-size:41px}
  .lq-hero-txt{min-width:0; width:100%}
  .lq-bar{align-items:stretch}
  .lq-legend{gap:10px}
  .lq-toggle{flex:1; justify-content:center}
  .modal-foot .btn{flex:1; min-width:130px; justify-content:center}
  .row-actions{flex-wrap:wrap}
  .adm-top-actions{width:100%}
}

@media (max-width:600px){
  .stat-grid{grid-template-columns:1fr 1fr; gap:11px}
  .stat{padding:15px; gap:11px}
  .stat-ico{width:38px; height:38px; border-radius:11px}
  .stat-txt b{font-size:24px}
  .an-grid{grid-template-columns:1fr 1fr; gap:11px}
  .an-tile{padding:14px}
  .an-tile b{font-size:21px}
  .lq-pad{grid-template-columns:repeat(auto-fill,minmax(64px,1fr)); gap:11px}
  .lq-peb{font-size:19px}
  .lq-peb u{font-size:7.5px; bottom:8px}
  .lq-pill{font-size:11.5px; padding:7px 11px}
  .tk-eta{grid-template-columns:repeat(3,1fr); gap:8px}
  .tk-eta div{padding:10px 6px}
  .tk-eta b{font-size:17px}
  .tk-eta small{font-size:8.5px; letter-spacing:.03em}
  .tk-card{padding:17px}
  .tk-mine{padding:20px 16px}
  .tk-ring{width:132px; height:132px}
  .tk-ring-in b{font-size:38px}
  .adm-top-actions .btn{flex:1; justify-content:center}
  .date-pick{flex:1; min-width:0}
  .date-pick input{min-width:0; width:100%}
}

@media (max-width:400px){
  .container,.container-sm{padding:0 13px}
  .stat-grid,.an-grid{grid-template-columns:1fr}
  .lq-pad{grid-template-columns:repeat(auto-fill,minmax(58px,1fr)); gap:9px}
  .lq-peb{font-size:17px}
  .lq-peb i{width:17px; height:17px; font-size:9px; top:3px; right:3px}
  .lq-peb u{display:none}
  .tk-eta{grid-template-columns:1fr}
  .kv{grid-template-columns:1fr; gap:2px 0}
  .kv dt{margin-top:9px}
  .modal-foot .btn{width:100%; flex:none}
}

/* short screens: landscape phones and split-screen windows */
@media (max-height:640px){
  .modal-body{max-height:none}
}
@media (max-height:560px) and (min-width:601px){
  .adm-side{gap:12px; padding:14px}
  .lq-hero{padding:14px}
}

/* touch: fingers need bigger targets than a pointer, and a hover state must
   never be able to "stick" after a tap */
@media (hover:none) and (pointer:coarse){
  .btn:not(.btn-icon){min-height:44px}
  .btn-sm:not(.btn-icon){min-height:38px}
  .lq-toggle{min-height:42px}
  .chip{min-height:36px}
  .lq-cap{padding:6px 8px; font-size:11px}
  .lq-peb:hover{transform:none}
  .lq-peb:hover::after{animation:none; opacity:0}
  .lq-peb:active{transform:scale(.94)}
  .lq-peb:active::after{opacity:1; animation:lqGlint .9s var(--ease)}
  .stat:hover,.an-tile:hover,.tk-mini:hover{transform:none; box-shadow:var(--sh1)}
}

@media print{
  .adm-side,.adm-top,.nav,.ft,.lq-bar,.row-actions,.toast-wrap{display:none !important}
  .adm{grid-template-columns:1fr}
  .adm-body{padding:0}
  .lq-peb{box-shadow:none; border:1px solid #999; color:#000; background:#fff}
  .lq-peb::before,.lq-peb::after{display:none}
}
`;

let stylesInjected = false;

function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return;

  /* Vite's starter index.html ships the viewport tag, but if it was ever edited
     out, NOTHING below would scale on a phone - it would render desktop-wide
     and zoomed out. Guaranteeing it here makes responsiveness independent of
     that file, which keeps this a two-file project. */
  let viewport = document.querySelector('meta[name="viewport"]');
  if (!viewport) {
    viewport = document.createElement('meta');
    viewport.setAttribute('name', 'viewport');
    document.head.appendChild(viewport);
  }
  viewport.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');

  const existing = document.getElementById('mcf-styles');
  if (existing) existing.remove();
  const tag = document.createElement('style');
  tag.id = 'mcf-styles';
  tag.textContent = CSS_BASE + CSS_SITE + CSS_ADMIN + CSS_QUEUE + CSS_OWNER + CSS_RESP;
  document.head.appendChild(tag);
  stylesInjected = true;
}

injectStyles();

/* ============================================================================
 * ROUTER - hash based on purpose. Pathname routing (the previous approach)
 * 404s on refresh and on deep links unless the dev/prod server is configured
 * for SPA fallback. Hash routes always work, everywhere.
 * ========================================================================== */

function parseHash() {
  const raw = (typeof window !== 'undefined' ? window.location.hash || '' : '').replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  if (!parts.length) return { name: 'home', id: '', query };
  const [head, second] = parts;
  if (head === 'clinic' && second) return { name: 'booking', id: second, query };
  if (head === 'admin') return { name: 'admin', id: second || '', query };
  // #/track and #/queue are the same screen. The optional second segment lets
  // a clinic hand out a direct link to its own live board.
  if (head === 'track' || head === 'queue') return { name: 'track', id: second || '', query };
  // #/owner is the platform owner console - intentionally not linked in the nav.
  if (head === 'owner') return { name: 'owner', id: second || '', query };
  if (['register', 'login', 'forgot'].includes(head)) return { name: head, id: '', query };
  return { name: 'home', id: '', query };
}

function useHashRoute() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash());
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const go = useCallback((to) => {
    const next = '#' + (to.startsWith('/') ? to : '/' + to);
    if (window.location.hash === next) {
      setRoute(parseHash());
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      window.location.hash = next;
    }
  }, []);

  return [route, go];
}

/* ============================================================================
 * PRIMITIVES
 * ========================================================================== */

function Toasts({ items, dismiss }) {
  return (
    <div className="toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={'toast toast-' + t.type} role="status" onClick={() => dismiss(t.id)}>
          <b>
            <Icon name={t.type === 'err' ? 'alert' : t.type === 'info' ? 'spark' : 'check'} size={13} />
          </b>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

function useToasts() {
  const [items, setItems] = useState([]);

  const dismiss = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    (message, type = 'ok') => {
      if (!message) return;
      const id = Date.now() + Math.random();
      setItems((list) => [...list.slice(-2), { id, message, type }]);
      window.setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 4600);
    },
    []
  );

  return { items, notify, dismiss };
}

function Alert({ kind = 'err', children }) {
  if (!children) return null;
  const icon = kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'spark';
  return (
    <div className={'alert alert-' + kind}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </div>
  );
}

function Reveal({ children, delay = 0, className = '' }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0] && entries[0].isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={'reveal ' + (shown ? 'in ' : '') + className} style={{ transitionDelay: delay + 'ms' }}>
      {children}
    </div>
  );
}

function CountUp({ value = 0, duration = 900 }) {
  const target = Number(value) || 0;
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);

  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return undefined;

    const reduce = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

    if (reduce) {
      fromRef.current = target;
      setShown(target);
      return undefined;
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setShown(Math.round(from + (target - from) * eased));
      if (progress < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return <>{shown}</>;
}

function Modal({ title, subtitle, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' modal-wide' : '')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="grow">
            <h3>{title}</h3>
            {subtitle ? <p className="small muted">{subtitle}</p> : null}
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" size={17} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

function Spinner({ dark = false }) {
  return <span className={'spinner' + (dark ? ' spinner-dark' : '')} />;
}

function Loading({ label = 'Loading' }) {
  return (
    <div className="loading-block">
      <Spinner dark />
      <span>{label}...</span>
    </div>
  );
}

function SkeletonCards({ count = 6 }) {
  return (
    <div className="clinic-grid">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="sk sk-card" />
      ))}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    booked: ['badge-booked', 'clock', 'Waiting'],
    visited: ['badge-visited', 'check', 'Visited'],
    cancelled: ['badge-cancelled', 'ban', 'Cancelled'],
  };
  const [cls, icon, label] = map[status] || ['badge-soft', 'clock', status || '-'];
  return (
    <span className={'badge ' + cls}>
      <Icon name={icon} size={12} />
      {label}
    </span>
  );
}

function QuotaBadge({ quota }) {
  const emergency = quota === 'Emergency';
  return (
    <span className={'badge ' + (emergency ? 'badge-emergency' : 'badge-general')}>
      <Icon name={emergency ? 'alert' : 'shield'} size={12} />
      {quota || 'General'}
    </span>
  );
}

function SourceBadge({ source }) {
  const walkIn = source === 'walk-in';
  return <span className={'badge ' + (walkIn ? 'badge-walkin' : 'badge-online')}>{walkIn ? 'Walk-in' : 'Online'}</span>;
}

function Avatar({ clinic, className = 'cc-av' }) {
  return (
    <div className={className}>
      {clinic && clinic.photo ? <img src={clinic.photo} alt="" loading="lazy" /> : initials(clinic ? clinic.clinicName : '')}
    </div>
  );
}

/* ------------------------------------------------------------- chrome UI -- */

function Navbar({ go, active }) {
  const [open, setOpen] = useState(false);
  const clinic = getStoredClinic();

  const jump = (to) => {
    setOpen(false);
    go(to);
  };

  const findClinics = () => {
    setOpen(false);
    if (active !== 'home') {
      go('/');
      window.setTimeout(() => {
        const node = document.getElementById('directory');
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 260);
    } else {
      const node = document.getElementById('directory');
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <header className="nav">
      <div className="container nav-in">
        <button className="brand" onClick={() => jump('/')}>
          <span className="brand-mark">
            <Cross size={19} />
          </span>
          MediCare <i>Flow</i>
        </button>

        <nav className="nav-links">
          <button onClick={findClinics}>Find a clinic</button>
          <button onClick={() => jump('/track')}>Live token queue</button>
          <button onClick={() => jump('/register')}>For clinics</button>
        </nav>

        <div className="nav-actions">
          {clinic ? (
            <button className="btn btn-primary btn-sm" onClick={() => jump('/admin/' + clinic.clinicId)}>
              <Icon name="grid" size={15} /> Dashboard
            </button>
          ) : (
            <>
              <button className="btn btn-outline btn-sm" onClick={() => jump('/login')}>
                Clinic sign in
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => jump('/register')}>
                <Icon name="plus" size={15} /> List your clinic
              </button>
            </>
          )}
          <button className="btn-icon nav-burger" onClick={() => setOpen((v) => !v)} aria-label="Menu">
            <Icon name={open ? 'close' : 'menu'} size={19} />
          </button>
        </div>
      </div>

      {open ? (
        <div className="nav-drop">
          <div className="container">
            <button onClick={findClinics}>Find a clinic</button>
            <button onClick={() => jump('/track')}>Live token queue</button>
            <button onClick={() => jump('/register')}>Register your clinic</button>
            {clinic ? (
              <button onClick={() => jump('/admin/' + clinic.clinicId)}>Open dashboard</button>
            ) : (
              <button onClick={() => jump('/login')}>Clinic sign in</button>
            )}
          </div>
        </div>
      ) : null}
    </header>
  );
}

function Footer({ go }) {
  return (
    <footer className="ft">
      <div className="container">
        <div className="ft-grid">
          <div>
            <button className="brand" onClick={() => go('/')}>
              <span className="brand-mark">
                <Cross size={19} />
              </span>
              MediCare <i>Flow</i>
            </button>
            <p>
              A multi-clinic appointment and queue platform. Patients book in seconds with OTP-verified email, clinics manage
              their own private queue from a dedicated dashboard.
            </p>
          </div>
          <div>
            <h4>Patients</h4>
            <div className="ft-links">
              <button onClick={() => go('/')}>Find a clinic</button>
              <button onClick={() => go('/track')}>Live token queue</button>
            </div>
          </div>
          <div>
            <h4>Clinics</h4>
            <div className="ft-links">
              <button onClick={() => go('/register')}>Register your clinic</button>
              <button onClick={() => go('/login')}>Admin sign in</button>
              <button onClick={() => go('/forgot')}>Forgot password</button>
            </div>
          </div>
        </div>
        <div className="ft-base">
          <span>{BRAND} - built on the MTSS booking engine.</span>
          <span>
            Appointment records auto-clear after 15 days.{' '}
            <button className="btn-link" onClick={() => go('/owner')}>
              Master admin
            </button>
          </span>
        </div>
      </div>
    </footer>
  );
}

/* ============================================================================
 * HOME - public clinic directory
 * ========================================================================== */

function ClinicCard({ clinic, go, delay }) {
  const queue = clinic.todayQueue || { booked: 0, visited: 0, waiting: 0 };

  return (
    <Reveal delay={delay}>
      <article className="cc">
        <div className="cc-top">
          <Avatar clinic={clinic} />
          <div className="cc-head">
            <h3 title={clinic.clinicName}>{clinic.clinicName}</h3>
            <p title={clinic.doctorName}>{clinic.doctorName}</p>
          </div>
        </div>

        <div className="cc-tags">
          <span className="badge badge-general">
            <Icon name="stetho" size={12} /> {clinic.specialization || 'General Physician'}
          </span>
          <span className="badge badge-soft">
            <span className="live-dot" /> Live queue
          </span>
        </div>

        <div className="cc-meta">
          <div>
            <Icon name="pin" size={15} />
            <span>{[clinic.address, clinic.city].filter(Boolean).join(', ')}</span>
          </div>
          {clinic.timings ? (
            <div>
              <Icon name="clock" size={15} />
              <span>{clinic.timings}</span>
            </div>
          ) : null}
          {clinic.phone ? (
            <div>
              <Icon name="phone" size={15} />
              <span>{clinic.phone}</span>
            </div>
          ) : null}
        </div>

        <div className="cc-q">
          <div>
            <b>{queue.booked}</b>
            <span>TODAY</span>
          </div>
          <div>
            <b>{queue.waiting}</b>
            <span>WAITING</span>
          </div>
          <div>
            <b>{queue.visited}</b>
            <span>SEEN</span>
          </div>
        </div>

        <div className="cc-foot">
          <button className="btn btn-primary grow" onClick={() => go('/clinic/' + clinic.clinicId)}>
            Book appointment <Icon name="right" size={16} />
          </button>
        </div>
      </article>
    </Reveal>
  );
}

function HomePage({ go }) {
  const [clinics, setClinics] = useState([]);
  const [specs, setSpecs] = useState([]);
  const [spec, setSpec] = useState('All');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api('/clinics/specializations').then((data) => {
      if (alive && data.success) setSpecs(data.specializations || []);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (spec !== 'All') params.set('specialization', spec);
      const query = params.toString();
      const data = await api('/clinics' + (query ? '?' + query : ''));
      if (!alive) return;
      if (data.success) {
        setClinics(data.clinics || []);
        setError('');
      } else {
        setClinics([]);
        setError(data.message);
      }
      setLoading(false);
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [search, spec]);

  const totals = useMemo(() => {
    let today = 0;
    let waiting = 0;
    for (const clinic of clinics) {
      const queue = clinic.todayQueue || {};
      today += queue.booked || 0;
      waiting += queue.waiting || 0;
    }
    return { today, waiting };
  }, [clinics]);

  const toDirectory = () => {
    const node = document.getElementById('directory');
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="pg">
      {/* -------------------------------------------------------------- hero */}
      <section className="hero">
        <div className="hero-orb a" />
        <div className="hero-orb b" />
        <div className="hero-orb c" />
        <div className="hero-grid-lines" />
        <div className="container hero-in">
          <div className="hero-copy">
            <span className="eyebrow eyebrow-light">
              <span className="live-dot" /> Care without the waiting room
            </span>
            <h1>
              Healthcare queues that <em>actually flow.</em>
            </h1>
            <p className="lead">
              Find a trusted clinic near you, verify with a single email OTP, and walk in knowing your exact token number.
              No accounts, no phone calls, no guessing.
            </p>
            <div className="hero-cta">
              <button className="btn btn-white btn-lg" onClick={toDirectory}>
                Find a clinic <Icon name="right" size={17} />
              </button>
              <button className="btn btn-lg btn-soft" onClick={() => go('/register')}>
                <Icon name="building" size={17} /> List your clinic
              </button>
            </div>
            <div className="hero-stats">
              <div>
                <b>
                  <CountUp value={clinics.length} />
                </b>
                <span>Clinics listed</span>
              </div>
              <div>
                <b>
                  <CountUp value={totals.today} />
                </b>
                <span>Appointments today</span>
              </div>
              <div>
                <b>6 days</b>
                <span>Booking window</span>
              </div>
              <div>
                <b>15 days</b>
                <span>Data retention</span>
              </div>
            </div>
          </div>

          <div className="hero-panel">
            <div className="hero-panel-head">
              <span>Your next appointment</span>
              <span className="badge badge-visited">
                <Icon name="check" size={12} /> Confirmed
              </span>
            </div>
            <div className="hero-token">
              <small>Queue token</small>
              <b>07</b>
              <p>{fmtLongDate(todayISO())}</p>
            </div>
            <div className="hero-rows">
              <div className="hero-row">
                <span>Now serving</span>
                <b>Token 04</b>
              </div>
              <div className="hero-row">
                <span>Estimated wait</span>
                <b>~18 min</b>
              </div>
              <div className="hero-row">
                <span>Verification</span>
                <b>Email OTP</b>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- features */}
      <section className="section">
        <div className="container">
          <div className="sec-head">
            <div>
              <span className="eyebrow">
                <Icon name="spark" size={13} /> Why MediCare Flow
              </span>
              <h2>Built for real waiting rooms</h2>
              <p className="lead">
                Every clinic gets its own isolated booking page, queue counter and dashboard. Patients get a token number
                before they leave home.
              </p>
            </div>
          </div>

          <div className="feat-grid">
            {[
              ['shield', 'OTP verified bookings', 'Every online appointment is confirmed with a 6-digit code sent to the patient email, so no-shows and prank bookings drop.'],
              ['ticket', 'Sequential daily tokens', 'Token numbers reset per clinic per day and are allocated atomically, so two patients can never receive the same number.'],
              ['alert', 'General and Emergency quota', 'Reception can flag urgent cases at booking time and see the emergency split live on the dashboard.'],
              ['users', 'Walk-ins in the same queue', 'Patients who arrive at the counter get the next token from the same sequence as online bookings.'],
              ['chart', 'Analytics that matter', 'Date-range reporting on visited, waiting and cancelled appointments with a General versus Emergency breakdown.'],
              ['clock', 'Automatic clean-up', 'Appointment records older than 15 days are removed every night, so the database stays lean by itself.'],
            ].map(([icon, title, body], index) => (
              <Reveal key={title} delay={index * 70}>
                <div className="feat">
                  <div className="feat-ico">
                    <Icon name={icon} size={22} />
                  </div>
                  <h4>{title}</h4>
                  <p>{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- directory */}
      <section className="section-tight" id="directory">
        <div className="container">
          <div className="sec-head">
            <div>
              <span className="eyebrow">
                <Icon name="pin" size={13} /> Clinic directory
              </span>
              <h2>Care near you</h2>
              <p className="lead">Pick a clinic and reserve your place in its queue for today or the next five days.</p>
            </div>
            <div className="dir-tools">
              <div className="input-icon">
                <Icon name="search" size={17} />
                <input
                  className="input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search clinic, doctor, specialty or city"
                  aria-label="Search clinics"
                />
              </div>
            </div>
          </div>

          {specs.length ? (
            <div className="chips">
              {['All', ...specs].map((item) => (
                <button key={item} className={'chip' + (spec === item ? ' on' : '')} onClick={() => setSpec(item)}>
                  {item}
                </button>
              ))}
            </div>
          ) : null}

          {error ? (
            <div style={{ marginBottom: 18 }}>
              <Alert kind="err">{error}</Alert>
            </div>
          ) : null}

          {loading ? (
            <SkeletonCards count={6} />
          ) : clinics.length ? (
            <div className="clinic-grid">
              {clinics.map((clinic, index) => (
                <ClinicCard key={clinic.clinicId} clinic={clinic} go={go} delay={Math.min(index, 5) * 60} />
              ))}
            </div>
          ) : (
            <div className="panel empty">
              <div className="empty-ico">
                <Icon name="building" size={26} />
              </div>
              <h3>No clinics found</h3>
              <p>
                {search || spec !== 'All'
                  ? 'Nothing matches that search yet. Try a different name, specialty or city.'
                  : 'No clinic has registered yet. Be the first to list a clinic on MediCare Flow.'}
              </p>
              <div className="row" style={{ justifyContent: 'center' }}>
                {search || spec !== 'All' ? (
                  <button
                    className="btn btn-outline"
                    onClick={() => {
                      setSearch('');
                      setSpec('All');
                    }}
                  >
                    <Icon name="refresh" size={16} /> Clear filters
                  </button>
                ) : null}
                <button className="btn btn-primary" onClick={() => go('/register')}>
                  <Icon name="plus" size={16} /> Register your clinic
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="section">
        <div className="container">
          <div className="sec-head">
            <div>
              <span className="eyebrow">
                <Icon name="activity" size={13} /> How it works
              </span>
              <h2>Three steps, under a minute</h2>
            </div>
          </div>
          <div className="steps-strip">
            {[
              ['Fill in your details', 'Choose General or Emergency quota, pick a date within the next six days and enter patient details.'],
              ['Verify your email', 'A 6-digit OTP lands in your inbox. Enter it to lock the appointment in.'],
              ['Get your token', 'Your queue number and booking ID appear instantly and are emailed to you as a receipt.'],
            ].map(([title, body], index) => (
              <Reveal key={title} delay={index * 90}>
                <div className="step-item">
                  <div className="step-num">{index + 1}</div>
                  <h4>{title}</h4>
                  <p>{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- clinic CTA */}
      <section className="section-tight">
        <div className="container">
          <div className="bp-banner" style={{ marginBottom: 0 }}>
            <div className="hero-orb a" />
            <div className="hero-orb b" />
            <div className="bp-id">
              <span className="eyebrow eyebrow-light">For clinics and doctors</span>
              <h1 style={{ fontSize: 'clamp(22px,3vw,30px)' }}>Run your whole queue from one dashboard.</h1>
              <p>
                Register in a minute, choose your own admin user ID and password, and get a public booking page plus a private
                dashboard with stats, analytics and walk-in entry.
              </p>
            </div>
            <div className="bp-live">
              <button className="btn btn-white btn-lg" onClick={() => go('/register')}>
                Register clinic <Icon name="right" size={17} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ============================================================================
 * AUTH - register / login / forgot + reset
 * ========================================================================== */

/* ============================================================================
 * BOOKING - the MTSS stepper (Details -> Verify OTP -> Confirmed),
 * parameterised only by clinicId.
 *
 * FIX IN THIS REVISION: this entire block was missing from the previous build.
 * App() rendered <BookingPage /> and WalkInModal rendered <PatientFields />,
 * so opening #/clinic/<id> threw "BookingPage is not defined", React unmounted
 * the whole tree, and the browser showed a blank white page.
 * ========================================================================== */

const QUOTAS = [
  { value: 'General', title: 'General Quota', note: 'Standard consultation queue', em: false },
  { value: 'Emergency', title: 'Emergency Quota', note: 'Urgent - flagged for the doctor', em: true },
];

const GENDERS = ['Male', 'Female', 'Other'];

function PatientFields({ form, set, dates = [], walkIn = false }) {
  return (
    <>
      <div className="field">
        <label>
          Appointment Quota <span className="req">*</span>
        </label>
        <div className="quota-grid">
          {QUOTAS.map((item) => (
            <button
              type="button"
              key={item.value}
              className={'quota' + (item.em ? ' em' : '') + (form.quota === item.value ? ' on' : '')}
              onClick={() => set('quota', item.value)}
              aria-pressed={form.quota === item.value}
            >
              <span className="quota-mark">
                <i />
              </span>
              <b>{item.title}</b>
              <span>{item.note}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>
          Full Name of Patient <span className="req">*</span>
        </label>
        <input
          className="input"
          required
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Enter the patient's full name"
          autoComplete="name"
        />
      </div>

      <div className="grid2">
        <div className="field">
          <label>
            Gender <span className="req">*</span>
          </label>
          <select className="select" required value={form.gender} onChange={(e) => set('gender', e.target.value)}>
            <option value="">Select gender</option>
            {GENDERS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            Age (Years) <span className="req">*</span>
          </label>
          <input
            className="input"
            required
            inputMode="numeric"
            value={form.age}
            onChange={(e) => set('age', e.target.value.replace(/\D/g, '').slice(0, 3))}
            placeholder="1 - 120"
          />
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label>
            Weight (kg) <span className="req">*</span>
          </label>
          <input
            className="input"
            required
            inputMode="decimal"
            value={form.weight}
            onChange={(e) => set('weight', e.target.value.replace(/[^0-9.]/g, '').slice(0, 6))}
            placeholder="e.g. 62"
          />
        </div>
        <div className="field">
          <label>
            Appointment Date <span className="req">*</span>
          </label>
          {walkIn ? (
            <>
              <input className="input" value={fmtLongDate(todayISO())} disabled readOnly />
              <span className="hint">Walk-in patients always join today's queue.</span>
            </>
          ) : (
            <select className="select" required value={form.date} onChange={(e) => set('date', e.target.value)}>
              {dates.length ? null : <option value="">Loading dates...</option>}
              {dates.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="grid2">
        <div className="field">
          <label>
            Mobile Number <span className="req">*</span>
          </label>
          <input
            className={'input' + (form.mobile && form.mobile.length !== 10 ? ' bad' : '')}
            required
            inputMode="numeric"
            value={form.mobile}
            onChange={(e) => set('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))}
            placeholder="10-digit mobile number"
            autoComplete="tel"
          />
          <span className="hint">{(form.mobile || '').length}/10 digits</span>
        </div>
        <div className="field">
          <label>
            Email Address {walkIn ? <span className="hint">(optional)</span> : <span className="req">*</span>}
          </label>
          <input
            className="input"
            required={!walkIn}
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            placeholder="name@example.com"
            autoComplete="email"
          />
          <span className="hint">{walkIn ? 'Add it to email the token receipt.' : 'Your OTP and token are sent here.'}</span>
        </div>
      </div>

      <div className="field">
        <label>
          Address <span className="req">*</span>
        </label>
        <textarea
          className="textarea"
          required
          rows="3"
          value={form.address}
          onChange={(e) => set('address', e.target.value)}
          placeholder="House / street, area, city"
        />
      </div>
    </>
  );
}

/* Six single-character boxes with auto-advance, backspace, arrows and paste. */
function OtpBoxes({ value, onChange, disabled = false }) {
  const refs = useRef([]);
  const chars = [0, 1, 2, 3, 4, 5].map((index) => String(value || '')[index] || '');

  const focusBox = (index) => {
    const el = refs.current[index];
    if (el) el.focus();
  };

  const handleChange = (index, raw) => {
    const digit = raw.replace(/\D/g, '').slice(-1);
    const next = chars.slice();
    next[index] = digit;
    onChange(next.join('').slice(0, 6));
    if (digit && index < 5) focusBox(index + 1);
  };

  const handleKeyDown = (index, event) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const next = chars.slice();
      if (next[index]) {
        next[index] = '';
        onChange(next.join(''));
        return;
      }
      if (index > 0) {
        next[index - 1] = '';
        onChange(next.join(''));
        focusBox(index - 1);
      }
      return;
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusBox(index - 1);
    }
    if (event.key === 'ArrowRight' && index < 5) {
      event.preventDefault();
      focusBox(index + 1);
    }
  };

  const handlePaste = (event) => {
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    const digits = String(text || '').replace(/\D/g, '').slice(0, 6);
    if (!digits) return;
    event.preventDefault();
    onChange(digits);
    focusBox(Math.min(digits.length, 5));
  };

  return (
    <div className="otp-boxes" onPaste={handlePaste}>
      {chars.map((char, index) => (
        <input
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
          className={'otp-box' + (char ? ' filled' : '')}
          value={char}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          disabled={disabled}
          autoFocus={index === 0}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          aria-label={'OTP digit ' + (index + 1)}
        />
      ))}
    </div>
  );
}

function BookingPage({ clinicId, go, notify }) {
  const [clinic, setClinic] = useState(null);
  const [dates, setDates] = useState([]);
  const [fatal, setFatal] = useState('');
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(EMPTY_FORM);
  const [otp, setOtp] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(0);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    let alive = true;
    setFatal('');
    setClinic(null);
    (async () => {
      const data = await api('/clinics/' + encodeURIComponent(clinicId));
      if (!alive) return;
      if (!data.success) {
        setFatal(data.message || 'This clinic could not be loaded.');
        return;
      }
      const list = Array.isArray(data.dates) ? data.dates : [];
      setClinic(data.clinic);
      setDates(list);
      setForm((current) => ({
        ...current,
        date: current.date || (list.length ? list[0].value : data.today || todayISO()),
      }));
    })();
    return () => {
      alive = false;
    };
  }, [clinicId]);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  const sendOtp = async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/booking/send-otp', { method: 'POST', body: { clinicId, form } });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    setOtp('');
    setStep(2);
    setResendIn(60);
    notify(data.message || 'OTP sent to your email.', 'ok');
  };

  const verify = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/booking/verify', { method: 'POST', body: { clinicId, email: form.email, otp } });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    setResult(data.appointment);
    setStep(3);
    notify('Appointment confirmed. Token #' + data.appointment.bookingNumber + '.', 'ok');
  };

  const bookAnother = () => {
    setResult(null);
    setOtp('');
    setError('');
    setForm({ ...EMPTY_FORM, date: dates.length ? dates[0].value : todayISO() });
    setStep(1);
  };

  if (fatal) {
    return (
      <div className="bp container pg">
        <button className="crumb" onClick={() => go('/')}>
          <Icon name="left" size={15} /> All clinics
        </button>
        <div className="panel">
          <div className="panel-head">
            <h3>Clinic unavailable</h3>
          </div>
          <div className="panel-body">
            <Alert kind="err">{fatal}</Alert>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn btn-primary" onClick={() => go('/')}>
                <Icon name="grid" size={15} /> Browse clinics
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!clinic) return <Loading label="Loading clinic" />;

  const queue = clinic.todayQueue || { booked: 0, visited: 0, waiting: 0, nextToken: null };
  const firstName = String((result && result.name) || '').split(' ')[0];
  const stepNotes = ['Patient details and date', 'Code sent to your email', 'Token number issued'];

  return (
    <div className="bp container pg">
      <button className="crumb" onClick={() => go('/')}>
        <Icon name="left" size={15} /> All clinics
      </button>

      <section className="bp-banner">
        <div className="hero-orb a" />
        <div className="hero-orb b" />
        <Avatar clinic={clinic} className="bp-av" />
        <div className="bp-id">
          <span className="badge badge-soft">{clinic.specialization}</span>
          <h1>{clinic.clinicName}</h1>
          <p>
            <Icon name="stetho" size={15} />
            <span>
              {clinic.doctorName}
              {clinic.address ? ' - ' + [clinic.address, clinic.city].filter(Boolean).join(', ') : ''}
            </span>
          </p>
        </div>
        <div className="bp-live">
          <div>
            <b>{queue.booked || 0}</b>
            <span>Booked</span>
          </div>
          <div>
            <b>{queue.waiting || 0}</b>
            <span>Waiting</span>
          </div>
          <div>
            <b>{queue.nextToken ? '#' + queue.nextToken : '-'}</b>
            <span>Next token</span>
          </div>
        </div>
      </section>

      <div className="bp-layout">
        <aside className="bp-aside">
          <div>
            <span className="eyebrow">
              <Icon name="calendar" size={13} /> Appointment booking
            </span>
            <h2>Reserve your place in today's queue.</h2>
            <p className="lead">
              Book for today or any of the next 5 days. Your token number is issued the moment your email is verified.
            </p>
          </div>

          <div className="steps">
            {STEPS.map((label, index) => {
              const num = index + 1;
              const state = step > num ? ' done' : step === num ? ' on' : '';
              return (
                <div className={'step-row' + state} key={label}>
                  <div className="step-dot">{step > num ? <Icon name="check" size={15} /> : num}</div>
                  <div className="step-txt">
                    <b>{label}</b>
                    <span>{stepNotes[index]}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="trust">
            <div>
              <Icon name="shield" size={16} />
              <span>Every booking is verified with a one-time code sent to your email.</span>
            </div>
            <div>
              <Icon name="ticket" size={16} />
              <span>Tokens are sequential per clinic per day, so your position is fixed.</span>
            </div>
            <div>
              <Icon name="clock" size={16} />
              <span>Records are kept for 15 days and then removed automatically.</span>
            </div>
            {clinic.timings ? (
              <div>
                <Icon name="activity" size={16} />
                <span>{clinic.timings}</span>
              </div>
            ) : null}
          </div>
        </aside>

        <section>
          {step === 1 ? (
            <form className="form-card" onSubmit={sendOtp} noValidate>
              <span className="eyebrow">
                <Icon name="user" size={13} /> Step 1 of 3
              </span>
              <h2>Patient details</h2>
              <p className="lead">Enter the details exactly as they should appear on the clinic's queue list.</p>

              <div className="form-grid">
                <PatientFields form={form} set={set} dates={dates} />
              </div>

              {error ? (
                <div style={{ marginTop: 16 }}>
                  <Alert kind="err">{error}</Alert>
                </div>
              ) : null}

              <div style={{ marginTop: 18 }}>
                <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
                  {busy ? (
                    <>
                      <Spinner /> Sending code...
                    </>
                  ) : (
                    <>
                      Send verification code <Icon name="right" size={17} />
                    </>
                  )}
                </button>
              </div>

              <p className="tiny muted center" style={{ marginTop: 12 }}>
                No account needed. Your details are visible only to this clinic.
              </p>
            </form>
          ) : null}

          {step === 2 ? (
            <form className="form-card otp-card" onSubmit={verify} noValidate>
              <div className="otp-ico">
                <Icon name="mail" size={26} />
              </div>
              <span className="eyebrow">Step 2 of 3</span>
              <h2>Check your inbox</h2>
              <p className="lead">
                We sent a 6-digit code to <b>{form.email}</b>. It expires in 10 minutes.
              </p>

              <OtpBoxes value={otp} onChange={setOtp} disabled={busy} />

              <p className="otp-timer">
                {resendIn > 0 ? (
                  <>
                    You can request a new code in <b>{resendIn}s</b>
                  </>
                ) : (
                  'Nothing yet? Check the spam folder, then resend.'
                )}
              </p>

              {error ? (
                <div style={{ marginBottom: 16 }}>
                  <Alert kind="err">{error}</Alert>
                </div>
              ) : null}

              <div className="stack">
                <button className="btn btn-primary btn-lg btn-block" disabled={busy || otp.length !== 6}>
                  {busy ? (
                    <>
                      <Spinner /> Confirming...
                    </>
                  ) : (
                    <>
                      Verify and confirm booking <Icon name="check" size={17} />
                    </>
                  )}
                </button>
                <button type="button" className="btn btn-ghost" disabled={busy || resendIn > 0} onClick={() => sendOtp()}>
                  <Icon name="refresh" size={15} /> Resend code
                </button>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setError('');
                    setStep(1);
                  }}
                >
                  <Icon name="left" size={14} /> Edit booking details
                </button>
              </div>
            </form>
          ) : null}

          {step === 3 && result ? (
            <div className="form-card done-card">
              <div className="done-ring">
                <Icon name="check" size={40} />
              </div>
              <span className="eyebrow">Step 3 of 3 - confirmed</span>
              <h2>You are all set{firstName ? ', ' + firstName : ''}.</h2>
              <p className="lead">A confirmation with your token number has been emailed to {result.email}.</p>

              <div className="token-box">
                <small>Your queue token</small>
                <b>#{result.bookingNumber}</b>
                <p>{result.longDate || fmtLongDate(result.date)}</p>
              </div>

              <div className="recap">
                <div>
                  <span>Booking ID</span>
                  <b className="mono">{result.bookingId}</b>
                </div>
                <div>
                  <span>Patient</span>
                  <b>{result.name}</b>
                </div>
                <div>
                  <span>Quota</span>
                  <b>{result.quota}</b>
                </div>
                <div>
                  <span>Clinic</span>
                  <b>{clinic.clinicName}</b>
                </div>
              </div>

              <div className="stack" style={{ marginTop: 22 }}>
                <button className="btn btn-primary btn-block" onClick={bookAnother}>
                  <Icon name="plus" size={15} /> Book another appointment
                </button>
                <button className="btn btn-ghost" onClick={() => go('/track')}>
                  Track this booking later <Icon name="right" size={15} />
                </button>
                <button className="btn-link" onClick={() => go('/')}>
                  Back to all clinics
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/* ============================================================================
 * ERROR BOUNDARY - a render error now shows a readable card instead of the
 * blank white page React produces when it unmounts a crashed tree.
 * ========================================================================== */

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[MediCare Flow] render error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
    return (
      <div className="container" style={{ padding: '60px 0' }}>
        <div className="panel">
          <div className="panel-head">
            <h3>This screen hit a rendering error</h3>
          </div>
          <div className="panel-body">
            <Alert kind="err">{message}</Alert>
            <p className="small muted" style={{ marginTop: 14 }}>
              The full stack trace is in the browser console. Nothing was lost - reload or go back to the home page.
            </p>
            <div className="row" style={{ marginTop: 16 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  window.location.hash = '#/';
                  window.location.reload();
                }}
              >
                <Icon name="left" size={15} /> Back to home
              </button>
              <button className="btn btn-ghost" onClick={() => window.location.reload()}>
                <Icon name="refresh" size={15} /> Reload page
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

function AuthShell({ children, go, mode }) {
  const copy = {
    register: ['Put your clinic on the map', 'Registration takes a minute. You choose your own admin user ID and password - there is no shared secret.'],
    login: ['Welcome back', 'Sign in to manage today\'s queue, add walk-ins and review your analytics.'],
    forgot: ['Reset your password', 'We email a 6-digit code to the admin address on file, then you choose a new password.'],
  }[mode];

  return (
    <div className="auth pg">
      <aside className="auth-side">
        <div className="hero-orb a" />
        <div className="hero-orb b" />
        <button className="brand" onClick={() => go('/')}>
          <span className="brand-mark">
            <Cross size={19} />
          </span>
          MediCare <i>Flow</i>
        </button>

        <div className="auth-body">
          <span className="eyebrow eyebrow-light">MediCare Flow for clinics</span>
          <h2>
            {copy[0].split(' ').slice(0, -1).join(' ')} <em>{copy[0].split(' ').slice(-1)}</em>
          </h2>
          <p>{copy[1]}</p>

          <div className="auth-pts">
            {[
              'Your own public booking page with live queue counts',
              'Sequential daily tokens per clinic, allocated atomically',
              'Walk-in entry that shares the same token sequence',
              'Emergency quota flagging and date-range analytics',
              'Strict data isolation - no clinic sees another clinic\'s data',
            ].map((point) => (
              <div className="auth-pt" key={point}>
                <Icon name="check" size={16} />
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="auth-body small" style={{ color: 'rgba(226,242,240,.6)' }}>
          Powered by the original MTSS booking engine.
        </div>
      </aside>

      <main className="auth-main">
        <div style={{ width: '100%', maxWidth: 520 }}>
          <button className="crumb" onClick={() => go('/')}>
            <Icon name="left" size={15} /> Back to home
          </button>
          {children}
        </div>
      </main>
    </div>
  );
}

function RegisterPage({ go, notify, onSession }) {
  const [form, setForm] = useState({
    clinicName: '',
    doctorName: '',
    specialization: 'General Physician',
    address: '',
    city: '',
    phone: '',
    photo: '',
    timings: '',
    about: '',
    adminUserId: '',
    adminEmail: '',
    password: '',
    confirm: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState('form');
  const [otp, setOtp] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [resendIn, setResendIn] = useState(0);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  /* Step 1 - the server validates everything and emails a 6-digit code.
     Nothing is written to MongoDB until that code is verified. */
  const sendCode = async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    if (form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    const { confirm, ...payload } = form;
    const data = await api('/auth/register/send-otp', { method: 'POST', body: payload });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    setOtp('');
    setSentTo(data.sentTo || form.adminEmail);
    setStage('otp');
    setResendIn(60);
    notify(data.message || 'Verification code sent.', 'ok');
  };

  /* Step 2 - verifying the code is what actually creates the clinic. */
  const verifyCode = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/auth/register/verify', {
      method: 'POST',
      body: { adminUserId: form.adminUserId, otp },
    });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    onSession(data.token, data.clinic);
    notify(data.message || 'Clinic registered successfully.', 'ok');
    go('/admin/' + data.clinic.clinicId);
  };

  if (stage === 'otp') {
    return (
      <AuthShell go={go} mode="register">
        <form className="auth-card otp-card" onSubmit={verifyCode} noValidate>
          <div className="otp-ico">
            <Icon name="mail" size={26} />
          </div>
          <span className="eyebrow">Step 2 of 2 - verify email</span>
          <h2>Confirm your email</h2>
          <p className="lead">
            We sent a 6-digit code to <b>{sentTo}</b>. Enter it to finish creating <b>{form.clinicName}</b>. The code expires in
            10 minutes.
          </p>

          <OtpBoxes value={otp} onChange={setOtp} disabled={busy} />

          <p className="otp-timer">
            {resendIn > 0 ? (
              <>
                You can request a new code in <b>{resendIn}s</b>
              </>
            ) : (
              'Nothing yet? Check the spam folder, then resend.'
            )}
          </p>

          {error ? (
            <div style={{ marginBottom: 16 }}>
              <Alert kind="err">{error}</Alert>
            </div>
          ) : null}

          <div className="stack">
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || otp.length !== 6}>
              {busy ? (
                <>
                  <Spinner /> Creating your clinic...
                </>
              ) : (
                <>
                  Verify and create account <Icon name="check" size={17} />
                </>
              )}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy || resendIn > 0} onClick={() => sendCode()}>
              <Icon name="refresh" size={15} /> Resend code
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setError('');
                setStage('form');
              }}
            >
              <Icon name="left" size={14} /> Edit clinic details
            </button>
          </div>

          <div className="auth-foot">
            <span>Wrong address?</span>
            <span className="small muted">Go back, correct the admin email, and we will send a fresh code.</span>
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell go={go} mode="register">
      <form className="auth-card" onSubmit={sendCode} noValidate>
        <span className="eyebrow">
          <Icon name="building" size={13} /> Step 1 of 2 - clinic details
        </span>
        <h2>Register your clinic</h2>
        <p className="lead">
          We email a 6-digit code to your admin address to confirm it is yours. After verification your clinic is listed
          publicly and your dashboard opens immediately.
        </p>

        <div className="form-grid">
          <div className="field">
            <label>
              Clinic name <span className="req">*</span>
            </label>
            <input className="input" required value={form.clinicName} onChange={(e) => set('clinicName', e.target.value)} placeholder="e.g. Maa Tripura Sundari Seva Sadan" />
          </div>

          <div className="grid2">
            <div className="field">
              <label>
                Doctor name <span className="req">*</span>
              </label>
              <input className="input" required value={form.doctorName} onChange={(e) => set('doctorName', e.target.value)} placeholder="Dr. C S Gupta (MBBS)" />
            </div>
            <div className="field">
              <label>
                Specialization <span className="req">*</span>
              </label>
              <select className="select" required value={form.specialization} onChange={(e) => set('specialization', e.target.value)}>
                {SPECIALIZATIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label>
              Clinic address <span className="req">*</span>
            </label>
            <textarea className="textarea" required rows="2" value={form.address} onChange={(e) => set('address', e.target.value)} placeholder="Street, area, landmark" />
          </div>

          <div className="grid2">
            <div className="field">
              <label>City</label>
              <input className="input" value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="e.g. Ballia" />
            </div>
            <div className="field">
              <label>
                Clinic phone <span className="req">*</span>
              </label>
              <input
                className="input"
                required
                inputMode="numeric"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value.replace(/\D/g, '').slice(0, 10))}
                placeholder="10-digit number"
              />
            </div>
          </div>

          <div className="grid2">
            <div className="field">
              <label>Opening hours</label>
              <input className="input" value={form.timings} onChange={(e) => set('timings', e.target.value)} placeholder="Mon-Sat, 9 AM - 6 PM" />
            </div>
            <div className="field">
              <label>Photo URL</label>
              <input className="input" value={form.photo} onChange={(e) => set('photo', e.target.value)} placeholder="https://..." />
            </div>
          </div>

          <div className="divider">Admin login</div>

          <div className="grid2">
            <div className="field">
              <label>
                Admin user ID <span className="req">*</span>
              </label>
              <input
                className="input"
                required
                value={form.adminUserId}
                onChange={(e) => set('adminUserId', e.target.value.replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 24))}
                placeholder="mtss.admin"
                autoComplete="username"
              />
              <span className="hint">4-24 characters: letters, numbers, dot or underscore.</span>
            </div>
            <div className="field">
              <label>
                Admin email <span className="req">*</span>
              </label>
              <input className="input" required type="email" value={form.adminEmail} onChange={(e) => set('adminEmail', e.target.value)} placeholder="clinic@example.com" />
              <span className="hint">Verified with a code now, and used for password resets.</span>
            </div>
          </div>

          <div className="grid2">
            <div className="field">
              <label>
                Password <span className="req">*</span>
              </label>
              <input
                className="input"
                required
                type="password"
                minLength="6"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                autoComplete="new-password"
                placeholder="At least 6 characters"
              />
            </div>
            <div className="field">
              <label>
                Confirm password <span className="req">*</span>
              </label>
              <input
                className={'input' + (form.confirm && form.confirm !== form.password ? ' bad' : '')}
                required
                type="password"
                value={form.confirm}
                onChange={(e) => set('confirm', e.target.value)}
                autoComplete="new-password"
                placeholder="Repeat password"
              />
            </div>
          </div>
        </div>

        {error ? (
          <div style={{ marginTop: 16 }}>
            <Alert kind="err">{error}</Alert>
          </div>
        ) : null}

        <div style={{ marginTop: 18 }}>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Sending verification code...
              </>
            ) : (
              <>
                Email me a verification code <Icon name="right" size={17} />
              </>
            )}
          </button>
        </div>

        <div className="auth-foot">
          <span>Already registered?</span>
          <button type="button" className="btn-link" onClick={() => go('/login')}>
            Sign in instead <Icon name="right" size={14} />
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

function LoginPage({ go, notify, onSession }) {
  const [form, setForm] = useState({ adminUserId: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/auth/login', { method: 'POST', body: form });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    onSession(data.token, data.clinic);
    notify(data.message, 'ok');
    go('/admin/' + data.clinic.clinicId);
  };

  return (
    <AuthShell go={go} mode="login">
      <form className="auth-card" onSubmit={submit} noValidate>
        <span className="eyebrow">
          <Icon name="shield" size={13} /> Clinic admin
        </span>
        <h2>Sign in to your dashboard</h2>
        <p className="lead">Use the admin user ID and password you chose during registration.</p>

        <div className="form-grid">
          <div className="field">
            <label>Admin user ID</label>
            <div className="input-icon">
              <Icon name="user" size={17} />
              <input
                className="input"
                required
                value={form.adminUserId}
                onChange={(e) => setForm({ ...form, adminUserId: e.target.value })}
                placeholder="your.user.id"
                autoComplete="username"
              />
            </div>
          </div>
          <div className="field">
            <label>Password</label>
            <div className="input-icon">
              <Icon name="shield" size={17} />
              <input
                className="input"
                required
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="Your password"
                autoComplete="current-password"
              />
            </div>
          </div>
        </div>

        {error ? (
          <div style={{ marginTop: 16 }}>
            <Alert kind="err">{error}</Alert>
          </div>
        ) : null}

        <div style={{ marginTop: 18 }}>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Signing in...
              </>
            ) : (
              <>
                Sign in <Icon name="right" size={17} />
              </>
            )}
          </button>
        </div>

        <div className="auth-foot">
          <button type="button" className="btn-link" onClick={() => go('/forgot')}>
            Forgot password?
          </button>
          <button type="button" className="btn-link" onClick={() => go('/register')}>
            Register a clinic <Icon name="right" size={14} />
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

function ForgotPage({ go, notify, onSession }) {
  const [stage, setStage] = useState('request');
  const [form, setForm] = useState({ identifier: '', code: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [resendIn, setResendIn] = useState(0);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  /* The identifier is the admin user ID OR the registered admin email. Typing
     the email used to return a fake success and send nothing - that is fixed. */
  const request = async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/auth/forgot-password', { method: 'POST', body: { identifier: form.identifier } });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    setSentTo(data.sentTo || '');
    setResendIn(45);
    notify(data.message, 'ok');
    setStage('reset');
  };

  const reset = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/auth/reset-password', {
      method: 'POST',
      body: { identifier: form.identifier, code: form.code, password: form.password },
    });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    onSession(data.token, data.clinic);
    notify(data.message, 'ok');
    go('/admin/' + data.clinic.clinicId);
  };

  return (
    <AuthShell go={go} mode="forgot">
      <form className="auth-card" onSubmit={stage === 'request' ? request : reset} noValidate>
        <span className="eyebrow">
          <Icon name="mail" size={13} /> Step {stage === 'request' ? '1' : '2'} of 2
        </span>
        <h2>{stage === 'request' ? 'Request a reset code' : 'Choose a new password'}</h2>
        <p className="lead">
          {stage === 'request'
            ? 'Enter your admin user ID or the admin email you registered with. A 6-digit code is emailed to that address.'
            : 'Enter the 6-digit code from your email along with a new password. The code expires in 15 minutes.'}
        </p>

        {stage === 'reset' && sentTo ? (
          <Alert kind="info">
            Code sent to <b>{sentTo}</b> - valid for 15 minutes.
          </Alert>
        ) : null}

        <div className="form-grid">
          <div className="field">
            <label>
              Admin user ID or email <span className="req">*</span>
            </label>
            <input
              className="input"
              required
              value={form.identifier}
              onChange={(e) => set('identifier', e.target.value)}
              placeholder="mtss.admin or clinic@example.com"
              autoComplete="username"
            />
          </div>

          {stage === 'reset' ? (
            <>
              <div className="field">
                <label>6-digit reset code</label>
                <input
                  className="input"
                  required
                  inputMode="numeric"
                  value={form.code}
                  onChange={(e) => set('code', e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                />
              </div>
              <div className="field">
                <label>New password</label>
                <input
                  className="input"
                  required
                  type="password"
                  minLength="6"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder="At least 6 characters"
                  autoComplete="new-password"
                />
              </div>
            </>
          ) : null}
        </div>

        {error ? (
          <div style={{ marginTop: 16 }}>
            <Alert kind="err">{error}</Alert>
          </div>
        ) : null}

        <div className="stack" style={{ marginTop: 18 }}>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Please wait...
              </>
            ) : stage === 'request' ? (
              <>
                Email me a code <Icon name="right" size={17} />
              </>
            ) : (
              <>
                Reset password <Icon name="check" size={17} />
              </>
            )}
          </button>
          {stage === 'reset' ? (
            <button type="button" className="btn btn-ghost" onClick={() => setStage('request')}>
              <Icon name="left" size={15} /> Send another code
            </button>
          ) : null}
        </div>

        <div className="auth-foot">
          <span>Remembered it?</span>
          <button type="button" className="btn-link" onClick={() => go('/login')}>
            Back to sign in
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

/* ============================================================================
 * LIVE TOKEN QUEUE TRACKING - no patient accounts, so a booking is found by
 * mobile or booking ID, then followed live against the clinic queue
 * ========================================================================== */

function QueueTrackPage({ clinicId, go }) {
  const [mode, setMode] = useState('mobile');
  const [value, setValue] = useState('');
  const [rows, setRows] = useState(null);
  const [picked, setPicked] = useState(null);
  const [clinics, setClinics] = useState([]);
  const [boardId, setBoardId] = useState(clinicId || '');
  const [board, setBoard] = useState(null);
  const [busy, setBusy] = useState(false);
  const [boardBusy, setBoardBusy] = useState(false);
  const [error, setError] = useState('');
  const [auto, setAuto] = useState(true);
  const [tick, setTick] = useState(Date.now());
  const [beat, setBeat] = useState(0);

  /* A tracked booking wins over a browsed clinic board, and it also pins the
     board to that booking's date so an old token is never compared against
     today's queue. */
  const tClinic = picked ? picked.clinicId : boardId;
  const tDate = picked ? picked.date : '';

  useEffect(() => {
    api('/clinics').then((data) => {
      if (data.success) setClinics(data.clinics || []);
    });
  }, []);

  const loadBoard = useCallback(
    async (silent) => {
      if (!tClinic) return undefined;
      if (!silent) setBoardBusy(true);
      const query = tDate ? '?date=' + encodeURIComponent(tDate) : '';
      const data = await api('/clinics/' + encodeURIComponent(tClinic) + '/live' + query);
      if (!silent) setBoardBusy(false);
      if (!data.success) {
        setError(data.message);
        setBoard(null);
        return undefined;
      }
      setError('');
      setBoard(data);
      setBeat(Date.now());
      return undefined;
    },
    [tClinic, tDate]
  );

  useEffect(() => {
    setBoard(null);
    loadBoard(false);
  }, [loadBoard]);

  /* REALTIME. The clinic pushes a new board the instant a token is called, so
     the patient's screen moves without waiting for any timer. The pushed
     payload is already exactly the public board shape, so it is applied
     DIRECTLY - no refetch round trip, no flicker. */
  const socketLive = useQueueSocket(tClinic, tDate, (payload) => {
    if (!payload || !payload.live) return;
    setBoard((prev) => (prev ? Object.assign({}, prev, { live: payload.live }) : prev));
    setBeat(Date.now());
  });

  /* Polling stays as a safety net for sleeping phones, flaky proxies, and any
     deployment where socket.io is not installed on the backend. */
  useEffect(() => {
    if (!auto || !tClinic) return undefined;
    const id = window.setInterval(() => loadBoard(true), socketLive ? 45000 : 15000);
    return () => window.clearInterval(id);
  }, [auto, tClinic, loadBoard, socketLive]);

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const params = new URLSearchParams();
    params.set(mode, value.trim());
    const data = await api('/lookup?' + params.toString());
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      setRows(null);
      setPicked(null);
      return;
    }
    const list = data.appointments || [];
    setRows(list);
    const today = todayISO();
    setPicked(list.find((row) => row.date === today && row.status !== 'cancelled') || list[0] || null);
  };

  const live = board ? board.live : null;
  const pace = live ? live.paceMinutes || live.defaultPaceMinutes : 8;
  const myToken = picked ? picked.bookingNumber : null;

  /* People genuinely ahead = still-waiting tokens with a lower number. Plain
     subtraction (myToken - currentToken) lies the moment a token is cancelled
     or an emergency case is seen out of order. */
  const ahead =
    live && myToken
      ? live.tokens.filter((row) => row.status === 'booked' && row.bookingNumber < myToken).length
      : 0;
  const etaMin = ahead * pace;
  const etaAt = new Date(tick + etaMin * 60000);
  const agoSec = beat ? Math.max(0, Math.round((tick - beat) / 1000)) : 0;
  const isToday = picked ? picked.date === todayISO() : true;

  const startAhead = myToken ? Math.max(1, myToken - 1) : 1;
  const ringPct = myToken ? Math.max(0, Math.min(100, Math.round(((startAhead - ahead) / startAhead) * 100))) : 0;

  let state = 'wait';
  let stateMsg = '';
  if (picked) {
    if (picked.status === 'cancelled') {
      state = 'void';
      stateMsg = 'This booking was cancelled. Please book a fresh appointment.';
    } else if (picked.status === 'visited') {
      state = 'done';
      stateMsg = 'Token ' + myToken + ' has already been seen by the doctor.';
    } else if (!isToday) {
      state = 'wait';
      stateMsg = 'This token is for ' + picked.dateLabel + '. Live tracking starts on the day of your appointment.';
    } else if (!live || !live.currentToken) {
      state = 'wait';
      stateMsg = 'The doctor has not called the first token yet. This page updates the moment token 1 is called.';
    } else if (ahead === 0) {
      state = 'turn';
      stateMsg = 'You are next. Please wait right outside the consultation room.';
    } else if (ahead <= 2) {
      state = 'soon';
      stateMsg = 'Almost your turn - only ' + ahead + (ahead === 1 ? ' patient is' : ' patients are') + ' ahead of you.';
    } else {
      stateMsg = ahead + ' patients are ahead of you. Keep this page open, it refreshes itself.';
    }
  }

  const pebbleClass = (row) => {
    const bits = ['lq-peb'];
    if (row.status === 'cancelled') bits.push('void');
    else if (row.status === 'visited') bits.push('done');
    else if (row.quota === 'Emergency') bits.push('emg');
    else bits.push('wait');
    if (live && row.bookingNumber === live.currentToken) bits.push('now');
    if (myToken && row.bookingNumber === myToken) bits.push('mine');
    return bits.join(' ');
  };

  const liveHero = live ? (
    <div className="lq-hero">
      <div className="lq-hero-in">
        <div className="lq-dial">
          <div>
            <b>{live.currentToken ? String(live.currentToken).padStart(2, '0') : '--'}</b>
            <small>Now serving</small>
          </div>
        </div>
        <div className="lq-hero-txt">
          <span className="lq-live">
            <span className={'lq-dot' + (auto ? '' : ' off')} />
            {socketLive ? 'Live - realtime' : auto ? 'Live - polling' : 'Paused'}
            {beat ? ' - updated ' + agoSec + 's ago' : ''}
          </span>
          <h2 style={{ marginTop: 8 }}>
            {live.currentToken ? 'Token ' + live.currentToken + ' is with the doctor' : 'Consultations have not started'}
          </h2>
          <p>
            {board.clinic.clinicName}
            {board.clinic.doctorName ? ' - ' + board.clinic.doctorName : ''}
            {live.dateLabel ? ' - ' + live.dateLabel : ''}
          </p>
          <div className="lq-pills">
            <span className="lq-pill">
              <Icon name="right" size={14} /> Up next <b>{live.nextToken ? '#' + live.nextToken : '--'}</b>
            </span>
            <span className="lq-pill">
              <Icon name="clock" size={14} /> Waiting <b>{live.waiting}</b>
            </span>
            <span className="lq-pill">
              <Icon name="check" size={14} /> Seen <b>{live.visited}</b>
            </span>
            <span className="lq-pill">
              <Icon name="activity" size={14} /> Pace <b>{pace} min</b>
            </span>
            <span className="lq-pill">
              <Icon name="ticket" size={14} /> Tokens today <b>{live.maxToken || 0}</b>
            </span>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const strip =
    live && live.tokens.length ? (
      <div className="tk-card">
        <div className="row-between" style={{ marginBottom: 6 }}>
          <div>
            <h3 style={{ fontSize: 16, margin: 0 }}>Whole queue at a glance</h3>
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              Green is done, blue is waiting, red is an emergency case.
              {myToken ? ' Your token has a purple ring.' : ''}
            </p>
          </div>
          <button className={'lq-toggle' + (auto ? ' on' : '')} onClick={() => setAuto((flag) => !flag)}>
            <span className={'lq-dot' + (auto ? '' : ' off')} /> {auto ? 'Auto' : 'Paused'}
          </button>
        </div>
        <div className="tk-strip">
          {live.tokens.map((row) => (
            <div className="lq-cell" key={row.bookingNumber}>
              <div className={pebbleClass(row)} title={'Token ' + row.bookingNumber + ' - ' + row.status}>
                <span>{row.bookingNumber}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <div className="container pg" style={{ padding: '34px 22px 80px' }}>
      <button className="crumb" onClick={() => go('/')}>
        <Icon name="left" size={15} /> Back to clinics
      </button>

      <div className="center" style={{ marginBottom: 26 }}>
        <span className="eyebrow">
          <Icon name="activity" size={13} /> Live token queue
        </span>
        <h1 style={{ fontSize: 'clamp(26px,4vw,38px)', margin: '12px 0 10px' }}>Which token is the doctor on?</h1>
        <p className="muted">
          No account needed. Enter the mobile number you booked with to track your own token, or just watch any clinic
          queue move in real time.
        </p>
      </div>

      <Reveal>
        <form className="card card-pad" onSubmit={submit} noValidate style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 14 }}>
            {[
              ['mobile', 'Mobile number'],
              ['bookingId', 'Booking ID'],
            ].map(([id, label]) => (
              <button
                type="button"
                key={id}
                className={'chip' + (mode === id ? ' on' : '')}
                onClick={() => {
                  setMode(id);
                  setValue('');
                  setRows(null);
                  setPicked(null);
                  setError('');
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="row" style={{ gap: 10 }}>
            <div className="input-icon grow">
              <Icon name={mode === 'mobile' ? 'phone' : 'ticket'} size={17} />
              <input
                className="input"
                required
                value={value}
                onChange={(event) =>
                  setValue(
                    mode === 'mobile' ? event.target.value.replace(/\D/g, '').slice(0, 10) : event.target.value.toUpperCase()
                  )
                }
                placeholder={mode === 'mobile' ? '10-digit mobile number' : 'MCF-XXXXXX-XXXXXX'}
                inputMode={mode === 'mobile' ? 'numeric' : 'text'}
              />
            </div>
            <button className="btn btn-primary" disabled={busy || !value.trim()}>
              {busy ? <Spinner /> : <Icon name="search" size={16} />} Track my token
            </button>
          </div>

          <div className="row" style={{ gap: 10, marginTop: 16, alignItems: 'center' }}>
            <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
              or watch a clinic
            </span>
            <select
              className="input grow"
              value={picked ? '' : boardId}
              onChange={(event) => {
                setPicked(null);
                setRows(null);
                setError('');
                setBoardId(event.target.value);
              }}
            >
              <option value="">Choose a clinic queue...</option>
              {clinics.map((clinic) => (
                <option key={clinic.clinicId} value={clinic.clinicId}>
                  {clinic.clinicName}
                  {clinic.doctorName ? ' - ' + clinic.doctorName : ''}
                </option>
              ))}
            </select>
          </div>

          {error ? (
            <div style={{ marginTop: 14 }}>
              <Alert kind="err">{error}</Alert>
            </div>
          ) : null}
        </form>
      </Reveal>

      {rows && rows.length > 1 ? (
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>
            {rows.length} bookings found - pick the one to track
          </h3>
          <div className="track-list">
            {rows.map((row) => (
              <button
                key={row.bookingId}
                className={'tk-mini' + (picked && picked.bookingId === row.bookingId ? ' on' : '')}
                onClick={() => setPicked(row)}
              >
                <span className="tk-tok">{String(row.bookingNumber).padStart(2, '0')}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{row.clinicName}</b>
                  <small>
                    {row.dateLabel} - {row.name}
                  </small>
                </span>
                <StatusBadge status={row.status} />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {rows && !rows.length ? (
        <div className="empty">
          <div className="empty-ico">
            <Icon name="search" size={26} />
          </div>
          <h4>No bookings found</h4>
          <p className="muted small">
            Check the mobile number or booking ID. Records older than 15 days are cleared automatically.
          </p>
        </div>
      ) : null}

      {boardBusy && !board ? <Loading label="Loading the live queue" /> : null}

      {picked && live ? (
        <Reveal>
          <div className="tk-grid">
            <div className="tk-card tk-mine">
              <span className="eyebrow">
                <Icon name="ticket" size={13} /> Your token
              </span>
              <div className="tk-ring" style={{ '--p': ringPct }}>
                <div className="tk-ring-in">
                  <b>{String(myToken).padStart(2, '0')}</b>
                  <small>{picked.quota}</small>
                </div>
              </div>

              <h3 style={{ fontSize: 18, margin: '0 0 4px' }}>{picked.name}</h3>
              <p className="small muted" style={{ margin: 0 }}>
                {picked.clinicName} - {picked.dateLabel}
              </p>

              <div className="tk-eta">
                <div>
                  <b>{live.currentToken || '--'}</b>
                  <small>Now serving</small>
                </div>
                <div>
                  <b>{picked.status === 'booked' && isToday ? ahead : '--'}</b>
                  <small>Ahead of you</small>
                </div>
                <div>
                  <b>
                    {picked.status === 'booked' && isToday
                      ? etaMin === 0
                        ? 'Now'
                        : '~' + etaMin + 'm'
                      : '--'}
                  </b>
                  <small>Your turn</small>
                </div>
              </div>

              <div className={'tk-state ' + state}>
                <Icon
                  name={state === 'turn' ? 'spark' : state === 'void' ? 'ban' : state === 'done' ? 'check' : 'clock'}
                  size={17}
                />
                <span>{stateMsg}</span>
              </div>

              {picked.status === 'booked' && isToday && etaMin > 0 ? (
                <p className="small muted" style={{ marginTop: 12 }}>
                  Estimated call time around{' '}
                  <b>{etaAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>, based on{' '}
                  {live.paceSamples ? 'the doctor averaging ' + pace + ' min per patient today' : 'a ' + pace + ' min average'}.
                  Please arrive earlier, since emergency cases can move the queue.
                </p>
              ) : null}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {liveHero}
              {strip}
            </div>
          </div>
        </Reveal>
      ) : null}

      {!picked && live ? (
        <Reveal>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {liveHero}
            {strip}
            <div className="lq-tip">
              <Icon name="spark" size={16} />
              <span>
                Want your own position and a time estimate? Enter the mobile number you booked with above and this board
                will follow your token instead.
              </span>
            </div>
          </div>
        </Reveal>
      ) : null}
    </div>
  );
}

/* ============================================================================
 * ADMIN DASHBOARD - every request is scoped to the signed-in clinic by the
 * JWT on the server, so one clinic can never read another clinic's rows.
 * ========================================================================== */

function AdminDashboard({ routeClinicId, go, notify }) {
  const [clinic, setClinic] = useState(getStoredClinic());
  const [tab, setTab] = useState('overview');
  const [date, setDate] = useState(todayISO());
  const [stats, setStats] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ search: '', status: '', quota: '', source: '' });
  const [range, setRange] = useState({ startDate: '', endDate: '' });
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [error, setError] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const [walkOpen, setWalkOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [busyId, setBusyId] = useState('');
  // Drill-down dialog. Opened by clicking any overview stat card or analytics
  // tile; holds the exact appointment subset that the clicked card counts.
  const [drill, setDrill] = useState(null);

  const signOut = useCallback(
    (message) => {
      setToken('');
      setStoredClinic(null);
      if (message) notify(message, 'err');
      go('/login');
    },
    [go, notify]
  );

  /* -- session ---------------------------------------------------------- */
  useEffect(() => {
    if (!getToken()) {
      go('/login');
      return undefined;
    }
    let alive = true;
    api('/auth/me', { auth: true }).then((data) => {
      if (!alive) return;
      if (!data.success) {
        if (data.unauthorized) signOut('Your session expired. Please sign in again.');
        else setError(data.message);
        setLoading(false);
        return;
      }
      setClinic(data.clinic);
      setStoredClinic(data.clinic);
      setLoading(false);
      if (routeClinicId !== data.clinic.clinicId) go('/admin/' + data.clinic.clinicId);
    });
    return () => {
      alive = false;
    };
  }, [go, routeClinicId, signOut]);

  /* -- stats + analytics ------------------------------------------------ */
  const loadSummary = useCallback(async () => {
    if (!getToken()) return;
    const params = new URLSearchParams();
    if (range.startDate) params.set('startDate', range.startDate);
    if (range.endDate) params.set('endDate', range.endDate);
    const query = params.toString();

    const [statsData, analyticsData] = await Promise.all([
      api('/admin/stats?date=' + encodeURIComponent(date), { auth: true }),
      api('/admin/analytics' + (query ? '?' + query : ''), { auth: true }),
    ]);

    if (statsData.unauthorized || analyticsData.unauthorized) {
      signOut('Your session expired. Please sign in again.');
      return;
    }
    if (statsData.success) setStats(statsData);
    if (analyticsData.success) setAnalytics(analyticsData);
    if (!statsData.success) setError(statsData.message);
    else if (!analyticsData.success) setError(analyticsData.message);
    else setError('');
  }, [date, range.startDate, range.endDate, signOut]);

  /* -- appointment rows -------------------------------------------------- */
  const loadRows = useCallback(async () => {
    if (!getToken()) return;
    setRowsLoading(true);
    const params = new URLSearchParams();
    if (range.startDate || range.endDate) {
      if (range.startDate) params.set('startDate', range.startDate);
      if (range.endDate) params.set('endDate', range.endDate);
    } else {
      params.set('date', date);
    }
    if (filters.search.trim()) params.set('search', filters.search.trim());
    if (filters.status) params.set('status', filters.status);
    if (filters.quota) params.set('quota', filters.quota);
    if (filters.source) params.set('source', filters.source);

    const data = await api('/admin/appointments?' + params.toString(), { auth: true });
    if (data.unauthorized) {
      signOut('Your session expired. Please sign in again.');
      return;
    }
    if (data.success) {
      setRows(data.appointments || []);
      setError('');
    } else {
      setRows([]);
      setError(data.message);
    }
    setRowsLoading(false);
  }, [date, filters.search, filters.status, filters.quota, filters.source, range.startDate, range.endDate, signOut]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    const timer = window.setTimeout(loadRows, filters.search ? 320 : 0);
    return () => window.clearTimeout(timer);
  }, [loadRows, filters.search]);

  const refreshAll = useCallback(() => {
    loadSummary();
    loadRows();
  }, [loadSummary, loadRows]);

  /* -- drill-down dialog ------------------------------------------------- */
  /* Each card describes a filter. The dialog re-queries the clinic-scoped
     appointments endpoint so the list always matches the number on the card. */
  const drillQuery = useCallback(
    (card) => {
      const params = new URLSearchParams();
      if (card.scope === 'range') {
        if (range.startDate) params.set('startDate', range.startDate);
        if (range.endDate) params.set('endDate', range.endDate);
      } else {
        params.set('date', date);
      }
      if (card.status) params.set('status', card.status);
      if (card.quota) params.set('quota', card.quota);
      if (card.source) params.set('source', card.source);
      return params.toString();
    },
    [date, range.startDate, range.endDate]
  );

  const openDrill = useCallback(
    async (card) => {
      setDrill(Object.assign({}, card, { list: [], loading: true, error: '' }));
      const data = await api('/admin/appointments?' + drillQuery(card), { auth: true });
      if (data.unauthorized) {
        signOut('Your session expired. Please sign in again.');
        return;
      }
      setDrill(
        Object.assign({}, card, {
          list: data.success ? data.appointments || [] : [],
          loading: false,
          error: data.success ? '' : data.message,
        })
      );
    },
    [drillQuery, signOut]
  );

  /* -- row actions ------------------------------------------------------- */
  const act = async (row, action) => {
    const id = row._id || row.id;
    if (action === 'cancel' && !window.confirm('Cancel appointment #' + row.bookingNumber + ' for ' + row.name + '?')) return;
    setBusyId(id + action);
    const data = await api('/admin/appointments/' + id + '/' + action, { method: 'PUT', auth: true });
    setBusyId('');
    if (data.unauthorized) {
      signOut('Your session expired. Please sign in again.');
      return;
    }
    if (!data.success) {
      notify(data.message, 'err');
      return;
    }
    notify(data.message, 'ok');
    setDetail(null);
    refreshAll();
    if (drill) openDrill(drill); // keep an open drill-down list in sync
  };

  if (loading && !clinic) return <Loading label="Opening your dashboard" />;

  const tabs = [
    ['overview', 'Overview', 'grid'],
    ['queue', 'Live queue status', 'activity'],
    ['appointments', 'Appointments', 'list'],
    ['analytics', 'Analytics', 'chart'],
    ['settings', 'Clinic settings', 'settings'],
  ];

  const dayLabel = stats ? stats.dateLabel : fmtDate(date);

  /* Overview cards. `status`/`quota`/`source` are the filters the drill-down
     dialog replays against /api/admin/appointments for the selected date. */
  const statCards = [
    { label: 'Total today', value: stats ? stats.total : 0, tone: 'c-teal', icon: 'users', note: 'Bookings excluding cancelled', status: 'active' },
    { label: 'Patients seen', value: stats ? stats.visited : 0, tone: 'c-green', icon: 'check', note: 'Marked visited', status: 'visited' },
    { label: 'Still waiting', value: stats ? stats.remaining : 0, tone: 'c-amber', icon: 'clock', note: 'In the queue right now', status: 'booked' },
    { label: 'Emergency', value: stats ? stats.emergency : 0, tone: 'c-violet', icon: 'alert', note: 'Emergency quota today', status: 'active', quota: 'Emergency' },
  ];

  const rangeLabel =
    range.startDate || range.endDate
      ? (range.startDate ? fmtDate(range.startDate) : 'Earliest') + ' to ' + (range.endDate ? fmtDate(range.endDate) : 'Latest')
      : 'All stored appointments';

  /* Analytics tiles - same idea, but scoped to the chosen date range. */
  const analyticsCards = [
    { label: 'Total booked', value: analytics ? analytics.total : 0, tone: 'c-teal', note: 'Excludes cancelled', status: 'active' },
    { label: 'Visited', value: analytics ? analytics.visited : 0, tone: 'c-green', note: 'Consultations completed', status: 'visited' },
    { label: 'Waiting', value: analytics ? analytics.remaining : 0, tone: 'c-amber', note: 'Still in the queue', status: 'booked' },
    { label: 'Cancelled', value: analytics ? analytics.cancelled : 0, tone: 'c-red', note: 'Cancelled bookings', status: 'cancelled' },
    { label: 'Visited - General', value: analytics ? analytics.visitedGeneral : 0, tone: 'c-teal', note: 'General quota seen', status: 'visited', quota: 'General' },
    { label: 'Visited - Emergency', value: analytics ? analytics.visitedEmergency : 0, tone: 'c-violet', note: 'Emergency quota seen', status: 'visited', quota: 'Emergency' },
    { label: 'Waiting - General', value: analytics ? analytics.remainingGeneral : 0, tone: 'c-blue', note: 'General quota waiting', status: 'booked', quota: 'General' },
    { label: 'Waiting - Emergency', value: analytics ? analytics.remainingEmergency : 0, tone: 'c-red', note: 'Emergency quota waiting', status: 'booked', quota: 'Emergency' },
    { label: 'Online bookings', value: analytics ? analytics.online : 0, tone: 'c-teal', note: 'Booked by patients', status: 'active', source: 'online' },
    { label: 'Walk-in bookings', value: analytics ? analytics.walkIns : 0, tone: 'c-violet', note: 'Added at reception', status: 'active', source: 'walk-in' },
  ];

  const visitedSplit = analytics ? (analytics.visitedGeneral || 0) + (analytics.visitedEmergency || 0) : 0;
  const genPct = visitedSplit ? Math.round(((analytics.visitedGeneral || 0) / visitedSplit) * 100) : 0;
  const emgPct = visitedSplit ? 100 - genPct : 0;

  /* Cards are divs, not buttons, so the tone-driven currentColor styling is
     untouched. These props restore the keyboard/AX behaviour a button gives. */
  const tapProps = (fn) => ({
    role: 'button',
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fn();
      }
    },
  });

  /* Shared table header. `showDate` adds a Date column for range-wide lists. */
  const tableHead = (showDate) => (
    <thead>
      <tr>
        <th>Token</th>
        {showDate ? <th>Date</th> : null}
        <th>Patient</th>
        <th>Contact</th>
        <th>Quota</th>
        <th>Status</th>
        <th>Source</th>
        <th style={{ textAlign: 'right' }}>Actions</th>
      </tr>
    </thead>
  );

  /* One queue row, reused by the overview table, the grouped day tables and
     the drill-down dialog, so quick actions behave identically everywhere. */
  const renderRow = (row, showDate) => {
    const id = row._id || row.id;
    return (
      <tr key={id}>
        <td className="tok" data-label="Token">
          <span className={'tok-chip' + (row.quota === 'Emergency' ? ' em' : '') + (row.status === 'cancelled' ? ' tok-struck' : '')}>
            {row.bookingNumber}
          </span>
        </td>
        {showDate ? (
          <td data-label="Date">
            <span className="small">{row.dateLabel || fmtDate(row.date)}</span>
          </td>
        ) : null}
        <td data-label="Patient">
          <div className="who">
            <b>{row.name}</b>
            <span>
              {row.gender}, {row.age}y - {row.weight}kg
            </span>
          </div>
        </td>
        <td data-label="Contact">
          <div className="contact">
            <b>{row.mobile}</b>
            <span>{row.email || 'No email'}</span>
          </div>
        </td>
        <td data-label="Quota">
          <QuotaBadge quota={row.quota} />
        </td>
        <td data-label="Status">
          <StatusBadge status={row.status} />
        </td>
        <td data-label="Source">
          <SourceBadge source={row.source} />
        </td>
        <td data-label="Actions">
          <div className="row-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setDetail(row)}>
              <Icon name="list" size={14} /> Details
            </button>
            {row.status === 'booked' ? (
              <>
                <button className="btn btn-soft btn-sm" disabled={busyId === id + 'visited'} onClick={() => act(row, 'visited')}>
                  {busyId === id + 'visited' ? <Spinner dark /> : <Icon name="check" size={14} />} Visited
                </button>
                <button className="btn btn-danger btn-sm" disabled={busyId === id + 'cancel'} onClick={() => act(row, 'cancel')}>
                  {busyId === id + 'cancel' ? <Spinner /> : <Icon name="ban" size={14} />} Cancel
                </button>
              </>
            ) : null}
            {row.status === 'visited' ? (
              <button className="btn btn-outline btn-sm" disabled={busyId === id + 'unvisited'} onClick={() => act(row, 'unvisited')}>
                {busyId === id + 'unvisited' ? <Spinner dark /> : <Icon name="undo" size={14} />} Revert
              </button>
            ) : null}
            {row.status === 'cancelled' ? <span className="tiny muted">No actions</span> : null}
          </div>
        </td>
      </tr>
    );
  };

  /* Group the loaded rows by appointment date, newest day first. */
  const dayGroups = (() => {
    const map = new Map();
    rows.forEach((row) => {
      if (!map.has(row.date)) map.set(row.date, []);
      map.get(row.date).push(row);
    });
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  })();

  const todayRows = rows.filter((row) => row.date === date);

  return (
    <div className="adm">
      {sidebar ? <div className="adm-scrim" onClick={() => setSidebar(false)} /> : null}

      <aside className={'adm-side' + (sidebar ? ' open' : '')}>
        <button className="brand" onClick={() => go('/')}>
          <span className="brand-mark">
            <Cross size={18} />
          </span>
          MediCare <i>Flow</i>
        </button>

        <div className="adm-clinic">
          <Avatar clinic={clinic} />
          <div>
            <b title={clinic ? clinic.clinicName : ''}>{clinic ? clinic.clinicName : 'Clinic'}</b>
            <span title={clinic ? clinic.doctorName : ''}>{clinic ? clinic.doctorName : ''}</span>
          </div>
        </div>

        <nav className="adm-nav">
          {tabs.map(([id, label, icon]) => (
            <button
              key={id}
              className={tab === id ? 'on' : ''}
              onClick={() => {
                setTab(id);
                setSidebar(false);
              }}
            >
              <Icon name={icon} size={17} /> {label}
              {id === 'appointments' && stats ? <span className="count">{stats.total}</span> : null}
            </button>
          ))}
          <button onClick={() => setWalkOpen(true)}>
            <Icon name="plus" size={17} /> Add walk-in
          </button>
        </nav>

        <div className="adm-side-foot">
          <button onClick={() => go('/clinic/' + (clinic ? clinic.clinicId : ''))}>
            <Icon name="right" size={16} /> View public page
          </button>
          <button onClick={() => signOut('')}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      </aside>

      <main className="adm-main">
        <div className="adm-top">
          <div className="row">
            <button className="btn-icon adm-burger" onClick={() => setSidebar(true)} aria-label="Open menu">
              <Icon name="menu" size={19} />
            </button>
            <div>
              <h1>{tabs.find(([id]) => id === tab)[1]}</h1>
              <p className="sub">
                {clinic ? clinic.clinicName : ''} - {stats ? stats.dateLabel : fmtDate(date)}
              </p>
            </div>
          </div>

          <div className="adm-top-actions">
            <label className="date-pick">
              <Icon name="calendar" size={16} />
              <input type="date" value={date} onChange={(event) => setDate(event.target.value || todayISO())} />
            </label>
            <button className="btn btn-soft btn-sm" onClick={refreshAll}>
              <Icon name="refresh" size={15} /> Refresh
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setWalkOpen(true)}>
              <Icon name="plus" size={15} /> Walk-in
            </button>
          </div>
        </div>

        <div className="adm-body">
          <ListingStatusBanner clinic={clinic} />
          {error ? <Alert kind="err">{error}</Alert> : null}

          {/* ------------------------------------------------------ overview */}
          {tab === 'overview' ? (
            <>
              <div className="hint-bar">
                <Icon name="spark" size={16} /> Tip: click any card to open the matching patient list for {dayLabel}.
              </div>

              <div className="stat-grid">
                {statCards.map((card, index) => (
                  <Reveal key={card.label} delay={index * 55}>
                    <div
                      className={'stat tap ' + card.tone}
                      {...tapProps(() =>
                        openDrill({
                          title: card.label,
                          note: dayLabel,
                          scope: 'day',
                          status: card.status || '',
                          quota: card.quota || '',
                          source: card.source || '',
                        })
                      )}
                    >
                      <span className="stat-ico">
                        <Icon name={card.icon} size={21} />
                      </span>
                      <span className="stat-txt">
                        <small>{card.label}</small>
                        <b>
                          <CountUp value={card.value} />
                        </b>
                        <span>{card.note}</span>
                        <span className="tap-cue">
                          <Icon name="list" size={12} /> View list
                        </span>
                      </span>
                    </div>
                  </Reveal>
                ))}
              </div>

              <div className="next-card">
                <div className="hero-orb a" />
                <div className="nc-txt">
                  <small>Next token to be issued</small>
                  <p>
                    {stats && stats.remaining
                      ? stats.remaining + ' patient(s) still waiting on ' + (stats.dateLabel || fmtDate(date)) + '.'
                      : 'The queue is clear for ' + (stats ? stats.dateLabel : fmtDate(date)) + '.'}
                  </p>
                </div>
                <b>#{stats ? stats.nextToken : 1}</b>
                <button className="btn btn-white" onClick={() => setWalkOpen(true)}>
                  <Icon name="plus" size={16} /> Issue walk-in token
                </button>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Today at a glance</h3>
                    <p className="small muted">Progress for {stats ? stats.dateLabel : fmtDate(date)}</p>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => setTab('appointments')}>
                    Manage queue <Icon name="right" size={15} />
                  </button>
                </div>
                <div className="panel-body bars">
                  {[
                    ['Patients seen', stats ? stats.visited : 0, stats ? stats.total : 0, 'bf-green'],
                    ['Still waiting', stats ? stats.remaining : 0, stats ? stats.total : 0, 'bf-amber'],
                    ['Emergency quota', stats ? stats.emergency : 0, stats ? stats.total : 0, 'bf-red'],
                    ['Walk-in entries', stats ? stats.walkIns : 0, stats ? stats.total : 0, 'bf-violet'],
                  ].map(([label, part, whole, tone]) => (
                    <div className="bar-row" key={label}>
                      <div className="bar-top">
                        <span className="muted">{label}</span>
                        <b>
                          {part} of {whole || 0} ({pct(part, whole)}%)
                        </b>
                      </div>
                      <div className="bar-track">
                        <div className={'bar-fill ' + tone} style={{ width: pct(part, whole) + '%' }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Appointments for {dayLabel}</h3>
                    <p className="small muted">{todayRows.length} record(s) on this date</p>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => setTab('appointments')}>
                    Open queue view <Icon name="right" size={15} />
                  </button>
                </div>
                <div className="panel-body" style={{ padding: 0 }}>
                  {rowsLoading ? (
                    <Loading label="Loading the queue" />
                  ) : todayRows.length ? (
                    <div className="table-wrap">
                      <table className="tbl">
                        {tableHead(false)}
                        <tbody>{todayRows.map((row) => renderRow(row, false))}</tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="empty">
                      <div className="empty-ico">
                        <Icon name="calendar" size={24} />
                      </div>
                      <h3>Nothing booked for {dayLabel}</h3>
                      <p>Use the Walk-in button to issue a token at the counter.</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {/* ---------------------------------------------- live queue status */}
          {tab === 'queue' ? (
            <LiveQueueTab clinicId={clinic ? clinic.clinicId : ''} date={date} setDate={setDate} notify={notify} onExpired={signOut} onChanged={refreshAll} />
          ) : null}

          {/* -------------------------------------------------- appointments */}
          {tab === 'appointments' ? (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h3>Queue management</h3>
                  <p className="small muted">
                    {range.startDate || range.endDate
                      ? 'Showing ' + (range.startDate || 'earliest') + ' to ' + (range.endDate || 'latest')
                      : 'Showing ' + fmtDate(date)}
                    {' - '}
                    {rows.length} record(s)
                  </p>
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => setWalkOpen(true)}>
                  <Icon name="plus" size={15} /> Add walk-in
                </button>
              </div>

              <div className="panel-body">
                <div className="filters" style={{ marginBottom: 16 }}>
                  <div className="input-icon">
                    <Icon name="search" size={17} />
                    <input
                      className="input"
                      value={filters.search}
                      onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                      placeholder="Search name, mobile, email or booking ID"
                    />
                  </div>
                  <select className="select" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
                    <option value="">All statuses</option>
                    <option value="active">Active (not cancelled)</option>
                    <option value="booked">Waiting</option>
                    <option value="visited">Visited</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <select className="select" value={filters.quota} onChange={(event) => setFilters({ ...filters, quota: event.target.value })}>
                    <option value="">All quotas</option>
                    <option value="General">General</option>
                    <option value="Emergency">Emergency</option>
                  </select>
                  <select className="select" value={filters.source} onChange={(event) => setFilters({ ...filters, source: event.target.value })}>
                    <option value="">All sources</option>
                    <option value="online">Online</option>
                    <option value="walk-in">Walk-in</option>
                  </select>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setFilters({ search: '', status: '', quota: '', source: '' });
                      setRange({ startDate: '', endDate: '' });
                      setDate(todayISO());
                    }}
                  >
                    <Icon name="refresh" size={15} /> Reset
                  </button>
                </div>

                {rowsLoading ? (
                  <Loading label="Loading appointments" />
                ) : dayGroups.length ? (
                  <div className="day-stack">
                    {dayGroups.map(([groupDate, groupRows]) => {
                      const seen = groupRows.filter((row) => row.status === 'visited').length;
                      const waiting = groupRows.filter((row) => row.status === 'booked').length;
                      const dropped = groupRows.filter((row) => row.status === 'cancelled').length;
                      const urgent = groupRows.filter((row) => row.quota === 'Emergency' && row.status !== 'cancelled').length;
                      return (
                        <div className="day-group" key={groupDate}>
                          <div className="day-head">
                            <h4>
                              <Icon name="calendar" size={16} /> {fmtLongDate(groupDate)}
                            </h4>
                            <div className="day-chips">
                              <span className="day-chip">{groupRows.length} appointment(s)</span>
                              <span className="day-chip">{seen} visited</span>
                              <span className="day-chip">{waiting} waiting</span>
                              {urgent ? <span className="day-chip">{urgent} emergency</span> : null}
                              {dropped ? <span className="day-chip">{dropped} cancelled</span> : null}
                            </div>
                          </div>
                          <div className="table-wrap">
                            <table className="tbl">
                              {tableHead(false)}
                              <tbody>{groupRows.map((row) => renderRow(row, false))}</tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty">
                    <div className="empty-ico">
                      <Icon name="list" size={24} />
                    </div>
                    <h3>No appointments here</h3>
                    <p>Nothing matches this date and filter combination yet.</p>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {/* ----------------------------------------------------- analytics */}
          {tab === 'analytics' ? (
            <>
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Date range</h3>
                    <p className="small muted">Leave both dates empty to report on every stored appointment.</p>
                  </div>
                </div>
                <div className="panel-body">
                  <div className="grid3">
                    <div className="field">
                      <label>From</label>
                      <input className="input" type="date" value={range.startDate} onChange={(event) => setRange({ ...range, startDate: event.target.value })} />
                    </div>
                    <div className="field">
                      <label>To</label>
                      <input className="input" type="date" value={range.endDate} onChange={(event) => setRange({ ...range, endDate: event.target.value })} />
                    </div>
                    <div className="field">
                      <label>&nbsp;</label>
                      <button className="btn btn-outline btn-block" onClick={() => setRange({ startDate: '', endDate: '' })}>
                        <Icon name="refresh" size={16} /> Clear range
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Appointment breakdown</h3>
                    <p className="small muted">General and Emergency split across the selected range.</p>
                  </div>
                </div>
                <div className="panel-body">
                  <div className="hint-bar">
                    <Icon name="spark" size={16} /> Click any tile to list the exact patients it counts - {rangeLabel}.
                  </div>

                  <div className="an-grid">
                    {analyticsCards.map((card) => (
                      <div
                        className="an-tile tap"
                        key={card.label}
                        {...tapProps(() =>
                          openDrill({
                            title: card.label,
                            note: rangeLabel,
                            scope: 'range',
                            status: card.status || '',
                            quota: card.quota || '',
                            source: card.source || '',
                          })
                        )}
                      >
                        <small>{card.label}</small>
                        <b className={card.tone}>
                          <CountUp value={card.value} />
                        </b>
                        <p>{card.note}</p>
                        <span className="tap-cue">
                          <Icon name="list" size={12} /> View patients
                        </span>
                      </div>
                    ))}
                  </div>

                  {analytics && analytics.total ? (
                    <div className="bars" style={{ marginTop: 24 }}>
                      <div className="bar-row">
                        <div className="bar-top">
                          <span className="muted">Overall completion</span>
                          <b>
                            {analytics.visited} of {analytics.total} visited ({pct(analytics.visited, analytics.total)}%)
                          </b>
                        </div>
                        <div className="bar-track">
                          <div className="bar-fill bf-green" style={{ width: pct(analytics.visited, analytics.total) + '%' }} />
                        </div>
                      </div>

                      {visitedSplit ? (
                        <div className="bar-row">
                          <div className="bar-top">
                            <span className="muted">Visited patients - quota split</span>
                            <b>
                              General {genPct}% - Emergency {emgPct}%
                            </b>
                          </div>
                          <div className="split-bar">
                            <i style={{ width: genPct + '%', background: 'var(--grad)' }} />
                            <i style={{ width: emgPct + '%', background: 'linear-gradient(135deg,#dc2626,#f97316)' }} />
                          </div>
                          <div className="split-legend">
                            <span>
                              <em style={{ background: 'var(--grad)' }} /> General - {analytics.visitedGeneral} visited
                            </span>
                            <span>
                              <em style={{ background: 'linear-gradient(135deg,#dc2626,#f97316)' }} /> Emergency - {analytics.visitedEmergency} visited
                            </span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h3>Recent daily trend</h3>
                    <p className="small muted">Visited versus waiting per day.</p>
                  </div>
                  <div className="legend">
                    <span>
                      <i style={{ background: 'linear-gradient(135deg,#059669,#10b981)' }} /> Visited
                    </span>
                    <span>
                      <i style={{ background: 'linear-gradient(180deg,#7dd3fc,#38bdf8)' }} /> Waiting
                    </span>
                  </div>
                </div>
                <div className="panel-body">
                  {analytics && analytics.trend && analytics.trend.length ? (
                    <div className="trend">
                      {(() => {
                        const trend = analytics.trend.slice(-21);
                        const max = Math.max(1, ...trend.map((item) => item.total || 0));
                        return trend.map((item) => {
                          const visited = item.visited || 0;
                          const waiting = Math.max(0, (item.total || 0) - visited);
                          return (
                            <div className="trend-col" key={item.date} title={item.label + ': ' + (item.total || 0) + ' total, ' + visited + ' visited'}>
                              <div className="trend-bar">
                                {waiting ? <div className="trend-seg w" style={{ height: (waiting / max) * 100 + '%' }} /> : null}
                                {visited ? <div className="trend-seg v" style={{ height: (visited / max) * 100 + '%' }} /> : null}
                              </div>
                              <span className="trend-lbl">{item.label}</span>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  ) : (
                    <div className="empty">
                      <div className="empty-ico">
                        <Icon name="chart" size={24} />
                      </div>
                      <h3>No trend data yet</h3>
                      <p>Once appointments start coming in, daily totals appear here.</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {/* ------------------------------------------------------ settings */}
          {tab === 'settings' && clinic ? (
            <SettingsTab
              clinic={clinic}
              notify={notify}
              onSaved={(updated) => {
                setClinic(updated);
                setStoredClinic(updated);
              }}
              onExpired={() => signOut('Your session expired. Please sign in again.')}
              go={go}
            />
          ) : null}
        </div>
      </main>

      {walkOpen ? (
        <WalkInModal
          close={() => setWalkOpen(false)}
          notify={notify}
          onExpired={() => signOut('Your session expired. Please sign in again.')}
          onAdded={() => {
            setWalkOpen(false);
            setDate(todayISO());
            refreshAll();
          }}
        />
      ) : null}

      {drill ? (
        <Modal
          wide
          title={drill.title}
          subtitle={drill.note + (drill.loading ? '' : ' - ' + drill.list.length + ' record(s)')}
          onClose={() => setDrill(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setDrill(null)}>
                Close
              </button>
              <button
                className="btn btn-outline"
                onClick={() => {
                  const next = drill;
                  setDrill(null);
                  setFilters({ search: '', status: next.status || '', quota: next.quota || '', source: next.source || '' });
                  if (next.scope === 'day') setRange({ startDate: '', endDate: '' });
                  setTab('appointments');
                }}
              >
                <Icon name="list" size={15} /> Open in queue view
              </button>
            </>
          }
        >
          {drill.loading ? (
            <Loading label="Loading matching patients" />
          ) : drill.error ? (
            <Alert kind="err">{drill.error}</Alert>
          ) : drill.list.length ? (
            <div className="table-wrap">
              <table className="tbl tbl-drill">
                {tableHead(drill.scope === 'range')}
                <tbody>{drill.list.map((row) => renderRow(row, drill.scope === 'range'))}</tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <div className="empty-ico">
                <Icon name="list" size={24} />
              </div>
              <h3>Nothing in this group</h3>
              <p>No appointment matches this card for the selected period.</p>
            </div>
          )}
        </Modal>
      ) : null}

      {detail ? (
        <Modal
          title={'Token #' + detail.bookingNumber + ' - ' + detail.name}
          subtitle={detail.bookingId}
          onClose={() => setDetail(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setDetail(null)}>
                Close
              </button>
              {detail.status === 'booked' ? (
                <>
                  <button className="btn btn-danger" onClick={() => act(detail, 'cancel')}>
                    <Icon name="ban" size={15} /> Cancel appointment
                  </button>
                  <button className="btn btn-primary" onClick={() => act(detail, 'visited')}>
                    <Icon name="check" size={15} /> Mark visited
                  </button>
                </>
              ) : null}
              {detail.status === 'visited' ? (
                <button className="btn btn-outline" onClick={() => act(detail, 'unvisited')}>
                  <Icon name="undo" size={15} /> Revert to waiting
                </button>
              ) : null}
            </>
          }
        >
          <div className="row" style={{ marginBottom: 16 }}>
            <StatusBadge status={detail.status} />
            <QuotaBadge quota={detail.quota} />
            <SourceBadge source={detail.source} />
          </div>
          <dl className="kv">
            <dt>Patient</dt>
            <dd>{detail.name}</dd>
            <dt>Gender / Age</dt>
            <dd>
              {detail.gender} / {detail.age} years
            </dd>
            <dt>Weight</dt>
            <dd>{detail.weight} kg</dd>
            <dt>Appointment date</dt>
            <dd>{detail.dateLabel || fmtLongDate(detail.date)}</dd>
            <dt>Mobile</dt>
            <dd>{detail.mobile}</dd>
            <dt>Email</dt>
            <dd>{detail.email || 'Not provided'}</dd>
            <dt>Address</dt>
            <dd>{detail.address}</dd>
            <dt>Booking ID</dt>
            <dd>{detail.bookingId}</dd>
          </dl>
        </Modal>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------- live queue status -- */

/* The pebble dial pad. Tapping a waiting token marks it visited immediately -
   that is the single most repeated action of a clinic day, so it must not cost
   a confirmation click. Tapping a visited token asks first, because undoing a
   consultation is the destructive direction. */
function LiveQueueTab({ clinicId, date, setDate, notify, onExpired, onChanged }) {
  const [tokens, setTokens] = useState([]);
  const [live, setLive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [info, setInfo] = useState(null);
  const [auto, setAuto] = useState(true);
  const [names, setNames] = useState(true);
  const [beat, setBeat] = useState(0);

  const load = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      const data = await api('/admin/queue?date=' + encodeURIComponent(date), { auth: true });
      if (!silent) setLoading(false);
      if (!data.success) {
        if (data.unauthorized) return onExpired();
        setError(data.message);
        return undefined;
      }
      setError('');
      setTokens(data.tokens || []);
      setLive(data.live || null);
      setBeat(Date.now());
      return undefined;
    },
    [date, onExpired]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  /* REALTIME. Any change - made on this screen, on another reception screen, or
     by a patient booking online - pushes a fresh board over Socket.IO within
     milliseconds. The admin pad REFETCHES rather than trusting the pushed
     payload, because it also needs patient names, which the public broadcast
     deliberately leaves out. */
  const socketLive = useQueueSocket(clinicId, date, () => load(true));

  /* Polling is now only a safety net: relaxed while the socket is connected,
     brisk when it is not, so the pad still self-heals without Socket.IO. */
  useEffect(() => {
    if (!auto) return undefined;
    const id = window.setInterval(() => load(true), socketLive ? 45000 : 12000);
    return () => window.clearInterval(id);
  }, [auto, load, socketLive]);

  const apply = async (row, next) => {
    setBusy(row.id);
    const verb = next === 'visited' ? 'visited' : 'unvisited';
    const data = await api('/admin/appointments/' + row.id + '/' + verb, { method: 'PUT', auth: true });
    setBusy(null);
    if (!data.success) {
      if (data.unauthorized) return onExpired();
      notify(data.message, 'err');
      return undefined;
    }
    notify(data.message, 'ok');
    await load(true);
    if (onChanged) onChanged();
    return undefined;
  };

  const tap = (row) => {
    if (row.status === 'empty' || !row.id) {
      notify('Token ' + row.bookingNumber + ' was never issued on this date.', 'err');
      return;
    }
    if (row.status === 'cancelled') {
      notify('Token ' + row.bookingNumber + ' is cancelled, so it cannot be served.', 'err');
      return;
    }
    if (row.status === 'visited') {
      setConfirm(row);
      return;
    }
    apply(row, 'visited');
  };

  const callNext = () => {
    const next = tokens.find((row) => row.status === 'booked');
    if (!next) {
      notify('No waiting tokens left for this date.', 'err');
      return;
    }
    apply(next, 'visited');
  };

  const current = live ? live.currentToken : null;
  const upNext = live ? live.nextToken : null;
  const pace = live ? live.paceMinutes || live.defaultPaceMinutes : 8;
  const waiting = live ? live.waiting : 0;
  const clearIn = waiting * pace;

  const pebbleClass = (row) => {
    const bits = ['lq-peb'];
    if (row.status === 'empty') bits.push('gap');
    else if (row.status === 'cancelled') bits.push('void');
    else if (row.status === 'visited') bits.push('done');
    else if (row.quota === 'Emergency') bits.push('emg');
    else bits.push('wait');
    if (row.bookingNumber === current) bits.push('now');
    else if (row.bookingNumber === upNext) bits.push('next');
    if (busy === row.id) bits.push('busy');
    return bits.join(' ');
  };

  const hint = (row) => {
    if (row.status === 'empty') return 'Token ' + row.bookingNumber + ' - not issued';
    const who = row.name + ' (' + row.age + ', ' + row.gender + ') - ' + row.mobile;
    if (row.status === 'cancelled') return who + ' - CANCELLED';
    if (row.status === 'visited') return who + ' - visited, tap to revert';
    return who + ' - ' + row.quota + ' quota, tap to mark visited';
  };

  return (
    <div className="lq">
      <div className="lq-hero">
        <div className="lq-hero-in">
          <div className="lq-dial">
            <div>
              <b>{current ? String(current).padStart(2, '0') : '--'}</b>
              <small>Now serving</small>
            </div>
          </div>
          <div className="lq-hero-txt">
            <span className="lq-live">
              <span className={'lq-dot' + (auto ? '' : ' off')} />
              {socketLive ? 'Live - realtime' : auto ? 'Live - polling' : 'Paused'}
            </span>
            <h2 style={{ marginTop: 8 }}>
              {current ? 'Token ' + current + ' is with the doctor' : 'No token called yet'}
            </h2>
            <p>
              {live && live.maxToken
                ? 'Tokens 1 to ' + live.maxToken + ' issued for ' + (live.dateLabel || date) + '. Tap any pebble to change its status.'
                : 'No tokens have been issued for ' + (live ? live.dateLabel || date : date) + ' yet.'}
            </p>
            <div className="lq-pills">
              <span className="lq-pill">
                <Icon name="right" size={14} /> Up next <b>{upNext ? '#' + upNext : '--'}</b>
              </span>
              <span className="lq-pill">
                <Icon name="clock" size={14} /> Waiting <b>{waiting}</b>
              </span>
              <span className="lq-pill">
                <Icon name="check" size={14} /> Seen <b>{live ? live.visited : 0}</b>
              </span>
              <span className="lq-pill">
                <Icon name="activity" size={14} /> Pace <b>{pace} min</b>
              </span>
              {waiting ? (
                <span className="lq-pill">
                  <Icon name="spark" size={14} /> Clears in <b>~{clearIn} min</b>
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>Live queue status</h3>
            <p className="small muted">
              {live && live.paceSamples
                ? 'Pace is measured from ' + live.paceSamples + ' completed consultation' + (live.paceSamples === 1 ? '' : 's') + ' today.'
                : 'Pace falls back to ' + pace + ' minutes until two consultations are done.'}
            </p>
          </div>
          <div className="adm-top-actions">
            <div className="date-pick">
              <Icon name="calendar" size={15} />
              <input type="date" value={date} onChange={(event) => setDate(event.target.value || todayISO())} />
            </div>
            <button className="btn btn-soft btn-sm" onClick={() => load(false)}>
              <Icon name="refresh" size={15} /> Refresh
            </button>
            <button className="btn btn-primary btn-sm" onClick={callNext} disabled={!waiting}>
              <Icon name="right" size={15} /> Call next token
            </button>
          </div>
        </div>

        <div className="panel-body">
          <div className="lq-bar" style={{ marginBottom: 18 }}>
            <div className="lq-legend">
              <span className="lq-key">
                <span className="lq-swatch" style={{ background: 'linear-gradient(145deg,#22d3ee,#0369a1)' }} /> Waiting
              </span>
              <span className="lq-key">
                <span className="lq-swatch" style={{ background: 'linear-gradient(145deg,#4ade80,#047857)' }} /> Visited
              </span>
              <span className="lq-key">
                <span className="lq-swatch" style={{ background: 'linear-gradient(145deg,#fca5a5,#b91c1c)' }} /> Emergency
              </span>
              <span className="lq-key">
                <span className="lq-swatch" style={{ background: 'linear-gradient(145deg,#e2e8f0,#94a3b8)' }} /> Cancelled
              </span>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <button className={'lq-toggle' + (names ? ' on' : '')} onClick={() => setNames((v) => !v)}>
                <Icon name={names ? 'user' : 'users'} size={14} /> {names ? 'Names on' : 'Names off'}
              </button>
              <button className={'lq-toggle' + (auto ? ' on' : '')} onClick={() => setAuto((v) => !v)}>
                <span className={'lq-dot' + (auto ? '' : ' off')} />{' '}
                {socketLive ? 'Realtime on' : auto ? 'Auto refresh' : 'Paused'}
              </button>
            </div>
          </div>

          {error ? <Alert kind="err">{error}</Alert> : null}

          {loading && !tokens.length ? (
            <Loading label="Loading today's queue" />
          ) : !tokens.length ? (
            <div className="empty">
              <div className="empty-ico">
                <Icon name="ticket" size={26} />
              </div>
              <h4>No tokens issued yet</h4>
              <p className="muted small">
                As soon as a patient books online or you add a walk-in, token 1 appears here.
              </p>
            </div>
          ) : (
            <>
              <div className="lq-pad">
                {tokens.map((row) => (
                  <div className="lq-cell" key={row.bookingNumber}>
                    <button
                      className={pebbleClass(row)}
                      title={hint(row)}
                      aria-label={hint(row)}
                      onClick={() => tap(row)}
                    >
                      <span>{row.bookingNumber}</span>
                      {row.quota === 'Emergency' && row.status !== 'empty' ? <i>!</i> : null}
                      {row.bookingNumber === current ? <u>now</u> : null}
                      {row.bookingNumber === upNext ? <u>{live && live.nextIsLeftover ? 'left' : 'next'}</u> : null}
                    </button>
                    {names ? (
                      row.status === 'empty' || !row.id ? (
                        <span className="lq-cap dim">not issued</span>
                      ) : (
                        <button
                          className="lq-cap"
                          title={'View full details for ' + row.name}
                          onClick={() => setInfo(row)}
                        >
                          {row.name}
                        </button>
                      )
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="lq-tip" style={{ marginTop: 20 }}>
                <Icon name="spark" size={16} />
                <span>
                  Tap a blue or red pebble to mark that patient <b>visited</b> straight away. Tapping a green pebble
                  asks for confirmation before reverting it to unvisited. Tap the <b>name</b> under a pebble to open that
                  patient in full. The dashed amber ring shows who is up next and only ever moves forward, so marking a
                  skipped token later never pulls it backwards.
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {info ? (
        <Modal
          title={'Token #' + info.bookingNumber + ' - ' + info.name}
          subtitle={info.bookingId}
          onClose={() => setInfo(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setInfo(null)}>
                Close
              </button>
              {info.status === 'booked' ? (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const row = info;
                    setInfo(null);
                    apply(row, 'visited');
                  }}
                >
                  <Icon name="check" size={15} /> Mark visited
                </button>
              ) : null}
              {info.status === 'visited' ? (
                <button
                  className="btn btn-outline"
                  onClick={() => {
                    const row = info;
                    setInfo(null);
                    setConfirm(row);
                  }}
                >
                  <Icon name="undo" size={15} /> Revert to unvisited
                </button>
              ) : null}
            </>
          }
        >
          <div className="row" style={{ marginBottom: 16 }}>
            <StatusBadge status={info.status} />
            <QuotaBadge quota={info.quota} />
            <SourceBadge source={info.source} />
          </div>
          <dl className="kv">
            <dt>Patient</dt>
            <dd>{info.name}</dd>
            <dt>Gender / Age</dt>
            <dd>
              {info.gender} / {info.age} years
            </dd>
            <dt>Weight</dt>
            <dd>{info.weight ? info.weight + ' kg' : 'Not recorded'}</dd>
            <dt>Appointment date</dt>
            <dd>{info.dateLabel || fmtLongDate(info.date)}</dd>
            <dt>Mobile</dt>
            <dd>{info.mobile}</dd>
            <dt>Email</dt>
            <dd>{info.email || 'Not provided'}</dd>
            <dt>Address</dt>
            <dd>{info.address || 'Not recorded'}</dd>
            <dt>Booking ID</dt>
            <dd>{info.bookingId}</dd>
            <dt>Seen at</dt>
            <dd>
              {info.visitedAt
                ? new Date(info.visitedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'Not yet'}
            </dd>
          </dl>
        </Modal>
      ) : null}

      {confirm ? (
        <Modal
          title={'Revert token ' + confirm.bookingNumber + '?'}
          subtitle={confirm.name + ' - ' + confirm.quota + ' quota'}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Keep as visited
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  const row = confirm;
                  setConfirm(null);
                  apply(row, 'booked');
                }}
              >
                <Icon name="undo" size={16} /> Yes, mark unvisited
              </button>
            </>
          }
        >
          <p style={{ fontSize: 15, fontWeight: 600 }}>Do you want to mark it as unvisited?</p>
          <p className="muted small" style={{ marginTop: 10 }}>
            Token {confirm.bookingNumber} goes back into the waiting queue and the patient reappears on the live
            tracking page. If this was the token being served, "now serving" moves back to the previous visited token.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- walk-in modal -- */

function WalkInModal({ close, notify, onAdded, onExpired }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, date: todayISO() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/admin/walk-in', { method: 'POST', auth: true, body: { form: { ...form, date: todayISO() } } });
    setBusy(false);
    if (data.unauthorized) {
      onExpired();
      return;
    }
    if (!data.success) {
      setError(data.message);
      return;
    }
    notify(data.message, 'ok');
    onAdded();
  };

  return (
    <Modal
      wide
      title="Add walk-in patient"
      subtitle={'Gets the next token in today\'s queue - ' + fmtLongDate(todayISO())}
      onClose={close}
      footer={
        <>
          <button className="btn btn-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" form="walkin-form" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Adding...
              </>
            ) : (
              <>
                <Icon name="ticket" size={15} /> Add to queue
              </>
            )}
          </button>
        </>
      }
    >
      <form id="walkin-form" onSubmit={submit} noValidate>
        <PatientFields form={form} set={set} walkIn />
        {error ? (
          <div style={{ marginTop: 16 }}>
            <Alert kind="err">{error}</Alert>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ settings -- */

function SettingsTab({ clinic, notify, onSaved, onExpired, go }) {
  const [profile, setProfile] = useState({
    clinicName: clinic.clinicName || '',
    doctorName: clinic.doctorName || '',
    specialization: clinic.specialization || '',
    address: clinic.address || '',
    city: clinic.city || '',
    phone: clinic.phone || '',
    photo: clinic.photo || '',
    timings: clinic.timings || '',
    about: clinic.about || '',
    adminEmail: clinic.adminEmail || '',
  });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pwError, setPwError] = useState('');

  const set = (key, value) => setProfile((current) => ({ ...current, [key]: value }));

  const saveProfile = async (event) => {
    event.preventDefault();
    setBusy('profile');
    setError('');
    const data = await api('/admin/profile', { method: 'PUT', auth: true, body: profile });
    setBusy('');
    if (data.unauthorized) {
      onExpired();
      return;
    }
    if (!data.success) {
      setError(data.message);
      return;
    }
    onSaved(data.clinic);
    notify(data.message, 'ok');
  };

  const savePassword = async (event) => {
    event.preventDefault();
    if (pw.newPassword !== pw.confirm) {
      setPwError('The two new passwords do not match.');
      return;
    }
    setBusy('password');
    setPwError('');
    const data = await api('/admin/password', {
      method: 'PUT',
      auth: true,
      body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword },
    });
    setBusy('');
    if (data.unauthorized) {
      onExpired();
      return;
    }
    if (!data.success) {
      setPwError(data.message);
      return;
    }
    setPw({ currentPassword: '', newPassword: '', confirm: '' });
    notify(data.message, 'ok');
  };

  const bookingLink =
    (typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '') + '#/clinic/' + clinic.clinicId;

  return (
    <div className="set-grid">
      <form className="panel" onSubmit={saveProfile} noValidate>
        <div className="panel-head">
          <div>
            <h3>Clinic profile</h3>
            <p className="small muted">This is what patients see in the public directory.</p>
          </div>
        </div>
        <div className="panel-body form-grid">
          <div className="field">
            <label>Clinic name</label>
            <input className="input" required value={profile.clinicName} onChange={(e) => set('clinicName', e.target.value)} />
          </div>
          <div className="grid2">
            <div className="field">
              <label>Doctor name</label>
              <input className="input" required value={profile.doctorName} onChange={(e) => set('doctorName', e.target.value)} />
            </div>
            <div className="field">
              <label>Specialization</label>
              <select className="select" value={profile.specialization} onChange={(e) => set('specialization', e.target.value)}>
                {SPECIALIZATIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Address</label>
            <textarea className="textarea" rows="2" required value={profile.address} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="grid2">
            <div className="field">
              <label>City</label>
              <input className="input" value={profile.city} onChange={(e) => set('city', e.target.value)} />
            </div>
            <div className="field">
              <label>Phone</label>
              <input className="input" value={profile.phone} onChange={(e) => set('phone', e.target.value.replace(/\D/g, '').slice(0, 10))} />
            </div>
          </div>
          <div className="grid2">
            <div className="field">
              <label>Opening hours</label>
              <input className="input" value={profile.timings} onChange={(e) => set('timings', e.target.value)} placeholder="Mon-Sat, 9 AM - 6 PM" />
            </div>
            <div className="field">
              <label>Photo URL</label>
              <input className="input" value={profile.photo} onChange={(e) => set('photo', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>About the clinic</label>
            <textarea className="textarea" rows="3" value={profile.about} onChange={(e) => set('about', e.target.value)} placeholder="Services, facilities, anything patients should know" />
          </div>
          <div className="field">
            <label>Admin email (password resets)</label>
            <input className="input" type="email" value={profile.adminEmail} onChange={(e) => set('adminEmail', e.target.value)} />
          </div>

          {error ? <Alert kind="err">{error}</Alert> : null}

          <button className="btn btn-primary btn-block" disabled={busy === 'profile'}>
            {busy === 'profile' ? (
              <>
                <Spinner /> Saving...
              </>
            ) : (
              <>
                <Icon name="check" size={16} /> Save clinic profile
              </>
            )}
          </button>
        </div>
      </form>

      <div className="stack">
        <div className="panel">
          <div className="panel-head">
            <div>
              <h3>Your public booking link</h3>
              <p className="small muted">Share this with patients, print it, or add it to your board.</p>
            </div>
          </div>
          <div className="panel-body stack">
            <div className="copy-row">
              <Icon name="right" size={15} />
              <span className="mono">{bookingLink}</span>
            </div>
            <div className="row">
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  if (navigator.clipboard) {
                    navigator.clipboard.writeText(bookingLink);
                    notify('Booking link copied.', 'ok');
                  } else {
                    notify('Copy is not available in this browser.', 'err');
                  }
                }}
              >
                <Icon name="list" size={15} /> Copy link
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => go('/clinic/' + clinic.clinicId)}>
                <Icon name="right" size={15} /> Open booking page
              </button>
            </div>
            <dl className="kv">
              <dt>Clinic ID</dt>
              <dd className="mono">{clinic.clinicId}</dd>
              <dt>Admin user ID</dt>
              <dd className="mono">{clinic.adminUserId}</dd>
              <dt>Registered</dt>
              <dd>{clinic.createdAt ? fmtLongDate(String(clinic.createdAt).slice(0, 10)) : '-'}</dd>
            </dl>
          </div>
        </div>

        <form className="panel" onSubmit={savePassword} noValidate>
          <div className="panel-head">
            <div>
              <h3>Change password</h3>
              <p className="small muted">Passwords are stored only as bcrypt hashes.</p>
            </div>
          </div>
          <div className="panel-body form-grid">
            <div className="field">
              <label>Current password</label>
              <input
                className="input"
                required
                type="password"
                value={pw.currentPassword}
                onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
                autoComplete="current-password"
              />
            </div>
            <div className="grid2">
              <div className="field">
                <label>New password</label>
                <input
                  className="input"
                  required
                  type="password"
                  minLength="6"
                  value={pw.newPassword}
                  onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
                  autoComplete="new-password"
                />
              </div>
              <div className="field">
                <label>Confirm new password</label>
                <input
                  className={'input' + (pw.confirm && pw.confirm !== pw.newPassword ? ' bad' : '')}
                  required
                  type="password"
                  value={pw.confirm}
                  onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
                  autoComplete="new-password"
                />
              </div>
            </div>

            {pwError ? <Alert kind="err">{pwError}</Alert> : null}

            <button className="btn btn-dark btn-block" disabled={busy === 'password'}>
              {busy === 'password' ? (
                <>
                  <Spinner /> Updating...
                </>
              ) : (
                <>
                  <Icon name="shield" size={16} /> Update password
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ============================================================================
 * ROOT
 * ========================================================================== */

/* ============================================================================
 * MASTER ADMIN PANEL - platform owner console
 *
 * A completely separate privilege level from a clinic dashboard: its own login,
 * its own localStorage keys and its own Bearer token. Reached at #/owner.
 * ========================================================================== */

/* Shown to a CLINIC inside its own dashboard, so a clinic always understands
   why it is or is not on the public homepage. Renders nothing once a listing is
   approved and visible, which is the normal steady state. */
function ListingStatusBanner({ clinic }) {
  if (!clinic) return null;
  const status = clinic.status || 'approved';
  if (status === 'approved' && !clinic.hidden) return null;

  if (status === 'pending') {
    return (
      <div className="lst-banner pend">
        <Icon name="clock" size={19} />
        <div>
          <b>Awaiting approval</b>
          Your clinic is registered and this dashboard is fully usable, but the listing is not on the public homepage yet.
          Every new clinic is reviewed before going live - we will email you the moment it is approved, and online booking
          opens at the same time.
        </div>
      </div>
    );
  }

  if (status === 'rejected') {
    return (
      <div className="lst-banner rej">
        <Icon name="ban" size={19} />
        <div>
          <b>Listing not approved</b>
          {clinic.rejectionNote ? 'Reason given: ' + clinic.rejectionNote + ' ' : ''}
          Your admin account still works. Correct your details in Clinic settings, then reply to the notification email to
          ask for another review.
        </div>
      </div>
    );
  }

  return (
    <div className="lst-banner hid">
      <Icon name="alert" size={19} />
      <div>
        <b>Temporarily hidden from the homepage</b>
        New patients cannot discover you in the public directory right now. Your live queue, existing tokens and direct
        booking links all keep working normally.
      </div>
    </div>
  );
}

function OwnerLoginPage({ onSignedIn, notify, go }) {
  const [form, setForm] = useState({ userId: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = await api('/owner/login', { method: 'POST', body: form });
    setBusy(false);
    if (!data.success) {
      setError(data.message);
      return;
    }
    setOwnerToken(data.token);
    setStoredOwner(data.owner);
    notify(data.message, 'ok');
    onSignedIn(data.owner);
  };

  return (
    <div className="own-gate">
      <form className="own-gate-card" onSubmit={submit} noValidate>
        <button type="button" className="brand" onClick={() => go('/')}>
          <span className="brand-mark">
            <Cross size={19} />
          </span>
          MediCare <i>Flow</i>
        </button>

        <span className="eyebrow">
          <Icon name="shield" size={13} /> Platform owner
        </span>
        <h2>Master admin panel</h2>
        <p className="lead">Approve clinic listings, edit them, hide them or remove them. This console is not linked from the public navigation.</p>

        <div className="form-grid">
          <div className="field">
            <label>Owner ID</label>
            <div className="input-icon">
              <Icon name="user" size={17} />
              <input
                className="input"
                required
                value={form.userId}
                onChange={(event) => setForm({ ...form, userId: event.target.value })}
                placeholder="owner"
                autoComplete="username"
              />
            </div>
          </div>
          <div className="field">
            <label>Password</label>
            <div className="input-icon">
              <Icon name="shield" size={17} />
              <input
                className="input"
                required
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                placeholder="Your owner password"
                autoComplete="current-password"
              />
            </div>
          </div>
        </div>

        {error ? (
          <div style={{ marginTop: 16 }}>
            <Alert kind="err">{error}</Alert>
          </div>
        ) : null}

        <div style={{ marginTop: 18 }}>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Signing in...
              </>
            ) : (
              <>
                Open master panel <Icon name="right" size={17} />
              </>
            )}
          </button>
        </div>

        <div className="own-gate-foot">
          Credentials come from OWNER_ID and OWNER_PASSWORD in the backend .env file - there is no owner account in the
          database, so this login cannot be created or changed through the API.
        </div>
      </form>
    </div>
  );
}

/* Add and edit share one modal. In edit mode the password field is optional and
   is only sent when actually filled in, so saving never resets a password by
   accident. clinicId is never editable: it is the tenant key stamped on every
   appointment row. */
function ListingFormModal({ clinic, close, notify, onSaved, onExpired }) {
  const editing = Boolean(clinic);
  const [form, setForm] = useState({
    clinicName: editing ? clinic.clinicName || '' : '',
    doctorName: editing ? clinic.doctorName || '' : '',
    specialization: editing ? clinic.specialization || 'General Physician' : 'General Physician',
    address: editing ? clinic.address || '' : '',
    city: editing ? clinic.city || '' : '',
    phone: editing ? clinic.phone || '' : '',
    timings: editing ? clinic.timings || '' : '',
    photo: editing ? clinic.photo || '' : '',
    about: editing ? clinic.about || '' : '',
    adminUserId: editing ? clinic.adminUserId || '' : '',
    adminEmail: editing ? clinic.adminEmail || '' : '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (key) => (event) => setForm((prev) => Object.assign({}, prev, { [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');

    const body = Object.assign({}, form);
    if (editing && !body.password) delete body.password;

    const data = editing
      ? await api('/owner/clinics/' + clinic.clinicId, { method: 'PUT', owner: true, body })
      : await api('/owner/clinics', { method: 'POST', owner: true, body });

    setBusy(false);
    if (!data.success) {
      if (data.unauthorized) {
        onExpired();
        return;
      }
      setError(data.message);
      return;
    }
    notify(data.message, 'ok');
    onSaved();
    close();
  };

  return (
    <Modal
      wide
      title={editing ? 'Edit listing' : 'Add a listing'}
      subtitle={
        editing
          ? clinic.clinicName + ' - changes go live immediately'
          : 'Owner-created listings skip the approval queue and are published straight away'
      }
      onClose={close}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" form="listing-form" disabled={busy}>
            {busy ? (
              <>
                <Spinner /> Saving...
              </>
            ) : (
              <>
                <Icon name="check" size={16} /> {editing ? 'Save changes' : 'Add and publish'}
              </>
            )}
          </button>
        </>
      }
    >
      <form id="listing-form" className="form-grid" onSubmit={submit} noValidate>
        <div className="field">
          <label>
            Clinic / hospital name <span className="req">*</span>
          </label>
          <input className="input" required value={form.clinicName} onChange={set('clinicName')} placeholder="Vrindavan Hospital" />
        </div>

        <div className="field">
          <label>
            Doctor name <span className="req">*</span>
          </label>
          <input className="input" required value={form.doctorName} onChange={set('doctorName')} placeholder="Dr. Arnav Tyagi (MBBS)" />
        </div>

        <div className="field">
          <label>
            Specialization <span className="req">*</span>
          </label>
          <select className="select" value={form.specialization} onChange={set('specialization')}>
            {SPECIALIZATIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>
            Address <span className="req">*</span>
          </label>
          <textarea className="textarea" required rows={2} value={form.address} onChange={set('address')} placeholder="Street, area, landmark" />
        </div>

        <div className="field">
          <label>City</label>
          <input className="input" value={form.city} onChange={set('city')} placeholder="Agartala" />
        </div>

        <div className="field">
          <label>
            Clinic phone (10 digits) <span className="req">*</span>
          </label>
          <input className="input" required inputMode="numeric" maxLength={10} value={form.phone} onChange={set('phone')} placeholder="9876543210" />
        </div>

        <div className="field">
          <label>Opening hours</label>
          <input className="input" value={form.timings} onChange={set('timings')} placeholder="Mon-Sat, 9:00 AM - 2:00 PM" />
        </div>

        <div className="field">
          <label>Photo URL</label>
          <input className="input" value={form.photo} onChange={set('photo')} placeholder="https://..." />
        </div>

        <div className="field">
          <label>About</label>
          <textarea className="textarea" rows={3} value={form.about} onChange={set('about')} placeholder="A short description shown on the public page." />
        </div>

        <div className="field">
          <label>
            Admin user ID <span className="req">*</span>
          </label>
          <input className="input" required value={form.adminUserId} onChange={set('adminUserId')} placeholder="vrindavan.admin" autoComplete="off" />
        </div>

        <div className="field">
          <label>
            Admin email <span className="req">*</span>
          </label>
          <input className="input" required type="email" value={form.adminEmail} onChange={set('adminEmail')} placeholder="clinic@example.com" />
        </div>

        <div className="field">
          <label>
            {editing ? 'New password' : 'Password'} {editing ? null : <span className="req">*</span>}
          </label>
          <input
            className="input"
            required={!editing}
            type="password"
            value={form.password}
            onChange={set('password')}
            placeholder={editing ? 'Leave blank to keep the current password' : 'At least 6 characters'}
            autoComplete="new-password"
          />
        </div>

        {error ? <Alert kind="err">{error}</Alert> : null}
      </form>
    </Modal>
  );
}

function OwnerPanel({ go, notify }) {
  const [owner, setOwner] = useState(getStoredOwner());
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState('requests');
  const [view, setView] = useState('cards');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [visibility, setVisibility] = useState('all');
  const [overview, setOverview] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const [formState, setFormState] = useState(null);
  const [detail, setDetail] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState('');

  const signOut = useCallback(
    (message) => {
      setOwnerToken('');
      setStoredOwner(null);
      setOwner(null);
      setRows([]);
      setOverview(null);
      if (message) notify(message, 'warn');
    },
    [notify]
  );

  // Verify a stored token against the server before trusting it.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!getOwnerToken()) {
        if (alive) setBooting(false);
        return;
      }
      const data = await api('/owner/me', { owner: true });
      if (!alive) return;
      if (data.success) {
        setOwner(data.owner);
        setStoredOwner(data.owner);
      } else {
        setOwnerToken('');
        setStoredOwner(null);
        setOwner(null);
      }
      setBooting(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Debounce typing so each keystroke does not fire a query.
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 320);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (silent) => {
      if (!silent) setLoading(true);
      setError('');

      const params = [];
      if (term) params.push('search=' + encodeURIComponent(term));
      if (tab === 'listings') {
        if (statusFilter !== 'all') params.push('status=' + encodeURIComponent(statusFilter));
        if (visibility !== 'all') params.push('visibility=' + encodeURIComponent(visibility));
      }
      const base = tab === 'requests' ? '/owner/requests' : '/owner/clinics';
      const path = base + (params.length ? '?' + params.join('&') : '');

      const [list, counts] = await Promise.all([api(path, { owner: true }), api('/owner/overview', { owner: true })]);

      if (list.unauthorized || counts.unauthorized) {
        signOut('Your owner session expired. Please sign in again.');
        setLoading(false);
        return;
      }
      if (list.success) setRows(list.clinics || []);
      else setError(list.message);
      if (counts.success) setOverview(counts.counts);
      setLoading(false);
    },
    [tab, term, statusFilter, visibility, signOut]
  );

  useEffect(() => {
    if (owner) load();
  }, [owner, load]);

  const act = async (clinic, kind, payload) => {
    setBusyId(clinic.clinicId);
    const base = '/owner/clinics/' + encodeURIComponent(clinic.clinicId);
    let data;
    if (kind === 'approve') data = await api(base + '/approve', { method: 'PUT', owner: true });
    else if (kind === 'reject') data = await api(base + '/reject', { method: 'PUT', owner: true, body: { note: payload || '' } });
    else if (kind === 'hide') data = await api(base + '/visibility', { method: 'PUT', owner: true, body: { hidden: true } });
    else if (kind === 'show') data = await api(base + '/visibility', { method: 'PUT', owner: true, body: { hidden: false } });
    else if (kind === 'delete') data = await api(base, { method: 'DELETE', owner: true });
    setBusyId('');

    if (!data || !data.success) {
      if (data && data.unauthorized) {
        signOut('Your owner session expired. Please sign in again.');
        return;
      }
      notify(data ? data.message : 'That action failed.', 'err');
      return;
    }
    notify(data.message, 'ok');
    setConfirm(null);
    setNote('');
    setDetail(null);
    load(true);
  };

  const tapProps = (fn) => ({
    role: 'button',
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fn();
      }
    },
  });

  if (booting) return <Loading label="Opening master panel" />;
  if (!owner) return <OwnerLoginPage go={go} notify={notify} onSignedIn={setOwner} />;

  const counts = overview || { total: 0, pending: 0, approved: 0, rejected: 0, hidden: 0, listed: 0, bookingsToday: 0 };

  const tabs = [
    ['overview', 'Overview', 'grid'],
    ['requests', 'Approval requests', 'shield'],
    ['listings', 'All listings', 'building'],
  ];

  const statusMeta = (clinic) => {
    if (clinic.status === 'pending') return ['pend', 'Pending'];
    if (clinic.status === 'rejected') return ['rej', 'Rejected'];
    if (clinic.hidden) return ['hid', 'Hidden'];
    return ['appr', 'Listed'];
  };

  const jumpTo = (nextTab, nextStatus, nextVisibility) => {
    setTab(nextTab);
    setStatusFilter(nextStatus || 'all');
    setVisibility(nextVisibility || 'all');
    setSearch('');
  };

  const cards = [
    { label: 'Pending requests', value: counts.pending, tone: 'c-amber', icon: 'clock', note: 'Waiting for your decision', go: () => jumpTo('requests') },
    { label: 'Listed publicly', value: counts.listed, tone: 'c-green', icon: 'check', note: 'Live on the homepage', go: () => jumpTo('listings', 'approved', 'visible') },
    { label: 'Hidden', value: counts.hidden, tone: 'c-blue', icon: 'ban', note: 'Approved but delisted', go: () => jumpTo('listings', 'approved', 'hidden') },
    { label: 'Rejected', value: counts.rejected, tone: 'c-red', icon: 'close', note: 'Declined listings', go: () => jumpTo('listings', 'rejected') },
    { label: 'Total clinics', value: counts.total, tone: 'c-teal', icon: 'building', note: 'Every registration', go: () => jumpTo('listings') },
    { label: 'Bookings today', value: counts.bookingsToday, tone: 'c-violet', icon: 'users', note: 'Across all clinics', go: null },
  ];

  const actionsFor = (clinic) => {
    const busy = busyId === clinic.clinicId;
    const buttons = [];

    if (clinic.status !== 'approved') {
      buttons.push(
        <button key="ap" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(clinic, 'approve')}>
          <Icon name="check" size={15} /> Approve
        </button>
      );
    }
    if (clinic.status === 'pending') {
      buttons.push(
        <button
          key="rj"
          className="btn btn-outline btn-sm"
          disabled={busy}
          onClick={() => {
            setNote('');
            setConfirm({ kind: 'reject', clinic });
          }}
        >
          <Icon name="ban" size={15} /> Reject
        </button>
      );
    }
    if (clinic.status === 'approved') {
      buttons.push(
        clinic.hidden ? (
          <button key="sh" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(clinic, 'show')}>
            <Icon name="undo" size={15} /> Unhide
          </button>
        ) : (
          <button key="hd" className="btn btn-soft btn-sm" disabled={busy} onClick={() => act(clinic, 'hide')}>
            <Icon name="ban" size={15} /> Hide
          </button>
        )
      );
    }

    buttons.push(
      <button key="ed" className="btn btn-soft btn-sm" disabled={busy} onClick={() => setFormState({ clinic })}>
        <Icon name="settings" size={15} /> Edit
      </button>
    );
    buttons.push(
      <button key="dt" className="btn btn-ghost btn-sm" onClick={() => setDetail(clinic)}>
        <Icon name="list" size={15} /> Details
      </button>
    );
    buttons.push(
      <button key="dl" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setConfirm({ kind: 'delete', clinic })}>
        <Icon name="close" size={15} /> Delete
      </button>
    );
    return buttons;
  };

  const renderCard = (clinic, index) => {
    const [tone, label] = statusMeta(clinic);
    return (
      <Reveal key={clinic.clinicId} delay={Math.min(index, 8) * 40}>
        <article className={'own-card ' + tone}>
          <div className="own-card-top">
            <Avatar clinic={clinic} />
            <div className="own-card-id">
              <b title={clinic.clinicName}>{clinic.clinicName}</b>
              <span title={clinic.doctorName}>{clinic.doctorName}</span>
            </div>
            <span className={'own-st ' + tone}>{label}</span>
          </div>

          <div className="own-tags">
            <span className="badge badge-general">
              <Icon name="stetho" size={12} /> {clinic.specialization || 'General Physician'}
            </span>
            <span className="badge badge-soft">
              <Icon name="ticket" size={12} /> {clinic.appointments} total
            </span>
            <span className="badge badge-soft">
              <Icon name="calendar" size={12} /> {clinic.appointmentsToday} today
            </span>
          </div>

          <div className="own-meta">
            <div>
              <Icon name="pin" size={15} />
              <span>{[clinic.address, clinic.city].filter(Boolean).join(', ') || 'No address on file'}</span>
            </div>
            <div>
              <Icon name="phone" size={15} />
              <span>{clinic.phone || 'No phone'}</span>
            </div>
            <div>
              <Icon name="mail" size={15} />
              <span>{clinic.adminEmail}</span>
            </div>
            <div>
              <Icon name="user" size={15} />
              <span>{clinic.adminUserId}</span>
            </div>
          </div>

          <div className="own-actions">{actionsFor(clinic)}</div>
        </article>
      </Reveal>
    );
  };

  const renderTable = () => (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Clinic</th>
            <th>Doctor</th>
            <th>Location</th>
            <th>Contact</th>
            <th>Admin</th>
            <th>Status</th>
            <th>Bookings</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((clinic) => {
            const [tone, label] = statusMeta(clinic);
            return (
              <tr key={clinic.clinicId}>
                <td>
                  <b>{clinic.clinicName}</b>
                  <span className="own-cell-sub">{clinic.specialization}</span>
                </td>
                <td>{clinic.doctorName}</td>
                <td>
                  {clinic.city || '-'}
                  <span className="own-cell-sub">{clinic.address}</span>
                </td>
                <td>
                  {clinic.phone}
                  <span className="own-cell-sub">{clinic.adminEmail}</span>
                </td>
                <td>{clinic.adminUserId}</td>
                <td>
                  <span className={'own-st ' + tone}>{label}</span>
                </td>
                <td>
                  {clinic.appointments}
                  <span className="own-cell-sub">{clinic.appointmentsToday} today</span>
                </td>
                <td>
                  <div className="own-actions" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
                    {actionsFor(clinic)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const searchBar = (
    <div className="own-bar">
      <div className="input-icon">
        <Icon name="search" size={17} />
        <input
          className="input"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search clinic name, doctor, email, mobile, admin user ID, address or city"
        />
      </div>

      {tab === 'listings' ? (
        <>
          <select className="select" style={{ maxWidth: 170 }} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <select className="select" style={{ maxWidth: 170 }} value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            <option value="all">Visible and hidden</option>
            <option value="visible">On the homepage</option>
            <option value="hidden">Hidden only</option>
          </select>
        </>
      ) : null}

      <div className="own-seg">
        <button className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')}>
          <Icon name="grid" size={15} /> Cards
        </button>
        <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
          <Icon name="list" size={15} /> List
        </button>
      </div>
    </div>
  );

  const emptyState = () => {
    if (tab === 'requests') {
      return (
        <div className="own-empty">
          <Icon name="check" size={30} />
          <b>{term ? 'No pending request matches that search' : 'No requests waiting'}</b>
          {term ? 'Try a clinic name, doctor, email, mobile number or admin user ID.' : 'Every registration has been reviewed. New requests appear here and are emailed to you.'}
        </div>
      );
    }
    return (
      <div className="own-empty">
        <Icon name="building" size={30} />
        <b>{term || statusFilter !== 'all' || visibility !== 'all' ? 'No listing matches those filters' : 'No clinics yet'}</b>
        {term || statusFilter !== 'all' || visibility !== 'all'
          ? 'Clear the search or filters to see everything.'
          : 'Use Add listing to create one yourself, or wait for a clinic to register.'}
      </div>
    );
  };

  return (
    <div className="adm">
      {sidebar ? <div className="adm-scrim" onClick={() => setSidebar(false)} /> : null}

      <aside className={'adm-side' + (sidebar ? ' open' : '')}>
        <button className="brand" onClick={() => go('/')}>
          <span className="brand-mark">
            <Cross size={18} />
          </span>
          MediCare <i>Flow</i>
        </button>

        <div className="adm-clinic">
          <div className="cc-av">
            <Icon name="shield" size={18} />
          </div>
          <div>
            <b>Master admin</b>
            <span>{owner.ownerId}</span>
          </div>
        </div>

        <nav className="adm-nav">
          {tabs.map(([id, label, icon]) => (
            <button
              key={id}
              className={tab === id ? 'on' : ''}
              onClick={() => {
                setTab(id);
                setSidebar(false);
              }}
            >
              <Icon name={icon} size={17} /> {label}
              {id === 'requests' && counts.pending ? <span className="count">{counts.pending}</span> : null}
            </button>
          ))}
          <button
            onClick={() => {
              setFormState({ clinic: null });
              setSidebar(false);
            }}
          >
            <Icon name="plus" size={17} /> Add listing
          </button>
        </nav>

        <div className="adm-side-foot">
          <button onClick={() => go('/')}>
            <Icon name="right" size={16} /> View public homepage
          </button>
          <button onClick={() => signOut('Signed out of the master panel.')}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      </aside>

      <main className="adm-main">
        <div className="adm-top">
          <div className="row">
            <button className="btn-icon adm-burger" onClick={() => setSidebar(true)} aria-label="Open menu">
              <Icon name="menu" size={19} />
            </button>
            <div>
              <h1>{tabs.find(([id]) => id === tab)[1]}</h1>
              <p className="sub">
                {tab === 'requests'
                  ? counts.pending + ' request(s) awaiting approval'
                  : tab === 'listings'
                    ? rows.length + ' listing(s) shown'
                    : 'Platform-wide listing control'}
              </p>
            </div>
          </div>

          <div className="adm-top-actions">
            <button className="btn btn-soft btn-sm" onClick={() => load()}>
              <Icon name="refresh" size={15} /> Refresh
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => setFormState({ clinic: null })}>
              <Icon name="plus" size={15} /> Add listing
            </button>
          </div>
        </div>

        <div className="adm-body">
          {error ? <Alert kind="err">{error}</Alert> : null}

          {tab === 'overview' ? (
            <>
              <div className="stat-grid">
                {cards.map((card) => (
                  <div
                    key={card.label}
                    className={'stat ' + card.tone + (card.go ? ' tap' : '')}
                    {...(card.go ? tapProps(card.go) : {})}
                  >
                    <span className="stat-ico">
                      <Icon name={card.icon} size={21} />
                    </span>
                    <span className="stat-txt">
                      <small>{card.label}</small>
                      <b>
                        <CountUp value={card.value} />
                      </b>
                      <span>{card.note}</span>
                    </span>
                  </div>
                ))}
              </div>

              {counts.pending ? (
                <div className="own-note">
                  {counts.pending} clinic listing(s) are waiting for your approval. Until you approve them they stay off the
                  public homepage and cannot take online bookings.
                </div>
              ) : null}

              <div className="own-note" style={{ background: '#f0f9ff', borderColor: '#7dd3fc', color: '#075985' }}>
                Hiding a listing removes it from the public homepage only. The clinic keeps working, so patients who already
                hold a token can still track the live queue. Rejecting is the decision to keep it off the platform.
              </div>
            </>
          ) : (
            <>
              {searchBar}

              {loading ? (
                <SkeletonCards count={6} />
              ) : rows.length === 0 ? (
                emptyState()
              ) : view === 'cards' ? (
                <div className="own-grid">{rows.map(renderCard)}</div>
              ) : (
                renderTable()
              )}
            </>
          )}
        </div>
      </main>

      {formState ? (
        <ListingFormModal
          clinic={formState.clinic}
          close={() => setFormState(null)}
          notify={notify}
          onSaved={() => load(true)}
          onExpired={() => signOut('Your owner session expired. Please sign in again.')}
        />
      ) : null}

      {detail ? (
        <Modal
          title={detail.clinicName}
          subtitle={detail.doctorName + ' - ' + detail.specialization}
          onClose={() => setDetail(null)}
          footer={
            <button className="btn btn-ghost" onClick={() => setDetail(null)}>
              Close
            </button>
          }
        >
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <span className={'own-st ' + statusMeta(detail)[0]}>{statusMeta(detail)[1]}</span>
            </dd>
            <dt>Clinic ID</dt>
            <dd>{detail.clinicId}</dd>
            <dt>Address</dt>
            <dd>{[detail.address, detail.city].filter(Boolean).join(', ') || '-'}</dd>
            <dt>Clinic phone</dt>
            <dd>{detail.phone || '-'}</dd>
            <dt>Opening hours</dt>
            <dd>{detail.timings || '-'}</dd>
            <dt>Admin user ID</dt>
            <dd>{detail.adminUserId}</dd>
            <dt>Admin email</dt>
            <dd>{detail.adminEmail}</dd>
            <dt>Registered</dt>
            <dd>{detail.createdAt ? fmtDate(String(detail.createdAt).slice(0, 10)) : '-'}</dd>
            <dt>Decision</dt>
            <dd>{detail.decidedAt ? fmtDate(String(detail.decidedAt).slice(0, 10)) + ' by ' + (detail.decidedBy || 'owner') : 'Not decided yet'}</dd>
            {detail.rejectionNote ? (
              <>
                <dt>Rejection note</dt>
                <dd>{detail.rejectionNote}</dd>
              </>
            ) : null}
            <dt>Total bookings</dt>
            <dd>
              {detail.appointments} ({detail.appointmentsToday} today)
            </dd>
            <dt>About</dt>
            <dd>{detail.about || '-'}</dd>
          </dl>
        </Modal>
      ) : null}

      {confirm && confirm.kind === 'reject' ? (
        <Modal
          title="Reject this listing request"
          subtitle={confirm.clinic.clinicName}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={busyId === confirm.clinic.clinicId} onClick={() => act(confirm.clinic, 'reject', note)}>
                <Icon name="ban" size={16} /> Reject listing
              </button>
            </>
          }
        >
          <div className="form-grid">
            <p className="small muted">
              The clinic keeps its admin account and can sign in, but it will not appear on the public homepage. Your reason
              is emailed to {confirm.clinic.adminEmail}.
            </p>
            <div className="field">
              <label>Reason (optional, included in the email)</label>
              <textarea
                className="textarea"
                rows={3}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="For example: the address could not be verified."
              />
            </div>
          </div>
        </Modal>
      ) : null}

      {confirm && confirm.kind === 'delete' ? (
        <Modal
          title="Delete this listing permanently"
          subtitle={confirm.clinic.clinicName}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={busyId === confirm.clinic.clinicId} onClick={() => act(confirm.clinic, 'delete')}>
                <Icon name="close" size={16} /> Delete everything
              </button>
            </>
          }
        >
          <Alert kind="err">
            This removes the clinic, its admin login, all {confirm.clinic.appointments} appointment record(s) and its queue
            counters. It cannot be undone. To take a clinic off the homepage without losing data, use Hide instead.
          </Alert>
        </Modal>
      ) : null}
    </div>
  );
}

export default function App() {
  const [route, go] = useHashRoute();
  const { items, notify, dismiss } = useToasts();
  const [health, setHealth] = useState('checking');

  useEffect(() => {
    injectStyles();
  }, []);

  useEffect(() => {
    let alive = true;
    api('/health').then((data) => {
      if (!alive) return;
      setHealth(data.success ? 'up' : 'down');
    });
    return () => {
      alive = false;
    };
  }, []);

  const onSession = useCallback((token, clinic) => {
    setToken(token);
    setStoredClinic(clinic);
  }, []);

  const chrome = route.name === 'home' || route.name === 'booking' || route.name === 'track';

  return (
    <div className="mcf">
      {chrome ? <Navbar go={go} active={route.name} /> : null}

      {health === 'down' ? (
        <div className="container" style={{ paddingTop: 16 }}>
          <Alert kind="warn">
            The frontend cannot reach the API at {API}. Start the backend with <b>nodemon Server.js</b> (it listens on port 5000)
            or set VITE_API_URL in your frontend .env file.
          </Alert>
        </div>
      ) : null}

      <ErrorBoundary key={route.name + ':' + (route.id || '')}>
        {route.name === 'home' ? <HomePage go={go} /> : null}
        {route.name === 'booking' ? <BookingPage clinicId={route.id} go={go} notify={notify} /> : null}
        {route.name === 'track' ? <QueueTrackPage clinicId={route.id} go={go} /> : null}
        {route.name === 'register' ? <RegisterPage go={go} notify={notify} onSession={onSession} /> : null}
        {route.name === 'login' ? <LoginPage go={go} notify={notify} onSession={onSession} /> : null}
        {route.name === 'forgot' ? <ForgotPage go={go} notify={notify} onSession={onSession} /> : null}
        {route.name === 'admin' ? <AdminDashboard routeClinicId={route.id} go={go} notify={notify} /> : null}
        {route.name === 'owner' ? <OwnerPanel go={go} notify={notify} /> : null}
      </ErrorBoundary>

      {chrome ? <Footer go={go} /> : null}

      <Toasts items={items} dismiss={dismiss} />
    </div>
  );
}
