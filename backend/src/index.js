const pgSession = require('connect-pg-simple')(require('express-session'));
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
  database: process.env.POSTGRES_DB || 'weeklyreport',
  user: process.env.POSTGRES_USER || 'portal_user',
  password: process.env.POSTGRES_PASSWORD,
});

async function connectDB() {
  await pool.query('SELECT 1');
  console.log('Database connection OK.');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '../../frontend/public')));

app.use(cors({
  origin: process.env.PORTAL_ORIGIN || true,
  credentials: true,
}));

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
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

// ── Weekly sales + commentary ─────────────────────────────────────────────────
// Returns S-region offering rows for the current Mon–Sun week,
// each joined with existing commentary (if any)
app.get('/api/week', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        o.sale_date,
        o.offered,
        o.sold,
        o.passed_in,
        o.reoffered,
        c.salecommentary
      FROM offering o
      LEFT JOIN commentary c ON c.saledate = o.sale_date
      WHERE
        o.region_code = 'S'
        AND o.sale_date >= date_trunc('week', CURRENT_DATE)
        AND o.sale_date <  date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'
      ORDER BY o.sale_date ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Save commentary (upsert) ──────────────────────────────────────────────────
app.post('/api/commentary', requireAuth, async (req, res) => {
  const { saledate, salecommentary } = req.body;
  if (!saledate || typeof salecommentary === 'undefined') {
    return res.status(400).json({ error: 'saledate and salecommentary are required' });
  }

  try {
    // Verify this date exists in the offering table for region S
    const check = await pool.query(
      "SELECT 1 FROM offering WHERE sale_date = $1 AND region_code = 'S'",
      [saledate]
    );
    if (!check.rows[0]) {
      return res.status(400).json({ error: 'No S-region sale found for that date' });
    }

    // Upsert: update if exists, insert if not
    await pool.query(`
      INSERT INTO commentary (saledate, salecommentary)
      VALUES ($1, $2)
      ON CONFLICT (saledate)
      DO UPDATE SET salecommentary = EXCLUDED.salecommentary
    `, [saledate, salecommentary]);

    await pool.query(
      'INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)',
      [req.session.userId, 'SAVE_COMMENTARY', `Commentary saved for ${saledate} by ${req.session.username}`]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Trigger n8n webhook ───────────────────────────────────────────────────────
app.post('/api/dispatch', requireAuth, async (req, res) => {
  try {
    const n8nUrl = process.env.N8N_WEBHOOK_URL;
    if (!n8nUrl) return res.status(500).json({ error: 'N8N_WEBHOOK_URL not configured' });

    // Gather this week's data + commentary to send along
    const result = await pool.query(`
      SELECT
        o.sale_date,
        o.offered,
        o.sold,
        o.passed_in,
        o.reoffered,
        c.salecommentary
      FROM offering o
      LEFT JOIN commentary c ON c.saledate = o.sale_date
      WHERE
        o.region_code = 'S'
        AND o.sale_date >= date_trunc('week', CURRENT_DATE)
        AND o.sale_date <  date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'
      ORDER BY o.sale_date ASC
    `);

    const webhookRes = await fetch(n8nUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        triggered_by: req.session.username,
        week_starting: new Date(Date.now()).toISOString().split('T')[0],
        sales: result.rows,
      }),
    });

    if (!webhookRes.ok) {
      const body = await webhookRes.text();
      console.error('n8n webhook error:', webhookRes.status, body);
      return res.status(502).json({ error: `n8n webhook returned ${webhookRes.status}` });
    }

    await pool.query(
      'INSERT INTO audit_log (user_id, action, detail) VALUES ($1, $2, $3)',
      [req.session.userId, 'DISPATCH', `Report dispatched by ${req.session.username}`]
    );

    res.json({ ok: true, message: 'Report dispatched via n8n.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Audit log ─────────────────────────────────────────────────────────────────
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
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Market Portal running on :${PORT}`));
}).catch(err => {
  console.error('Failed to connect to database:', err);
  process.exit(1);
});
