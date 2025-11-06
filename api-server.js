// api-server.js
// COMPLETE INSTAGRAM-OPTIMIZED SMART CACHE-FIRST API SERVER
// NOW WITH STRIPE + SUPABASE INTEGRATION FOR SUBSCRIPTIONS
// Ready-to-deploy version with all optimizations included

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

class SmartCacheFirstAPI {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.apiKey = process.env.VC_API_KEY || 'your-secure-api-key';
        this.rapidApiKey = process.env.RAPIDAPI_KEY;
        this.claudeApiKey = process.env.ANTHROPIC_API_KEY;
        
        // Initialize Supabase lazily when first needed
        this._supabase = null;
        this._supabaseClient = null;

        
        this.activeJobs = new Map();
        this.jobResults = new Map();
        
        // Cache settings
        this.cacheMaxAgeDays = 30;
        this.thresholdSteps = [5, 4, 3, 2, 1];
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupErrorHandling();
    }

    get supabase() {
        console.log('🔍 SKIPPING Supabase client creation (database disabled for testing)');
        return null;
    }

    // NEW: Supabase client for Stripe integration (uses service role key)
    getSupabaseClient() {
        if (!this._supabaseClient) {
            this._supabaseClient = createClient(
                process.env.SUPABASE_URL,
                process.env.SUPABASE_SERVICE_ROLE_KEY
            );
            console.log('✅ Supabase client initialized for Stripe integration');
        }
        return this._supabaseClient;
    }

    setupMiddleware() {
        this.app.use(helmet());
        this.app.use(compression());
        this.app.use(cors({
            origin: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
            credentials: true
        }));

        this.app.set('trust proxy', true);
        
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 100,
            message: {
                error: 'Too many requests from this IP, please try again later.',
                retryAfter: 15 * 60
            }
        });
        this.app.use('/api/', limiter);
        
        // CRITICAL: Use raw body for webhook, JSON for everything else
        this.app.use((req, res, next) => {
            if (req.path === '/api/stripe/webhook') {
                next();
            } else {
                express.json({ limit: '10mb' })(req, res, next);
            }
        });
        this.app.use(express.urlencoded({ extended: true }));
        
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });
    }

    authenticateAPI(req, res, next) {
        const apiKey = req.headers['x-api-key'] || req.query.apiKey;
        
        console.log('🔍 AUTH DEBUG:');
        console.log('  Received Key:', apiKey);
        console.log('  Expected Key:', this.apiKey);
        console.log('  Keys Match:', apiKey === this.apiKey);
        
        if (!apiKey || apiKey !== this.apiKey) {
            console.log('❌ Authentication failed');
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Valid API key required in X-API-Key header'
            });
        }
        
        console.log('✅ Authentication successful');
        next();
    }

    setupRoutes() {
        // ========================================================================
        // PUBLIC ROUTES (NO AUTH REQUIRED)
        // ========================================================================

        // API Documentation
        this.app.get('/api', (req, res) => {
            const baseUrl = req.protocol + '://' + req.get('host');
            
            res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NYC Real Estate API - Documentation</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1200px; 
            margin: 0 auto; 
            padding: 40px 20px; 
            line-height: 1.6; 
            color: #333;
            background: #f8f9fa;
        }
        .container { 
            background: white; 
            padding: 40px; 
            border-radius: 12px; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header { 
            text-align: center; 
            margin-bottom: 40px; 
            border-bottom: 2px solid #e9ecef; 
            padding-bottom: 30px;
        }
        .endpoint { 
            margin: 30px 0; 
            padding: 25px; 
            background: #f8f9fa; 
            border-radius: 8px; 
            border-left: 4px solid #007bff;
        }
        .method { 
            background: #007bff; 
            color: white; 
            padding: 4px 12px; 
            border-radius: 4px; 
            font-weight: bold; 
            font-size: 12px;
            display: inline-block;
            margin-right: 10px;
        }
        .method.get { background: #28a745; }
        .method.post { background: #007bff; }
        .command { 
            background: #2d3748; 
            color: #e2e8f0; 
            padding: 15px; 
            border-radius: 6px; 
            font-family: 'Monaco', 'Menlo', monospace; 
            font-size: 13px; 
            overflow-x: auto; 
            margin: 15px 0;
            white-space: pre-wrap;
        }
        h1 { color: #2d3748; }
        h2 { color: #4a5568; margin-top: 40px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🏠 NYC Real Estate API Documentation</h1>
            <p>Complete API reference for AI-powered property discovery</p>
            <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
        </div>
        <h2>Available Endpoints</h2>
        <div class="endpoint">
            <h3><span class="method post">POST</span>/api/search/smart</h3>
            <p>Search for undervalued properties (requires X-API-Key)</p>
        </div>
        <div class="endpoint">
            <h3><span class="method post">POST</span>/api/preferences/save</h3>
            <p>Save user preferences and create Stripe checkout (no auth required)</p>
        </div>
        <div class="endpoint">
            <h3><span class="method get">GET</span>/api/billing/portal</h3>
            <p>Get Stripe billing portal URL (no auth required)</p>
        </div>
    </div>
</body>
</html>
            `);
        });

        // Homepage
        this.app.get('/', (req, res) => {
            const baseUrl = req.protocol + '://' + req.get('host');
            res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NYC Real Estate API</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1000px; 
            margin: 0 auto; 
            padding: 40px 20px; 
            line-height: 1.6; 
            color: #333;
            background: #f8f9fa;
        }
        .container { 
            background: white; 
            padding: 40px; 
            border-radius: 12px; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header { 
            text-align: center; 
            margin-bottom: 40px; 
            border-bottom: 2px solid #e9ecef; 
            padding-bottom: 30px;
        }
        .status { 
            background: #d4edda; 
            color: #155724; 
            padding: 12px 20px; 
            border-radius: 6px; 
            display: inline-block; 
            font-weight: 500;
            margin-bottom: 20px;
        }
        h1 { color: #2d3748; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Realer Estate API</h1>
            <div class="status">✅ API Operational</div>
            <p>AI-powered undervalued property discovery</p>
        </div>
        <p><a href="/api">→ Full API Documentation</a></p>
        <p><a href="/health">→ Health Check</a></p>
    </div>
</body>
</html>
            `);
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                service: 'nyc_full_api',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                version: '3.1.0',
                features: [
                    'smart_search',
                    'stripe_integration',
                    'subscription_management',
                    'instagram_dm_ready'
                ],
                activeJobs: this.activeJobs.size
            });
        });

        // ========================================================================
        // NEW: STRIPE + SUPABASE INTEGRATION ROUTES (NO AUTH)
        // ========================================================================

        this.setupPreferencesRoute();
        this.setupWebhookRoute();
        this.setupBillingPortalRoute();

        // ========================================================================
        // PROTECTED ROUTES (REQUIRE X-API-KEY)
        // ========================================================================

        this.app.use('/api/', this.authenticateAPI.bind(this));

        // Smart property search
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
                    doorman = false,
                    elevator = false,
                    laundry = false,
                    privateOutdoorSpace = false,
                    washerDryer = false,
                    dishwasher = false,
                    propertyTypes = [],
                    maxHoa,
                    maxTax
                } = req.body;

                if (!neighborhood) {
                    return res.status(400).json({
                        error: 'Bad Request',
                        message: 'neighborhood parameter is required',
                        example: 'bushwick, soho, tribeca, williamsburg'
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
                    noFee
                });

                res.status(202).json({
                    success: true,
                    data: {
                        jobId: jobId,
                        status: 'started',
                        message: `Smart search started for ${neighborhood}`,
                        parameters: req.body,
                        estimatedDuration: '4-8 seconds',
                        checkStatusUrl: `/api/jobs/${jobId}`,
                        getResultsUrl: `/api/results/${jobId}`
                    }
                });

            } catch (error) {
                console.error('Smart search error:', error);
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: 'Failed to start smart search',
                    details: error.message
                });
            }
        });

        // Job status endpoint
        this.app.get('/api/jobs/:jobId', (req, res) => {
            const { jobId } = req.params;
            const job = this.activeJobs.get(jobId);
            
            if (!job) {
                return res.status(404).json({
                    error: 'Not Found',
                    message: 'Job ID not found'
                });
            }

            res.json({
                success: true,
                data: {
                    jobId: jobId,
                    status: job.status,
                    progress: job.progress || 0,
                    startTime: job.startTime,
                    lastUpdate: job.lastUpdate,
                    message: job.message,
                    error: job.error || null
                }
            });
        });

        // Job results endpoint
        this.app.get('/api/results/:jobId', (req, res) => {
            const { jobId } = req.params;
            const results = this.jobResults.get(jobId);
            
            if (!results) {
                return res.status(404).json({
                    error: 'Not Found',
                    message: 'Results not found for this job ID'
                });
            }
            res.json({
                success: true,
                data: results
            });
        });

        // Cache stats
        this.app.get('/api/cache/stats', async (req, res) => {
            res.json({
                success: true,
                data: {
                    total_requests: 0,
                    cache_only_requests: 0,
                    cache_hit_rate: 0,
                    avg_processing_time_ms: 0,
                    note: 'Database disabled for testing'
                }
            });
        });

        // Trigger full search from Railway Function
        this.app.post('/api/trigger/full-search', async (req, res) => {
            try {
                const searchParams = req.body;
                
                console.log('🚀 Full API triggered by Railway Function');
                
                const jobId = this.generateJobId();
                
                this.startSmartSearch(jobId, {
                    ...searchParams,
                    neighborhood: searchParams.neighborhood?.toLowerCase().replace(/\s+/g, '-'),
                    maxResults: Math.min(parseInt(searchParams.maxResults || 1), 5),
                    source: 'railway_function_fallback'
                });

                res.status(202).json({
                    success: true,
                    data: {
                        jobId: jobId,
                        status: 'started',
                        message: `Full API search started for ${searchParams.neighborhood}`,
                        estimatedDuration: '2-5 minutes',
                        checkStatusUrl: `/api/jobs/${jobId}`,
                        getResultsUrl: `/api/results/${jobId}`,
                        source: 'railway_function_fallback'
                    }
                });

            } catch (error) {
                console.error('Full API trigger error:', error);
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: 'Failed to trigger full API search',
                    details: error.message
                });
            }
        });
    }

    // ============================================================================
    // NEW: STRIPE + SUPABASE ROUTE IMPLEMENTATIONS
    // ============================================================================

    setupPreferencesRoute() {
        this.app.post('/api/preferences/save', async (req, res) => {
            try {
                const {
                    email,
                    instagram_handle,
                    bedrooms,
                    max_budget,
                    preferred_neighborhoods,
                    neighborhood_preferences,
                    discount_threshold,
                    property_type,
                    marketing_channel,
                    subscription_renewal = 'monthly'
                } = req.body;

                // Validate required fields
                if (!email || !email.includes('@')) {
                    return res.status(400).json({
                        error: 'Invalid email address'
                    });
                }

                // Sanitize and validate inputs
                const sanitizedEmail = email.toLowerCase().trim();
                const sanitizedNeighborhoods = (preferred_neighborhoods || neighborhood_preferences || [])
                    .map(n => n.toLowerCase().trim());
                
                const validatedBedrooms = bedrooms ? Math.min(Math.max(parseInt(bedrooms), 0), 10) : null;
                const validatedBudget = max_budget ? Math.max(parseInt(max_budget), 0) : null;
                const validatedDiscount = discount_threshold ? Math.min(Math.max(parseInt(discount_threshold), 1), 100) : 15;

                console.log('💾 Upserting profile:', {
                    email: sanitizedEmail,
                    instagram_handle,
                    neighborhoods: sanitizedNeighborhoods
                });

                // Upsert profile to Supabase
                const supabase = this.getSupabaseClient();
                
                const { data: existingProfile, error: fetchError } = await supabase
                    .from('profiles')
                    .select('id, stripe_customer_id')
                    .eq('email_address', sanitizedEmail)
                    .single();

                let profileId;
                let stripeCustomerId = existingProfile?.stripe_customer_id;

                if (existingProfile) {
                    // Update existing profile
                    const { data: updated, error: updateError } = await supabase
                        .from('profiles')
                        .update({
                            instagram_handle,
                            bedrooms: validatedBedrooms,
                            max_budget: validatedBudget,
                            preferred_neighborhoods: sanitizedNeighborhoods,
                            neighborhood_preferences: sanitizedNeighborhoods,
                            discount_threshold: validatedDiscount,
                            property_type,
                            marketing_channel,
                            subscription_renewal
                        })
                        .eq('id', existingProfile.id)
                        .select()
                        .single();

                    if (updateError) throw updateError;
                    profileId = existingProfile.id;
                    console.log('✅ Updated existing profile:', profileId);
                } else {
                    // Create new profile
                    const { data: created, error: createError } = await supabase
                        .from('profiles')
                        .insert({
                            email_address: sanitizedEmail,
                            instagram_handle,
                            bedrooms: validatedBedrooms,
                            max_budget: validatedBudget,
                            preferred_neighborhoods: sanitizedNeighborhoods,
                            neighborhood_preferences: sanitizedNeighborhoods,
                            discount_threshold: validatedDiscount,
                            property_type,
                            marketing_channel,
                            subscription_plan: 'free',
                            subscription_renewal,
                            is_canceled: false
                        })
                        .select()
                        .single();

                    if (createError) throw createError;
                    profileId = created.id;
                    console.log('✅ Created new profile:', profileId);
                }

                // Create Stripe Checkout Session
                const priceId = subscription_renewal === 'annual'
                    ? process.env.STRIPE_PRICE_UNLIMITED_ANNUAL
                    : process.env.STRIPE_PRICE_UNLIMITED_MONTHLY;

                const session = await stripe.checkout.sessions.create({
                    mode: 'subscription',
                    payment_method_types: ['card'],
                    line_items: [{
                        price: priceId,
                        quantity: 1
                    }],
                    customer_email: sanitizedEmail,
                    client_reference_id: profileId,
                    metadata: {
                        profile_id: profileId,
                        instagram_handle: instagram_handle || '',
                        neighborhood: sanitizedNeighborhoods[0] || 'nyc'
                    },
                    success_url: process.env.STRIPE_SUCCESS_URL,
                    cancel_url: process.env.STRIPE_CANCEL_URL,
                    allow_promotion_codes: true
                });

                console.log('💳 Stripe Checkout created:', session.id);
                console.log('📧 Customer email:', sanitizedEmail);
                console.log('🆔 Profile ID:', profileId);

                res.json({
                    success: true,
                    checkoutUrl: session.url,
                    profileId,
                    sessionId: session.id
                });

            } catch (error) {
                console.error('❌ Preferences save error:', error);
                res.status(500).json({
                    error: 'Failed to save preferences',
                    message: error.message
                });
            }
        });
    }

    setupWebhookRoute() {
        this.app.post('/api/stripe/webhook',
            express.raw({ type: 'application/json' }),
            async (req, res) => {
                const sig = req.headers['stripe-signature'];
                let event;

                try {
                    event = stripe.webhooks.constructEvent(
                        req.body,
                        sig,
                        process.env.STRIPE_WEBHOOK_SECRET
                    );
                } catch (err) {
                    console.error('⚠️ Webhook signature verification failed:', err.message);
                    return res.status(400).send(`Webhook Error: ${err.message}`);
                }

                console.log('🎣 Webhook received:', event.type);

                try {
                    const supabase = this.getSupabaseClient();

                    switch (event.type) {
                        case 'checkout.session.completed': {
                            const session = event.data.object;
                            
                            console.log('✅ Checkout completed:', {
                                session_id: session.id,
                                customer: session.customer,
                                email: session.customer_email,
                                profile_id: session.client_reference_id
                            });

                            let subscriptionRenewal = 'monthly';
                            if (session.subscription) {
                                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                                const interval = subscription.items.data[0]?.price?.recurring?.interval;
                                subscriptionRenewal = interval === 'year' ? 'annual' : 'monthly';
                            }

                            const { error: updateError } = await supabase
                                .from('profiles')
                                .update({
                                    stripe_customer_id: session.customer,
                                    subscription_plan: 'unlimited',
                                    subscription_renewal: subscriptionRenewal,
                                    is_canceled: false
                                })
                                .or(`id.eq.${session.client_reference_id},email_address.eq.${session.customer_email}`);

                            if (updateError) {
                                console.error('❌ Profile update error:', updateError);
                            } else {
                                console.log('✅ Profile activated:', session.client_reference_id);
                            }
                            break;
                        }

                        case 'customer.subscription.updated': {
                            const subscription = event.data.object;
                            
                            console.log('🔄 Subscription updated:', {
                                customer: subscription.customer,
                                status: subscription.status
                            });

                            const isCanceled = ['canceled', 'incomplete_expired'].includes(subscription.status);
                            const interval = subscription.items.data[0]?.price?.recurring?.interval;
                            const subscriptionRenewal = interval === 'year' ? 'annual' : 'monthly';

                            const { error: updateError } = await supabase
                                .from('profiles')
                                .update({
                                    subscription_renewal: subscriptionRenewal,
                                    is_canceled: isCanceled,
                                    ...(isCanceled ? { subscription_plan: 'free' } : {})
                                })
                                .eq('stripe_customer_id', subscription.customer);

                            if (updateError) {
                                console.error('❌ Subscription update error:', updateError);
                            } else {
                                console.log('✅ Subscription synced:', subscription.customer);
                            }
                            break;
                        }

                        case 'customer.subscription.deleted': {
                            const subscription = event.data.object;
                            
                            console.log('❌ Subscription canceled:', subscription.customer);

                            const { error: updateError } = await supabase
                                .from('profiles')
                                .update({
                                    is_canceled: true,
                                    subscription_plan: 'free'
                                })
                                .eq('stripe_customer_id', subscription.customer);

                            if (updateError) {
                                console.error('❌ Cancellation update error:', updateError);
                            } else {
                                console.log('✅ Subscription canceled:', subscription.customer);
                            }
                            break;
                        }

                        default:
                            console.log('ℹ️ Unhandled event type:', event.type);
                    }

                    res.json({ received: true });

                } catch (error) {
                    console.error('❌ Webhook processing error:', error);
                    res.status(500).json({ error: 'Webhook processing failed' });
                }
            }
        );
    }

    setupBillingPortalRoute() {
        this.app.get('/api/billing/portal', async (req, res) => {
            try {
                const { email, stripe_customer_id } = req.query;

                if (!email && !stripe_customer_id) {
                    return res.status(400).json({
                        error: 'Email or stripe_customer_id required'
                    });
                }

                let customerId = stripe_customer_id;

                if (!customerId && email) {
                    const supabase = this.getSupabaseClient();
                    const { data: profile, error } = await supabase
                        .from('profiles')
                        .select('stripe_customer_id')
                        .eq('email_address', email.toLowerCase().trim())
                        .single();

                    if (error || !profile?.stripe_customer_id) {
                        return res.status(404).json({
                            error: 'No subscription found for this email'
                        });
                    }

                    customerId = profile.stripe_customer_id;
                }

                const session = await stripe.billingPortal.sessions.create({
                    customer: customerId,
                    return_url: process.env.STRIPE_PORTAL_RETURN_URL
                });

                console.log('💳 Billing portal created for:', customerId);

                res.json({
                    success: true,
                    portalUrl: session.url
                });

            } catch (error) {
                console.error('❌ Billing portal error:', error);
                res.status(500).json({
                    error: 'Failed to create billing portal',
                    message: error.message
                });
            }
        });
    }

    setupErrorHandling() {
        this.app.use((req, res) => {
            res.status(404).json({
                error: 'Not Found',
                message: 'Endpoint not found',
                availableEndpoints: '/api'
            });
        });

        this.app.use((error, req, res, next) => {
            console.error('Global error handler:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred'
            });
        });
    }

    // ============================================================================
    // EXISTING SMART SEARCH LOGIC (UNCHANGED)
    // ============================================================================

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
            thresholdLowered: false
        };
        
        this.activeJobs.set(jobId, job);
        let fetchRecord = null;

        try {
            console.log('🔍 Step 1: Creating fetch record...');
            fetchRecord = await this.createFetchRecord(jobId, params);
            console.log('✅ Step 1 complete - fetch record created');

            job.progress = 20;
            job.message = 'Checking cache for existing matches...';
            job.lastUpdate = new Date().toISOString();

            console.log('🔍 Step 2: Starting cache search...');
            const cacheResults = await this.smartCacheSearch(params);
            console.log('✅ Step 2 complete - cache search done');
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
                    total_properties_found: cacheResults.length
                });

                this.jobResults.set(jobId, {
                    jobId: jobId,
                    type: 'smart_search',
                    source: 'cache_only',
                    parameters: params,
                    properties: cacheResults,
                    instagramReady: this.formatInstagramResponse(cacheResults),
                    instagramSummary: {
                        hasImages: cacheResults.some(p => p.image_count > 0),
                        totalImages: cacheResults.reduce((sum, p) => sum + (p.image_count || 0), 0),
                        primaryImages: cacheResults.map(p => p.primary_image).filter(Boolean),
                        readyForPosting: cacheResults.filter(p => p.image_count > 0 && p.primary_image)
                    },
                    summary: {
                        totalFound: cacheResults.length,
                        cacheHits: cacheResults.length,
                        newlyScraped: 0,
                        thresholdUsed: params.undervaluationThreshold,
                        processingTimeMs: Date.now() - startTime
                    },
                    completedAt: new Date().toISOString()
                });
                return;
            }

            job.progress = 40;
            job.message = `Found ${cacheResults.length} cached properties, fetching more from StreetEasy...`;
            job.lastUpdate = new Date().toISOString();

            console.log('🔍 Step 3: Starting StreetEasy fetch...');
            const streetEasyResults = await this.fetchWithThresholdFallback(params, fetchRecord.id);
            console.log('✅ Step 3 complete - StreetEasy fetch done');

            if (streetEasyResults.properties.length === 0 && cacheResults.length === 0) {
                job.progress = 70;
                job.message = 'No direct matches found, searching for similar listings...';
                job.lastUpdate = new Date().toISOString();
                
                console.log('🔍 Step 4: Starting similar listings fallback...');
                const similarResults = await this.fetchSimilarListings(params, fetchRecord.id);
                console.log('✅ Step 4 complete - similar listings search done');
                
                if (similarResults.properties.length === 0) {
                    job.status = 'completed';
                    job.progress = 100;
                    job.message = 'No properties found matching criteria or similar alternatives';
                    
                    await this.updateFetchRecord(fetchRecord.id, {
                        status: 'completed',
                        completed_at: new Date().toISOString(),
                        processing_duration_ms: Date.now() - startTime,
                        total_properties_found: 0
                    });

                    this.jobResults.set(jobId, {
                        jobId: jobId,
                        type: 'smart_search',
                        source: 'no_results',
                        parameters: params,
                        properties: [],
                        instagramReady: [],
                        instagramSummary: {
                            hasImages: false,
                            totalImages: 0,
                            primaryImages: [],
                            readyForPosting: []
                        },
                        summary: {
                            totalFound: 0,
                            cacheHits: cacheResults.length,
                            newlyScraped: 0,
                            thresholdUsed: params.undervaluationThreshold,
                            processingTimeMs: Date.now() - startTime
                        },
                        completedAt: new Date().toISOString()
                    });
                    return;
                } else {
                    streetEasyResults.properties = similarResults.properties;
                    streetEasyResults.usedSimilarFallback = true;
                    streetEasyResults.similarFallbackMessage = similarResults.fallbackMessage;
                }
            }
            
            job.progress = 90;
            job.message = 'Combining cached and new results...';
            job.lastUpdate = new Date().toISOString();

            const combinedResults = this.combineResults(cacheResults, streetEasyResults.properties, params.maxResults);
            job.thresholdUsed = streetEasyResults.thresholdUsed;
            job.thresholdLowered = streetEasyResults.thresholdLowered;

            job.status = 'completed';
            job.progress = 100;
            
            if (streetEasyResults.usedSimilarFallback) {
                job.message = `Found ${combinedResults.length} similar properties (${cacheResults.length} cached + ${streetEasyResults.properties.length} similar)`;
            } else {
                job.message = `Found ${combinedResults.length} total properties (${cacheResults.length} cached + ${streetEasyResults.properties.length} new)`;
            }
            job.lastUpdate = new Date().toISOString();

            await this.updateFetchRecord(fetchRecord.id, {
                status: 'completed',
                completed_at: new Date().toISOString(),
                processing_duration_ms: Date.now() - startTime,
                used_cache_only: false,
                cache_hits: cacheResults.length,
                total_properties_found: combinedResults.length
            });

            this.jobResults.set(jobId, {
                jobId: jobId,
                type: 'smart_search',
                source: streetEasyResults.usedSimilarFallback ? 'similar_listings' : 'cache_and_fresh',
                parameters: params,
                properties: combinedResults,
                instagramReady: this.formatInstagramResponse(combinedResults),
                instagramSummary: {
                    hasImages: combinedResults.some(p => p.image_count > 0),
                    totalImages: combinedResults.reduce((sum, p) => sum + (p.image_count || 0), 0),
                    primaryImages: combinedResults.map(p => p.primary_image).filter(Boolean),
                    readyForPosting: combinedResults.filter(p => p.image_count > 0 && p.primary_image)
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
                    usedSimilarFallback: streetEasyResults.usedSimilarFallback || false
                },
                completedAt: new Date().toISOString()
            });

        } catch (error) {
            console.error('❌ REAL ERROR in startSmartSearch:', error.name, error.message);
            console.error('❌ STACK TRACE:', error.stack);
            
            job.status = 'failed';
            job.error = error.message;
            job.lastUpdate = new Date().toISOString();

            try {
                if (fetchRecord?.id) {
                    await this.updateFetchRecord(fetchRecord.id, {
                        status: 'failed',
                        completed_at: new Date().toISOString(),
                        processing_duration_ms: Date.now() - startTime,
                        error_message: error.message
                    });
                }
            } catch (updateError) {
                console.warn('Failed to update fetch record:', updateError.message);
            }
        }
    }

    async smartCacheSearch(params) {
        console.log(`🔍 SKIPPING database cache search for ${params.neighborhood}...`);
        console.log(`✅ Cache search: 0 properties (database skipped)`);
        return [];
    }

    async fetchWithThresholdFallback(params, fetchRecordId) {
        const thresholds = [params.undervaluationThreshold];
        
        for (const step of this.thresholdSteps) {
            const lowerThreshold = params.undervaluationThreshold - step;
            if (lowerThreshold >= 1) {
                thresholds.push(lowerThreshold);
            }
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
            claudeCost
        };
    }

    async fetchSimilarListings(originalParams, fetchRecordId) {
        console.log('🔄 PROGRESSIVE FALLBACK: Starting search...');
        
        if (originalParams.maxPrice) {
            const budgetMultipliers = [1.2, 1.5, 2.0, 3.0, 5.0, 10.0];
            
            for (const multiplier of budgetMultipliers) {
                const newBudget = Math.round(originalParams.maxPrice * multiplier);
                
                const results = await this.fetchFromStreetEasy({
                    ...originalParams,
                    maxPrice: newBudget,
                    minPrice: undefined,
                    undervaluationThreshold: 1
                }, 1, fetchRecordId);
                
                if (results.properties.length > 0) {
                    const sortedProperties = results.properties.sort((a, b) => {
                        const priceA = a.monthly_rent || a.price || 0;
                        const priceB = b.monthly_rent || b.price || 0;
                        return priceA - priceB;
                    });
                    
                    const cheapestProperties = sortedProperties.slice(0, originalParams.maxResults || 1);
                    
                    const markedProperties = cheapestProperties.map(prop => ({
                        ...prop,
                        isSimilarFallback: true,
                        fallbackStrategy: 'progressive_budget_increase'
                    }));
                    
                    return {
                        properties: markedProperties,
                        fallbackMessage: 'No properties found under budget, here is the cheapest available:',
                        fallbackStrategy: 'progressive_budget_increase',
                        apiCalls: results.apiCalls,
                        totalFetched: results.totalFetched,
                        totalAnalyzed: results.totalAnalyzed,
                        claudeApiCalls: results.claudeApiCalls || 0,
                        claudeTokens: results.claudeTokens || 0,
                        claudeCost: results.claudeCost || 0
                    };
                }
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
            claudeCost: 0
        };
    }

    async fetchFromStreetEasy(params, threshold, fetchRecordId) {
        try {
            const apiUrl = params.propertyType === 'rental' 
                ? 'https://streeteasy-api.p.rapidapi.com/rentals/search'
                : 'https://streeteasy-api.p.rapidapi.com/sales/search';
            
            const apiParams = {
                areas: params.neighborhood,
                limit: Math.min(20, params.maxResults * 4),
                offset: 0
            };

            if (params.minPrice) apiParams.minPrice = params.minPrice;
            if (params.maxPrice) apiParams.maxPrice = params.maxPrice;
            if (params.bedrooms) {
                apiParams.minBeds = params.bedrooms;
                apiParams.maxBeds = params.bedrooms;
            }
            if (params.bathrooms) {
                apiParams.minBath = params.bathrooms;
            }
            if (params.noFee && params.propertyType === 'rental') {
                apiParams.noFee = true;
            }

            const response = await axios.get(apiUrl, {
                params: apiParams,
                headers: {
                    'X-RapidAPI-Key': this.rapidApiKey,
                    'X-RapidAPI-Host': 'streeteasy-api.p.rapidapi.com'
                },
                timeout: 30000
            });

            let listings = [];
            if (response.data?.results && Array.isArray(response.data.results)) {
                listings = response.data.results;
            } else if (response.data?.listings && Array.isArray(response.data.listings)) {
                listings = response.data.listings;
            } else if (Array.isArray(response.data)) {
                listings = response.data;
            }

            if (listings.length === 0) {
                return {
                    properties: [],
                    apiCalls: 1,
                    totalFetched: 0,
                    totalAnalyzed: 0,
                    claudeApiCalls: 0,
                    claudeTokens: 0,
                    claudeCost: 0
                };
            }

            const analysisResults = await this.analyzePropertiesWithClaude(listings, params, threshold);
            const savedProperties = await this.savePropertiesToDatabase(
                analysisResults.qualifyingProperties, 
                params.propertyType, 
                fetchRecordId
            );

            return {
                properties: savedProperties,
                apiCalls: 1,
                totalFetched: listings.length,
                totalAnalyzed: listings.length,
                claudeApiCalls: analysisResults.claudeApiCalls,
                claudeTokens: analysisResults.claudeTokens,
                claudeCost: analysisResults.claudeCost
            };

        } catch (error) {
            console.error('❌ StreetEasy fetch error:', error.message);
            return {
                properties: [],
                apiCalls: 1,
                totalFetched: 0,
                totalAnalyzed: 0,
                claudeApiCalls: 0,
                claudeTokens: 0,
                claudeCost: 0
            };
        }
    }

    async analyzePropertiesWithClaude(listings, params, threshold) {
        const batchSize = 50;
        let allQualifyingProperties = [];
        let totalClaudeApiCalls = 0;
        let totalClaudeTokens = 0;
        let totalClaudeCost = 0;

        for (let i = 0; i < listings.length; i += batchSize) {
            const batch = listings.slice(i, i + batchSize);
            
            const batchResults = await this.analyzePropertyBatchWithClaude(batch, params, threshold);
            
            allQualifyingProperties.push(...batchResults.qualifyingProperties);
            totalClaudeApiCalls += 1;
            totalClaudeTokens += batchResults.tokensUsed;
            totalClaudeCost += batchResults.cost;
            
            if (i + batchSize < listings.length) {
                await this.delay(1000);
            }
        }

        return {
            qualifyingProperties: allQualifyingProperties,
            claudeApiCalls: totalClaudeApiCalls,
            claudeTokens: totalClaudeTokens,
            claudeCost: totalClaudeCost
        };
    }

    async analyzePropertyBatchWithClaude(properties, params, threshold) {
        const prompt = this.buildDetailedClaudePrompt(properties, params, threshold);

        try {
            const response = await axios.post('https://api.anthropic.com/v1/messages', {
                model: 'claude-3-haiku-20240307',
                max_tokens: 2000,
                temperature: 0.1,
                messages: [{
                    role: 'user',
                    content: prompt
                }]
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.claudeApiKey,
                    'anthropic-version': '2023-06-01'
                }
            });

            const analysis = JSON.parse(response.data.content[0].text);
            const tokensUsed = response.data.usage?.input_tokens + response.data.usage?.output_tokens || 1500;
            const cost = (tokensUsed / 1000000) * 1.25;

            const qualifyingProperties = properties
                .map((prop, i) => {
                    const propAnalysis = analysis.find(a => a.propertyIndex === i + 1) || {
                        percentBelowMarket: 0,
                        isUndervalued: false,
                        reasoning: 'Analysis failed',
                        score: 0,
                        grade: 'F'
                    };
                    
                    return {
                        ...prop,
                        discount_percent: propAnalysis.percentBelowMarket,
                        isUndervalued: propAnalysis.isUndervalued,
                        reasoning: propAnalysis.reasoning,
                        score: propAnalysis.score || 0,
                        grade: propAnalysis.grade || 'F',
                        analyzed: true
                    };
                })
                .filter(prop => prop.discount_percent >= threshold);

            return {
                qualifyingProperties,
                tokensUsed,
                cost
            };

        } catch (error) {
            console.warn('⚠️ Claude analysis failed:', error.message);
            return {
                qualifyingProperties: [],
                tokensUsed: 0,
                cost: 0
            };
        }
    }

    buildDetailedClaudePrompt(properties, params, threshold) {
        return `You are an expert NYC real estate analyst. Analyze these ${params.propertyType} properties in ${params.neighborhood} for undervaluation potential.

PROPERTIES TO ANALYZE:
${properties.map((prop, i) => `
Property ${i + 1}:
- Address: ${prop.address || 'Not listed'}
- ${params.propertyType === 'rental' ? 'Monthly Rent' : 'Sale Price'}: ${prop.price?.toLocaleString() || 'Not listed'}
- Layout: ${prop.bedrooms || 'N/A'}BR/${prop.bathrooms || 'N/A'}BA
`).join('\n')}

Respond with ONLY a valid JSON array:

[
  {
    "propertyIndex": 1,
    "percentBelowMarket": 20,
    "isUndervalued": true,
    "reasoning": "Brief explanation",
    "score": 85,
    "grade": "A-"
  }
]`;
    }

    async savePropertiesToDatabase(properties, propertyType, fetchRecordId) {
        if (properties.length === 0) return [];
        
        const formattedProperties = properties.map(property => 
            this.formatPropertyForDatabase(property, propertyType, fetchRecordId)
        );
        
        return formattedProperties;
    }

    formatPropertyForDatabase(property, propertyType, fetchRecordId) {
        const extractedImages = this.extractAndFormatImages(property);
        
        const baseData = {
            fetch_job_id: fetchRecordId,
            listing_id: property.id || `generated_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            address: property.address || '',
            neighborhood: property.neighborhood || '',
            borough: this.getBoroughFromNeighborhood(property.neighborhood || ''),
            bedrooms: property.bedrooms || 0,
            bathrooms: property.bathrooms || 0,
            sqft: property.sqft || null,
            discount_percent: property.discount_percent || 0,
            score: property.score || 0,
            grade: property.grade || 'F',
            reasoning: property.reasoning || '',
            images: extractedImages.processedImages,
            image_count: extractedImages.count,
            primary_image: extractedImages.primary,
            instagram_ready_images: extractedImages.instagramReady,
            listing_url: property.url || property.listing_url || '',
            status: 'active'
        };

        if (propertyType === 'rental') {
            return {
                ...baseData,
                monthly_rent: property.price || 0,
                potential_monthly_savings: Math.round((property.price || 0) * (property.discount_percent || 0) / 100),
                annual_savings: Math.round((property.price || 0) * (property.discount_percent || 0) / 100 * 12)
            };
        } else {
            return {
                ...baseData,
                price: property.price || 0,
                potential_savings: Math.round((property.price || 0) * (property.discount_percent || 0) / 100)
            };
        }
    }

    extractAndFormatImages(property) {
        try {
            let rawImages = [];
            
            if (property.images && Array.isArray(property.images)) {
                rawImages = property.images;
            } else if (property.photos && Array.isArray(property.photos)) {
                rawImages = property.photos;
            }

            const processedImages = rawImages
                .filter(img => img && typeof img === 'string' || (img && img.url))
                .map(img => {
                    const imageUrl = typeof img === 'string' ? img : img.url;
                    return this.optimizeImageForInstagram(imageUrl);
                })
                .filter(Boolean)
                .slice(0, 10);

            const primaryImage = processedImages.length > 0 ? processedImages[0] : null;

            const instagramReady = processedImages.map((img, index) => ({
                url: img,
                caption: this.generateImageCaption(property, index),
                isPrimary: index === 0
            }));

            return {
                processedImages: processedImages,
                count: processedImages.length,
                primary: primaryImage,
                instagramReady: instagramReady
            };

        } catch (error) {
            return {
                processedImages: [],
                count: 0,
                primary: null,
                instagramReady: []
            };
        }
    }

    optimizeImageForInstagram(imageUrl) {
        if (!imageUrl) return null;
        
        try {
            if (imageUrl.includes('streeteasy.com')) {
                return imageUrl
                    .replace('/small/', '/large/')
                    .replace('/medium/', '/large/');
            }
            
            return imageUrl.startsWith('https://') ? imageUrl : imageUrl.replace('http://', 'https://');
            
        } catch (error) {
            return imageUrl;
        }
    }

    generateImageCaption(property, imageIndex) {
        const price = property.monthly_rent || property.price;
        const priceText = property.monthly_rent ? `${price?.toLocaleString()}/month` : `${price?.toLocaleString()}`;
        
        if (imageIndex === 0) {
            return `🏠 ${property.bedrooms}BR/${property.bathrooms}BA in ${property.neighborhood}\n💰 ${priceText}`;
        } else {
            return `📸 ${property.address} - Photo ${imageIndex + 1}`;
        }
    }

    generateInstagramDMMessage(property) {
        const price = property.monthly_rent || property.price;
        const priceText = property.monthly_rent ? `${price?.toLocaleString()}/month` : `${price?.toLocaleString()}`;
        const savings = property.potential_monthly_savings || property.potential_savings;
        
        let message = property.isSimilarFallback ? '🔄 *ALTERNATIVE FOUND*\n\n' : '🏠 *UNDERVALUED PROPERTY ALERT*\n\n';
        
        message += `📍 **${property.address}**\n`;
        message += `🏘️ ${property.neighborhood}, ${property.borough}\n\n`;
        message += `💰 **${priceText}**\n`;
        
        if (!property.isSimilarFallback) {
            message += `📉 ${property.discount_percent}% below market\n`;
            message += `💵 Save ${savings?.toLocaleString()} ${property.monthly_rent ? 'per month' : 'total'}\n\n`;
        }
        
        message += `🏠 ${property.bedrooms}BR/${property.bathrooms}BA`;
        if (property.sqft) message += ` | ${property.sqft} sqft`;
        message += `\n📊 Score: ${property.score}/100 (${property.grade})\n\n`;
        message += `🧠 *AI Analysis:*\n"${property.reasoning?.substring(0, 150)}..."\n\n`;
        message += `🔗 [View Full Listing](${property.listing_url})`;
        
        return message;
    }

    formatInstagramResponse(properties) {
        return properties.map(property => ({
            ...property,
            instagram: {
                primaryImage: property.primary_image,
                imageCount: property.image_count,
                images: property.instagram_ready_images || [],
                dmMessage: this.generateInstagramDMMessage(property)
            }
        }));
    }

    combineResults(cacheResults, newResults, maxResults) {
        const combined = [...cacheResults];
        const existingIds = new Set(cacheResults.map(r => r.listing_id));

        for (const newResult of newResults) {
            if (!existingIds.has(newResult.listing_id)) {
                combined.push({
                    ...newResult,
                    source: 'fresh',
                    isCached: false
                });
            }
        }

        return combined
            .sort((a, b) => (b.discount_percent || 0) - (a.discount_percent || 0))
            .slice(0, maxResults);
    }

    async createFetchRecord(jobId, params) {
        return { 
            id: `fake_${jobId}`,
            job_id: jobId,
            status: 'processing'
        };
    }

    async updateFetchRecord(id, updates) {
        return;
    }

    getBoroughFromNeighborhood(neighborhood) {
        const boroughMap = {
            'soho': 'Manhattan',
            'tribeca': 'Manhattan',
            'williamsburg': 'Brooklyn',
            'bushwick': 'Brooklyn',
            'astoria': 'Queens'
        };
        
        return boroughMap[neighborhood.toLowerCase()] || 'Unknown';
    }

    generateJobId() {
        return `smart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    start() {
        this.app.listen(this.port, () => {
            console.log(`🚀 NYC Real Estate API Server running on port ${this.port}`);
            console.log(`📊 API Documentation: http://localhost:${this.port}/api`);
            console.log(`💳 Stripe Integration: ENABLED`);
            console.log(`📧 Supabase Integration: ENABLED`);
            console.log(`🎯 New Routes:`);
            console.log(`   POST /api/preferences/save (no auth)`);
            console.log(`   POST /api/stripe/webhook (no auth)`);
            console.log(`   GET /api/billing/portal (no auth)`);
        });
    }
}

if (require.main === module) {
    const api = new SmartCacheFirstAPI();
    api.start();
}

module.exports = SmartCacheFirstAPI;
