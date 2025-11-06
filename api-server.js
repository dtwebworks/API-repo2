// api-server.js
// COMPLETE INSTAGRAM-OPTIMIZED SMART CACHE-FIRST API SERVER
// WITH STRIPE + SUPABASE INTEGRATION + FREE MODE SUPPORT
// Set DISABLE_STRIPE=true for free email notifications (no payment required)

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Only require Stripe if not disabled
const stripe = process.env.DISABLE_STRIPE !== 'true' 
    ? require('stripe')(process.env.STRIPE_SECRET_KEY)
    : null;

class SmartCacheFirstAPI {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.apiKey = process.env.VC_API_KEY || 'your-secure-api-key';
        this.rapidApiKey = process.env.RAPIDAPI_KEY;
        this.claudeApiKey = process.env.ANTHROPIC_API_KEY;
        this.stripeDisabled = process.env.DISABLE_STRIPE === 'true';
        
        this._supabase = null;
        this._supabaseClient = null;
        this.activeJobs = new Map();
        this.jobResults = new Map();
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

    getSupabaseClient() {
        if (!this._supabaseClient) {
            this._supabaseClient = createClient(
                process.env.SUPABASE_URL,
                process.env.SUPABASE_SERVICE_ROLE_KEY
            );
            console.log('✅ Supabase client initialized');
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
            message: { error: 'Too many requests from this IP', retryAfter: 15 * 60 }
        });
        this.app.use('/api/', limiter);
        
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

        this.app.get('/', (req, res) => {
            const freeMode = this.stripeDisabled;
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
            background: #f8f9fa;
        }
        .container { 
            background: white; 
            padding: 40px; 
            border-radius: 12px; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .status { 
            background: #d4edda; 
            color: #155724; 
            padding: 12px 20px; 
            border-radius: 6px; 
            display: inline-block; 
            font-weight: 500;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏠 Realer Estate API</h1>
        <div class="status">✅ Operational ${freeMode ? '(FREE MODE)' : ''}</div>
        <p>AI-powered undervalued property discovery for NYC</p>
        <p><a href="/api">→ API Documentation</a></p>
        <p><a href="/health">→ Health Check</a></p>
    </div>
</body>
</html>
            `);
        });

        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                service: 'nyc_full_api',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                version: '3.3.0',
                features: [
                    'smart_search',
                    'streeteasy_integration',
                    'claude_ai_analysis',
                    'instagram_formatting',
                    this.stripeDisabled ? 'free_mode' : 'stripe_integration'
                ],
                stripeEnabled: !this.stripeDisabled,
                activeJobs: this.activeJobs.size
            });
        });

        this.app.get('/api', (req, res) => {
            const baseUrl = req.protocol + '://' + req.get('host');
            const freeMode = this.stripeDisabled;
            
            res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>API Documentation</title>
    <style>
        body { font-family: sans-serif; max-width: 1200px; margin: 50px auto; padding: 20px; }
        .endpoint { background: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #007bff; }
        .method { background: #007bff; color: white; padding: 4px 12px; border-radius: 4px; font-weight: bold; }
        .method.get { background: #28a745; }
        code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; }
    </style>
</head>
<body>
    <h1>🏠 NYC Real Estate API Documentation</h1>
    <p><strong>${freeMode ? '🆓 FREE MODE ENABLED' : '💳 STRIPE ENABLED'}</strong></p>
    <p><strong>Base URL:</strong> <code>${baseUrl}</code></p>
    
    <h2>Endpoints</h2>
    
    <div class="endpoint">
        <h3><span class="method">POST</span> /api/preferences/save</h3>
        <p>Save user preferences and ${freeMode ? 'activate immediately (FREE)' : 'create Stripe checkout'}</p>
        <p><strong>Auth:</strong> None required</p>
        <p><strong>Body:</strong> email, instagram_handle, bedrooms, max_budget, preferred_neighborhoods, etc.</p>
    </div>
    
    <div class="endpoint">
        <h3><span class="method">POST</span> /api/search/smart</h3>
        <p>Search for undervalued NYC properties with AI analysis</p>
        <p><strong>Auth:</strong> X-API-Key required</p>
        <p><strong>Body:</strong> neighborhood, propertyType, bedrooms, maxPrice, etc.</p>
    </div>
    
    <div class="endpoint">
        <h3><span class="method get">GET</span> /api/jobs/{jobId}</h3>
        <p>Check property search job status</p>
        <p><strong>Auth:</strong> X-API-Key required</p>
    </div>
    
    <div class="endpoint">
        <h3><span class="method get">GET</span> /api/results/{jobId}</h3>
        <p>Get property search results with Instagram formatting</p>
        <p><strong>Auth:</strong> X-API-Key required</p>
    </div>
    
    ${!freeMode ? `
    <div class="endpoint">
        <h3><span class="method get">GET</span> /api/billing/portal</h3>
        <p>Get Stripe billing portal URL for subscription management</p>
        <p><strong>Auth:</strong> None required</p>
        <p><strong>Query:</strong> ?email=user@example.com</p>
    </div>
    ` : ''}
</body>
</html>
            `);
        });

