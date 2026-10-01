const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ---------------------------------------------------------------------------
// Split Bill — bills and their per-person shares.
//
// Amounts live as integer cents (`*_cents` columns), never floats. Bills are
// per-user (only the creator sees them), so both tables are marked
// `staging:private`: staging clones get the schema without anyone's rows.
// ---------------------------------------------------------------------------

const MAX_PARTICIPANTS = 20;
const MAX_NAME_LENGTH = 60;
const MAX_TITLE_LENGTH = 200;
const MAX_TOTAL_CENTS = 100000000; // $1,000,000.00

// "42", "42.5" and "42.75" are accepted; anything else is not an amount.
function amountToCents(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/^\$/, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = parseInt(m[1], 10) * 100 + (m[2] ? parseInt((m[2] + '00').slice(0, 2), 10) : 0);
  if (cents <= 0 || cents > MAX_TOTAL_CENTS) return null;
  return cents;
}

// Split `total` cents evenly across `n` people, handing the spare cents
// (at most n-1) to the first people on the list so the shares always sum
// back to the total.
function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const remainder = total % n;
  const shares = [];
  for (let i = 0; i < n; i++) shares.push(base + (i < remainder ? 1 : 0));
  return shares;
}

// Request-time demo injection (staging previews only). The demo bills exist
// only inside these responses — nothing is written to the database, so the
// plain route still answers exactly what production would.
const DEMO_BILLS = [
  {
    id: -1,
    title: 'Staging demo: Pizza night',
    total_cents: 4860,
    payer: 'Alex',
    created_at: '2026-09-27T18:30:00.000Z',
    shares: [
      { id: -11, username: 'Alex', share_cents: 1620, is_payer: true, paid: true },
      { id: -12, username: 'Sam', share_cents: 1620, is_payer: false, paid: true },
      { id: -13, username: 'Jordan', share_cents: 1620, is_payer: false, paid: false },
    ],
  },
  {
    id: -2,
    title: 'Staging demo: Movie tickets',
    total_cents: 3600,
    payer: 'Sam',
    created_at: '2026-09-30T20:00:00.000Z',
    shares: [
      { id: -21, username: 'Sam', share_cents: 1200, is_payer: true, paid: true },
      { id: -22, username: 'Alex', share_cents: 1200, is_payer: false, paid: false },
      { id: -23, username: 'Jordan', share_cents: 1200, is_payer: false, paid: false },
    ],
  },
];

function demoEnabled(req) {
  return IS_STAGING && req.query.demo === '1';
}

function demoBillMeta(bill) {
  return {
    id: bill.id,
    title: bill.title,
    total_cents: bill.total_cents,
    payer: bill.payer,
    created_at: bill.created_at,
    owed_count: bill.shares.filter((s) => !s.is_payer).length,
    paid_count: bill.shares.filter((s) => !s.is_payer && s.paid).length,
  };
}

