/**
 * Brand Discovery Worker — Hetzner VPS
 * Runs the long-running discovery pipeline outside of Supabase Edge Function limits.
 *
 * Endpoints:
 * - POST /api/discover     — Start a discovery job
 * - GET  /api/status/:id   — Check job status
 * - POST /api/batch        — Queue multiple brands
 * - GET  /api/health       — Health check
 *
 * Usage: deno run --allow-net --allow-env worker/server.ts
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { discoverBrand } from '../lib/brand-discovery.ts';
import { BrandDiscoveryRequest, BrandDiscoveryResponse } from '../lib/types.ts';

// ============================================
// Configuration
// ============================================

const PORT = parseInt(Deno.env.get('PORT') || '8787');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const META_ACCESS_TOKEN = Deno.env.get('META_ACCESS_TOKEN') || '';
const SCRAPINGBEE_KEY = Deno.env.get('SCRAPINGBEE_API_KEY') || '';
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') || '';
const API_SECRET = Deno.env.get('WORKER_API_SECRET') || ''; // Auth for edge function → worker

// ============================================
// Job Queue
// ============================================

interface Job {
  id: string;
  brand: string;
  request: BrandDiscoveryRequest;
  status: 'queued' | 'running' | 'completed' | 'error';
  result: BrandDiscoveryResponse | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  progress: string;
}

const jobs = new Map<string, Job>();
let isProcessing = false;
const jobQueue: string[] = [];

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================
// Job Processing
// ============================================

async function processNextJob(supabase: SupabaseClient | null): Promise<void> {
  if (isProcessing || jobQueue.length === 0) return;

  const jobId = jobQueue.shift()!;
  const job = jobs.get(jobId);
  if (!job) return;

  isProcessing = true;
  job.status = 'running';
  job.started_at = Date.now();
  job.progress = 'Starting discovery pipeline...';

  console.log(`[Worker] Starting job ${jobId} for brand "${job.brand}"`);

  try {
    const result = await discoverBrand(job.brand, {
      country: job.request.country || 'DE',
      countries: job.request.countries || [job.request.country || 'DE'],
      keywords: job.request.keywords,
      max_keyword_ads: job.request.max_keyword_ads || 300,
      max_keywords: 8,
      max_brand_ads: 500,
      max_domains_to_check: 0,           // 0 = UNLIMITED — check ALL domains
      use_headless: true,
      use_headless_for_domains: true,     // ScrapingBee for domain checks
      access_token: META_ACCESS_TOKEN,
      scrapingbee_key: SCRAPINGBEE_KEY || undefined,
      openai_key: OPENAI_KEY || undefined,
      timeout_ms: 0,                     // 0 = NO DEADLINE (worker has no timeout)
      onProgress: (step, detail) => {
        job.progress = `[${step}] ${detail}`;
        console.log(`[Worker] ${jobId}: ${job.progress}`);
      },
    });

    job.status = 'completed';
    job.result = result;
    job.completed_at = Date.now();
    job.progress = 'Completed';

    console.log(`[Worker] Job ${jobId} completed in ${Math.round((Date.now() - job.started_at!) / 1000)}s`);

    // Store result in Supabase cache
    if (supabase && result.success) {
      await storeInCache(supabase, job.brand, result);
    }
  } catch (error) {
    job.status = 'error';
    job.error = String(error);
    job.completed_at = Date.now();
    job.progress = `Error: ${String(error).slice(0, 200)}`;
    console.error(`[Worker] Job ${jobId} failed:`, error);
  }

  isProcessing = false;

  // Process next job in queue
  if (jobQueue.length > 0) {
    processNextJob(supabase);
  }
}

/**
 * Store discovery result in Supabase cache tables
 */
async function storeInCache(
  supabase: SupabaseClient,
  brand: string,
  result: BrandDiscoveryResponse
): Promise<void> {
  try {
    const brandLower = brand.toLowerCase().trim();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Store in domain_mapping_cache (unique constraint is on brand+country)
    await supabase.from('domain_mapping_cache').upsert({
      brand: brandLower,
      country: 'DE',
      data: result,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    }, { onConflict: 'brand,country' });

    // 2. Store brand_domain_mappings
    for (const domain of result.domains.all) {
      const domainType = result.domains.presell.includes(domain) ? 'presell'
        : result.domains.redirect.includes(domain) ? 'redirect'
        : result.domains.final_shop.includes(domain) ? 'shop'
        : 'unknown';

      await supabase.from('brand_domain_mapping').upsert({
        brand: brandLower,
        domain,
        domain_type: domainType,
        confidence: 0.8,
        discovered_via: 'brand_discovery',
        sample_urls: [`https://${domain}`],
        ad_count: 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'brand,domain' });
    }

    // 3. Store third_party_pages
    for (const page of result.pages.third_party) {
      await supabase.from('third_party_pages').upsert({
        brand: brandLower,
        page_id: page.page_id,
        page_name: page.page_name,
        ad_count: page.ad_count,
        connection_type: page.connection_type,
        confidence: page.confidence,
        discovered_via: page.discovered_via,
        domains_used: page.domains_used,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'brand,page_id' });
    }

    console.log(`[Worker] Cached results for brand "${brand}"`);
  } catch (error) {
    console.error('[Worker] Cache store error:', error);
  }
}

// ============================================
// HTTP Handler
// ============================================

