/**
 * Brand Discovery Worker — Hetzner VPS
 * Runs the long-running discovery pipeline outside of Supabase Edge Function limits.
 *
 * CRASH-RESILIENT: Jobs are persisted in Supabase (discovery_jobs table).
 * On startup, interrupted jobs (status='running') are automatically resumed.
 * Intermediate results cached in full_url_cache + domain_check_cache.
 *
 * Endpoints:
 * - POST /api/discover     — Start a discovery job
 * - GET  /api/status/:id   — Check job status
 * - POST /api/batch        — Queue multiple brands
 * - POST /api/pause        — Pause after current job
 * - POST /api/resume       — Resume processing
 * - POST /api/cancel       — Cancel current + clear queue
 * - GET  /api/queue        — Queue status overview
 * - POST /api/restore-all  — Restore ALL dismissed pages (full undo)
 * - POST /api/cleanup-fp-test — Test cleanup on specific brands (dry run)
 * - GET  /api/health       — Health check
 *
 * Usage: deno run --allow-all worker/server.ts
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { discoverBrand } from '../lib/brand-discovery.ts';
import { BrandDiscoveryRequest, BrandDiscoveryResponse } from '../lib/types.ts';
import { BrowserRenderer, killAllChromiumProcesses } from '../lib/browser-renderer.ts';
import { checkFalsePositives, applyFalsePositiveFlags } from '../lib/false-positive-detector.ts';
// Old name-based verifier no longer used — replaced by content-based ai-content-verifier
import { verifyAllPages, applyContentVerification } from '../lib/ai-content-verifier.ts';

// ============================================
// Crash Protection: Prevent unhandled rejections from killing the worker
// ============================================
globalThis.addEventListener('unhandledrejection', (event) => {
  console.error(`[Worker] Unhandled rejection caught (process stays alive): ${String(event.reason).substring(0, 200)}`);
  event.preventDefault();
});

// ============================================
// Configuration
// ============================================

const PORT = parseInt(Deno.env.get('PORT') || '8787');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
// Multi-token support: META_ACCESS_TOKENS (comma-separated), no fallback
const META_ACCESS_TOKENS: string[] = (() => {
  const multi = Deno.env.get('META_ACCESS_TOKENS');
  if (multi) return multi.split(',').map(t => t.trim()).filter(t => t.length > 0);
  return [];
})();
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') || '';
const API_SECRET = Deno.env.get('WORKER_API_SECRET') || ''; // Auth for edge function → worker

// Watchdog: If no progress for this long, force-restart (systemd brings us back)
const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const WATCHDOG_CHECK_INTERVAL_MS = 30 * 1000; // Check every 30s
let lastActivityAt = 0; // Timestamp of last onProgress/onCheckpoint callback

// ============================================
// Job Queue (in-memory cache backed by Supabase)
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

// In-memory cache — always backed by discovery_jobs table in Supabase
const jobs = new Map<string, Job>();
let isProcessing = false;
const jobQueue: string[] = [];

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================
// Job Persistence (Supabase discovery_jobs)
// ============================================

/**
 * Persist job state to Supabase. Called on every status change.
 */
async function persistJob(supabase: SupabaseClient | null, job: Job): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('discovery_jobs').upsert({
      id: job.id,
      brand: job.brand,
      country: job.request.country || 'DE',
      request: job.request,
      status: job.status,
      progress: job.progress,
      started_at: job.started_at ? new Date(job.started_at).toISOString() : null,
      completed_at: job.completed_at ? new Date(job.completed_at).toISOString() : null,
      updated_at: new Date().toISOString(),
      result: job.result,
      error: job.error,
    }, { onConflict: 'id' });
  } catch (error) {
    console.error(`[Worker] Failed to persist job ${job.id}:`, String(error).substring(0, 100));
  }
}

/**
 * Update job checkpoint in Supabase (lightweight update, called during processing).
 */
async function persistCheckpoint(
  supabase: SupabaseClient | null,
  jobId: string,
  checkpoint: Record<string, unknown>,
  progress: string
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('discovery_jobs').update({
      checkpoint,
      progress,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
  } catch {
    // Non-critical — checkpoint write failure shouldn't stop processing
  }
}

/**
 * Check for interrupted jobs on startup and resume them.
 * Called once when worker starts.
 */
async function resumeInterruptedJobs(supabase: SupabaseClient): Promise<void> {
  try {
    // Find jobs that were running when worker crashed
    const { data: interrupted } = await supabase
      .from('discovery_jobs')
      .select('*')
      .eq('status', 'running')
      .order('created_at', { ascending: true });

    if (!interrupted || interrupted.length === 0) {
      console.log('[Worker] No interrupted jobs to resume');
      return;
    }

    console.log(`[Worker] Found ${interrupted.length} interrupted job(s) to resume`);

    for (const dbJob of interrupted) {
      const job: Job = {
        id: dbJob.id,
        brand: dbJob.brand,
        request: dbJob.request as BrandDiscoveryRequest,
        status: 'queued',  // Re-queue for processing
        result: null,
        error: null,
        created_at: new Date(dbJob.created_at).getTime(),
        started_at: null,
        completed_at: null,
        progress: `Resuming (was: ${dbJob.progress})`,
      };

      jobs.set(job.id, job);
      jobQueue.push(job.id);
      console.log(`[Worker] Resuming job ${job.id} for brand "${job.brand}" (checkpoint: ${JSON.stringify(dbJob.checkpoint || {})})`);
    }

    // Also check for queued jobs that never started
    const { data: queued } = await supabase
      .from('discovery_jobs')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true });

    if (queued && queued.length > 0) {
      console.log(`[Worker] Found ${queued.length} queued job(s) to process`);
      for (const dbJob of queued) {
        if (jobs.has(dbJob.id)) continue; // Already loaded
        const job: Job = {
          id: dbJob.id,
          brand: dbJob.brand,
          request: dbJob.request as BrandDiscoveryRequest,
          status: 'queued',
          result: null,
          error: null,
          created_at: new Date(dbJob.created_at).getTime(),
          started_at: null,
          completed_at: null,
          progress: 'Queued (restored)',
        };
        jobs.set(job.id, job);
        jobQueue.push(job.id);
      }
    }
  } catch (error) {
    console.error('[Worker] Failed to check for interrupted jobs:', error);
  }
}

