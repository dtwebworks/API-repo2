// api-server.js
// COMPLETE INSTAGRAM-OPTIMIZED SMART CACHE-FIRST API SERVER
// + Lightweight Account→Checkout flow (no DB) for Instagram DM bots

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const axios = require('axios');
const crypto = require('crypto');
const cookie = require('cookie');
const { createClient } = require('@supabase/supabase-js'); // kept (still disabled below)
require('dotenv').config();

class SmartCacheFirstAPI {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;

    // KEYS / CONFIG
    this.apiKey = process.env.VC_API_KEY || 'your-secure-api-key';
    this.rapidApiKey = process.env.RAPIDAPI_KEY;
    this.claudeApiKey = process.env.ANTHROPIC_API_KEY;
    this.STRIPE_CHECKOUT_URL =
      process.env.STRIPE_CHECKOUT_URL ||
      'https://buy.stripe.com/dRm00lbY3dwg5ZAble9R600';
    this.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null;

    // Initialize Supabase lazily when first needed (still disabled)
    this._supabase = null;

    // In-memory job storage
    this.activeJobs = new Map();
    this.jobResults = new Map();

    // Cache settings
    this.cacheMaxAgeDays = 30;
    this.thresholdSteps = [5, 4, 3, 2, 1];

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  // ===== Utilities =====
  baseUrl(req) {
    if (this.PUBLIC_BASE_URL) return this.PUBLIC_BASE_URL;
    return `${req.protocol}://${req.get('host')}`;
  }