const BILL_LIST_SQL = `
  SELECT b.id, b.title, b.total_cents, b.payer, b.created_at,
         COUNT(*) FILTER (WHERE NOT s.is_payer)::int AS owed_count,
         COUNT(*) FILTER (WHERE NOT s.is_payer AND s.paid)::int AS paid_count
  FROM bills b
  LEFT JOIN bill_shares s ON s.bill_id = b.id
  WHERE b.user_id = $1
  GROUP BY b.id
  ORDER BY b.created_at DESC, b.id DESC
`;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// List the signed-in user's bills (newest first), each with how many of the
// non-payer shares are settled so the list card can show progress.
app.get('/api/bills', async (req, res) => {
  try {
    const { rows } = await pool.query(BILL_LIST_SQL, [req.user.id]);
    if (demoEnabled(req)) {
      return res.json({ bills: rows.concat(DEMO_BILLS.map(demoBillMeta)), demo: true });
    }
    res.json({ bills: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a bill: title, total and who paid, split equally across the named
// friends. The payer gets a settled share row; everyone else starts owing.
app.post('/api/bills', async (req, res) => {
  try {
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length < 3) return res.status(400).json({ error: 'Title needs at least 3 characters.' });
    if (title.length > MAX_TITLE_LENGTH) {
      return res.status(400).json({ error: 'Title is too long (200 characters max).' });
    }

    const cents = amountToCents(body.amount);
    if (cents === null) return res.status(400).json({ error: 'Enter an amount greater than zero.' });

    const rawNames = Array.isArray(body.participants) ? body.participants : [];
    const byKey = new Map();
    for (const entry of rawNames) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim().replace(/\s+/g, ' ');
      if (!name) continue;
      if (name.length > MAX_NAME_LENGTH) {
        return res.status(400).json({ error: 'Names must be 60 characters or fewer.' });
      }
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, name);
    }
    const participants = [...byKey.values()];
    if (participants.length < 2) return res.status(400).json({ error: 'Add at least two friends.' });
    if (participants.length > MAX_PARTICIPANTS) {
      return res.status(400).json({ error: 'A bill can have at most 20 people.' });
    }

    const payerKey = typeof body.payer === 'string' ? body.payer.trim().toLowerCase() : '';
    if (!byKey.has(payerKey)) {
      return res.status(400).json({ error: 'Pick who paid from the friends list.' });
    }
    const payer = byKey.get(payerKey);
    const payerIndex = participants.findIndex((n) => n.toLowerCase() === payerKey);
    const shares = splitEvenly(cents, participants.length);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const billResult = await client.query(
        `INSERT INTO bills (user_id, title, total_cents, payer)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, total_cents, payer, created_at`,
        [req.user.id, title, cents, payer]
      );
      const bill = billResult.rows[0];
      const values = [];
      const params = [];
      participants.forEach((name, i) => {
        const o = params.length;
        values.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`);
        params.push(bill.id, name, shares[i], i === payerIndex, i === payerIndex);
      });
      await client.query(
        `INSERT INTO bill_shares (bill_id, username, share_cents, is_payer, paid)
         VALUES ${values.join(', ')}`,
        params
      );
      const shareRows = await client.query(
        `SELECT id, username, share_cents, is_payer, paid FROM bill_shares WHERE bill_id = $1 ORDER BY id`,
        [bill.id]
      );
      await client.query('COMMIT');
      res.status(201).json({ bill, shares: shareRows.rows });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One bill with its per-person split, payer first in the shares list.
app.get('/api/bills/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    if (demoEnabled(req) && id < 0) {
      const demo = DEMO_BILLS.find((b) => b.id === id);
      if (!demo) return res.status(404).json({ error: 'Bill not found.' });
      return res.json({
        bill: { id, title: demo.title, total_cents: demo.total_cents, payer: demo.payer, created_at: demo.created_at },
        shares: demo.shares,
        demo: true,
      });
    }
    const { rows } = await pool.query(
      `SELECT id, title, total_cents, payer, created_at FROM bills WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bill not found.' });
    const shareRows = await pool.query(
      `SELECT id, username, share_cents, is_payer, paid FROM bill_shares WHERE bill_id = $1 ORDER BY id`,
      [id]
    );
    res.json({ bill: rows[0], shares: shareRows.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark a friend's share as paid (or undo it). The payer's own share is not
// toggleable — they paid the bill, nobody owes them their own share.
app.post('/api/bills/:id/shares/:shareId/toggle', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const shareId = parseInt(req.params.shareId, 10);
  if (demoEnabled(req) && id < 0 && shareId < 0) {
    const demo = DEMO_BILLS.find((b) => b.id === id);
    const share = demo && demo.shares.find((s) => s.id === shareId);
    if (!share) return res.status(404).json({ error: 'Share not found.' });
    if (share.is_payer) return res.status(400).json({ error: 'The payer does not owe a share.' });
    // Flip a copy for the response only: demo state never persists anywhere.
    return res.json({ share: { ...share, paid: !share.paid } });
  }
  try {
    const owned = await pool.query(
      `SELECT s.id, s.is_payer
       FROM bill_shares s
       JOIN bills b ON b.id = s.bill_id
       WHERE s.id = $1 AND s.bill_id = $2 AND b.user_id = $3`,
      [shareId, id, req.user.id]
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Share not found.' });
    if (owned.rows[0].is_payer) return res.status(400).json({ error: 'The payer does not owe a share.' });
    const { rows } = await pool.query(
      `UPDATE bill_shares SET paid = NOT paid WHERE id = $1
       RETURNING id, username, share_cents, is_payer, paid`,
      [shareId]
    );
    res.json({ share: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// `index: false` keeps the directory index off so an unauthenticated visit
// to `/` falls through to the gated HTML handler below instead of the shell
// being served straight off the static middleware. Real assets (JS, CSS)
// still come from here.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/split-bill-315f1e/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/split-bill-315f1e/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let shuttingDown = false;

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bills (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL,
      total_cents INTEGER NOT NULL,
      payer VARCHAR(60) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bills_user_idx ON bills (user_id, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bill_shares (
      id SERIAL PRIMARY KEY,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      username VARCHAR(60) NOT NULL,
      share_cents INTEGER NOT NULL,
      is_payer BOOLEAN NOT NULL DEFAULT FALSE,
      paid BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS bill_shares_bill_idx ON bill_shares (bill_id)`);
  // Bills belong to one person and hold who they lent money to, so a
  // stranger reading every row would see private financial detail. Staging
  // clones get the schema only; previews use the ?demo=1 fixtures instead.
  await pool.query(`COMMENT ON TABLE bills IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE bill_shares IS 'staging:private'`);
  // The starter template's demo table goes away with the template screen.
  await pool.query(`DROP TABLE IF EXISTS presses`);

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops and replaces this container on every deploy with a
  // bounded grace period: stop accepting connections, drain in-flight
  // requests, close the pool, exit. Idempotent so a second signal is a no-op.
  return server;
}

const DRAIN_MS = 3000;
let currentServer = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (currentServer) {
    currentServer.close(() => {});
    currentServer.closeIdleConnections?.();
    const t = setTimeout(() => currentServer.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (err) {
    console.error('[shutdown] pool.end failed', err.message);
  }
  process.exit(0);
}

start()
  .then((server) => {
    currentServer = server;
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch(err => { console.error(err); process.exit(1); });