// ============================================
// Job Processing
// ============================================

let isPaused = false;

function getCurrentJobInfo(): { id: string; brand: string; progress: string; started_at: number | null } | null {
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      return { id: job.id, brand: job.brand, progress: job.progress, started_at: job.started_at };
    }
  }
  return null;
}

async function processNextJob(supabase: SupabaseClient | null): Promise<void> {
  if (isProcessing || jobQueue.length === 0 || isPaused) return;

  const jobId = jobQueue.shift()!;
  const job = jobs.get(jobId);
  if (!job) return;

  isProcessing = true;
  job.status = 'running';
  job.started_at = Date.now();
  job.progress = 'Starting discovery pipeline...';
  lastActivityAt = Date.now(); // Initialize watchdog

  // Persist running status immediately
  await persistJob(supabase, job);

  // Load saved checkpoint for resume (skip completed steps)
  let savedCheckpoint: Record<string, unknown> | null = null;
  if (supabase) {
    try {
      const { data: jobRow } = await supabase
        .from('discovery_jobs')
        .select('checkpoint')
        .eq('id', jobId)
        .single();
      savedCheckpoint = jobRow?.checkpoint || null;
      if (savedCheckpoint) {
        console.log(`[Worker] Resuming job ${jobId} with checkpoint: ${JSON.stringify(savedCheckpoint)}`);
      }
    } catch { /* no checkpoint, start fresh */ }
  }

  console.log(`[Worker] Starting job ${jobId} for brand "${job.brand}"`);

  try {
    const result = await discoverBrand(job.brand, {
      page_id: job.request.page_id,
      country: job.request.country || 'DE',
      countries: job.request.countries || [job.request.country || 'DE'],
      keywords: job.request.keywords,
      max_keyword_ads: job.request.max_keyword_ads || 300,
      max_keywords: 8,
      max_brand_ads: 500,
      max_domains_to_check: 0,           // 0 = UNLIMITED — check ALL domains
      use_headless: true,
      use_headless_for_domains: true,     // Headless for domain checks
      deep_cta_enabled: true,            // Deep CTA chain: follow presell CTAs through to checkout
      access_tokens: META_ACCESS_TOKENS,
      openai_key: OPENAI_KEY || undefined,
      timeout_ms: 0,                     // 0 = NO DEADLINE (worker has no timeout)
      supabase: supabase,               // Pass Supabase client for checkpoint caching
      resumeCheckpoint: savedCheckpoint, // Skip completed steps on resume
      onProgress: (step, detail) => {
        job.progress = `[${step}] ${detail}`;
        lastActivityAt = Date.now(); // Reset watchdog on every progress update
        console.log(`[Worker] ${jobId}: ${job.progress}`);
      },
      onCheckpoint: (data) => {
        lastActivityAt = Date.now(); // Reset watchdog on every checkpoint
        // Persist checkpoint to DB (fire-and-forget, non-blocking)
        persistCheckpoint(supabase, jobId, data as Record<string, unknown>, job.progress);
      },
    });

    // --- AI Content-Based Verification (scrapes actual landing pages) ---
    if (result.success && result.pages.third_party.length > 0 && OPENAI_KEY) {
      job.progress = 'AI: Content-verifying landing pages...';
      await persistJob(supabase, job);
      try {
        const pipelineDomainData = {
          domains_all: result.domains?.all || [],
          domain_urls: result.domain_urls || {},
          brand_domain: result.brand_domain || '',
        };
        const report = await verifyAllPages(
          job.brand,
          result.brand_domain,
          result.pages.third_party as any,
          OPENAI_KEY,
          { domainData: pipelineDomainData }
        );

        const { kept, removed } = applyContentVerification(result.pages.third_party as any, report);

        // Update result: only keep verified pages
        result.pages.third_party = kept as any;

        // Store removed pages in dismissed_third_party_pages for audit trail
        if (supabase && removed.length > 0) {
          const brandLower = job.brand.toLowerCase().trim();
          for (const page of removed) {
            try {
              await supabase.from('dismissed_third_party_pages').upsert({
                brand: brandLower,
                page_id: page.page_id,
                page_name: page.page_name,
                connection_type: page.connection_type,
                confidence: page.confidence,
                ai_verdict: (page as any).ai_verdict,
                ai_confidence: (page as any).ai_confidence,
                reason: page.flag_reason || 'Content verification removed',
                dismissed_at: new Date().toISOString(),
              }, { onConflict: 'brand,page_id' });
            } catch (dismissErr) {
              console.log(`[Worker] Failed to store dismissed page ${page.page_id}: ${dismissErr}`);
            }
          }
          console.log(`[Worker] Stored ${removed.length} dismissed pages in audit trail`);
        }

        console.log(`[Worker] Content verify: ${removed.length} removed, ${kept.length} kept (${report.pages_scrape_failed} scrape failed)`);
      } catch (fpError) {
        console.log(`[Worker] Content verification failed (non-critical): ${fpError}`);
      }
    }

    job.status = 'completed';
    job.result = result;
    job.completed_at = Date.now();
    job.progress = 'Completed';

    console.log(`[Worker] Job ${jobId} completed in ${Math.round((Date.now() - job.started_at!) / 1000)}s`);

    // Persist completed status + result
    await persistJob(supabase, job);

    // Store result in Supabase cache tables
    if (supabase && result.success) {
      await storeInCache(supabase, job.brand, result);

      // Update brand_list: mark discovery as done + resolve page_name
      try {
        const pageName = result.pages?.official?.[0]?.page_name || job.brand;
        const pageId = result.pages?.official?.[0]?.page_id;
        await supabase
          .from('brand_list')
          .update({
            discovery_cached_at: new Date().toISOString(),
            ...(pageId ? { page_id: pageId } : {}),
            ...(pageName ? { page_name: pageName } : {}),
          })
          .ilike('input_name', job.brand);
        console.log(`[Worker] Updated brand_list: discovery_cached_at for "${job.brand}"`);
      } catch (blErr) {
        console.log(`[Worker] brand_list update failed (non-critical): ${blErr}`);
      }
    }
  } catch (error) {
    job.status = 'error';
    job.error = String(error);
    job.completed_at = Date.now();
    job.progress = `Error: ${String(error).slice(0, 200)}`;
    console.error(`[Worker] Job ${jobId} failed:`, error);

    // Persist error status
    await persistJob(supabase, job);
  }

  // Browser cleanup: close Chromium to free memory between jobs
  try {
    const renderer = BrowserRenderer.getInstance();
    await renderer.closeBrowser();
    console.log(`[Worker] Browser closed (memory cleanup between jobs)`);
  } catch (e) {
    console.log(`[Worker] Browser cleanup warning: ${String(e).substring(0, 100)}`);
  }

  isProcessing = false;

  // Cooldown + process next job in queue
  if (jobQueue.length > 0) {
    console.log(`[Worker] Cooldown 120s before next job — rate limit budget recovery (${jobQueue.length} remaining in queue)...`);
    await new Promise(r => setTimeout(r, 120000));
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
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days

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
        flagged_suspicious: (page as any).flagged_suspicious || false,
        flag_reason: (page as any).flag_reason || null,
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

    if (META_ACCESS_TOKENS.length === 0) {
      return jsonResponse({ error: 'No META_ACCESS_TOKEN(S) configured' }, corsHeaders, 500);
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

    // Check if already processing (in-memory)
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

    // Also check DB for running/queued jobs from previous session
    if (supabase) {
      const { data: existingJob } = await supabase
        .from('discovery_jobs')
        .select('id, progress, status')
        .eq('brand', body.brand.toLowerCase().trim())
        .in('status', ['queued', 'running'])
        .maybeSingle();

      if (existingJob) {
        return jsonResponse({
          status: 'processing',
          job_id: existingJob.id,
          progress: existingJob.progress,
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

    // Persist to DB immediately
    await persistJob(supabase, job);

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
    let job = jobs.get(jobId);

    // If not in memory, check DB
    if (!job && supabase) {
      const { data: dbJob } = await supabase
        .from('discovery_jobs')
        .select('*')
        .eq('id', jobId)
        .maybeSingle();

      if (dbJob) {
        if (dbJob.status === 'completed' && dbJob.result) {
          return jsonResponse({
            status: 'completed',
            job_id: jobId,
            result: dbJob.result,
            duration_seconds: dbJob.completed_at && dbJob.started_at
              ? Math.round((new Date(dbJob.completed_at).getTime() - new Date(dbJob.started_at).getTime()) / 1000)
              : null,
          }, corsHeaders);
        }
        if (dbJob.status === 'error') {
          return jsonResponse({
            status: 'error',
            job_id: jobId,
            error: dbJob.error,
          }, corsHeaders);
        }
        return jsonResponse({
          status: dbJob.status,
          job_id: jobId,
          progress: dbJob.progress,
        }, corsHeaders);
      }
    }

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

      // Persist each job to DB
      await persistJob(supabase, job);
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

  // POST /api/pause — Pause after current job (queue stays)
  if (path === '/api/pause' && req.method === 'POST') {
    isPaused = true;
    console.log(`[Worker] Paused — will stop after current job (queue: ${jobQueue.length})`);
    return jsonResponse({
      status: 'paused',
      queue_length: jobQueue.length,
      current_job: isProcessing ? getCurrentJobInfo() : null,
    }, corsHeaders);
  }

  // POST /api/resume — Resume processing
  if (path === '/api/resume' && req.method === 'POST') {
    isPaused = false;
    console.log(`[Worker] Resumed — processing queue (${jobQueue.length} jobs)`);
    processNextJob(supabase);
    return jsonResponse({
      status: 'resumed',
      queue_length: jobQueue.length,
    }, corsHeaders);
  }

  // POST /api/cancel — Cancel current job + clear queue
  if (path === '/api/cancel' && req.method === 'POST') {
    const cleared = jobQueue.length;
    // Remove queued jobs from memory and mark as error in DB
    for (const jobId of [...jobQueue]) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = 'Cancelled by user';
        job.completed_at = Date.now();
        await persistJob(supabase, job);
      }
      jobs.delete(jobId);
    }
    jobQueue.length = 0;
    isPaused = true; // Stop processing after current job finishes
    console.log(`[Worker] Cancelled: cleared ${cleared} queued jobs, will stop after current`);
    return jsonResponse({
      status: 'cancelled',
      jobs_cleared: cleared,
      current_job_will_finish: isProcessing,
    }, corsHeaders);
  }

  // POST /api/clear — Clear all queued jobs and stop processing (legacy)
  if (path === '/api/clear' && req.method === 'POST') {
    const cleared = jobQueue.length;
    for (const jobId of [...jobQueue]) {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = 'Cleared by user';
        job.completed_at = Date.now();
        await persistJob(supabase, job);
      }
      jobs.delete(jobId);
    }
    jobQueue.length = 0;
    isProcessing = false;
    console.log(`[Worker] Cleared ${cleared} queued jobs`);
    return jsonResponse({
      status: 'cleared',
      jobs_cleared: cleared,
      jobs_remaining: jobs.size,
    }, corsHeaders);
  }

  // GET /api/queue — Queue status overview
  if (path === '/api/queue' && req.method === 'GET') {
    return jsonResponse({
      paused: isPaused,
      processing: isProcessing,
      queue_length: jobQueue.length,
      current_job: isProcessing ? getCurrentJobInfo() : null,
      queued_brands: jobQueue.map(id => {
        const j = jobs.get(id);
        return j ? { id: j.id, brand: j.brand, progress: j.progress } : { id };
      }),
    }, corsHeaders);
  }

  // POST /api/restore-all — Restore ALL dismissed pages back into caches (full undo)
  if (path === '/api/restore-all' && req.method === 'POST') {
    if (!supabase) {
      return jsonResponse({ error: 'Supabase not configured' }, corsHeaders, 500);
    }

    try {
      // 1. Load ALL dismissed pages
      const { data: allDismissed, error } = await supabase
        .from('dismissed_third_party_pages')
        .select('*');

      if (error) {
        return jsonResponse({ error: `Failed to load dismissed pages: ${error.message}` }, corsHeaders, 500);
      }

      if (!allDismissed || allDismissed.length === 0) {
        return jsonResponse({ status: 'ok', restored: 0, message: 'No dismissed pages to restore' }, corsHeaders);
      }

      // 2. Group by brand
      const byBrand = new Map<string, any[]>();
      for (const d of allDismissed) {
        if (!byBrand.has(d.brand)) byBrand.set(d.brand, []);
        byBrand.get(d.brand)!.push(d);
      }

      let totalRestored = 0;
      let brandsUpdated = 0;
      const errors: string[] = [];

      for (const [brand, pages] of byBrand) {
        try {
          // 3a. Restore into domain_mapping_cache
          const { data: cached } = await supabase
            .from('domain_mapping_cache')
            .select('data')
            .eq('brand', brand)
            .maybeSingle();

          if (cached?.data) {
            const cachedData = cached.data as any;
            if (!cachedData.pages) cachedData.pages = {};
            if (!Array.isArray(cachedData.pages.third_party)) cachedData.pages.third_party = [];

            const existingIds = new Set(cachedData.pages.third_party.map((p: any) => p.page_id));
            let addedToCache = 0;

            for (const d of pages) {
              if (existingIds.has(d.page_id)) continue;
              cachedData.pages.third_party.push({
                page_id: d.page_id,
                page_name: d.page_name || 'Unknown',
                connection_type: d.connection_type,
                confidence: d.confidence || 0.8,
                ad_count: d.ad_count || 1,
                domains_used: d.domains_used || [],
              });
              addedToCache++;
            }

            if (addedToCache > 0) {
              await supabase
                .from('domain_mapping_cache')
                .update({ data: cachedData })
                .eq('brand', brand);
            }
            totalRestored += addedToCache;
          }

          // 3b. Restore into discovery_jobs JSONB too
          const { data: jobData } = await supabase
            .from('discovery_jobs')
            .select('id, result')
            .eq('brand', brand)
            .eq('status', 'completed')
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (jobData?.result?.pages?.third_party) {
            const existingJobIds = new Set(jobData.result.pages.third_party.map((p: any) => p.page_id));
            let addedToJob = 0;

            for (const d of pages) {
              if (existingJobIds.has(d.page_id)) continue;
              jobData.result.pages.third_party.push({
                page_id: d.page_id,
                page_name: d.page_name || 'Unknown',
                connection_type: d.connection_type,
                confidence: d.confidence || 0.8,
                ad_count: d.ad_count || 1,
                domains_used: d.domains_used || [],
              });
              addedToJob++;
            }

            if (addedToJob > 0) {
              await supabase
                .from('discovery_jobs')
                .update({ result: jobData.result })
                .eq('id', jobData.id);
            }
          }

          // 3c. Delete restored pages from dismissed table
          const pageIds = pages.map((p: any) => p.page_id);
          await supabase
            .from('dismissed_third_party_pages')
            .delete()
            .eq('brand', brand)
            .in('page_id', pageIds);

          brandsUpdated++;
          console.log(`[Restore-All] ${brand}: ${pages.length} pages restored`);
        } catch (brandErr) {
          errors.push(`${brand}: ${String(brandErr).substring(0, 100)}`);
        }
      }

      console.log(`[Restore-All] Done: ${totalRestored} pages restored across ${brandsUpdated} brands`);
      return jsonResponse({
        status: 'ok',
        total_dismissed: allDismissed.length,
        restored: totalRestored,
        brands: brandsUpdated,
        errors: errors.length > 0 ? errors : undefined,
      }, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: String(err) }, corsHeaders, 500);
    }
  }

  // POST /api/cleanup-fp-test — Test cleanup on specific brands only
  if (path === '/api/cleanup-fp-test' && req.method === 'POST') {
    if (!supabase) {
      return jsonResponse({ error: 'Supabase not configured' }, corsHeaders, 500);
    }
    if (!OPENAI_KEY) {
      return jsonResponse({ error: 'OpenAI key not configured' }, corsHeaders, 500);
    }

    const body = await req.json() as { brands: string[] };
    if (!body.brands?.length) {
      return jsonResponse({ error: 'brands array is required' }, corsHeaders, 400);
    }

    const results: Record<string, any> = {};

    for (const brandName of body.brands) {
      const brand = brandName.toLowerCase().trim();
      try {
        // Load cached data for this brand
        const { data: cached } = await supabase
          .from('domain_mapping_cache')
          .select('data')
          .eq('brand', brand)
          .maybeSingle();

        if (!cached?.data) {
          results[brand] = { error: 'No cached data found' };
          continue;
        }

        const cachedData = cached.data as any;
        const pages = cachedData.pages?.third_party || [];

        if (pages.length === 0) {
          results[brand] = { tp_count: 0, message: 'No third-party pages' };
          continue;
        }

        const brandDomain = cachedData?.brand_domain || null;
        const domainData = {
          domains_all: cachedData.domains?.all || [],
          domain_urls: cachedData.domain_urls || {},
          brand_domain: brandDomain || '',
        };

        // Run content-based AI verification (DRY RUN)
        const report = await verifyAllPages(brand, brandDomain, pages, OPENAI_KEY, { dryRun: true, domainData });
        const { kept, removed } = applyContentVerification(pages, report);

        const removedDetails = removed.map((p: any) => ({
          page_id: p.page_id,
          page_name: p.page_name,
          connection_type: p.connection_type,
          ai_verdict: p.ai_verdict,
          ai_confidence: p.ai_confidence,
          reason: p.flag_reason,
        }));

        const keptByType: Record<string, number> = {};
        for (const p of kept) {
          keptByType[p.connection_type] = (keptByType[p.connection_type] || 0) + 1;
        }

        results[brand] = {
          tp_before: pages.length,
          tp_after: kept.length,
          removed_count: removed.length,
          pages_checked: report.pages_checked,
          kept_by_type: keptByType,
          removed: removedDetails,
        };

        console.log(`[Cleanup-FP-Test] ${brand}: ${pages.length} → ${kept.length} (removed ${removed.length})`);

        // Rate limit pause between brands
        await new Promise(r => setTimeout(r, 500));
      } catch (brandErr) {
        results[brand] = { error: String(brandErr).substring(0, 200) };
      }
    }

    return jsonResponse({
      status: 'test_complete',
      note: 'DRY RUN — no changes written to DB',
      results,
    }, corsHeaders);
  }

  // POST /api/verify-content — Content-based AI verification (scrapes actual pages)
  if (path === '/api/verify-content' && req.method === 'POST') {
    if (!supabase) {
      return jsonResponse({ error: 'Supabase not configured' }, corsHeaders, 500);
    }
    if (!OPENAI_KEY) {
      return jsonResponse({ error: 'OpenAI key not configured' }, corsHeaders, 500);
    }

    const body = await req.json() as { brands?: string[]; dry_run?: boolean; apply?: boolean };
    const dryRun = body.dry_run !== false; // Default: true
    const applyChanges = body.apply === true && !dryRun;

    try {
      // Load brands — either specific or all with TP pages
      let brandsToCheck: { brand: string; data: any }[] = [];

      if (body.brands?.length) {
        for (const brandName of body.brands) {
          const brand = brandName.toLowerCase().trim();
          const { data: cached } = await supabase
            .from('domain_mapping_cache')
            .select('data')
            .eq('brand', brand)
            .maybeSingle();
          if (cached?.data) {
            brandsToCheck.push({ brand, data: cached.data });
          }
        }
      } else {
        const { data: allCached } = await supabase
          .from('domain_mapping_cache')
          .select('brand, data')
          .order('brand');
        brandsToCheck = (allCached || [])
          .filter((r: any) => r.data?.pages?.third_party?.length > 0)
          .map((r: any) => ({ brand: r.brand, data: r.data }));
      }

      const results: Record<string, any> = {};

      for (const { brand, data: cachedData } of brandsToCheck) {
        const pages = cachedData.pages?.third_party || [];
        if (pages.length === 0) {
          results[brand] = { total: 0, message: 'No third-party pages' };
          continue;
        }

        const brandDomain = cachedData.brand_domain || null;
        const domainData = {
          domains_all: cachedData.domains?.all || [],
          domain_urls: cachedData.domain_urls || {},
          brand_domain: brandDomain || '',
        };
        const report = await verifyAllPages(brand, brandDomain, pages, OPENAI_KEY, { dryRun, domainData });

        // Apply changes if requested
        if (applyChanges && report.pages_removed > 0) {
          const { kept, removed } = applyContentVerification(pages, report);

          // Update domain_mapping_cache
          cachedData.pages.third_party = kept;
          await supabase
            .from('domain_mapping_cache')
            .update({ data: cachedData })
            .eq('brand', brand);

          // Store removed pages in dismissed table
          for (const page of removed) {
            try {
              await supabase.from('dismissed_third_party_pages').upsert({
                brand,
                page_id: page.page_id,
                page_name: page.page_name,
                connection_type: page.connection_type,
                confidence: page.confidence,
                ai_verdict: page.ai_verdict,
                ai_confidence: page.ai_confidence,
                reason: page.flag_reason || 'Content verification removed',
                dismissed_at: new Date().toISOString(),
              }, { onConflict: 'brand,page_id' });
            } catch (e) {
              console.log(`[VerifyContent] Failed to dismiss ${page.page_id}: ${e}`);
            }
          }
          console.log(`[VerifyContent] Applied: ${brand} — ${removed.length} removed, ${kept.length} kept`);
        }

        results[brand] = {
          brand_domain: brandDomain,
          brand_profile: report.brand_profile_summary,
          total_pages: report.total_pages,
          pages_checked: report.pages_checked,
          pages_kept: report.pages_kept,
          pages_removed: report.pages_removed,
          pages_scrape_failed: report.pages_scrape_failed,
          applied: applyChanges,
          details: report.details.map(d => ({
            page_name: d.page_name,
            connection_type: d.connection_type,
            domain: d.domain_scraped,
            scrape_ok: d.scrape_success,
            verdict: d.verdict.verdict,
            confidence: d.verdict.confidence,
            reason: d.verdict.reason,
          })),
        };

        // Rate limit between brands
        await new Promise(r => setTimeout(r, 500));
      }

      return jsonResponse({
        status: dryRun ? 'dry_run_complete' : 'complete',
        note: dryRun ? 'DRY RUN — no changes written to DB. Set apply=true to write.' : 'Changes applied to DB.',
        brands_checked: brandsToCheck.length,
        results,
      }, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: String(err) }, corsHeaders, 500);
    }
  }

  // POST /api/cleanup-fp — Batch cleanup false positives from all cached brands
  if (path === '/api/cleanup-fp' && req.method === 'POST') {
    if (!supabase) {
      return jsonResponse({ error: 'Supabase not configured' }, corsHeaders, 500);
    }
    if (!OPENAI_KEY) {
      return jsonResponse({ error: 'OpenAI key not configured' }, corsHeaders, 500);
    }
    if (cleanupFpStatus.running) {
      return jsonResponse({ error: 'Cleanup already running', status: cleanupFpStatus }, corsHeaders, 409);
    }

    // Start cleanup in background
    runCleanupFP(supabase);

    return jsonResponse({
      status: 'started',
      message: 'Cleanup started in background. Check GET /api/cleanup-fp/status for progress.',
    }, corsHeaders, 202);
  }

  // GET /api/cleanup-fp/status — Check cleanup progress
  if (path === '/api/cleanup-fp/status' && req.method === 'GET') {
    return jsonResponse(cleanupFpStatus, corsHeaders);
  }

  // POST /api/restore-verified — Restore wrongly removed pages with verified connection types
  if (path === '/api/restore-verified' && req.method === 'POST') {
    if (!supabase) {
      return jsonResponse({ error: 'Supabase not configured' }, corsHeaders, 500);
    }

    try {
      const verifiedTypes = ['deep_cta', 'presell_cta', 'redirect', 'shopify_vendor'];

      // Get all wrongly dismissed pages with verified connection types
      const { data: dismissed, error } = await supabase
        .from('dismissed_third_party_pages')
        .select('*')
        .in('connection_type', verifiedTypes);

      if (error || !dismissed || dismissed.length === 0) {
        return jsonResponse({ status: 'ok', restored: 0, message: 'No verified pages to restore' }, corsHeaders);
      }

      // Group by brand
      const byBrand = new Map<string, any[]>();
      for (const d of dismissed) {
        if (!byBrand.has(d.brand)) byBrand.set(d.brand, []);
        byBrand.get(d.brand)!.push(d);
      }

      let totalRestored = 0;
      const errors: string[] = [];

      for (const [brand, pages] of byBrand) {
        try {
          // Load current domain_mapping_cache for this brand
          const { data: cached } = await supabase
            .from('domain_mapping_cache')
            .select('data')
            .eq('brand', brand)
            .maybeSingle();

          if (!cached?.data) continue;

          const cachedData = cached.data as any;
          if (!cachedData.pages) cachedData.pages = {};
          if (!Array.isArray(cachedData.pages.third_party)) cachedData.pages.third_party = [];

          const existingIds = new Set(cachedData.pages.third_party.map((p: any) => p.page_id));

          // Reconstruct ThirdPartyPageInfo from dismissed data
          for (const d of pages) {
            if (existingIds.has(d.page_id)) continue; // Already there

            cachedData.pages.third_party.push({
              page_id: d.page_id,
              page_name: d.page_name || 'Unknown',
              connection_type: d.connection_type,
              confidence: d.confidence || 0.8,
              ad_count: 1,
              domains_used: [],
            });
            totalRestored++;
          }

          // Update domain_mapping_cache
          await supabase
            .from('domain_mapping_cache')
            .update({ data: cachedData })
            .eq('brand', brand);

          // Delete restored pages from dismissed table
          const pageIds = pages.map((p: any) => p.page_id);
          await supabase
            .from('dismissed_third_party_pages')
            .delete()
            .eq('brand', brand)
            .in('page_id', pageIds);

          console.log(`[Restore] ${brand}: ${pages.length} verified pages restored`);
        } catch (brandErr) {
          errors.push(`${brand}: ${String(brandErr).substring(0, 100)}`);
        }
      }

      console.log(`[Restore] Done: ${totalRestored} pages restored across ${byBrand.size} brands`);
      return jsonResponse({ status: 'ok', restored: totalRestored, brands: byBrand.size, errors }, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: String(err) }, corsHeaders, 500);
    }
  }

  return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
}

