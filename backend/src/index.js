const express = require('express');
const session = require('express-session');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const path = require('path');

const app = express();

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'market_portal',
  user: process.env.POSTGRES_USER || 'portal_user',
  password: process.env.POSTGRES_PASSWORD,
});

// ── Init DB schema ────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      report_date DATE NOT NULL DEFAULT CURRENT_DATE,
      status TEXT NOT NULL DEFAULT 'draft',
      commentary TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      action TEXT NOT NULL,
      report_id INT REFERENCES reports(id),
      detail TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed an admin user if none exist
  const existing = await pool.query('SELECT id FROM users LIMIT 1');
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'changeme123', 12);
    await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [process.env.ADMIN_USERNAME || 'admin', hash]
    );
    console.log('Seeded default admin user.');
  }

  // Seed a sample report if none exist
  const reports = await pool.query('SELECT id FROM reports LIMIT 1');
  if (reports.rows.length === 0) {
    await pool.query(`
      INSERT INTO reports (title, report_date, status)
      VALUES ('Market Report – ' || TO_CHAR(NOW(), 'Mon DD, YYYY'), CURRENT_DATE, 'draft')
    `);
  }

  console.log('Database ready.');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../frontend/public')));

app.use(cors({
  origin: process.env.PORTAL_ORIGIN || true,
  credentials: true,
}));

app.use(session({
  secret: process.env.SESSION_SECRET || 'replace-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId = user.id;
    req.session.username = user.username;

    await pool.query(
      'INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)',
      [user.id, 'LOGIN', `User ${user.username} logged in`]
    );

    res.json({ ok: true, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, username: req.session.username });
});

// ── Report routes ─────────────────────────────────────────────────────────────
app.get('/api/reports', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM reports ORDER BY report_date DESC LIMIT 20'
  );
  res.json(result.rows);
});

app.get('/api/reports/latest', requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM reports WHERE status != 'sent' ORDER BY report_date DESC LIMIT 1"
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'No active report found' });
  res.json(result.rows[0]);
});

app.get('/api/reports/:id', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(result.rows[0]);
});

app.patch('/api/reports/:id/commentary', requireAuth, async (req, res) => {
  const { commentary } = req.body;
  if (typeof commentary === 'undefined') return res.status(400).json({ error: 'commentary required' });

  try {
    const result = await pool.query(
      `UPDATE reports
       SET commentary = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'draft'
       RETURNING *`,
      [commentary, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Report not found or already sent' });

    await pool.query(
      'INSERT INTO audit_log (user_id, action, report_id, detail) VALUES ($1, $2, $3, $4)',
      [req.session.userId, 'EDIT_COMMENTARY', req.params.id, `Commentary updated by ${req.session.username}`]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve → moves status from draft to approved
app.post('/api/reports/:id/approve', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE reports SET status = 'approved', updated_at = NOW()
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Report not found or not in draft state' });

    await pool.query(
      'INSERT INTO audit_log (user_id, action, report_id, detail) VALUES ($1, $2, $3, $4)',
      [req.session.userId, 'APPROVE', req.params.id, `Approved by ${req.session.username}`]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send → calls n8n webhook, marks as sent
app.post('/api/reports/:id/send', requireAuth, async (req, res) => {
  try {
    const report = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    const r = report.rows[0];
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.status !== 'approved') return res.status(400).json({ error: 'Report must be approved before sending' });

    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    if (!n8nUrl) return res.status(500).json({ error: 'N8N_WEBHOOK_URL not configured' });

    // Call n8n webhook with report data
    const webhookRes = await fetch(n8nUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_id: r.id,
        title: r.title,
        report_date: r.report_date,
        commentary: r.commentary,
        triggered_by: req.session.username,
      }),
    });

    if (!webhookRes.ok) {
      const body = await webhookRes.text();
      console.error('n8n webhook error:', webhookRes.status, body);
      return res.status(502).json({ error: `n8n webhook returned ${webhookRes.status}` });
    }

    await pool.query(
      `UPDATE reports SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [r.id]
    );

    await pool.query(
      'INSERT INTO audit_log (user_id, action, report_id, detail) VALUES ($1, $2, $3, $4)',
      [req.session.userId, 'SEND', r.id, `Sent by ${req.session.username}`]
    );

    res.json({ ok: true, message: 'Report dispatched via n8n.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Audit log
app.get('/api/audit', requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT al.*, u.username FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC LIMIT 50
  `);
  res.json(result.rows);
});

// Catch-all → serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/public/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Market Portal running on :${PORT}`));
}).catch(err => {
  console.error('Failed to initialise DB:', err);
  process.exit(1);
});
