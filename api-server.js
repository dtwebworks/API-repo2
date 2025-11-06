// api-server.js
// IG-ready API + minimal Account→Checkout flow (Stripe Payment Link)
// Works with or without .env (safe HARDCODED defaults below)

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const axios = require('axios');
const crypto = require('crypto');
const cookie = require('cookie');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js'); // (DB disabled in this build)

// --- HARD DEFAULTS (used if .env is missing) ---
const HARDCODED = {
  API_KEY: 'autos_realer_2025_K4y7wJ9Qf2', // <- change if you want
  STRIPE_LINK: 'https://buy.stripe.com/dRm00lbY3dwg5ZAble9R600',
  ALLOWED_ORIGINS: ['*'], // or restrict: ['https://yourdomain.com','https://instagram.com']
  PUBLIC_BASE_URL: null,   // null = infer from request host
};
// -----------------------------------------------

class SmartCacheFirstAPI {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;

    // === CONFIG / SECRETS ===
    this.apiKey = process.env.VC_API_KEY || HARDCODED.API_KEY;
    this.rapidApiKey = process.env.RAPIDAPI_KEY;
    this.claudeApiKey = process.env.ANTHROPIC_API_KEY;
    this.STRIPE_CHECKOUT_URL = process.env.STRIPE_CHECKOUT_URL || HARDCODED.STRIPE_LINK;
    this.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || HARDCODED.PUBLIC_BASE_URL;

    // In-memory job storage
    this.activeJobs = new Map();
    this.jobResults = new Map();

    // Search settings
    this.cacheMaxAgeDays = 30;
    this.thresholdSteps = [5, 4, 3, 2, 1];

    // (DB disabled)
    this._supabase = null;

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  // ===== Utilities =====
  baseUrl(req) {
    if (this.PUBLIC_BASE_URL) return this.PUBLIC_BASE_URL;
    return `${req.protocol}://${req.get('host')}`;
  }

  signPayload(obj) {
    const secret = this.apiKey;
    const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifySignedToken(token) {
    try {
      const secret = this.apiKey;
      const [payload, sig] = (token || '').split('.');
      if (!payload || !sig) return null;
      const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (obj.exp && Date.now() > obj.exp) return null;
      return obj;
    } catch {
      return null;
    }
  }

  buildStripeLink({ uid = 'guest', email = '' } = {}) {
    const url = new URL(this.STRIPE_CHECKOUT_URL);
    // harmless if the link doesn't support them
    if (uid) url.searchParams.set('client_reference_id', uid);
    if (email) url.searchParams.set('prefilled_email', email);
    return url.toString();
  }

  // ===== Middleware =====
  setupMiddleware() {
    this.app.use(helmet());
    this.app.use(compression());

    // CORS
    const allow = (process.env.ALLOWED_ORIGINS || HARDCODED.ALLOWED_ORIGINS.join(','))
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    this.app.use(
      cors({
        origin: (origin, cb) => {
          if (!origin || allow.includes('*') || allow.includes(origin)) return cb(null, true);
          return cb(new Error('CORS not allowed from this origin'), false);
        },
        credentials: true,
      })
    );

    this.app.set('trust proxy', true);
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Rate limit
    this.app.use(
      '/api/',
      rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests from this IP, please try again later.' },
      })
    );