// ============================================
// Cleanup FP: Batch re-verify all cached brands
// ============================================

interface CleanupFPStatus {
  running: boolean;
  started_at: string | null;
  completed_at: string | null;
  total_brands: number;
  processed_brands: number;
  current_brand: string | null;
  total_removed: number;
  total_flagged: number;
  errors: string[];
}

const cleanupFpStatus: CleanupFPStatus = {
  running: false,
  started_at: null,
  completed_at: null,
  total_brands: 0,
  processed_brands: 0,
  current_brand: null,
  total_removed: 0,
  total_flagged: 0,
  errors: [],
};

async function runCleanupFP(supabase: SupabaseClient): Promise<void> {
  cleanupFpStatus.running = true;
  cleanupFpStatus.started_at = new Date().toISOString();
  cleanupFpStatus.completed_at = null;
  cleanupFpStatus.processed_brands = 0;
  cleanupFpStatus.total_removed = 0;
  cleanupFpStatus.total_flagged = 0;
  cleanupFpStatus.errors = [];
  cleanupFpStatus.current_brand = null;

  try {
    // 1. Get all brands from domain_mapping_cache that have third_party pages
    //    (third_party_pages are stored as JSONB in domain_mapping_cache.data.pages.third_party)
    const { data: allCached, error } = await supabase
      .from('domain_mapping_cache')
      .select('brand, data')
      .order('brand');

    if (error || !allCached) {
      cleanupFpStatus.errors.push(`Failed to load brands: ${error?.message}`);
      cleanupFpStatus.running = false;
      return;
    }

    // Filter to brands that actually have third_party pages
    const brandsWithTP = allCached.filter((row: any) => {
      const tp = row.data?.pages?.third_party;
      return Array.isArray(tp) && tp.length > 0;
    });

    cleanupFpStatus.total_brands = brandsWithTP.length;
    console.log(`[Cleanup-FP] Starting: ${brandsWithTP.length} brands to process`);

    for (const row of brandsWithTP) {
      const brand = row.brand;
      const cachedData = row.data as any;
      const pages = cachedData.pages.third_party as any[];
      cleanupFpStatus.current_brand = brand;

      try {
        const brandDomain = cachedData?.brand_domain || null;
        const domainData = {
          domains_all: cachedData.domains?.all || [],
          domain_urls: cachedData.domain_urls || {},
          brand_domain: brandDomain || '',
        };

        // Run content-based AI verification (scrapes landing pages)
        const report = await verifyAllPages(brand, brandDomain, pages, OPENAI_KEY, { domainData });
        if (!report || report.pages_removed === 0) {
          cleanupFpStatus.processed_brands++;
          continue;
        }

        const { removed } = applyContentVerification(pages, report);

        // Store removed pages in dismissed_third_party_pages for audit trail
        for (const page of removed) {
          try {
            await supabase.from('dismissed_third_party_pages').upsert({
              brand,
              page_id: page.page_id,
              page_name: page.page_name,
              connection_type: page.connection_type,
              confidence: page.confidence,
              ai_verdict: (page as any).ai_verdict,
              ai_confidence: (page as any).ai_confidence,
              reason: page.flag_reason || 'Batch cleanup auto-removed',
              dismissed_at: new Date().toISOString(),
            }, { onConflict: 'brand,page_id' });

            cleanupFpStatus.total_removed++;
          } catch (delErr) {
            cleanupFpStatus.errors.push(`${brand}/${page.page_id}: ${delErr}`);
          }
        }

        // Update domain_mapping_cache to remove deleted pages
        if (removed.length > 0) {
          const removedIds = new Set(removed.map(p => p.page_id));
          cachedData.pages.third_party = cachedData.pages.third_party.filter(
            (p: any) => !removedIds.has(p.page_id)
          );
          await supabase
            .from('domain_mapping_cache')
            .update({ data: cachedData })
            .eq('brand', brand);
        }

        // Update discovery_jobs cache too
        if (removed.length > 0) {
          const { data: jobData } = await supabase
            .from('discovery_jobs')
            .select('id, result')
            .eq('brand', brand)
            .eq('status', 'completed')
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (jobData?.result?.pages?.third_party) {
            const removedIds = new Set(removed.map(p => p.page_id));
            jobData.result.pages.third_party = jobData.result.pages.third_party.filter(
              (p: any) => !removedIds.has(p.page_id)
            );
            await supabase
              .from('discovery_jobs')
              .update({ result: jobData.result })
              .eq('id', jobData.id);
          }
        }

        cleanupFpStatus.total_flagged += report.pages_removed;
        cleanupFpStatus.processed_brands++;

        console.log(`[Cleanup-FP] ${brand}: ${removed.length} removed, ${report.pages_checked} checked (${cleanupFpStatus.processed_brands}/${brandsWithTP.length})`);

        // Rate limit pause between brands
        await new Promise(r => setTimeout(r, 500));

      } catch (brandErr) {
        cleanupFpStatus.errors.push(`${brand}: ${String(brandErr).substring(0, 100)}`);
        cleanupFpStatus.processed_brands++;
      }
    }

    cleanupFpStatus.current_brand = null;
    cleanupFpStatus.completed_at = new Date().toISOString();
    console.log(`[Cleanup-FP] Done: ${cleanupFpStatus.total_removed} removed across ${brandsWithTP.length} brands`);

  } catch (err) {
    cleanupFpStatus.errors.push(`Fatal: ${String(err).substring(0, 200)}`);
    console.error(`[Cleanup-FP] Fatal error: ${err}`);
  } finally {
    cleanupFpStatus.running = false;
  }
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
// Cleanup: Remove old completed jobs from memory (>1h)
// + periodic DB cleanup of expired cache rows
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

/** Run DB cleanup: delete expired rows from all cache tables.
 *  Safe to call anytime — only deletes rows past their expires_at. */
async function cleanupExpiredDbRows(sb: SupabaseClient): Promise<void> {
  const now = new Date().toISOString();
  const tables = [
    'brand_search_cache',
    'domain_mapping_cache',
    'page_ad_cache',
    'full_url_cache',
    'ad_preview_cache',
  ];
  let totalDeleted = 0;
  for (const table of tables) {
    try {
      const { count } = await sb
        .from(table)
        .delete({ count: 'exact' })
        .lt('expires_at', now);
      if (count && count > 0) {
        totalDeleted += count;
        console.log(`[Cleanup] ${table}: deleted ${count} expired rows`);
      }
    } catch (e) {
      console.log(`[Cleanup] ${table}: error — ${e}`);
    }
  }
  // Also clean old discovery jobs (completed/error older than 30 days)
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await sb
      .from('discovery_jobs')
      .delete({ count: 'exact' })
      .in('status', ['completed', 'error'])
      .lt('updated_at', thirtyDaysAgo);
    if (count && count > 0) {
      totalDeleted += count;
      console.log(`[Cleanup] discovery_jobs: deleted ${count} old jobs`);
    }
  } catch (e) {
    console.log(`[Cleanup] discovery_jobs: error — ${e}`);
  }
  if (totalDeleted > 0) {
    console.log(`[Cleanup] Total: ${totalDeleted} expired rows deleted`);
  } else {
    console.log(`[Cleanup] No expired rows found`);
  }
}