function verifyAuth(req: Request): boolean {
  if (!API_SECRET) return true; // No auth if not configured
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${API_SECRET}`;
}

async function handleRequest(req: Request, supabase: SupabaseClient | null): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Health check (no auth)
  if (path === '/api/health') {
    return jsonResponse({
      status: 'healthy',
      jobs_total: jobs.size,
      jobs_queued: jobQueue.length,
      is_processing: isProcessing,
      uptime_seconds: Math.round(performance.now() / 1000),
    }, corsHeaders);
  }

  // Auth check for all other endpoints
  if (!verifyAuth(req)) {
    return jsonResponse({ error: 'Unauthorized' }, corsHeaders, 401);
  }

  // POST /api/discover — Start a discovery job
  if (path === '/api/discover' && req.method === 'POST') {
    const body = await req.json() as BrandDiscoveryRequest;

    if (!body.brand) {
      return jsonResponse({ error: 'brand is required' }, corsHeaders, 400);
    }

    if (!META_ACCESS_TOKEN) {
      return jsonResponse({ error: 'META_ACCESS_TOKEN not configured' }, corsHeaders, 500);
    }

    // Check if we have a cached result (skip if force_refresh)
    if (supabase && !body.force_refresh) {
      const { data: cached } = await supabase
        .from('domain_mapping_cache')
        .select('data, expires_at')
        .eq('brand', body.brand.toLowerCase().trim())
        .gt('expires_at', new Date().toISOString())
        .single();

      if (cached?.data) {
        return jsonResponse({
          ...cached.data,
          status: 'cached',
        }, corsHeaders);
      }
    }

    // Check if already processing
    for (const [, job] of jobs) {
      if (job.brand.toLowerCase() === body.brand.toLowerCase() &&
          (job.status === 'queued' || job.status === 'running')) {
        return jsonResponse({
          status: 'processing',
          job_id: job.id,
          progress: job.progress,
        }, corsHeaders);
      }
    }

    // Create new job
    const jobId = generateJobId();
    const job: Job = {
      id: jobId,
      brand: body.brand,
      request: body,
      status: 'queued',
      result: null,
      error: null,
      created_at: Date.now(),
      started_at: null,
      completed_at: null,
      progress: 'Queued',
    };

    jobs.set(jobId, job);
    jobQueue.push(jobId);

    // Start processing
    processNextJob(supabase);

    return jsonResponse({
      status: 'processing',
      job_id: jobId,
      progress: job.progress,
    }, corsHeaders, 202);
  }

  // GET /api/status/:id — Check job status
  if (path.startsWith('/api/status/') && req.method === 'GET') {
    const jobId = path.split('/api/status/')[1];
    const job = jobs.get(jobId);

    if (!job) {
      return jsonResponse({ error: 'Job not found' }, corsHeaders, 404);
    }

    if (job.status === 'completed' && job.result) {
      return jsonResponse({
        status: 'completed',
        job_id: jobId,
        result: job.result,
        duration_seconds: job.completed_at && job.started_at
          ? Math.round((job.completed_at - job.started_at) / 1000)
          : null,
      }, corsHeaders);
    }

    if (job.status === 'error') {
      return jsonResponse({
        status: 'error',
        job_id: jobId,
        error: job.error,
      }, corsHeaders);
    }

    return jsonResponse({
      status: job.status,
      job_id: jobId,
      progress: job.progress,
      queue_position: job.status === 'queued' ? jobQueue.indexOf(jobId) + 1 : null,
    }, corsHeaders);
  }

  // POST /api/batch — Queue multiple brands
  if (path === '/api/batch' && req.method === 'POST') {
    const body = await req.json() as { brands: BrandDiscoveryRequest[] };

    if (!body.brands?.length) {
      return jsonResponse({ error: 'brands array is required' }, corsHeaders, 400);
    }

    const jobIds: string[] = [];

    for (const brandReq of body.brands) {
      const jobId = generateJobId();
      const job: Job = {
        id: jobId,
        brand: brandReq.brand,
        request: brandReq,
        status: 'queued',
        result: null,
        error: null,
        created_at: Date.now(),
        started_at: null,
        completed_at: null,
        progress: 'Queued',
      };

      jobs.set(jobId, job);
      jobQueue.push(jobId);
      jobIds.push(jobId);
    }

    // Start processing
    processNextJob(supabase);

    return jsonResponse({
      status: 'queued',
      total: jobIds.length,
      job_ids: jobIds,
      queue_length: jobQueue.length,
    }, corsHeaders, 202);
  }

  return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
}

function jsonResponse(
  data: unknown,
  headers: Record<string, string>,
  status: number = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// ============================================
// Cleanup: Remove old completed jobs (>1h)
// ============================================

function cleanupOldJobs(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (
      (job.status === 'completed' || job.status === 'error') &&
      job.completed_at &&
      job.completed_at < oneHourAgo
    ) {
      jobs.delete(id);
    }
  }
}

// ============================================
// Main
// ============================================

console.log(`[Worker] Starting Brand Discovery Worker on port ${PORT}...`);

// Initialize Supabase client
let supabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[Worker] Supabase client initialized');
} else {
  console.log('[Worker] Warning: Supabase not configured, caching disabled');
}

// Cleanup interval
setInterval(cleanupOldJobs, 10 * 60 * 1000); // Every 10 minutes

// Start server
Deno.serve({ port: PORT }, (req) => handleRequest(req, supabase));