  // HMAC signer (no DB auth)
  signPayload(payloadObj) {
    const secret = this.apiKey; // reuse API key so you don't manage another secret
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifySignedToken(token) {
    try {
      const secret = this.apiKey;
      const [payload, sig] = token.split('.');
      if (!payload || !sig) return null;
      const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      // Expiry (default 2 hours)
      if (obj.exp && Date.now() > obj.exp) return null;
      return obj;
    } catch {
      return null;
    }
  }

  // Fake Supabase accessor (still disabled)
  get supabase() {
    console.log('🔍 SKIPPING Supabase client creation (database disabled for testing)');
    return null;
  }

  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(compression());
    this.app.use(
      cors({
        origin: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
        credentials: true,
      })
    );

    this.app.set('trust proxy', true);

    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: 15 * 60,
      },
    });
    this.app.use('/api/', limiter);

    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Request log
    this.app.use((req, _res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  // API key middleware (used for /api/* after health/docs/home)
  authenticateAPI(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!apiKey || apiKey !== this.apiKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Valid API key required in X-API-Key header',
      });
    }
    return next();
  }

  setupRoutes() {
    // ===== Public Docs =====
    this.app.get('/api', (req, res) => {
      const baseUrl = this.baseUrl(req);
      res.send(this.renderDocsHtml(baseUrl));
    });

    // ===== Public Home =====
    this.app.get('/', (req, res) => {
      const baseUrl = this.baseUrl(req);
      res.send(this.renderHomeHtml(baseUrl));
    });

    // ===== Health (Public) =====
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        service: 'nyc_full_api',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '3.1.0',
        mode: 'comprehensive_scraping_with_railway_functions_integration',
        features: [
          'smart_search',
          'job_queue',
          'railway_function_fallback',
          'instagram_dm_ready',
          'comprehensive_analysis',
          'similar_listings_fallback',
          'account_to_checkout_no_db',
        ],
        activeJobs: this.activeJobs.size,
        queueStatus: 'operational',
      });
    });

    // ===== NEW: Instagram → Account → Checkout (public pages) =====
    // 1) Bot DMs this link to user
    this.app.get('/auth/start', (req, res) => {
      // Accept either a signed token (t=) OR raw params (u/e) we immediately sign
      const { t, u, e, to = 'subscribe' } = req.query;

      let token = t;
      if (!token) {
        // Build minimal identity and sign it
        const userObj = {
          uid: (u || '').toString().slice(0, 128) || 'guest',
          email: (e || '').toString().slice(0, 256) || '',
          to: to === 'subscribe' ? 'subscribe' : 'home',
          // 2 hours expiry
          exp: Date.now() + 2 * 60 * 60 * 1000,
          iat: Date.now(),
          src: 'auth-start',
        };
        token = this.signPayload(userObj);
      }

      res.send(this.renderAuthStartHtml(this.baseUrl(req), token));
    });

    // 2) “Create/Sign in” single click (no DB; we just validate the signed token)
    this.app.post('/auth/complete', (req, res) => {
      const { token } = req.body || {};
      const data = this.verifySignedToken(token || '');
      if (!data) {
        return res.status(400).send(this.renderErrorHtml('Invalid or expired link. Please request a new one from the bot.'));
      }

      // Set a short-lived cookie so /subscribe can read it too (optional)
      const cookieVal = cookie.serialize('re_user', token, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: true,
        path: '/',
        maxAge: 2 * 60 * 60, // 2 hours
      });
      res.setHeader('Set-Cookie', cookieVal);

      // Success page with auto-continue to /subscribe
      const nextUrl =
        data.to === 'subscribe'
          ? `/subscribe?token=${encodeURIComponent(token)}`
          : '/';
      res.send(this.renderAuthCompleteHtml(this.baseUrl(req), nextUrl));
    });

    // 3) Subscribe: Verify token → redirect to Stripe Payment Link
    this.app.get('/subscribe', (req, res) => {
      const token = req.query.token || (req.headers.cookie && cookie.parse(req.headers.cookie || '').re_user);
      const data = this.verifySignedToken((token || '').toString());
      if (!data) {
        return res.status(400).send(this.renderErrorHtml('Session missing or expired. Tap the DM link again.'));
      }

      // Build Stripe Payment Link URL with helpful params (Stripe will ignore unsupported params)
      const url = new URL(this.STRIPE_CHECKOUT_URL);
      // Attach context
      url.searchParams.set('client_reference_id', data.uid || 'guest');
      if (data.email) url.searchParams.set('prefilled_email', data.email);

      // 302 to Stripe
      return res.redirect(302, url.toString());
    });

    // ====== API (protected) ======
    this.app.use('/api/', this.authenticateAPI.bind(this));

    // NEW: Bot helper to mint a single click link to DM
    this.app.post('/api/dm/cta', (req, res) => {
      try {
        const { igUserId, username, email, returnTo = 'subscribe' } = req.body || {};
        if (!igUserId && !username) {
          return res.status(400).json({ error: 'Bad Request', message: 'igUserId or username is required' });
        }

        const identity = {
          uid: (igUserId || username || 'guest').toString().slice(0, 128),
          email: (email || '').toString().slice(0, 256),
          to: returnTo === 'subscribe' ? 'subscribe' : 'home',
          exp: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
          iat: Date.now(),
          src: 'dm-cta',
        };

        const token = this.signPayload(identity);
        const link = `${this.baseUrl(req)}/auth/start?t=${encodeURIComponent(token)}`;

        return res.json({
          success: true,
          data: {
            link, // DM this to the user
            expiresAt: new Date(identity.exp).toISOString(),
          },
        });
      } catch (err) {
        console.error('dm/cta error', err);
        return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create link' });
      }
    });

    // ====== Your existing SMART SEARCH endpoints (unchanged behavior) ======

    // Smart search kickoff
    this.app.post('/api/search/smart', async (req, res) => {
      try {
        const {
          neighborhood,
          propertyType = 'rental',
          bedrooms,
          bathrooms,
          undervaluationThreshold = 15,
          minPrice,
          maxPrice,
          maxResults = 1,
          noFee = false,
          // Instagram-optimized extras (keep)
          doorman = false,
          elevator = false,
          laundry = false,
          privateOutdoorSpace = false,
          washerDryer = false,
          dishwasher = false,
          propertyTypes = [],
          maxHoa,
          maxTax,
        } = req.body;

        if (!neighborhood) {
          return res.status(400).json({
            error: 'Bad Request',
            message: 'neighborhood parameter is required',
            example: 'bushwick, soho, tribeca, williamsburg',
          });
        }

        const jobId = this.generateJobId();
        this.startSmartSearch(jobId, {
          neighborhood: neighborhood.toLowerCase().replace(/\s+/g, '-'),
          propertyType,
          bedrooms: bedrooms ? parseInt(bedrooms) : undefined,
          bathrooms: bathrooms ? parseFloat(bathrooms) : undefined,
          undervaluationThreshold,
          minPrice: minPrice ? parseInt(minPrice) : undefined,
          maxPrice: maxPrice ? parseInt(maxPrice) : undefined,
          maxResults: Math.min(parseInt(maxResults), 10),
          noFee,
          doorman,
          elevator,
          laundry,
          privateOutdoorSpace,
          washerDryer,
          dishwasher,
          propertyTypes,
          maxHoa,
          maxTax,
        });

        res.status(202).json({
          success: true,
          data: {
            jobId,
            status: 'started',
            message: `Smart search started for ${neighborhood}`,
            parameters: req.body,
            estimatedDuration: '4-8 seconds (cache-first + Instagram optimized)',
            checkStatusUrl: `/api/jobs/${jobId}`,
            getResultsUrl: `/api/results/${jobId}`,
          },
        });
      } catch (error) {
        console.error('Smart search error:', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to start smart search',
          details: error.message,
        });
      }
    });

    // Cache stats (still returns zeros due to disabled DB)
    this.app.get('/api/cache/stats', async (_req, res) => {
      res.json({
        success: true,
        data: {
          total_requests: 0,
          cache_only_requests: 0,
          cache_hit_rate: 0,
          avg_processing_time_ms: 0,
          note: 'Database disabled for testing',
        },
      });
    });

    // Job status
    this.app.get('/api/jobs/:jobId', (req, res) => {
      const { jobId } = req.params;
      const job = this.activeJobs.get(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Not Found', message: 'Job ID not found' });
      }
      res.json({
        success: true,
        data: {
          jobId,
          status: job.status,
          progress: job.progress || 0,
          startTime: job.startTime,
          lastUpdate: job.lastUpdate,
          message: job.message,
          cacheHits: job.cacheHits || 0,
          thresholdUsed: job.thresholdUsed || job.originalThreshold,
          thresholdLowered: job.thresholdLowered || false,
          error: job.error || null,
        },
      });
    });

    // Job results
    this.app.get('/api/results/:jobId', (req, res) => {
      const { jobId } = req.params;
      const results = this.jobResults.get(jobId);
      if (!results) {
        return res.status(404).json({ error: 'Not Found', message: 'Results not found for this job ID' });
      }
      res.json({ success: true, data: results });
    });

    // Railway-triggered full search (kept)
    this.app.post('/api/trigger/full-search', async (req, res) => {
      try {
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        if (!apiKey || apiKey !== this.apiKey) {
          return res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
        }

        const searchParams = req.body;
        const jobId = this.generateJobId();
        this.startSmartSearch(jobId, {
          ...searchParams,
          neighborhood: searchParams.neighborhood?.toLowerCase().replace(/\s+/g, '-'),
          maxResults: Math.min(parseInt(searchParams.maxResults || 1), 5),
          source: 'railway_function_fallback',
        });

        res.status(202).json({
          success: true,
          data: {
            jobId,
            status: 'started',
            message: `Full API search started for ${searchParams.neighborhood}`,
            estimatedDuration: '2-5 minutes (fresh scraping + analysis)',
            checkStatusUrl: `/api/jobs/${jobId}`,
            getResultsUrl: `/api/results/${jobId}`,
            source: 'railway_function_fallback',
          },
        });
      } catch (error) {
        console.error('Full API trigger error:', error);
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to trigger full API search',
          details: error.message,
        });
      }
    });
  }

  setupErrorHandling() {
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not Found', message: 'Endpoint not found', availableEndpoints: '/api' });
    });

    this.app.use((error, _req, res, _next) => {
      console.error('Global error handler:', error);
      res.status(500).json({ error: 'Internal Server Error', message: 'An unexpected error occurred' });
    });
  }

  // ====== Views (HTML) ======

  renderDocsHtml(baseUrl) {
    return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>NYC Real Estate API - Documentation</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:1200px;margin:0 auto;padding:40px 20px;line-height:1.6;color:#333;background:#f8f9fa}
.container{background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.1)}
.header{text-align:center;margin-bottom:40px;border-bottom:2px solid #e9ecef;padding-bottom:30px}
.endpoint{margin:30px 0;padding:25px;background:#f8f9fa;border-radius:8px;border-left:4px solid #007bff}
.method{background:#007bff;color:#fff;padding:4px 12px;border-radius:4px;font-weight:700;font-size:12px;display:inline-block;margin-right:10px}
.method.get{background:#28a745}.method.post{background:#007bff}
.command{background:#2d3748;color:#e2e8f0;padding:15px;border-radius:6px;font-family:Monaco,Menlo,monospace;font-size:13px;overflow-x:auto;margin:15px 0;white-space:pre-wrap}
.response{background:#f8f9fa;border:1px solid #dee2e6;padding:15px;border-radius:6px;font-family:Monaco,Menlo,monospace;font-size:13px;overflow-x:auto;margin:15px 0}
.params table{width:100%;border-collapse:collapse;margin:15px 0}
.params th,.params td{border:1px solid #dee2e6;padding:12px;text-align:left}
.params th{background:#f8f9fa;font-weight:600}.required{color:#dc3545;font-weight:700}.optional{color:#6c757d}
.toc{background:#e9ecef;padding:20px;border-radius:8px;margin:30px 0}
.toc a{color:#007bff;text-decoration:none;display:block;padding:5px 0}
.highlight{background:#fff3cd;color:#856404;padding:15px;border-radius:6px;margin:20px 0;border-left:4px solid #ffc107}
</style></head>
<body><div class="container">
<div class="header">
  <h1>🏠 NYC Real Estate API Documentation</h1>
  <p>Complete API reference for AI-powered property discovery</p>
  <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
  <p><strong>Authentication:</strong> <code>X-API-Key: audos_2025_realerestate_api_1294843</code></p>
</div>
<div class="toc">
  <h3>📚 Table of Contents</h3>
  <a href="#authflow">Account → Checkout (Instagram)</a>
  <a href="#search">POST /api/search/smart</a>
  <a href="#status">GET /api/jobs/{jobId}</a>
  <a href="#results">GET /api/results/{jobId}</a>
  <a href="#errors">Error Handling</a>
</div>

<div id="authflow" class="endpoint">
  <h3><span class="method post">POST</span>/api/dm/cta</h3>
  <p>Returns a one-click link for your Instagram bot to DM a user. The link opens a "Create/Sign in" page and then routes users to Stripe checkout.</p>
  <div class="command">curl -X POST ${baseUrl}/api/dm/cta \\
  -H "X-API-Key: audos_2025_realerestate_api_1294843" \\
  -H "Content-Type: application/json" \\
  -d '{ "igUserId": "1789...", "username": "nyc_renter", "email": "user@example.com", "returnTo": "subscribe" }'</div>
  <div class="response">{
  "success": true,
  "data": {
    "link": "${baseUrl}/auth/start?t=... (signed)",
    "expiresAt": "2025-07-25T19:10:00.000Z"
  }
}</div>
  <p>Your bot just DM’s <code>link</code>. User taps → account page → Stripe checkout.</p>
</div>

<div id="search" class="endpoint">
  <h3><span class="method post">POST</span>/api/search/smart</h3>
  <p>Finds undervalued NYC rentals or sales with AI analysis and Instagram formatting.</p>
  <div class="command">curl -X POST ${baseUrl}/api/search/smart \\
  -H "X-API-Key: audos_2025_realerestate_api_1294843" \\
  -H "Content-Type: application/json" \\
  -d '{ "neighborhood": "soho", "propertyType": "rental", "maxPrice": 5000, "maxResults": 1 }'</div>
</div>

<div id="status" class="endpoint">
  <h3><span class="method get">GET</span>/api/jobs/{jobId}</h3>
  <div class="command">curl ${baseUrl}/api/jobs/smart_123 \\
  -H "X-API-Key: audos_2025_realerestate_api_1294843"</div>
</div>

<div id="results" class="endpoint">
  <h3><span class="method get">GET</span>/api/results/{jobId}</h3>
  <div class="command">curl ${baseUrl}/api/results/smart_123 \\
  -H "X-API-Key: audos_2025_realerestate_api_1294843"</div>
</div>

<div id="errors" class="endpoint">
  <h3>⚠️ Error Handling</h3>
  <div class="response">{"error":"Unauthorized","message":"Valid API key required in X-API-Key header"}</div>
</div>

<div style="text-align:center;margin-top:50px;padding-top:30px;border-top:1px solid #e9ecef;">
  <p><a href="/" style="color:#007bff;text-decoration:none;">← Back to Homepage</a></p>
  <p style="color:#6c757d;margin-top:20px;">Your AI Realtor • Powered by Realer Estate</p>
</div>
</div></body></html>`;
  }

  renderHomeHtml(baseUrl) {
    return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>NYC Real Estate API</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:1000px;margin:0 auto;padding:40px 20px;line-height:1.6;color:#333;background:#f8f9fa}
.container{background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.1)}
.header{text-align:center;margin-bottom:40px;border-bottom:2px solid #e9ecef;padding-bottom:30px}
.status{background:#d4edda;color:#155724;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:500;margin-bottom:20px}
.section{margin:30px 0;padding:25px;background:#f8f9fa;border-radius:8px;border-left:4px solid #007bff}
.command{background:#2d3748;color:#e2e8f0;padding:15px;border-radius:6px;font-family:Monaco,Menlo,monospace;font-size:13px;overflow-x:auto;margin:10px 0;white-space:pre-wrap}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px;margin:25px 0}
.feature{background:#fff;padding:20px;border-radius:8px;border:1px solid #e9ecef}
</style></head>
<body><div class="container">
  <div class="header">
    <h1>Realer Estate API</h1>
    <div class="status">✅ API Operational</div>
    <p>AI-powered undervalued property discovery for Instagram AI Agent</p>
  </div>

  <div class="features">
    <div class="feature"><h3>⚡ Fast Analysis</h3><p>Find undervalued properties in 4-8 seconds using Realer Estate AI</p></div>
    <div class="feature"><h3>📱 Instagram Ready</h3><p>Pre-formatted DM messages and optimized images</p></div>
    <div class="feature"><h3>🧾 Account→Checkout</h3><p>One-tap create/sign-in then Stripe Payment Link</p></div>
  </div>

  <div class="section">
    <h2>🚀 Quick Test</h2>
    <p><strong>Get a DM link for a user</strong></p>
    <div class="command">curl -X POST ${baseUrl}/api/dm/cta \\
  -H "X-API-Key: audos_2025_realerestate_api_1294843" \\
  -H "Content-Type: application/json" \\
  -d '{"username":"nyc_renter","email":"user@example.com"}'</div>
  </div>

  <div class="section">
    <h2>📚 Documentation</h2>
    <p><a href="/api" style="color:#007bff;text-decoration:none;">→ Full API Documentation</a><br/>
       <a href="/health" style="color:#007bff;text-decoration:none;">→ Health Check</a></p>
  </div>

  <div style="text-align:center;margin-top:40px;padding-top:30px;border-top:1px solid #e9ecef;color:#6c757d;">
    <p>Your AI realtor • Powered by Realer Estate</p>
  </div>
</div></body></html>`;
  }

  renderAuthStartHtml(baseUrl, token) {
    return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Create or Sign in • Realer Estate</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;margin:0}
.wrap{max-width:520px;margin:0 auto;padding:32px}
.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.07);padding:28px;margin-top:28px}
h1{font-size:22px;margin:0 0 4px}p{margin:6px 0 0;color:#60656b}
.btn{width:100%;display:inline-block;padding:14px 16px;border-radius:10px;border:none;background:#111;color:#fff;font-weight:600;cursor:pointer}
small{color:#8a8f98}
</style></head>
<body><div class="wrap">
  <div class="card">
    <h1>Sign in / Create your account</h1>
    <p>We’ll create your account so you can finish checkout securely.</p>
    <form method="POST" action="${baseUrl}/auth/complete" style="margin-top:16px">
      <input type="hidden" name="token" value="${token}"/>
      <button class="btn" type="submit">Continue</button>
    </form>
    <p style="margin-top:12px"><small>By continuing you agree to our Terms and Privacy Policy.</small></p>
  </div>
</div></body></html>`;
  }

  renderAuthCompleteHtml(baseUrl, nextUrl) {
    return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Account Ready • Realer Estate</title>
<script>setTimeout(function(){ location.href='${nextUrl}'; }, 1200);</script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;margin:0}
.wrap{max-width:520px;margin:0 auto;padding:32px}
.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.07);padding:28px;margin-top:28px;text-align:center}
.btn{padding:12px 14px;border-radius:10px;border:none;background:#111;color:#fff;font-weight:600;cursor:pointer}
</style></head>
<body><div class="wrap">
  <div class="card">
    <h2>✅ Account ready</h2>
    <p>Taking you to checkout…</p>
    <p><a class="btn" href="${nextUrl}">Continue now</a></p>
  </div>
</div></body></html>`;
  }

  renderErrorHtml(msg) {
    return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Error</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;margin:0}
.wrap{max-width:520px;margin:0 auto;padding:32px}
.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.07);padding:28px;margin-top:28px}
</style></head>
<body><div class="wrap"><div class="card"><h2>⚠️ Oops</h2><p>${msg}</p></div></div></body></html>`;
  }

  // ====== CORE SMART SEARCH LOGIC (unchanged, with DB disabled) ======

  async startSmartSearch(jobId, params) {
    const startTime = Date.now();
    const job = {
      status: 'processing',
      progress: 0,
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      message: 'Starting smart cache-first search...',
      originalThreshold: params.undervaluationThreshold,
      cacheHits: 0,
      thresholdLowered: false,
    };
    this.activeJobs.set(jobId, job);
    let fetchRecord = null;

    try {
      // Fetch record (fake)
      fetchRecord = await this.createFetchRecord(jobId, params);

      // Cache step (disabled)
      job.progress = 20;
      job.message = 'Checking cache for existing matches...';
      job.lastUpdate = new Date().toISOString();

      const cacheResults = await this.smartCacheSearch(params);
      job.cacheHits = cacheResults.length;

      if (cacheResults.length >= params.maxResults) {
        job.status = 'completed';
        job.progress = 100;
        job.message = `Found ${cacheResults.length} properties from cache (instant results!)`;
        await this.updateFetchRecord(fetchRecord.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          processing_duration_ms: Date.now() - startTime,
          used_cache_only: true,
          cache_hits: cacheResults.length,
          cache_properties_returned: cacheResults.length,
          total_properties_found: cacheResults.length,
        });

        this.jobResults.set(jobId, {
          jobId,
          type: 'smart_search',
          source: 'cache_only',
          parameters: params,
          properties: cacheResults,
          instagramReady: this.formatInstagramResponse(cacheResults),
          instagramSummary: {
            hasImages: cacheResults.some((p) => p.image_count > 0),
            totalImages: cacheResults.reduce((s, p) => s + (p.image_count || 0), 0),
            primaryImages: cacheResults.map((p) => p.primary_image).filter(Boolean),
            readyForPosting: cacheResults.filter((p) => p.image_count > 0 && p.primary_image),
          },
          summary: {
            totalFound: cacheResults.length,
            cacheHits: cacheResults.length,
            newlyScraped: 0,
            thresholdUsed: params.undervaluationThreshold,
            thresholdLowered: false,
            processingTimeMs: Date.now() - startTime,
          },
          completedAt: new Date().toISOString(),
        });
        return;
      }

      // Fetch from API with fallback thresholds
      job.progress = 40;
      job.message = `Found ${cacheResults.length} cached properties, fetching more from StreetEasy...`;
      job.lastUpdate = new Date().toISOString();

      const streetEasyResults = await this.fetchWithThresholdFallback(params, fetchRecord.id);

      // Similar listings fallback
      if (streetEasyResults.properties.length === 0 && cacheResults.length === 0) {
        job.progress = 70;
        job.message = 'No direct matches found, searching for similar listings...';
        job.lastUpdate = new Date().toISOString();

        const similarResults = await this.fetchSimilarListings(params, fetchRecord.id);
        if (similarResults.properties.length === 0) {
          job.status = 'completed';
          job.progress = 100;
          job.message = 'No properties found matching criteria or similar alternatives';
          await this.updateFetchRecord(fetchRecord.id, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            processing_duration_ms: Date.now() - startTime,
            total_properties_found: 0,
          });

          this.jobResults.set(jobId, {
            jobId,
            type: 'smart_search',
            source: 'no_results',
            parameters: params,
            properties: [],
            instagramReady: [],
            instagramSummary: {
              hasImages: false,
              totalImages: 0,
              primaryImages: [],
              readyForPosting: [],
            },
            summary: {
              totalFound: 0,
              cacheHits: cacheResults.length,
              newlyScraped: 0,
              thresholdUsed: params.undervaluationThreshold,
              thresholdLowered: false,
              processingTimeMs: Date.now() - startTime,
            },
            completedAt: new Date().toISOString(),
          });
          return;
        } else {
          streetEasyResults.properties = similarResults.properties;
          streetEasyResults.usedSimilarFallback = true;
          streetEasyResults.similarFallbackMessage = similarResults.fallbackMessage;
          streetEasyResults.apiCalls += similarResults.apiCalls;
          streetEasyResults.totalFetched += similarResults.totalFetched;
          streetEasyResults.claudeApiCalls += similarResults.claudeApiCalls;
          streetEasyResults.claudeCost += similarResults.claudeCost;
        }
      }

      // Combine
      job.progress = 90;
      job.message = 'Combining cached and new results...';
      job.lastUpdate = new Date().toISOString();

      const combinedResults = this.combineResults(
        cacheResults,
        streetEasyResults.properties,
        params.maxResults
      );
      job.thresholdUsed = streetEasyResults.thresholdUsed;
      job.thresholdLowered = streetEasyResults.thresholdLowered;

      job.status = 'completed';
      job.progress = 100;
      job.message = streetEasyResults.usedSimilarFallback
        ? `Found ${combinedResults.length} similar properties (${cacheResults.length} cached + ${streetEasyResults.properties.length} similar)`
        : `Found ${combinedResults.length} total properties (${cacheResults.length} cached + ${streetEasyResults.properties.length} new)`;
      job.lastUpdate = new Date().toISOString();

      await this.updateFetchRecord(fetchRecord.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        processing_duration_ms: Date.now() - startTime,
        used_cache_only: false,
        cache_hits: cacheResults.length,
        cache_properties_returned: cacheResults.length,
        streeteasy_api_calls: streetEasyResults.apiCalls,
        streeteasy_properties_fetched: streetEasyResults.totalFetched,
        streeteasy_properties_analyzed: streetEasyResults.totalAnalyzed,
        total_properties_found: combinedResults.length,
        qualifying_properties_saved: streetEasyResults.properties.length,
        threshold_used: streetEasyResults.thresholdUsed,
        threshold_lowered: streetEasyResults.thresholdLowered,
        claude_api_calls: streetEasyResults.claudeApiCalls,
        claude_tokens_used: streetEasyResults.claudeTokens,
        claude_cost_usd: streetEasyResults.claudeCost,
        used_similar_fallback: streetEasyResults.usedSimilarFallback || false,
      });

      this.jobResults.set(jobId, {
        jobId,
        type: 'smart_search',
        source: streetEasyResults.usedSimilarFallback ? 'similar_listings' : 'cache_and_fresh',
        parameters: params,
        properties: combinedResults,
        instagramReady: this.formatInstagramResponse(combinedResults),
        instagramSummary: {
          hasImages: combinedResults.some((p) => p.image_count > 0),
          totalImages: combinedResults.reduce((s, p) => s + (p.image_count || 0), 0),
          primaryImages: combinedResults.map((p) => p.primary_image).filter(Boolean),
          readyForPosting: combinedResults.filter((p) => p.image_count > 0 && p.primary_image),
        },
        cached: cacheResults,
        newlyScraped: streetEasyResults.properties,
        usedSimilarFallback: streetEasyResults.usedSimilarFallback || false,
        similarFallbackMessage: streetEasyResults.similarFallbackMessage || null,
        summary: {
          totalFound: combinedResults.length,
          cacheHits: cacheResults.length,
          newlyScraped: streetEasyResults.properties.length,
          thresholdUsed: streetEasyResults.thresholdUsed,
          thresholdLowered: streetEasyResults.thresholdLowered,
          processingTimeMs: Date.now() - startTime,
          claudeApiCalls: streetEasyResults.claudeApiCalls,
          claudeCostUsd: streetEasyResults.claudeCost,
          usedSimilarFallback: streetEasyResults.usedSimilarFallback || false,
        },
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('❌ REAL ERROR in startSmartSearch:', error.name, error.message);
      console.error('❌ STACK TRACE:', error.stack);
      const job = this.activeJobs.get(jobId) || {};
      job.status = 'failed';
      job.error = error.message;
      job.lastUpdate = new Date().toISOString();
      this.activeJobs.set(jobId, job);
      try {
        if (fetchRecord?.id) {
          await this.updateFetchRecord(fetchRecord.id, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            processing_duration_ms: Date.now() - startTime,
            error_message: error.message,
          });
        }
      } catch { /* ignore */ }
    }
  }

  async smartCacheSearch(params) {
    console.log(`🔍 SKIPPING database cache search for ${params.neighborhood}...`);
    return [];
  }

  async fetchWithThresholdFallback(params, fetchRecordId) {
    const thresholds = [params.undervaluationThreshold];
    for (const step of this.thresholdSteps) {
      const lower = params.undervaluationThreshold - step;
      if (lower >= 1) thresholds.push(lower);
    }

    let allResults = [];
    let apiCalls = 0;
    let totalFetched = 0;
    let totalAnalyzed = 0;
    let claudeApiCalls = 0;
    let claudeTokens = 0;
    let claudeCost = 0;
    let thresholdUsed = params.undervaluationThreshold;
    let thresholdLowered = false;

    for (const threshold of thresholds) {
      console.log(`🎯 Trying threshold: ${threshold}%`);
      const results = await this.fetchFromStreetEasy(params, threshold, fetchRecordId);
      apiCalls += results.apiCalls;
      totalFetched += results.totalFetched;
      totalAnalyzed += results.totalAnalyzed;
      claudeApiCalls += results.claudeApiCalls;
      claudeTokens += results.claudeTokens;
      claudeCost += results.claudeCost;

      if (results.properties.length > 0) {
        thresholdUsed = threshold;
        thresholdLowered = threshold < params.undervaluationThreshold;
        allResults = results.properties;
        break;
      }
    }

    return {
      properties: allResults,
      thresholdUsed,
      thresholdLowered,
      apiCalls,
      totalFetched,
      totalAnalyzed,
      claudeApiCalls,
      claudeTokens,
      claudeCost,
    };
  }

  async fetchSimilarListings(originalParams, fetchRecordId) {
    console.log('🔄 PROGRESSIVE FALLBACK: Starting search until we find something...');
    if (originalParams.maxPrice) {
      const budgetMultipliers = [1.2, 1.5, 2.0, 3.0, 5.0, 10.0];
      for (const m of budgetMultipliers) {
        const results = await this.fetchFromStreetEasy(
          { ...originalParams, maxPrice: Math.round(originalParams.maxPrice * m), minPrice: undefined, undervaluationThreshold: 1 },
          1,
          fetchRecordId
        );
        if (results.properties.length > 0) {
          const sorted = results.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
          const take = sorted.slice(0, originalParams.maxResults || 1).map((p) => {
            return {
              ...p,
              isSimilarFallback: true,
              fallbackStrategy: 'progressive_budget_increase',
              originalSearchParams: originalParams,
              budgetIncreased: true,
              originalBudget: originalParams.maxPrice,
              newBudget: Math.round(originalParams.maxPrice * m),
              actualPrice: p.monthly_rent || p.price || 0,
              budgetIncreasePercent: Math.round((m - 1) * 100),
              isCheapestAvailable: true,
            };
          });
          return {
            properties: take,
            fallbackMessage: `There were no matches in ${originalParams.neighborhood} under $${originalParams.maxPrice.toLocaleString()}, but here's the cheapest we found there:`,
            fallbackStrategy: 'progressive_budget_increase',
            budgetIncreased: true,
            originalBudget: originalParams.maxPrice,
            finalBudget: Math.round(originalParams.maxPrice * m),
            budgetIncreasePercent: Math.round((m - 1) * 100),
            apiCalls: results.apiCalls,
            totalFetched: results.totalFetched,
            totalAnalyzed: results.totalAnalyzed,
            claudeApiCalls: results.claudeApiCalls,
            claudeTokens: results.claudeTokens,
            claudeCost: results.claudeCost,
          };
        }
      }
    }

    if (originalParams.bedrooms) {
      const results = await this.fetchFromStreetEasy(
        { ...originalParams, bedrooms: undefined, maxPrice: originalParams.maxPrice ? originalParams.maxPrice * 2 : undefined, undervaluationThreshold: 1 },
        originalParams.undervaluationThreshold,
        fetchRecordId
      );
      if (results.properties.length > 0) {
        const sorted = results.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
        const take = sorted.slice(0, originalParams.maxResults || 1).map((p) => ({
          ...p,
          isSimilarFallback: true,
          fallbackStrategy: 'bedroom_flexibility',
          originalSearchParams: originalParams,
          bedroomFlexible: true,
          isCheapestAvailable: true,
        }));
        return {
          properties: take,
          fallbackMessage: `There were no ${originalParams.bedrooms}-bedroom listings in ${originalParams.neighborhood}, but here's the cheapest we found there:`,
          fallbackStrategy: 'bedroom_flexibility',
          apiCalls: results.apiCalls,
          totalFetched: results.totalFetched,
          totalAnalyzed: results.totalAnalyzed,
          claudeApiCalls: results.claudeApiCalls,
          claudeTokens: results.claudeTokens,
          claudeCost: results.claudeCost,
        };
      }
    }

    const similarNeighborhoods = this.getSimilarNeighborhoods(originalParams.neighborhood);
    for (const n of similarNeighborhoods) {
      const ms = originalParams.maxPrice ? [1.0, 1.2, 1.5, 2.0] : [1.0];
      for (const m of ms) {
        const results = await this.fetchFromStreetEasy(
          { ...originalParams, neighborhood: n, maxPrice: originalParams.maxPrice ? Math.round(originalParams.maxPrice * m) : undefined, undervaluationThreshold: 1 },
          originalParams.undervaluationThreshold,
          fetchRecordId
        );
        if (results.properties.length > 0) {
          const sorted = results.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
          const take = sorted.slice(0, originalParams.maxResults || 1).map((p) => ({
            ...p,
            isSimilarFallback: true,
            fallbackStrategy: 'similar_neighborhood',
            originalSearchParams: originalParams,
            neighborhoodChanged: true,
            originalNeighborhood: originalParams.neighborhood,
            actualNeighborhood: n,
            isCheapestAvailable: true,
          }));
          return {
            properties: take,
            fallbackMessage: `There were no matches in ${originalParams.neighborhood}, but here's the cheapest we found in nearby ${n}:`,
            fallbackStrategy: 'similar_neighborhood',
            neighborhoodChanged: true,
            originalNeighborhood: originalParams.neighborhood,
            actualNeighborhood: n,
            apiCalls: results.apiCalls,
            totalFetched: results.totalFetched,
            totalAnalyzed: results.totalAnalyzed,
            claudeApiCalls: results.claudeApiCalls,
            claudeTokens: results.claudeTokens,
            claudeCost: results.claudeCost,
          };
        }
      }
    }

    const manhattanNeighborhoods = ['east-village', 'lower-east-side', 'chinatown', 'financial-district'];
    for (const n of manhattanNeighborhoods) {
      const results = await this.fetchFromStreetEasy(
        { ...originalParams, neighborhood: n, bedrooms: undefined, maxPrice: undefined, minPrice: undefined, undervaluationThreshold: 1 },
        originalParams.undervaluationThreshold,
        fetchRecordId
      );
      if (results.properties.length > 0) {
        const sorted = results.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
        const take = sorted.slice(0, 1).map((p) => ({
          ...p,
          isSimilarFallback: true,
          fallbackStrategy: 'last_resort',
          originalSearchParams: originalParams,
          isLastResort: true,
          isCheapestAvailable: true,
        }));
        return {
          properties: take,
          fallbackMessage: `We couldn't find what you were looking for in ${originalParams.neighborhood}, but here's the cheapest in Manhattan:`,
          fallbackStrategy: 'last_resort',
          isLastResort: true,
          apiCalls: results.apiCalls,
          totalFetched: results.totalFetched,
          totalAnalyzed: results.totalAnalyzed,
          claudeApiCalls: results.claudeApiCalls,
          claudeTokens: results.claudeTokens,
          claudeCost: results.claudeCost,
        };
      }
    }

    return {
      properties: [],
      fallbackMessage: null,
      fallbackStrategy: 'none',
      apiCalls: 0,
      totalFetched: 0,
      totalAnalyzed: 0,
      claudeApiCalls: 0,
      claudeTokens: 0,
      claudeCost: 0,
    };
  }

  getSimilarNeighborhoods(originalNeighborhood) {
    const g = {
      soho: ['tribeca', 'nolita', 'west-village', 'east-village', 'lower-east-side'],
      tribeca: ['soho', 'financial-district', 'west-village', 'battery-park-city'],
      'west-village': ['soho', 'tribeca', 'east-village', 'chelsea', 'meatpacking-district'],
      'east-village': ['west-village', 'lower-east-side', 'nolita', 'gramercy'],
      'lower-east-side': ['east-village', 'chinatown', 'nolita', 'two-bridges'],
      nolita: ['soho', 'east-village', 'lower-east-side', 'little-italy'],
      chelsea: ['west-village', 'gramercy', 'flatiron', 'meatpacking-district'],
      gramercy: ['chelsea', 'east-village', 'murray-hill', 'flatiron'],
      'upper-west-side': ['upper-east-side', 'morningside-heights', 'harlem', 'lincoln-square'],
      'upper-east-side': ['upper-west-side', 'yorkville', 'midtown-east'],
      harlem: ['morningside-heights', 'upper-west-side', 'washington-heights', 'east-harlem'],
      williamsburg: ['greenpoint', 'bushwick', 'dumbo', 'bedstuy'],
      bushwick: ['williamsburg', 'bedstuy', 'ridgewood', 'east-williamsburg'],
      'park-slope': ['prospect-heights', 'gowanus', 'carroll-gardens', 'windsor-terrace'],
      dumbo: ['brooklyn-heights', 'downtown-brooklyn', 'williamsburg', 'vinegar-hill'],
      astoria: ['long-island-city', 'sunnyside', 'woodside', 'jackson-heights'],
      'long-island-city': ['astoria', 'sunnyside', 'hunters-point'],
    };
    return g[originalNeighborhood?.toLowerCase()] || ['east-village', 'lower-east-side', 'chinatown'];
  }

  async fetchFromStreetEasy(params, threshold, _fetchRecordId) {
    try {
      console.log(`📡 OPTIMIZED StreetEasy fetch: ${params.neighborhood}, threshold: ${threshold}%`);
      const apiUrl =
        params.propertyType === 'rental'
          ? 'https://streeteasy-api.p.rapidapi.com/rentals/search'
          : 'https://streeteasy-api.p.rapidapi.com/sales/search';

      const apiParams = {
        areas: params.neighborhood,
        limit: Math.min(20, (params.maxResults || 1) * 4),
        offset: 0,
      };

      if (params.minPrice) apiParams.minPrice = params.minPrice;
      if (params.maxPrice) apiParams.maxPrice = params.maxPrice;
      if (params.bedrooms) {
        apiParams.minBeds = params.bedrooms;
        apiParams.maxBeds = params.bedrooms;
      }
      if (params.bathrooms) {
        if (params.propertyType === 'rental') apiParams.minBath = params.bathrooms;
        else apiParams.minBaths = params.bathrooms;
      }

      const amenityFilters = [];
      if (params.noFee && params.propertyType === 'rental') apiParams.noFee = true;
      if (params.doorman) amenityFilters.push('doorman');
      if (params.elevator) amenityFilters.push('elevator');
      if (params.laundry) amenityFilters.push('laundry');
      if (params.privateOutdoorSpace) amenityFilters.push('private_outdoor_space');
      if (params.washerDryer) amenityFilters.push('washer_dryer');
      if (params.dishwasher) amenityFilters.push('dishwasher');
      if (amenityFilters.length) apiParams.amenities = amenityFilters.join(',');
      if (params.propertyType === 'sale' && params.propertyTypes?.length) {
        apiParams.types = params.propertyTypes.join(',');
      }

      const response = await axios.get(apiUrl, {
        params: apiParams,
        headers: {
          'X-RapidAPI-Key': this.rapidApiKey,
          'X-RapidAPI-Host': 'streeteasy-api.p.rapidapi.com',
        },
        timeout: 30000,
      });

      let listings = [];
      if (response.data?.results && Array.isArray(response.data.results)) listings = response.data.results;
      else if (response.data?.listings && Array.isArray(response.data.listings)) listings = response.data.listings;
      else if (Array.isArray(response.data)) listings = response.data;

      if (!listings.length) {
        return {
          properties: [],
          apiCalls: 1,
          totalFetched: 0,
          totalAnalyzed: 0,
          claudeApiCalls: 0,
          claudeTokens: 0,
          claudeCost: 0,
        };
      }

      const analysisResults = await this.analyzePropertiesWithClaude(listings, params, threshold);
      const saved = await this.savePropertiesToDatabase(
        analysisResults.qualifyingProperties,
        params.propertyType,
        _fetchRecordId
      );

      return {
        properties: saved,
        apiCalls: 1,
        totalFetched: listings.length,
        totalAnalyzed: listings.length,
        claudeApiCalls: analysisResults.claudeApiCalls,
        claudeTokens: analysisResults.claudeTokens,
        claudeCost: analysisResults.claudeCost,
        optimizationUsed: true,
      };
    } catch (error) {
      console.error('❌ Optimized StreetEasy fetch error:', error.message);
      return {
        properties: [],
        apiCalls: 1,
        totalFetched: 0,
        totalAnalyzed: 0,
        claudeApiCalls: 0,
        claudeTokens: 0,
        claudeCost: 0,
        optimizationUsed: false,
        error: error.message,
      };
    }
  }

  async analyzePropertyBatchWithClaude(properties, params, threshold) {
    const prompt = this.buildDetailedClaudePrompt(properties, params, threshold);
    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-haiku-20240307',
          max_tokens: 2000,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.claudeApiKey,
            'anthropic-version': '2023-06-01',
          },
        }
      );

      const analysis = JSON.parse(response.data.content[0].text);
      const tokensUsed =
        (response.data.usage?.input_tokens || 0) + (response.data.usage?.output_tokens || 0);
      const cost = (tokensUsed / 1_000_000) * 1.25;

      const qualifyingProperties = properties
        .map((prop, i) => {
          const a = analysis.find((x) => x.propertyIndex === i + 1) || {
            percentBelowMarket: 0,
            isUndervalued: false,
            reasoning: 'Analysis failed',
            score: 0,
            grade: 'F',
          };
          return {
            ...prop,
            discount_percent: a.percentBelowMarket,
            isUndervalued: a.isUndervalued,
            reasoning: a.reasoning,
            score: a.score || 0,
            grade: a.grade || 'F',
            analyzed: true,
          };
        })
        .filter((prop) => prop.discount_percent >= threshold);

      return { qualifyingProperties, tokensUsed, cost };
    } catch (error) {
      console.warn('⚠️ Claude batch analysis failed:', error.message);
      return { qualifyingProperties: [], tokensUsed: 0, cost: 0 };
    }
  }

  async analyzePropertiesWithClaude(listings, params, threshold) {
    const batchSize = 50;
    let all = [];
    let calls = 0;
    let tokens = 0;
    let cost = 0;
    for (let i = 0; i < listings.length; i += batchSize) {
      const batch = listings.slice(i, i + batchSize);
      const r = await this.analyzePropertyBatchWithClaude(batch, params, threshold);
      all.push(...r.qualifyingProperties);
      calls += 1;
      tokens += r.tokensUsed;
      cost += r.cost;
      if (i + batchSize < listings.length) await this.delay(1000);
    }
    return { qualifyingProperties: all, claudeApiCalls: calls, claudeTokens: tokens, claudeCost: cost };
    }

  buildDetailedClaudePrompt(properties, params, threshold) {
    return `You are an expert NYC real estate analyst. Analyze these ${params.propertyType} properties in ${params.neighborhood} for undervaluation potential.

PROPERTIES TO ANALYZE:
${properties
  .map(
    (prop, i) => `
Property ${i + 1}:
- Address: ${prop.address || 'Not listed'}
- ${params.propertyType === 'rental' ? 'Monthly Rent' : 'Sale Price'}: ${
      prop.price?.toLocaleString() || 'Not listed'
    }
- Layout: ${prop.bedrooms || 'N/A'}BR/${prop.bathrooms || 'N/A'}BA
- Square Feet: ${prop.sqft || 'Not listed'}
- Description: ${prop.description?.substring(0, 300) || 'None'}...
- Amenities: ${prop.amenities?.join(', ') || 'None listed'}
- Building Year: ${prop.built_in || 'Unknown'}
- Days on Market: ${prop.days_on_market || 'Unknown'}`
  )
  .join('\n')}

ANALYSIS REQUIREMENTS:
- Evaluate each property against typical ${params.neighborhood} market rates
- Consider location, amenities, condition, and comparable properties
- Provide detailed reasoning for valuation assessment
- Calculate precise discount percentage vs market value
- Only mark as undervalued if discount is ${threshold}% or greater
- Assign numerical score (0-100) and letter grade (A+ to F)

CRITICAL: You MUST respond with ONLY a valid JSON array. No explanatory text before or after. Start with [ and end with ].

RESPONSE FORMAT (JSON Array):
[
  {
    "propertyIndex": 1,
    "percentBelowMarket": 20,
    "isUndervalued": true,
    "reasoning": "This 2BR rental at $3,200/month is 20% below the $4,000 market rate for similar properties in ${params.neighborhood}. The discount reflects older fixtures but the prime location makes it an excellent value.",
    "score": 85,
    "grade": "A-"
  }
]

Return ONLY the JSON array. No other text.`;
  }

  async savePropertiesToDatabase(properties, propertyType, fetchRecordId) {
    if (properties.length === 0) return [];
    console.log(`💾 SKIPPING database save of ${properties.length} properties...`);
    const formatted = properties.map((p) => this.formatPropertyForDatabase(p, propertyType, fetchRecordId));
    console.log(`✅ Successfully formatted ${formatted.length} properties (database skipped)`);
    return formatted;
  }

  formatPropertyForDatabase(property, propertyType, fetchRecordId) {
    const extractedImages = this.extractAndFormatImages(property);
    const baseData = {
      fetch_job_id: fetchRecordId,
      listing_id:
        property.id ||
        property.listing_id ||
        `generated_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      address: property.address || '',
      neighborhood: property.neighborhood || '',
      borough: this.getBoroughFromNeighborhood(property.neighborhood || ''),
      zipcode: property.zipcode || property.zip_code || '',
      bedrooms: property.bedrooms || 0,
      bathrooms: property.bathrooms || 0,
      sqft: property.sqft || null,
      discount_percent: property.discount_percent || 0,
      score: property.score || 0,
      grade: property.grade || 'F',
      reasoning: property.reasoning || '',
      comparison_method: 'claude_ai_analysis',
      description: property.description || '',
      amenities: property.amenities || [],
      images: extractedImages.processedImages,
      image_count: extractedImages.count,
      primary_image: extractedImages.primary,
      instagram_ready_images: extractedImages.instagramReady,
      listing_url: property.url || property.listing_url || '',
      built_in: property.built_in || property.year_built || null,
      days_on_market: property.days_on_market || 0,
      status: 'active',
    };

    if (propertyType === 'rental') {
      return {
        ...baseData,
        monthly_rent: property.price || 0,
        potential_monthly_savings: Math.round(((property.price || 0) * (property.discount_percent || 0)) / 100),
        annual_savings: Math.round(((property.price || 0) * (property.discount_percent || 0) * 12) / 100),
        no_fee: property.no_fee || property.noFee || false,
        doorman_building: property.doorman_building || false,
        elevator_building: property.elevator_building || false,
        pet_friendly: property.pet_friendly || false,
        laundry_available: property.laundry_available || false,
        gym_available: property.gym_available || false,
        rooftop_access: property.rooftop_access || false,
        rent_stabilized_probability: 0,
        rent_stabilized_confidence: 0,
        rent_stabilized_reasoning: '',
        rent_stabilized_detected: false,
      };
    } else {
      return {
        ...baseData,
        price: property.price || 0,
        potential_savings: Math.round(((property.price || 0) * (property.discount_percent || 0)) / 100),
        estimated_market_price: Math.round((property.price || 0) / (1 - (property.discount_percent || 0) / 100)),
        monthly_hoa: property.monthly_hoa || null,
        monthly_tax: property.monthly_tax || null,
        property_type: property.property_type || 'unknown',
      };
    }
  }

  extractAndFormatImages(property) {
    try {
      let raw = [];
      if (property.images && Array.isArray(property.images)) raw = property.images;
      else if (property.photos && Array.isArray(property.photos)) raw = property.photos;
      else if (property.media?.images) raw = property.media.images;
      else if (property.listingPhotos) raw = property.listingPhotos;

      const processed = raw
        .filter((img) => (typeof img === 'string' && img) || (img && img.url))
        .map((img) => this.optimizeImageForInstagram(typeof img === 'string' ? img : img.url))
        .filter(Boolean)
        .slice(0, 10);

      const primary = processed[0] || null;
      const instagramReady = processed.map((u, i) => ({
        url: u,
        caption: this.generateImageCaption(property, i),
        altText: `${property.address} - Photo ${i + 1}`,
        isPrimary: i === 0,
      }));

      return { processedImages: processed, count: processed.length, primary, instagramReady };
    } catch (e) {
      console.warn('Image extraction error:', e.message);
      return { processedImages: [], count: 0, primary: null, instagramReady: [] };
    }
  }

  optimizeImageForInstagram(imageUrl) {
    if (!imageUrl) return null;
    try {
      if (imageUrl.includes('streeteasy.com')) {
        return imageUrl
          .replace('/small/', '/large/')
          .replace('/medium/', '/large/')
          .replace('_sm.', '_lg.')
          .replace('_md.', '_lg.');
      }
      return imageUrl.startsWith('https://') ? imageUrl : imageUrl.replace('http://', 'https://');
    } catch {
      return imageUrl;
    }
  }

  generateImageCaption(property, idx) {
    const price = property.monthly_rent || property.price;
    const priceText = property.monthly_rent ? `${price?.toLocaleString()}/month` : `${price?.toLocaleString()}`;
    if (idx === 0) {
      return `🏠 ${property.bedrooms}BR/${property.bathrooms}BA in ${property.neighborhood}\n💰 ${priceText} (${property.discount_percent}% below market)\n📍 ${property.address}`;
    }
    return `📸 ${property.address} - Photo ${idx + 1}`;
  }

  generateInstagramDMMessage(property) {
    const price = property.monthly_rent || property.price;
    const priceText = property.monthly_rent ? `$${price?.toLocaleString()}/month` : `$${price?.toLocaleString()}`;
    const savings = property.potential_monthly_savings || property.potential_savings;

    let message = '';
    if (property.isSimilarFallback) {
      if (property.fallbackStrategy === 'progressive_budget_increase') {
        message += `💰 *BUDGET ADJUSTED ALERT*\n\n`;
        message += `🔍 Original: ${property.originalSearchParams.bedrooms || 'Any'}BR in ${property.originalSearchParams.neighborhood} under $${property.originalBudget?.toLocaleString()}\n`;
        message += `❌ No matches at that budget\n`;
        message += `✅ Cheapest available: ${priceText} (+${property.budgetIncreasePercent}%)\n\n`;
      } else if (property.fallbackStrategy === 'bedroom_flexibility') {
        message += `🏠 *BEDROOM FLEXIBLE ALERT*\n\n`;
        message += `🔍 Original: ${property.originalSearchParams.bedrooms}BR in ${property.originalSearchParams.neighborhood}\n`;
        message += `❌ No ${property.originalSearchParams.bedrooms}BR available\n`;
        message += `✅ Found: ${property.bedrooms}BR at ${priceText}\n\n`;
      } else if (property.fallbackStrategy === 'similar_neighborhood') {
        message += `📍 *NEARBY AREA ALERT*\n\n`;
        message += `🔍 Original: ${property.originalNeighborhood}\n`;
        message += `❌ No matches in ${property.originalNeighborhood}\n`;
        message += `✅ Found in ${property.actualNeighborhood}: ${priceText}\n\n`;
      } else {
        message += `🔄 *ALTERNATIVE FOUND*\n\n❌ No exact matches\n✅ Best alternative: ${priceText}\n\n`;
      }
    } else {
      message += `🏠 *UNDERVALUED PROPERTY ALERT*\n\n`;
    }

    message += `📍 **${property.address}**\n`;
    message += `🏘️ ${property.neighborhood}, ${property.borough}\n\n`;
    message += `💰 **${priceText}**\n`;

    if (!property.isSimilarFallback) {
      message += `📉 ${property.discount_percent}% below market\n`;
      message += `💵 Save $${savings?.toLocaleString()} ${property.monthly_rent ? 'per month' : 'total'}\n\n`;
    } else {
      message += `💡 Cheapest available option\n\n`;
    }

    message += `🏠 ${property.bedrooms}BR/${property.bathrooms}BA`;
    if (property.sqft) message += ` | ${property.sqft} sqft`;
    message += `\n📊 Score: ${property.score}/100 (${property.grade})\n\n`;

    const keyAmenities = [];
    if (property.no_fee) keyAmenities.push('No Fee');
    if (property.doorman_building) keyAmenities.push('Doorman');
    if (property.elevator_building) keyAmenities.push('Elevator');
    if (property.pet_friendly) keyAmenities.push('Pet Friendly');
    if (property.gym_available) keyAmenities.push('Gym');
    if (keyAmenities.length) message += `✨ ${keyAmenities.join(' • ')}\n\n`;

    message += `🧠 *AI Analysis:*\n"${(property.reasoning || '').substring(0, 150)}..."\n\n`;
    message += `🔗 [View Full Listing](${property.listing_url})`;
    return message;
  }

  formatInstagramResponse(properties) {
    return properties.map((p) => ({
      ...p,
      instagram: {
        primaryImage: p.primary_image,
        imageCount: p.image_count,
        images: p.instagram_ready_images || [],
        dmMessage: this.generateInstagramDMMessage(p),
      },
    }));
  }

  formatCacheResults(data, _propertyType) {
    return data.map((item) => ({ ...item, source: 'cache', isCached: true }));
  }

  combineResults(cacheResults, newResults, maxResults) {
    const combined = [...cacheResults];
    const seen = new Set(cacheResults.map((r) => r.listing_id));
    for (const r of newResults) {
      if (!seen.has(r.listing_id)) {
        combined.push({ ...r, source: 'fresh', isCached: false });
      }
    }
    return combined.sort((a, b) => (b.discount_percent || 0) - (a.discount_percent || 0)).slice(0, maxResults);
  }

  async createFetchRecord(jobId, params) {
    console.log('🔍 SKIPPING database - using fake record');
    return { id: `fake_${jobId}`, job_id: jobId, status: 'processing', neighborhood: params.neighborhood, property_type: params.propertyType };
  }
  async updateFetchRecord(_id, updates) {
    console.log('🔍 SKIPPING database update:', updates.status || 'processing');
    return;
  }

  getBoroughFromNeighborhood(n) {
    const m = {
      soho: 'Manhattan', tribeca: 'Manhattan', 'west-village': 'Manhattan', 'east-village': 'Manhattan',
      'lower-east-side': 'Manhattan', chinatown: 'Manhattan', 'financial-district': 'Manhattan', 'battery-park-city': 'Manhattan',
      chelsea: 'Manhattan', gramercy: 'Manhattan', 'murray-hill': 'Manhattan', midtown: 'Manhattan',
      "hell-s-kitchen": 'Manhattan', 'upper-west-side': 'Manhattan', 'upper-east-side': 'Manhattan', harlem: 'Manhattan',
      'washington-heights': 'Manhattan',
      williamsburg: 'Brooklyn', bushwick: 'Brooklyn', bedstuy: 'Brooklyn', 'park-slope': 'Brooklyn', 'red-hook': 'Brooklyn',
      dumbo: 'Brooklyn', 'brooklyn-heights': 'Brooklyn', 'carroll-gardens': 'Brooklyn', 'cobble-hill': 'Brooklyn',
      'fort-greene': 'Brooklyn', 'prospect-heights': 'Brooklyn', 'crown-heights': 'Brooklyn',
      astoria: 'Queens', 'long-island-city': 'Queens', 'forest-hills': 'Queens', flushing: 'Queens',
      elmhurst: 'Queens', 'jackson-heights': 'Queens',
      'mott-haven': 'Bronx', 'south-bronx': 'Bronx', concourse: 'Bronx', fordham: 'Bronx', riverdale: 'Bronx',
    };
    return m[n?.toLowerCase()] || 'Unknown';
  }

  generateJobId() {
    return `smart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`🚀 Instagram-Optimized Smart Cache-First API Server running on port ${this.port}`);
      console.log(`📊 API Documentation: http://localhost:${this.port}/api`);
      console.log(`💳 API Key: ${this.apiKey}`);
      console.log(`🧠 Mode: Smart cache-first with Instagram DM optimization + Account→Checkout flow`);
      console.log(`🔗 Stripe Link: ${this.STRIPE_CHECKOUT_URL}`);
    });
  }
}

// Railway deployment
if (require.main === module) {
  const api = new SmartCacheFirstAPI();
  api.start();
}

module.exports = SmartCacheFirstAPI;