// ============================================
// Main
// ============================================

// Kill zombie Chromium processes from previous runs (prevents CPU throttling)
await killAllChromiumProcesses();

console.log(`[Worker] Starting Brand Discovery Worker on port ${PORT}...`);
if (META_ACCESS_TOKENS.length > 0) {
  const masked = META_ACCESS_TOKENS.map((t, i) => `#${i + 1}: ***${t.slice(-6)}`).join(', ');
  console.log(`[Worker] Meta API tokens: ${META_ACCESS_TOKENS.length} configured (${masked})`);
} else {
  console.log('[Worker] WARNING: No Meta API tokens configured!');
}

// Initialize Browser Renderer (local Chromium)
const browser = BrowserRenderer.getInstance();
console.log('[Worker] Browser renderer initialized (local Chromium)');

// Initialize Supabase client
let supabase: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[Worker] Supabase client initialized');

  // DB cleanup on startup — delete expired cache rows
  await cleanupExpiredDbRows(supabase);

  // AUTO-RESUME: Check for interrupted jobs from previous session
  await resumeInterruptedJobs(supabase);
  if (jobQueue.length > 0) {
    console.log(`[Worker] Auto-resuming ${jobQueue.length} job(s)...`);
    processNextJob(supabase);
  }
} else {
  console.log('[Worker] Warning: Supabase not configured, caching + persistence disabled');
}