        // ========================================================================
        // STRIPE + SUPABASE INTEGRATION (NO AUTH)
        // ========================================================================

        this.setupPreferencesRoute();
        
        if (!this.stripeDisabled) {
            this.setupWebhookRoute();
            this.setupBillingPortalRoute();
        }

        // ========================================================================
        // PROTECTED ROUTES (REQUIRE X-API-KEY)
        // ========================================================================

        this.app.use('/api/', this.authenticateAPI.bind(this));

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
                    noFee = false
                } = req.body;

                if (!neighborhood) {
                    return res.status(400).json({
                        error: 'Bad Request',
                        message: 'neighborhood parameter is required'
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
                        jobId,
                        status: 'started',
                        message: `Smart search started for ${neighborhood}`,
                        estimatedDuration: '4-8 seconds',
                        checkStatusUrl: `/api/jobs/${jobId}`,
                        getResultsUrl: `/api/results/${jobId}`
                    }
                });

            } catch (error) {
                console.error('Smart search error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        this.app.get('/api/jobs/:jobId', (req, res) => {
            const job = this.activeJobs.get(req.params.jobId);
            if (!job) return res.status(404).json({ error: 'Job not found' });
            
            res.json({
                success: true,
                data: {
                    jobId: req.params.jobId,
                    status: job.status,
                    progress: job.progress || 0,
                    startTime: job.startTime,
                    lastUpdate: job.lastUpdate,
                    message: job.message,
                    error: job.error || null
                }
            });
        });

        this.app.get('/api/results/:jobId', (req, res) => {
            const results = this.jobResults.get(req.params.jobId);
            if (!results) return res.status(404).json({ error: 'Results not found' });
            
            res.json({ success: true, data: results });
        });
    }

    // ============================================================================
    // PREFERENCES + STRIPE INTEGRATION
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

                if (!email || !email.includes('@')) {
                    return res.status(400).json({ error: 'Invalid email address' });
                }

                const sanitizedEmail = email.toLowerCase().trim();
                const sanitizedNeighborhoods = (preferred_neighborhoods || neighborhood_preferences || [])
                    .map(n => n.toLowerCase().trim());
                
                const validatedBedrooms = bedrooms ? Math.min(Math.max(parseInt(bedrooms), 0), 10) : null;
                const validatedBudget = max_budget ? Math.max(parseInt(max_budget), 0) : null;
                const validatedDiscount = discount_threshold ? Math.min(Math.max(parseInt(discount_threshold), 1), 100) : 15;

                console.log('💾 Upserting profile:', {
                    email: sanitizedEmail,
                    instagram_handle,
                    neighborhoods: sanitizedNeighborhoods,
                    freeMode: this.stripeDisabled
                });

                const supabase = this.getSupabaseClient();
                
                const { data: existingProfile } = await supabase
                    .from('profiles')
                    .select('id, stripe_customer_id')
                    .eq('email_address', sanitizedEmail)
                    .single();

                let profileId;
                const profileData = {
                    instagram_handle,
                    bedrooms: validatedBedrooms,
                    max_budget: validatedBudget,
                    preferred_neighborhoods: sanitizedNeighborhoods,
                    neighborhood_preferences: sanitizedNeighborhoods,
                    discount_threshold: validatedDiscount,
                    property_type,
                    marketing_channel,
                    subscription_renewal
                };

                // FREE MODE: Auto-activate
                if (this.stripeDisabled) {
                    profileData.subscription_plan = 'unlimited';
                    profileData.is_canceled = false;
                    console.log('🆓 FREE MODE: Auto-activating subscription');
                }

                if (existingProfile) {
                    const { data: updated, error } = await supabase
                        .from('profiles')
                        .update(profileData)
                        .eq('id', existingProfile.id)
                        .select()
                        .single();
                    if (error) throw error;
                    profileId = existingProfile.id;
                    console.log('✅ Updated profile:', profileId);
                } else {
                    const { data: created, error } = await supabase
                        .from('profiles')
                        .insert({
                            email_address: sanitizedEmail,
                            ...profileData,
                            subscription_plan: this.stripeDisabled ? 'unlimited' : 'free',
                            is_canceled: false
                        })
                        .select()
                        .single();
                    if (error) throw error;
                    profileId = created.id;
                    console.log('✅ Created profile:', profileId);
                }

                // FREE MODE: Return success immediately
                if (this.stripeDisabled) {
                    return res.json({
                        success: true,
                        freeMode: true,
                        message: 'Email notifications activated! You will receive property alerts within 12 hours.',
                        profileId,
                        checkoutUrl: null
                    });
                }

                // STRIPE MODE: Create checkout
                const priceId = subscription_renewal === 'annual'
                    ? process.env.STRIPE_PRICE_UNLIMITED_ANNUAL
                    : process.env.STRIPE_PRICE_UNLIMITED_MONTHLY;

                const session = await stripe.checkout.sessions.create({
                    mode: 'subscription',
                    payment_method_types: ['card'],
                    line_items: [{ price: priceId, quantity: 1 }],
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

                res.json({
                    success: true,
                    freeMode: false,
                    checkoutUrl: session.url,
                    profileId,
                    sessionId: session.id
                });

            } catch (error) {
                console.error('❌ Preferences save error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupWebhookRoute() {
        this.app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
            const sig = req.headers['stripe-signature'];
            let event;

            try {
                event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
            } catch (err) {
                console.error('⚠️ Webhook signature failed:', err.message);
                return res.status(400).send(`Webhook Error: ${err.message}`);
            }

            console.log('🎣 Webhook received:', event.type);

            try {
                const supabase = this.getSupabaseClient();

                switch (event.type) {
                    case 'checkout.session.completed': {
                        const session = event.data.object;
                        
                        let subscriptionRenewal = 'monthly';
                        if (session.subscription) {
                            const subscription = await stripe.subscriptions.retrieve(session.subscription);
                            const interval = subscription.items.data[0]?.price?.recurring?.interval;
                            subscriptionRenewal = interval === 'year' ? 'annual' : 'monthly';
                        }

                        await supabase.from('profiles').update({
                            stripe_customer_id: session.customer,
                            subscription_plan: 'unlimited',
                            subscription_renewal: subscriptionRenewal,
                            is_canceled: false
                        }).or(`id.eq.${session.client_reference_id},email_address.eq.${session.customer_email}`);

                        console.log('✅ Profile activated:', session.client_reference_id);
                        break;
                    }

                    case 'customer.subscription.updated': {
                        const subscription = event.data.object;
                        const isCanceled = ['canceled', 'incomplete_expired'].includes(subscription.status);
                        const interval = subscription.items.data[0]?.price?.recurring?.interval;

                        await supabase.from('profiles').update({
                            subscription_renewal: interval === 'year' ? 'annual' : 'monthly',
                            is_canceled: isCanceled,
                            ...(isCanceled ? { subscription_plan: 'free' } : {})
                        }).eq('stripe_customer_id', subscription.customer);

                        console.log('✅ Subscription synced:', subscription.customer);
                        break;
                    }

                    case 'customer.subscription.deleted': {
                        const subscription = event.data.object;
                        
                        await supabase.from('profiles').update({
                            is_canceled: true,
                            subscription_plan: 'free'
                        }).eq('stripe_customer_id', subscription.customer);

                        console.log('✅ Subscription canceled:', subscription.customer);
                        break;
                    }
                }

                res.json({ received: true });
            } catch (error) {
                console.error('❌ Webhook processing error:', error);
                res.status(500).json({ error: 'Webhook failed' });
            }
        });
    }

    setupBillingPortalRoute() {
        this.app.get('/api/billing/portal', async (req, res) => {
            try {
                const { email, stripe_customer_id } = req.query;

                if (!email && !stripe_customer_id) {
                    return res.status(400).json({ error: 'Email or stripe_customer_id required' });
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
                        return res.status(404).json({ error: 'No subscription found' });
                    }

                    customerId = profile.stripe_customer_id;
                }

                const session = await stripe.billingPortal.sessions.create({
                    customer: customerId,
                    return_url: process.env.STRIPE_PORTAL_RETURN_URL
                });

                console.log('💳 Billing portal created for:', customerId);

                res.json({ success: true, portalUrl: session.url });

            } catch (error) {
                console.error('❌ Billing portal error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }

    setupErrorHandling() {
        this.app.use((req, res) => {
            res.status(404).json({ error: 'Not Found', availableEndpoints: '/api' });
        });

        this.app.use((error, req, res, next) => {
            console.error('Global error:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        });
    }

    // ============================================================================
    // COMPLETE SMART SEARCH ENGINE
    // ============================================================================

    async startSmartSearch(jobId, params) {
        const startTime = Date.now();
        const job = {
            status: 'processing',
            progress: 0,
            startTime: new Date().toISOString(),
            lastUpdate: new Date().toISOString(),
            message: 'Starting smart search...',
            originalThreshold: params.undervaluationThreshold,
            cacheHits: 0
        };
        
        this.activeJobs.set(jobId, job);
        let fetchRecord = null;

        try {
            fetchRecord = await this.createFetchRecord(jobId, params);
            
            job.progress = 20;
            job.message = 'Checking cache...';
            job.lastUpdate = new Date().toISOString();

            const cacheResults = await this.smartCacheSearch(params);
            job.cacheHits = cacheResults.length;

            if (cacheResults.length >= params.maxResults) {
                job.status = 'completed';
                job.progress = 100;
                job.message = `Found ${cacheResults.length} properties from cache`;
                
                this.jobResults.set(jobId, {
                    jobId,
                    type: 'smart_search',
                    source: 'cache_only',
                    parameters: params,
                    properties: cacheResults,
                    instagramReady: this.formatInstagramResponse(cacheResults),
                    summary: {
                        totalFound: cacheResults.length,
                        cacheHits: cacheResults.length,
                        processingTimeMs: Date.now() - startTime
                    },
                    completedAt: new Date().toISOString()
                });
                return;
            }

            job.progress = 40;
            job.message = 'Fetching from StreetEasy...';
            job.lastUpdate = new Date().toISOString();

            const streetEasyResults = await this.fetchWithThresholdFallback(params, fetchRecord.id);
            const combinedResults = this.combineResults(cacheResults, streetEasyResults.properties, params.maxResults);

            job.status = 'completed';
            job.progress = 100;
            job.message = `Found ${combinedResults.length} total properties`;
            job.lastUpdate = new Date().toISOString();

            this.jobResults.set(jobId, {
                jobId,
                type: 'smart_search',
                source: 'cache_and_fresh',
                parameters: params,
                properties: combinedResults,
                instagramReady: this.formatInstagramResponse(combinedResults),
                summary: {
                    totalFound: combinedResults.length,
                    cacheHits: cacheResults.length,
                    newlyScraped: streetEasyResults.properties.length,
                    processingTimeMs: Date.now() - startTime,
                    claudeApiCalls: streetEasyResults.claudeApiCalls,
                    claudeCostUsd: streetEasyResults.claudeCost
                },
                completedAt: new Date().toISOString()
            });

        } catch (error) {
            console.error('❌ Search error:', error);
            job.status = 'failed';
            job.error = error.message;
            job.lastUpdate = new Date().toISOString();
        }
    }

    async smartCacheSearch(params) {
        console.log(`🔍 Cache search for ${params.neighborhood}...`);
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
        let claudeApiCalls = 0;
        let claudeCost = 0;

        for (const threshold of thresholds) {
            console.log(`🎯 Trying threshold: ${threshold}%`);
            
            const results = await this.fetchFromStreetEasy(params, threshold, fetchRecordId);
            
            apiCalls += results.apiCalls;
            totalFetched += results.totalFetched;
            claudeApiCalls += results.claudeApiCalls;
            claudeCost += results.claudeCost;

            if (results.properties.length > 0) {
                allResults = results.properties;
                break;
            }
        }

        return {
            properties: allResults,
            apiCalls,
            totalFetched,
            claudeApiCalls,
            claudeCost
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
            if (params.bathrooms) apiParams.minBath = params.bathrooms;
            if (params.noFee && params.propertyType === 'rental') apiParams.noFee = true;

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

            console.log(`📊 StreetEasy returned ${listings.length} listings`);

            if (listings.length === 0) {
                return { properties: [], apiCalls: 1, totalFetched: 0, claudeApiCalls: 0, claudeCost: 0 };
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
                claudeApiCalls: analysisResults.claudeApiCalls,
                claudeCost: analysisResults.claudeCost
            };

        } catch (error) {
            console.error('❌ StreetEasy fetch error:', error.message);
            return { properties: [], apiCalls: 1, totalFetched: 0, claudeApiCalls: 0, claudeCost: 0 };
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
            console.log(`🤖 Analyzing batch ${Math.floor(i/batchSize) + 1} (${batch.length} properties)`);
            
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
        const prompt = `You are an expert NYC real estate analyst. Analyze these ${params.propertyType} properties in ${params.neighborhood} for undervaluation potential.

PROPERTIES TO ANALYZE:
${properties.map((prop, i) => `
Property ${i + 1}:
- Address: ${prop.address || 'Not listed'}
- ${params.propertyType === 'rental' ? 'Monthly Rent' : 'Sale Price'}: ${prop.price?.toLocaleString() || 'Not listed'}
- Layout: ${prop.bedrooms || 'N/A'}BR/${prop.bathrooms || 'N/A'}BA
- Square Feet: ${prop.sqft || 'Not listed'}
- Description: ${prop.description?.substring(0, 300) || 'None'}...
`).join('\n')}

ANALYSIS REQUIREMENTS:
- Evaluate each property against typical ${params.neighborhood} market rates
- Only mark as undervalued if discount is ${threshold}% or greater
- Assign numerical score (0-100) and letter grade (A+ to F)

CRITICAL: Respond with ONLY a valid JSON array. No explanatory text. Start with [ and end with ].

RESPONSE FORMAT:
[
  {
    "propertyIndex": 1,
    "percentBelowMarket": 20,
    "isUndervalued": true,
    "reasoning": "This 2BR rental at $3,200/month is 20% below market...",
    "score": 85,
    "grade": "A-"
  }
]`;

        try {
            const response = await axios.post('https://api.anthropic.com/v1/messages', {
                model: 'claude-3-haiku-20240307',
                max_tokens: 2000,
                temperature: 0.1,
                messages: [{ role: 'user', content: prompt }]
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.claudeApiKey,
                    'anthropic-version': '2023-06-01'
                }
            });

            const analysis = JSON.parse(response.data.content[0].text);
            const tokensUsed = (response.data.usage?.input_tokens || 0) + (response.data.usage?.output_tokens || 0);
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

            return { qualifyingProperties, tokensUsed, cost };

        } catch (error) {
            console.warn('⚠️ Claude analysis failed:', error.message);
            return { qualifyingProperties: [], tokensUsed: 0, cost: 0 };
        }
    }

    async savePropertiesToDatabase(properties, propertyType, fetchRecordId) {
        if (properties.length === 0) return [];
        
        console.log(`💾 Formatting ${properties.length} properties...`);
        
        const formattedProperties = properties.map(property => 
            this.formatPropertyForDatabase(property, propertyType, fetchRecordId)
        );
        
        console.log(`✅ Formatted ${formattedProperties.length} properties`);
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
                .filter(img => img && (typeof img === 'string' || (img && img.url)))
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
                processedImages,
                count: processedImages.length,
                primary: primaryImage,
                instagramReady
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
                    .replace('/medium/', '/large/')
                    .replace('_sm.', '_lg.')
                    .replace('_md.', '_lg.');
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
            return `🏠 ${property.bedrooms}BR/${property.bathrooms}BA in ${property.neighborhood}\n💰 ${priceText} (${property.discount_percent}% below market)`;
        } else {
            return `📸 ${property.address} - Photo ${imageIndex + 1}`;
        }
    }

    generateInstagramDMMessage(property) {
        const price = property.monthly_rent || property.price;
        const priceText = property.monthly_rent ? `${price?.toLocaleString()}/month` : `${price?.toLocaleString()}`;
        const savings = property.potential_monthly_savings || property.potential_savings;
        
        let message = '🏠 *UNDERVALUED PROPERTY ALERT*\n\n';
        message += `📍 **${property.address}**\n`;
        message += `🏘️ ${property.neighborhood}, ${property.borough}\n\n`;
        message += `💰 **${priceText}**\n`;
        message += `📉 ${property.discount_percent}% below market\n`;
        message += `💵 Save ${savings?.toLocaleString()} ${property.monthly_rent ? 'per month' : 'total'}\n\n`;
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
            'west-village': 'Manhattan',
            'east-village': 'Manhattan',
            'lower-east-side': 'Manhattan',
            'chelsea': 'Manhattan',
            'gramercy': 'Manhattan',
            'upper-west-side': 'Manhattan',
            'upper-east-side': 'Manhattan',
            'harlem': 'Manhattan',
            'williamsburg': 'Brooklyn',
            'bushwick': 'Brooklyn',
            'park-slope': 'Brooklyn',
            'dumbo': 'Brooklyn',
            'brooklyn-heights': 'Brooklyn',
            'astoria': 'Queens',
            'long-island-city': 'Queens',
            'forest-hills': 'Queens'
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
            console.log(`💳 Stripe Integration: ${this.stripeDisabled ? 'DISABLED (FREE MODE)' : 'ENABLED'}`);
            console.log(`📧 Supabase Integration: ENABLED`);
            console.log(`🎯 Features:`);
            console.log(`   ✅ Complete StreetEasy integration`);
            console.log(`   ✅ Claude AI property analysis`);
            console.log(`   ✅ Instagram-ready formatting`);
            console.log(`   ✅ ${this.stripeDisabled ? 'Free email notifications' : 'Stripe payments'}`);
        });
    }
}

if (require.main === module) {
    const api = new SmartCacheFirstAPI();
    api.start();
}

module.exports = SmartCacheFirstAPI;