    // Tiny request log
    this.app.use((req, _res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
      next();
    });
  }

  // API key guard for /api/*
  authenticateAPI(req, res, next) {
    const k = req.headers['x-api-key'] || req.query.apiKey;
    if (!k || k !== this.apiKey) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required in X-API-Key header' });
    }
    next();
  }

  // ===== Routes =====
  setupRoutes() {
    // Docs
    this.app.get('/api', (req, res) => res.send(this.renderDocsHtml(this.baseUrl(req))));
    // Home
    this.app.get('/', (req, res) => res.send(this.renderHomeHtml(this.baseUrl(req))));
    // Health
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'nyc_full_api',
        version: '3.2.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        features: [
          'smart_search',
          'job_queue',
          'instagram_dm_ready',
          'similar_listings_fallback',
          'account_to_checkout_no_db',
        ],
        activeJobs: this.activeJobs.size,
      });
    });

    // ===== IG → Account → Checkout (public HTML) =====
    this.app.get('/auth/start', (req, res) => {
      const { t, u, e, to = 'subscribe' } = req.query;
      let token = t;
      if (!token) {
        const payload = {
          uid: (u || '').toString().slice(0, 128) || 'guest',
          email: (e || '').toString().slice(0, 256) || '',
          to: to === 'subscribe' ? 'subscribe' : 'home',
          iat: Date.now(),
          exp: Date.now() + 2 * 60 * 60 * 1000,
          src: 'auth-start',
        };
        token = this.signPayload(payload);
      }
      res.send(this.renderAuthStartHtml(this.baseUrl(req), token));
    });

    this.app.post('/auth/complete', (req, res) => {
      const data = this.verifySignedToken((req.body?.token || '').toString());
      if (!data) return res.status(400).send(this.renderErrorHtml('Invalid or expired link. Tap the DM again.'));
      res.setHeader(
        'Set-Cookie',
        cookie.serialize('re_user', req.body.token, {
          httpOnly: true,
          sameSite: 'Lax',
          secure: true,
          path: '/',
          maxAge: 2 * 60 * 60,
        })
      );
      const nextUrl = data.to === 'subscribe' ? `/subscribe?token=${encodeURIComponent(req.body.token)}` : '/';
      res.send(this.renderAuthCompleteHtml(this.baseUrl(req), nextUrl));
    });

    this.app.get('/subscribe', (req, res) => {
      const token =
        req.query.token ||
        (req.headers.cookie && cookie.parse(req.headers.cookie || '').re_user);
      const data = this.verifySignedToken(String(token || ''));
      if (!data) return res.status(400).send(this.renderErrorHtml('Session missing or expired. Tap the DM again.'));
      return res.redirect(302, this.buildStripeLink({ uid: data.uid, email: data.email }));
    });

    // ===== Protected API (bot) =====
    this.app.use('/api/', this.authenticateAPI.bind(this));

    // JSON: get Stripe Checkout link
    this.app.get('/api/subscribe', (req, res) => {
      const uid = (req.query.uid || '').toString().slice(0, 128) || 'guest';
      const email = (req.query.email || '').toString().slice(0, 256) || '';
      return res.json({ success: true, data: { type: 'stripe_checkout_link', url: this.buildStripeLink({ uid, email }) } });
    });
    this.app.get('/api/pay', (req, res) => {
      const uid = (req.query.uid || '').toString().slice(0, 128) || 'guest';
      const email = (req.query.email || '').toString().slice(0, 256) || '';
      return res.json({ success: true, data: { type: 'stripe_checkout_link', url: this.buildStripeLink({ uid, email }) } });
    });

    // Bot helper: return one-click DM link
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
          iat: Date.now(),
          exp: Date.now() + 2 * 60 * 60 * 1000,
          src: 'dm-cta',
        };
        const token = this.signPayload(identity);
        const link = `${this.baseUrl(req)}/auth/start?t=${encodeURIComponent(token)}`;
        return res.json({ success: true, data: { link, expiresAt: new Date(identity.exp).toISOString() } });
      } catch (err) {
        console.error('dm/cta error', err);
        return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to create link' });
      }
    });

    // ===== Smart search endpoints (DB writes disabled) =====
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
          // IG opts
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
        res.status(500).json({ error: 'Internal Server Error', message: 'Failed to start smart search', details: error.message });
      }
    });

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

    this.app.get('/api/jobs/:jobId', (req, res) => {
      const { jobId } = req.params;
      const job = this.activeJobs.get(jobId);
      if (!job) return res.status(404).json({ error: 'Not Found', message: 'Job ID not found' });
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

    this.app.get('/api/results/:jobId', (req, res) => {
      const { jobId } = req.params;
      const results = this.jobResults.get(jobId);
      if (!results) return res.status(404).json({ error: 'Not Found', message: 'Results not found for this job ID' });
      res.json({ success: true, data: results });
    });

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
        res.status(500).json({ error: 'Internal Server Error', message: 'Failed to trigger full API search', details: error.message });
      }
    });
  }

  // ===== Error handling =====
  setupErrorHandling() {
    this.app.use((_req, res) => {
      res.status(404).json({ error: 'Not Found', message: 'Endpoint not found', availableEndpoints: '/api' });
    });
    this.app.use((err, _req, res, _next) => {
      console.error('Global error handler:', err);
      res.status(500).json({ error: 'Internal Server Error', message: 'An unexpected error occurred' });
    });
  }

  // ===== Views (HTML) =====
  renderDocsHtml(baseUrl) {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>NYC Real Estate API - Docs</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:1200px;margin:0 auto;padding:40px 20px;line-height:1.6;color:#333;background:#f8f9fa}.container{background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.1)}.header{text-align:center;margin-bottom:40px;border-bottom:2px solid #e9ecef;padding-bottom:30px}.endpoint{margin:30px 0;padding:25px;background:#f8f9fa;border-radius:8px;border-left:4px solid #007bff}.method{background:#007bff;color:#fff;padding:4px 12px;border-radius:4px;font-weight:700;font-size:12px;display:inline-block;margin-right:10px}.method.get{background:#28a745}.method.post{background:#007bff}.command{background:#2d3748;color:#e2e8f0;padding:15px;border-radius:6px;font-family:Monaco,Menlo,monospace;font-size:13px;overflow-x:auto;margin:15px 0;white-space:pre-wrap}</style></head>
<body><div class="container">
<div class="header">
  <h1>🏠 NYC Real Estate API</h1>
  <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
  <p><strong>Auth:</strong> <code>X-API-Key: &lt;your key&gt;</code></p>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/subscribe</h3>
  <p>Return Stripe checkout link as JSON (the IG bot should call this).</p>
  <div class="command">curl "${baseUrl}/api/subscribe?uid=1789&email=user@example.com" -H "X-API-Key: &lt;KEY&gt;"</div>
</div>

<div class="endpoint">
  <h3><span class="method post">POST</span>/api/dm/cta</h3>
  <p>Mint a one-click DM link that guides user → account → checkout.</p>
  <div class="command">curl -X POST ${baseUrl}/api/dm/cta -H "X-API-Key: &lt;KEY&gt;" -H "Content-Type: application/json" -d '{"username":"nyc_renter","email":"user@example.com"}'</div>
</div>

<div class="endpoint">
  <h3><span class="method post">POST</span>/api/search/smart</h3>
  <div class="command">curl -X POST ${baseUrl}/api/search/smart -H "X-API-Key: &lt;KEY&gt;" -H "Content-Type: application/json" -d '{"neighborhood":"soho","propertyType":"rental","maxResults":1}'</div>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/jobs/{jobId}</h3>
  <div class="command">curl ${baseUrl}/api/jobs/smart_123 -H "X-API-Key: &lt;KEY&gt;"</div>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/results/{jobId}</h3>
  <div class="command">curl ${baseUrl}/api/results/smart_123 -H "X-API-Key: &lt;KEY&gt;"</div>
</div>

</div></body></html>`;
  }

  renderHomeHtml(baseUrl) {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Realer Estate API</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:1000px;margin:0 auto;padding:40px 20px;line-height:1.6;color:#333;background:#f8f9fa}.container{background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.1)}.header{text-align:center;margin-bottom:40px;border-bottom:2px solid #e9ecef;padding-bottom:30px}.status{background:#d4edda;color:#155724;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:500;margin-bottom:20px}.section{margin:30px 0;padding:25px;background:#f8f9fa;border-radius:8px;border-left:4px solid #007bff}.command{background:#2d3748;color:#e2e8f0;padding:15px;border-radius:6px;font-family:Monaco,Menlo,monospace;font-size:13px;overflow-x:auto;margin:10px 0;white-space:pre-wrap}</style></head>
<body><div class="container">
  <div class="header">
    <h1>Realer Estate API</h1>
    <div class="status">✅ API Operational</div>
    <p>AI-powered undervalued property discovery + IG checkout flow</p>
  </div>
  <div class="section">
    <h2>Quick Test</h2>
    <div class="command">curl -X POST ${baseUrl}/api/dm/cta -H "X-API-Key: &lt;KEY&gt;" -H "Content-Type: application/json" -d '{"username":"nyc_renter","email":"user@example.com"}'</div>
    <div class="command">curl "${baseUrl}/api/subscribe?uid=demo&email=demo@example.com" -H "X-API-Key: &lt;KEY&gt;"</div>
  </div>
  <div class="section"><a href="/api">→ API Docs</a> • <a href="/health">Health</a></div>
</div></body></html>`;
  }

  renderAuthStartHtml(baseUrl, token) {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Create or Sign in</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;margin:0}.wrap{max-width:520px;margin:0 auto;padding:32px}.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.07);padding:28px;margin-top:28px}h1{font-size:22px;margin:0 0 4px}p{margin:6px 0 0;color:#60656b}.btn{width:100%;display:inline-block;padding:14px 16px;border-radius:10px;border:none	background:#111;color:#fff;font-weight:600;cursor:pointer}</style></head>
<body><div class="wrap"><div class="card">
  <h1>Sign in / Create your account</h1><p>We’ll create your account so you can finish checkout securely.</p>
  <form method="POST" action="${baseUrl}/auth/complete" style="margin-top:16px">
    <input type="hidden" name="token" value="${token}"/><button class="btn" type="submit">Continue</button>
  </form>
  <p style="margin-top:12px"><small>By continuing you agree to our Terms and Privacy Policy.</small></p>
</div></div></body></html>`;
  }

  renderAuthCompleteHtml(_baseUrl, nextUrl) {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Account Ready</title><script>setTimeout(function(){location.href='${nextUrl}';},1200);</script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;margin:0}.wrap{max-width:520px;margin:0 auto;padding:32px}.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.07);padding:28px;margin-top:28px;text-align:center}.btn{padding:12px 14px;border-radius:10px;border:none;background:#111;color:#fff;font-weight:600;cursor:pointer}</style></head>
<body><div class="wrap"><div class="card">
  <h2>✅ Account ready</h2><p>Taking you to checkout…</p><p><a class="btn" href="${nextUrl}">Continue now</a></p>
</div></div></body></html>`;
  }

  renderErrorHtml(msg) {
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Error</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;margin:0}.wrap{max-width:520px;margin:0 auto;padding:32px}.card{background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.07);padding:28px;margin-top:28px}</style></head>
<body><div class="wrap"><div class="card"><h2>⚠️ Oops</h2><p>${msg}</p></div></div></body></html>`;
  }

  // ===== Core smart search logic (DB skipped) =====
  async startSmartSearch(jobId, params) {
    const start = Date.now();
    const job = {
      status: 'processing',
      progress: 0,
      startTime: new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      message: 'Starting smart cache-first search…',
      originalThreshold: params.undervaluationThreshold,
      cacheHits: 0,
      thresholdLowered: false,
    };
    this.activeJobs.set(jobId, job);

    let fetchRecord = null;
    try {
      fetchRecord = await this.createFetchRecord(jobId, params);

      job.progress = 20;
      job.message = 'Checking cache…'; job.lastUpdate = new Date().toISOString();
      const cacheResults = await this.smartCacheSearch(params);
      job.cacheHits = cacheResults.length;

      if (cacheResults.length >= params.maxResults) {
        job.status = 'completed'; job.progress = 100;
        job.message = `Found ${cacheResults.length} properties from cache (instant)`;
        await this.updateFetchRecord(fetchRecord.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          processing_duration_ms: Date.now() - start,
          used_cache_only: true,
          cache_hits: cacheResults.length,
          cache_properties_returned: cacheResults.length,
          total_properties_found: cacheResults.length,
        });
        this.jobResults.set(jobId, {
          jobId, type: 'smart_search', source: 'cache_only',
          parameters: params, properties: cacheResults,
          instagramReady: this.formatInstagramResponse(cacheResults),
          summary: { totalFound: cacheResults.length, cacheHits: cacheResults.length, newlyScraped: 0, thresholdUsed: params.undervaluationThreshold, thresholdLowered: false, processingTimeMs: Date.now() - start },
          completedAt: new Date().toISOString(),
        });
        return;
      }

      job.progress = 40;
      job.message = `Found ${cacheResults.length} cached; fetching fresh…`; job.lastUpdate = new Date().toISOString();
      const streetEasyResults = await this.fetchWithThresholdFallback(params, fetchRecord.id);

      if (streetEasyResults.properties.length === 0 && cacheResults.length === 0) {
        job.progress = 70; job.message = 'No matches; looking for similar…'; job.lastUpdate = new Date().toISOString();
        const similar = await this.fetchSimilarListings(params, fetchRecord.id);
        if (similar.properties.length === 0) {
          job.status = 'completed'; job.progress = 100; job.message = 'No properties found';
          await this.updateFetchRecord(fetchRecord.id, {
            status: 'completed', completed_at: new Date().toISOString(),
            processing_duration_ms: Date.now() - start, total_properties_found: 0,
          });
          this.jobResults.set(jobId, {
            jobId, type: 'smart_search', source: 'no_results', parameters: params,
            properties: [], instagramReady: [], summary: { totalFound: 0, cacheHits: 0, newlyScraped: 0, thresholdUsed: params.undervaluationThreshold, thresholdLowered: false, processingTimeMs: Date.now() - start },
            completedAt: new Date().toISOString(),
          });
          return;
        } else {
          streetEasyResults.properties = similar.properties;
          streetEasyResults.usedSimilarFallback = true;
          streetEasyResults.similarFallbackMessage = similar.fallbackMessage;
          streetEasyResults.apiCalls += similar.apiCalls;
          streetEasyResults.totalFetched += similar.totalFetched;
          streetEasyResults.claudeApiCalls += similar.claudeApiCalls;
          streetEasyResults.claudeCost += similar.claudeCost;
        }
      }

      job.progress = 90; job.message = 'Combining results…'; job.lastUpdate = new Date().toISOString();
      const combined = this.combineResults(cacheResults, streetEasyResults.properties, params.maxResults);
      job.thresholdUsed = streetEasyResults.thresholdUsed;
      job.thresholdLowered = streetEasyResults.thresholdLowered;
      job.status = 'completed'; job.progress = 100;
      job.message = streetEasyResults.usedSimilarFallback
        ? `Found ${combined.length} similar (${cacheResults.length} cached + ${streetEasyResults.properties.length} similar)`
        : `Found ${combined.length} total (${cacheResults.length} cached + ${streetEasyResults.properties.length} new)`;

      await this.updateFetchRecord(fetchRecord.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        processing_duration_ms: Date.now() - start,
        used_cache_only: false,
        cache_hits: cacheResults.length,
        cache_properties_returned: cacheResults.length,
        streeteasy_api_calls: streetEasyResults.apiCalls,
        streeteasy_properties_fetched: streetEasyResults.totalFetched,
        streeteasy_properties_analyzed: streetEasyResults.totalAnalyzed,
        total_properties_found: combined.length,
        qualifying_properties_saved: streetEasyResults.properties.length,
        threshold_used: streetEasyResults.thresholdUsed,
        threshold_lowered: streetEasyResults.thresholdLowered,
        claude_api_calls: streetEasyResults.claudeApiCalls,
        claude_cost_usd: streetEasyResults.claudeCost,
        used_similar_fallback: streetEasyResults.usedSimilarFallback || false,
      });

      this.jobResults.set(jobId, {
        jobId,
        type: 'smart_search',
        source: streetEasyResults.usedSimilarFallback ? 'similar_listings' : 'cache_and_fresh',
        parameters: params,
        properties: combined,
        instagramReady: this.formatInstagramResponse(combined),
        cached: cacheResults,
        newlyScraped: streetEasyResults.properties,
        usedSimilarFallback: streetEasyResults.usedSimilarFallback || false,
        similarFallbackMessage: streetEasyResults.similarFallbackMessage || null,
        summary: {
          totalFound: combined.length,
          cacheHits: cacheResults.length,
          newlyScraped: streetEasyResults.properties.length,
          thresholdUsed: streetEasyResults.thresholdUsed,
          thresholdLowered: streetEasyResults.thresholdLowered,
          processingTimeMs: Date.now() - start,
          claudeApiCalls: streetEasyResults.claudeApiCalls,
          claudeCostUsd: streetEasyResults.claudeCost,
          usedSimilarFallback: streetEasyResults.usedSimilarFallback || false,
        },
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error('❌ REAL ERROR in startSmartSearch:', error);
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
            processing_duration_ms: Date.now() - start,
            error_message: error.message,
          });
        }
      } catch {}
    }
  }

  async smartCacheSearch(_params) { console.log('🔍 SKIPPING database cache search…'); return []; }

  async fetchWithThresholdFallback(params, fetchRecordId) {
    const thresholds = [params.undervaluationThreshold, ...this.thresholdSteps.map(s => params.undervaluationThreshold - s).filter(x => x >= 1)];
    let all = [];
    let apiCalls = 0, totalFetched = 0, totalAnalyzed = 0, claudeApiCalls = 0, claudeTokens = 0, claudeCost = 0;
    let thresholdUsed = params.undervaluationThreshold, thresholdLowered = false;

    for (const t of thresholds) {
      console.log(`🎯 Trying threshold: ${t}%`);
      const r = await this.fetchFromStreetEasy(params, t, fetchRecordId);
      apiCalls += r.apiCalls; totalFetched += r.totalFetched; totalAnalyzed += r.totalAnalyzed;
      claudeApiCalls += r.claudeApiCalls; claudeTokens += r.claudeTokens; claudeCost += r.claudeCost;
      if (r.properties.length > 0) { thresholdUsed = t; thresholdLowered = t < params.undervaluationThreshold; all = r.properties; break; }
    }
    return { properties: all, thresholdUsed, thresholdLowered, apiCalls, totalFetched, totalAnalyzed, claudeApiCalls, claudeTokens, claudeCost };
  }

  async fetchSimilarListings(originalParams, fetchRecordId) {
    console.log('🔄 Progressive fallback…');

    if (originalParams.maxPrice) {
      const ms = [1.2, 1.5, 2.0, 3.0, 5.0, 10.0];
      for (const m of ms) {
        const r = await this.fetchFromStreetEasy(
          { ...originalParams, maxPrice: Math.round(originalParams.maxPrice * m), minPrice: undefined, undervaluationThreshold: 1 },
          1,
          fetchRecordId
        );
        if (r.properties.length > 0) {
          const sorted = r.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
          const take = sorted.slice(0, originalParams.maxResults || 1).map(p => ({
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
          }));
          return {
            properties: take,
            fallbackMessage: `There were no matches in ${originalParams.neighborhood} under $${originalParams.maxPrice.toLocaleString()}, but here's the cheapest we found there:`,
            apiCalls: r.apiCalls, totalFetched: r.totalFetched, totalAnalyzed: r.totalAnalyzed, claudeApiCalls: r.claudeApiCalls, claudeCost: r.claudeCost,
          };
        }
      }
    }

    if (originalParams.bedrooms) {
      const r = await this.fetchFromStreetEasy(
        { ...originalParams, bedrooms: undefined, maxPrice: originalParams.maxPrice ? originalParams.maxPrice * 2 : undefined, undervaluationThreshold: 1 },
        1,
        fetchRecordId
      );
      if (r.properties.length > 0) {
        const sorted = r.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
        const take = sorted.slice(0, originalParams.maxResults || 1).map(p => ({
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
          apiCalls: r.apiCalls, totalFetched: r.totalFetched, totalAnalyzed: r.totalAnalyzed, claudeApiCalls: r.claudeApiCalls, claudeCost: r.claudeCost,
        };
      }
    }

    const similarNeighborhoods = this.getSimilarNeighborhoods(originalParams.neighborhood);
    for (const n of similarNeighborhoods) {
      const multipliers = originalParams.maxPrice ? [1.0, 1.2, 1.5, 2.0] : [1.0];
      for (const m of multipliers) {
        const r = await this.fetchFromStreetEasy(
          { ...originalParams, neighborhood: n, maxPrice: originalParams.maxPrice ? Math.round(originalParams.maxPrice * m) : undefined, undervaluationThreshold: 1 },
          1,
          fetchRecordId
        );
        if (r.properties.length > 0) {
          const sorted = r.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
          const take = sorted.slice(0, originalParams.maxResults || 1).map(p => ({
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
            apiCalls: r.apiCalls, totalFetched: r.totalFetched, totalAnalyzed: r.totalAnalyzed, claudeApiCalls: r.claudeApiCalls, claudeCost: r.claudeCost,
          };
        }
      }
    }

    // Last resort (Manhattan cheap)
    for (const n of ['east-village', 'lower-east-side', 'chinatown', 'financial-district']) {
      const r = await this.fetchFromStreetEasy(
        { ...originalParams, neighborhood: n, bedrooms: undefined, maxPrice: undefined, minPrice: undefined, undervaluationThreshold: 1 },
        1,
        fetchRecordId
      );
      if (r.properties.length > 0) {
        const sorted = r.properties.sort((a, b) => (a.monthly_rent || a.price || 0) - (b.monthly_rent || b.price || 0));
        const take = sorted.slice(0, 1).map(p => ({
          ...p, isSimilarFallback: true, fallbackStrategy: 'last_resort',
          originalSearchParams: originalParams, isLastResort: true, isCheapestAvailable: true,
        }));
        return {
          properties: take,
          fallbackMessage: `We couldn't find what you were looking for in ${originalParams.neighborhood}, but here's the cheapest in Manhattan:`,
          apiCalls: r.apiCalls, totalFetched: r.totalFetched, totalAnalyzed: r.totalAnalyzed, claudeApiCalls: r.claudeApiCalls, claudeCost: r.claudeCost,
        };
      }
    }

    return { properties: [], fallbackMessage: null, apiCalls: 0, totalFetched: 0, totalAnalyzed: 0, claudeApiCalls: 0, claudeCost: 0 };
  }

  getSimilarNeighborhoods(n) {
    const g = {
      soho: ['tribeca','nolita','west-village','east-village','lower-east-side'],
      tribeca: ['soho','financial-district','west-village','battery-park-city'],
      'west-village': ['soho','tribeca','east-village','chelsea','meatpacking-district'],
      'east-village': ['west-village','lower-east-side','nolita','gramercy'],
      'lower-east-side': ['east-village','chinatown','nolita','two-bridges'],
      nolita: ['soho','east-village','lower-east-side','little-italy'],
      chelsea: ['west-village','gramercy','flatiron','meatpacking-district'],
      gramercy: ['chelsea','east-village','murray-hill','flatiron'],
      'upper-west-side': ['upper-east-side','morningside-heights','harlem','lincoln-square'],
      'upper-east-side': ['upper-west-side','yorkville','midtown-east'],
      harlem: ['morningside-heights','upper-west-side','washington-heights','east-harlem'],
      williamsburg: ['greenpoint','bushwick','dumbo','bedstuy'],
      bushwick: ['williamsburg','bedstuy','ridgewood','east-williamsburg'],
      'park-slope': ['prospect-heights','gowanus','carroll-gardens','windsor-terrace'],
      dumbo: ['brooklyn-heights','downtown-brooklyn','williamsburg','vinegar-hill'],
      astoria: ['long-island-city','sunnyside','woodside','jackson-heights'],
      'long-island-city': ['astoria','sunnyside','hunters-point'],
    };
    return g[(n || '').toLowerCase()] || ['east-village','lower-east-side','chinatown'];
  }

  async fetchFromStreetEasy(params, threshold) {
    try {
      console.log(`📡 StreetEasy fetch: ${params.neighborhood}, threshold: ${threshold}%`);
      const apiUrl = params.propertyType === 'rental'
        ? 'https://streeteasy-api.p.rapidapi.com/rentals/search'
        : 'https://streeteasy-api.p.rapidapi.com/sales/search';

      const apiParams = { areas: params.neighborhood, limit: Math.min(20, (params.maxResults || 1) * 4), offset: 0 };
      if (params.minPrice) apiParams.minPrice = params.minPrice;
      if (params.maxPrice) apiParams.maxPrice = params.maxPrice;
      if (params.bedrooms) { apiParams.minBeds = params.bedrooms; apiParams.maxBeds = params.bedrooms; }
      if (params.bathrooms) { if (params.propertyType === 'rental') apiParams.minBath = params.bathrooms; else apiParams.minBaths = params.bathrooms; }

      const amenityFilters = [];
      if (params.noFee && params.propertyType === 'rental') apiParams.noFee = true;
      if (params.doorman) amenityFilters.push('doorman');
      if (params.elevator) amenityFilters.push('elevator');
      if (params.laundry) amenityFilters.push('laundry');
      if (params.privateOutdoorSpace) amenityFilters.push('private_outdoor_space');
      if (params.washerDryer) amenityFilters.push('washer_dryer');
      if (params.dishwasher) amenityFilters.push('dishwasher');
      if (amenityFilters.length) apiParams.amenities = amenityFilters.join(',');
      if (params.propertyType === 'sale' && params.propertyTypes?.length) apiParams.types = params.propertyTypes.join(',');

      const response = await axios.get(apiUrl, {
        params: apiParams,
        headers: { 'X-RapidAPI-Key': this.rapidApiKey, 'X-RapidAPI-Host': 'streeteasy-api.p.rapidapi.com' },
        timeout: 30000,
      });

      let listings = [];
      if (Array.isArray(response.data)) listings = response.data;
      else if (Array.isArray(response.data?.results)) listings = response.data.results;
      else if (Array.isArray(response.data?.listings)) listings = response.data.listings;

      if (!listings.length) {
        return { properties: [], apiCalls: 1, totalFetched: 0, totalAnalyzed: 0, claudeApiCalls: 0, claudeTokens: 0, claudeCost: 0 };
      }

      const analysis = await this.analyzePropertiesWithClaude(listings, params, threshold);
      const saved = await this.savePropertiesToDatabase(analysis.qualifyingProperties, params.propertyType, null);
      return {
        properties: saved,
        apiCalls: 1,
        totalFetched: listings.length,
        totalAnalyzed: listings.length,
        claudeApiCalls: analysis.claudeApiCalls,
        claudeTokens: analysis.claudeTokens,
        claudeCost: analysis.claudeCost,
      };
    } catch (e) {
      console.error('❌ StreetEasy fetch error:', e.message);
      return { properties: [], apiCalls: 1, totalFetched: 0, totalAnalyzed: 0, claudeApiCalls: 0, claudeTokens: 0, claudeCost: 0, error: e.message };
    }
  }

  async analyzePropertyBatchWithClaude(properties, params, threshold) {
    const prompt = this.buildDetailedClaudePrompt(properties, params, threshold);
    try {
      const r = await axios.post(
        'https://api.anthropic.com/v1/messages',
        { model: 'claude-3-haiku-20240307', max_tokens: 2000, temperature: 0.1, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'Content-Type': 'application/json', 'X-API-Key': this.claudeApiKey, 'anthropic-version': '2023-06-01' } }
      );
      const analysis = JSON.parse(r.data.content[0].text);
      const tokensUsed = (r.data.usage?.input_tokens || 0) + (r.data.usage?.output_tokens || 0);
      const cost = (tokensUsed / 1_000_000) * 1.25;

      const qualifyingProperties = properties
        .map((prop, i) => {
          const a = analysis.find(x => x.propertyIndex === i + 1) || { percentBelowMarket: 0, isUndervalued: false, reasoning: 'Analysis failed', score: 0, grade: 'F' };
          return { ...prop, discount_percent: a.percentBelowMarket, isUndervalued: a.isUndervalued, reasoning: a.reasoning, score: a.score || 0, grade: a.grade || 'F', analyzed: true };
        })
        .filter(p => p.discount_percent >= threshold);

      return { qualifyingProperties, tokensUsed, cost };
    } catch (e) {
      console.warn('⚠️ Claude batch analysis failed:', e.message);
      return { qualifyingProperties: [], tokensUsed: 0, cost: 0 };
    }
  }

  async analyzePropertiesWithClaude(listings, params, threshold) {
    const batchSize = 50;
    let all = [], calls = 0, tokens = 0, cost = 0;
    for (let i = 0; i < listings.length; i += batchSize) {
      const batch = listings.slice(i, i + batchSize);
      const r = await this.analyzePropertyBatchWithClaude(batch, params, threshold);
      all.push(...r.qualifyingProperties); calls += 1; tokens += r.tokensUsed; cost += r.cost;
      if (i + batchSize < listings.length) await this.delay(1000);
    }
    return { qualifyingProperties: all, claudeApiCalls: calls, claudeTokens: tokens, claudeCost: cost };
  }

  buildDetailedClaudePrompt(properties, params, threshold) {
    return `You are an expert NYC real estate analyst. Analyze these ${params.propertyType} properties in ${params.neighborhood} for undervaluation potential.

PROPERTIES TO ANALYZE:
${properties.map((prop, i) => `
Property ${i + 1}:
- Address: ${prop.address || 'Not listed'}
- ${params.propertyType === 'rental' ? 'Monthly Rent' : 'Sale Price'}: ${prop.price?.toLocaleString() || 'Not listed'}
- Layout: ${prop.bedrooms || 'N/A'}BR/${prop.bathrooms || 'N/A'}BA
- Square Feet: ${prop.sqft || 'Not listed'}
- Description: ${prop.description?.substring(0, 300) || 'None'}...
- Amenities: ${prop.amenities?.join(', ') || 'None listed'}
- Building Year: ${prop.built_in || 'Unknown'}
- Days on Market: ${prop.days_on_market || 'Unknown'}` ).join('\n')}

ANALYSIS REQUIREMENTS:
- Evaluate each property against typical ${params.neighborhood} market rates
- Consider location, amenities, condition, and comps
- Only mark as undervalued if discount is ${threshold}% or greater
- Provide score (0-100) and grade (A+ to F)

CRITICAL: Return ONLY a JSON array.

[{"propertyIndex":1,"percentBelowMarket":20,"isUndervalued":true,"reasoning":"...","score":85,"grade":"A-"}]`;
  }

  async savePropertiesToDatabase(properties, propertyType, fetchRecordId) {
    if (!properties.length) return [];
    console.log(`💾 SKIPPING database save of ${properties.length} properties…`);
    return properties.map(p => this.formatPropertyForDatabase(p, propertyType, fetchRecordId));
  }

  formatPropertyForDatabase(property, propertyType, fetchRecordId) {
    const extracted = this.extractAndFormatImages(property);
    const base = {
      fetch_job_id: fetchRecordId,
      listing_id: property.id || property.listing_id || `generated_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
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
      images: extracted.processedImages,
      image_count: extracted.count,
      primary_image: extracted.primary,
      instagram_ready_images: extracted.instagramReady,
      listing_url: property.url || property.listing_url || '',
      built_in: property.built_in || property.year_built || null,
      days_on_market: property.days_on_market || 0,
      status: 'active',
    };

    if (propertyType === 'rental') {
      return {
        ...base,
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
      };
    } else {
      return {
        ...base,
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
      if (Array.isArray(property.images)) raw = property.images;
      else if (Array.isArray(property.photos)) raw = property.photos;
      else if (property.media?.images) raw = property.media.images;
      else if (property.listingPhotos) raw = property.listingPhotos;

      const processed = raw
        .filter(img => (typeof img === 'string' && img) || (img && img.url))
        .map(img => this.optimizeImageForInstagram(typeof img === 'string' ? img : img.url))
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

  optimizeImageForInstagram(url) {
    if (!url) return null;
    try {
      if (url.includes('streeteasy.com')) {
        return url.replace('/small/', '/large/').replace('/medium/', '/large/').replace('_sm.', '_lg.').replace('_md.', '_lg.');
      }
      return url.startsWith('https://') ? url : url.replace('http://', 'https://');
    } catch {
      return url;
    }
  }

  generateImageCaption(p, i) {
    const price = p.monthly_rent || p.price;
    const priceText = p.monthly_rent ? `${price?.toLocaleString()}/month` : `${price?.toLocaleString()}`;
    return i === 0
      ? `🏠 ${p.bedrooms}BR/${p.bathrooms}BA in ${p.neighborhood}\n💰 ${priceText} (${p.discount_percent}% below market)\n📍 ${p.address}`
      : `📸 ${p.address} - Photo ${i + 1}`;
  }

  generateInstagramDMMessage(p) {
    const price = p.monthly_rent || p.price;
    const priceText = p.monthly_rent ? `$${price?.toLocaleString()}/month` : `$${price?.toLocaleString()}`;
    const savings = p.potential_monthly_savings || p.potential_savings;

    let msg = p.isSimilarFallback ? '🔄 *ALTERNATIVE FOUND*\n\n' : '🏠 *UNDERVALUED PROPERTY ALERT*\n\n';
    msg += `📍 **${p.address}**\n🏘️ ${p.neighborhood}, ${p.borough}\n\n💰 **${priceText}**\n`;
    msg += p.isSimilarFallback ? '💡 Cheapest available option\n\n' : `📉 ${p.discount_percent}% below market\n💵 Save $${savings?.toLocaleString()} ${p.monthly_rent ? 'per month' : 'total'}\n\n`;
    msg += `🏠 ${p.bedrooms}BR/${p.bathrooms}BA${p.sqft ? ` | ${p.sqft} sqft` : ''}\n📊 Score: ${p.score}/100 (${p.grade})\n\n`;
    const amenities = [];
    if (p.no_fee) amenities.push('No Fee');
    if (p.doorman_building) amenities.push('Doorman');
    if (p.elevator_building) amenities.push('Elevator');
    if (p.pet_friendly) amenities.push('Pet Friendly');
    if (p.gym_available) amenities.push('Gym');
    if (amenities.length) msg += `✨ ${amenities.join(' • ')}\n\n`;
    msg += `🧠 *AI Analysis:*\n"${(p.reasoning || '').substring(0, 150)}..."\n\n`;
    msg += `🔗 [View Full Listing](${p.listing_url})`;
    return msg;
  }

  formatInstagramResponse(props) {
    return props.map(p => ({
      ...p,
      instagram: {
        primaryImage: p.primary_image,
        imageCount: p.image_count,
        images: p.instagram_ready_images || [],
        dmMessage: this.generateInstagramDMMessage(p),
      },
    }));
  }

  combineResults(cacheResults, newResults, maxResults) {
    const combined = [...cacheResults];
    const seen = new Set(cacheResults.map(r => r.listing_id));
    for (const r of newResults) if (!seen.has(r.listing_id)) combined.push({ ...r, source: 'fresh', isCached: false });
    return combined.sort((a, b) => (b.discount_percent || 0) - (a.discount_percent || 0)).slice(0, maxResults);
  }

  async createFetchRecord(jobId, params) { console.log('🔍 SKIPPING database - fake record'); return { id: `fake_${jobId}`, job_id: jobId, status: 'processing', neighborhood: params.neighborhood, property_type: params.propertyType }; }
  async updateFetchRecord(_id, updates) { console.log('🔍 SKIPPING database update:', updates.status || 'processing'); }

  getBoroughFromNeighborhood(n) {
    const m = { soho:'Manhattan', tribeca:'Manhattan', 'west-village':'Manhattan', 'east-village':'Manhattan', 'lower-east-side':'Manhattan', chinatown:'Manhattan', 'financial-district':'Manhattan', 'battery-park-city':'Manhattan', chelsea:'Manhattan', gramercy:'Manhattan', 'murray-hill':'Manhattan', midtown:'Manhattan', "hell-s-kitchen":'Manhattan', 'upper-west-side':'Manhattan', 'upper-east-side':'Manhattan', harlem:'Manhattan', 'washington-heights':'Manhattan', williamsburg:'Brooklyn', bushwick:'Brooklyn', bedstuy:'Brooklyn', 'park-slope':'Brooklyn', 'red-hook':'Brooklyn', dumbo:'Brooklyn', 'brooklyn-heights':'Brooklyn', 'carroll-gardens':'Brooklyn', 'cobble-hill':'Brooklyn', 'fort-greene':'Brooklyn', 'prospect-heights':'Brooklyn', 'crown-heights':'Brooklyn', astoria:'Queens', 'long-island-city':'Queens', 'forest-hills':'Queens', flushing:'Queens', elmhurst:'Queens', 'jackson-heights':'Queens', 'mott-haven':'Bronx', 'south-bronx':'Bronx', concourse:'Bronx', fordham:'Bronx', riverdale:'Bronx' };
    return m[n?.toLowerCase()] || 'Unknown';
  }

  generateJobId() { return `smart_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`; }
  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  start() {
    this.app.listen(this.port, () => {
      console.log(`🚀 API running on port ${this.port}`);
      console.log(`📊 Docs: http://localhost:${this.port}/api`);
      console.log(`🧠 Mode: Smart cache-first + IG checkout`);
      console.log(`🔗 Stripe Link (base): ${this.STRIPE_CHECKOUT_URL}`);
    });
  }
}

if (require.main === module) {
  const api = new SmartCacheFirstAPI();
  api.start();
}

module.exports = SmartCacheFirstAPI;