// Cleanup intervals
setInterval(cleanupOldJobs, 10 * 60 * 1000); // Memory cleanup every 10 minutes
if (supabase) {
  // DB cleanup every 6 hours — delete expired cache rows
  setInterval(() => cleanupExpiredDbRows(supabase!), 6 * 60 * 60 * 1000);
}

// ============================================
// Watchdog: Force-restart if worker hangs
// ============================================
// If a job is running but no progress/checkpoint callback for 5 minutes,
// the worker is likely deadlocked (browser hang, acquireSlot spin-wait, etc).
// Force exit → systemd restarts → auto-resume picks up from cache.
setInterval(() => {
  if (!isProcessing || lastActivityAt === 0) return;

  const silentMs = Date.now() - lastActivityAt;
  if (silentMs > WATCHDOG_TIMEOUT_MS) {
    const silentMin = Math.round(silentMs / 60000);
    console.error(`[Watchdog] No progress for ${silentMin} minutes — worker appears hung!`);
    console.error(`[Watchdog] Force-restarting. Job will auto-resume from checkpoint.`);

    // Kill ALL chromium processes synchronously before exit
    // (closeBrowser is async and may not complete before Deno.exit)
    try {
      const killCmd = new Deno.Command('pkill', {
        args: ['-9', '-f', 'chromium'],
        stdout: 'null',
        stderr: 'null',
      });
      killCmd.outputSync();
      console.log('[Watchdog] Killed all chromium processes');
    } catch { /* no processes = ok */ }
    BrowserRenderer.getInstance().closeBrowser().catch(() => {});

    // Give a moment for the log to flush, then exit
    setTimeout(() => {
      Deno.exit(1); // systemd Restart=always will bring us back
    }, 1000);
  } else if (silentMs > WATCHDOG_TIMEOUT_MS / 2) {
    // Warning at 2.5 minutes
    const silentSec = Math.round(silentMs / 1000);
    console.warn(`[Watchdog] No progress for ${silentSec}s — monitoring...`);
  }
}, WATCHDOG_CHECK_INTERVAL_MS);

// Graceful shutdown — mark running jobs as interrupted (not error)
Deno.addSignalListener('SIGINT', async () => {
  console.log('[Worker] Shutting down gracefully...');

  // Mark running jobs back to 'running' in DB so they'll be resumed on next start
  // (They already have status='running' in DB, so nothing to change — just log it)
  for (const [, job] of jobs) {
    if (job.status === 'running') {
      console.log(`[Worker] Job ${job.id} for "${job.brand}" will resume on next start`);
    }
  }

  await browser.closeBrowser();
  Deno.exit(0);
});

// Start server
Deno.serve({ port: PORT }, (req) => handleRequest(req, supabase));
