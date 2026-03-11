/**
 * Meta Ad Library API Client
 * Documentation: https://developers.facebook.com/docs/marketing-api/reference/ads_archive/
 *
 * Supports multiple access tokens with automatic rotation on rate limit errors.
 * With wait_for_rate_limit=true: NEVER throws on rate limits — waits indefinitely.
 *
 * Error handling strategy:
 * - Rate limits (codes 4, 17, 32, 613): 10min cooldown per token, wait forever in worker mode
 * - Transient errors (codes 1, 2): 30s delay, retry up to 5 times, then throw (skip brand)
 * - Token errors (190, 102, 463): mark token dead, try other tokens
 */

import {
  MetaAdArchiveResponse,
  MetaAd,
  MetaApiConfig,
  DEFAULT_META_API_CONFIG,
  META_AD_FIELDS,
} from './types.ts';

export class MetaAdLibraryClient {
  private accessTokens: string[];
  private currentTokenIdx: number = 0;
  private tokenErrorCounts: number[];
  private apiVersion: string;
  private baseUrl: string;

  /** If true, fetchWithRetry will wait indefinitely for REAL rate limits instead of throwing after 3 rounds */
  private waitForRateLimit: boolean;

  /** Per-token X-App-Usage tracking (call_count, total_cputime, total_time as percentages) */
  private tokenUsage: Array<{ call_count: number; total_cputime: number; total_time: number }>;

  /** Per-token cooldown: timestamp until which the token should NOT be used (rate limit recovery) */
  private tokenCooldownUntil: number[];

  /** Cooldown for REAL rate limits (codes 4, 17, 32, 613) — 10 minutes.
   *  Meta uses rolling 1h window, continuing calls EXTENDS the block. */
  private static readonly RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;

  /** Max retries for transient server errors (codes 1, 2) before giving up */
  private static readonly MAX_TRANSIENT_RETRIES = 5;

  /** Delay between transient error retries (30 seconds) */
  private static readonly TRANSIENT_RETRY_DELAY_MS = 30 * 1000;

  /** Proactive cooldown when usage > 80% (3 minutes — back off before hitting limit) */
  private static readonly PROACTIVE_COOLDOWN_MS = 3 * 60 * 1000;

  /** Proactive cooldown when usage > 95% (10 minutes — almost certainly will hit limit) */
  private static readonly PROACTIVE_COOLDOWN_HIGH_MS = 10 * 60 * 1000;

  constructor(config: { access_token?: string; access_tokens?: string[]; api_version?: string; base_url?: string; wait_for_rate_limit?: boolean }) {
    this.accessTokens = config.access_tokens || (config.access_token ? [config.access_token] : []);
    if (this.accessTokens.length === 0) throw new Error('At least one Meta API access token is required');
    this.waitForRateLimit = config.wait_for_rate_limit ?? false;
    this.tokenErrorCounts = new Array(this.accessTokens.length).fill(0);
    this.tokenUsage = this.accessTokens.map(() => ({ call_count: 0, total_cputime: 0, total_time: 0 }));
    this.tokenCooldownUntil = new Array(this.accessTokens.length).fill(0);
    this.apiVersion = config.api_version || DEFAULT_META_API_CONFIG.api_version!;
    this.baseUrl = config.base_url || DEFAULT_META_API_CONFIG.base_url!;
    if (this.accessTokens.length > 1) {
      console.log(`[MetaAPI] Initialized with ${this.accessTokens.length} tokens (adaptive pacing, wait_for_rate_limit=${this.waitForRateLimit})`);
    }
  }

  /** Check if a token is currently in cooldown */
  private isTokenInCooldown(idx: number): boolean {
    return Date.now() < this.tokenCooldownUntil[idx];
  }

  /** Get remaining cooldown seconds for a token */
  private getTokenCooldownRemaining(idx: number): number {
    return Math.max(0, Math.ceil((this.tokenCooldownUntil[idx] - Date.now()) / 1000));
  }

  /** Get the soonest cooldown expiry timestamp across all tokens */
  private getSoonestCooldownExpiry(): number {
    const now = Date.now();
    let soonest = Infinity;
    for (let i = 0; i < this.accessTokens.length; i++) {
      if (this.tokenCooldownUntil[i] > now && this.tokenCooldownUntil[i] < soonest) {
        soonest = this.tokenCooldownUntil[i];
      }
    }
    return soonest;
  }

  /** Currently active token */
  private get currentToken(): string {
    return this.accessTokens[this.currentTokenIdx];
  }

  /** Rotate to next token. Returns true if wrapped around (all tokens tried). */
  private rotateToken(silent = false): boolean {
    const prevIdx = this.currentTokenIdx;
    this.currentTokenIdx = (this.currentTokenIdx + 1) % this.accessTokens.length;
    const wrapped = this.currentTokenIdx <= prevIdx;
    if (!silent) {
      console.log(`[MetaAPI] Rotated to token ${this.currentTokenIdx + 1}/${this.accessTokens.length} (***${this.currentToken.slice(-6)})`);
    }
    return wrapped;
  }

  /** Parse X-App-Usage header from response and update tracking for current token.
   *  Returns the peak usage percentage. Also applies proactive cooldown if usage is high. */
  private updateUsageFromHeader(response: Response): number {
    const usageHeader = response.headers.get('x-app-usage');
    if (!usageHeader) return 0;
    try {
      const usage = JSON.parse(usageHeader);
      this.tokenUsage[this.currentTokenIdx] = {
        call_count: usage.call_count || 0,
        total_cputime: usage.total_cputime || 0,
        total_time: usage.total_time || 0,
      };
      const peak = this.getCurrentUsage();
      if (peak > 30) {
        console.log(`[MetaAPI] Usage token ${this.currentTokenIdx + 1}: call=${usage.call_count}%, cpu=${usage.total_cputime}%, time=${usage.total_time}% → delay=${this.getAdaptiveDelay()}ms`);
      }

      // Proactive cooldown: rotate BEFORE hitting the rate limit
      if (peak > 95 && this.accessTokens.length > 1) {
        const masked = this.currentToken.slice(-6);
        this.tokenCooldownUntil[this.currentTokenIdx] = Date.now() + MetaAdLibraryClient.PROACTIVE_COOLDOWN_HIGH_MS;
        console.log(`[MetaAPI] Token ***${masked} usage ${peak}% > 95% → proactive cooldown ${MetaAdLibraryClient.PROACTIVE_COOLDOWN_HIGH_MS / 1000}s`);
        const bestIdx = this.findLowestUsageToken();
        if (bestIdx !== this.currentTokenIdx && !this.isTokenInCooldown(bestIdx)) {
          this.currentTokenIdx = bestIdx;
          console.log(`[MetaAPI] Proactive rotate to token ${bestIdx + 1} (***${this.currentToken.slice(-6)})`);
        }
      } else if (peak > 80 && this.accessTokens.length > 1) {
        const masked = this.currentToken.slice(-6);
        this.tokenCooldownUntil[this.currentTokenIdx] = Date.now() + MetaAdLibraryClient.PROACTIVE_COOLDOWN_MS;
        console.log(`[MetaAPI] Token ***${masked} usage ${peak}% > 80% → proactive cooldown ${MetaAdLibraryClient.PROACTIVE_COOLDOWN_MS / 1000}s`);
        const bestIdx = this.findLowestUsageToken();
        if (bestIdx !== this.currentTokenIdx && !this.isTokenInCooldown(bestIdx)) {
          this.currentTokenIdx = bestIdx;
          console.log(`[MetaAPI] Proactive rotate to token ${bestIdx + 1} (***${this.currentToken.slice(-6)})`);
        }
      }

      return peak;
    } catch { return 0; }
  }

  /** Get the peak usage percentage of the current token */
  private getCurrentUsage(): number {
    const u = this.tokenUsage[this.currentTokenIdx];
    return Math.max(u.call_count, u.total_cputime, u.total_time);
  }

  /** Get adaptive delay based on current token's usage level */
  getAdaptiveDelay(): number {
    const usage = this.getCurrentUsage();
    if (usage > 85) return 15000;
    if (usage > 70) return 8000;
    if (usage > 50) return 4000;
    if (usage > 30) return 2000;
    return 1000;
  }

  /** Find the token with lowest usage, skipping tokens in cooldown. Returns its index. */
  private findLowestUsageToken(): number {
    let minIdx = 0;
    let minUsage = Infinity;
    for (let i = 0; i < this.accessTokens.length; i++) {
      // Skip tokens still in cooldown
      if (this.isTokenInCooldown(i)) continue;
      const u = this.tokenUsage[i];
      const peak = Math.max(u.call_count, u.total_cputime, u.total_time);
      if (peak < minUsage) {
        minUsage = peak;
        minIdx = i;
      }
    }
    return minIdx;
  }

  /** Find any token that is NOT in cooldown. Returns its index, or -1 if all are in cooldown. */
  private findAvailableToken(): number {
    for (let i = 0; i < this.accessTokens.length; i++) {
      const idx = (this.currentTokenIdx + i) % this.accessTokens.length;
      if (!this.isTokenInCooldown(idx)) return idx;
    }
    return -1;
  }

  /**
   * Search for ads by search terms (brand name)
   * search_type: KEYWORD_UNORDERED (default) or KEYWORD_EXACT_PHRASE
   */
  async searchByTerms(params: {
    search_terms: string;
    ad_reached_countries: string[];
    ad_active_status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
    search_type?: 'KEYWORD_UNORDERED' | 'KEYWORD_EXACT_PHRASE';
    limit?: number;
    after?: string;
  }): Promise<MetaAdArchiveResponse> {
    const url = this.buildUrl('/ads_archive', {
      search_terms: params.search_terms,
      ad_reached_countries: JSON.stringify(params.ad_reached_countries),
      ad_active_status: params.ad_active_status || 'ALL',
      search_type: params.search_type || 'KEYWORD_EXACT_PHRASE',
      ad_type: 'ALL',
      fields: META_AD_FIELDS,
      limit: String(params.limit || 100),
      ...(params.after && { after: params.after }),
    });

    return this.fetchWithRetry<MetaAdArchiveResponse>(url);
  }

  /**
   * Search for ads by page IDs
   */
  async searchByPageIds(params: {
    page_ids: string[];
    ad_reached_countries: string[];
    ad_active_status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
    limit?: number;
    after?: string;
  }): Promise<MetaAdArchiveResponse> {
    const url = this.buildUrl('/ads_archive', {
      search_page_ids: params.page_ids.join(','),
      ad_reached_countries: JSON.stringify(params.ad_reached_countries),
      ad_active_status: params.ad_active_status || 'ALL',
      ad_type: 'ALL',
      fields: META_AD_FIELDS,
      limit: String(params.limit || 100),
      ...(params.after && { after: params.after }),
    });

    return this.fetchWithRetry<MetaAdArchiveResponse>(url);
  }

  /**
   * Fetch all ads by search terms with pagination
   */
  async fetchAllAds(params: {
    search_terms: string;
    ad_reached_countries: string[];
    ad_active_status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
    search_type?: 'KEYWORD_UNORDERED' | 'KEYWORD_EXACT_PHRASE';
    max_results?: number;
  }): Promise<MetaAd[]> {
    const allAds: MetaAd[] = [];
    let cursor: string | undefined;
    const maxResults = params.max_results || 1000;

    while (allAds.length < maxResults) {
      const response = await this.searchByTerms({
        search_terms: params.search_terms,
        ad_reached_countries: params.ad_reached_countries,
        ad_active_status: params.ad_active_status,
        search_type: params.search_type || 'KEYWORD_EXACT_PHRASE',
        limit: Math.min(100, maxResults - allAds.length),
        after: cursor,
      });

      if (!response.data || response.data.length === 0) {
        break;
      }

      allAds.push(...response.data);

      // Check for next page
      if (response.paging?.cursors?.after) {
        cursor = response.paging.cursors.after;
      } else {
        break;
      }

      // Adaptive delay based on X-App-Usage header
      await this.delay(this.getAdaptiveDelay());
    }

    return allAds;
  }

  /**
   * Fetch ALL ads from a specific Facebook Page using search_page_ids
   * This is the correct way to get all ads from a brand
   */
  async fetchAllAdsFromPage(params: {
    page_id: string;
    ad_reached_countries: string[];
    ad_active_status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
    max_results?: number;
  }): Promise<MetaAd[]> {
    const allAds: MetaAd[] = [];
    let cursor: string | undefined;
    const maxResults = params.max_results || 10000;

    console.log(`Fetching ads from page ${params.page_id}...`);

    while (allAds.length < maxResults) {
      try {
        const response = await this.searchByPageIds({
          page_ids: [params.page_id],
          ad_reached_countries: params.ad_reached_countries,
          ad_active_status: params.ad_active_status || 'ALL',
          limit: 100,
          after: cursor,
        });

        if (!response.data || response.data.length === 0) {
          break;
        }

        allAds.push(...response.data);
        console.log(`Loaded ${allAds.length} ads so far...`);

        if (response.paging?.cursors?.after) {
          cursor = response.paging.cursors.after;
        } else {
          break;
        }

        await this.delay(this.getAdaptiveDelay());
      } catch (err) {
        if (allAds.length > 0) {
          console.log(`[MetaAPI] Error during pagination after ${allAds.length} ads — returning partial results`);
          break;
        }
        throw err;
      }
    }

    console.log(`Total: ${allAds.length} ads from page ${params.page_id}`);
    return allAds;
  }

  /**
   * Get Facebook Page info by username or page ID
   */
  async getPageInfo(usernameOrId: string): Promise<{
    id: string;
    name: string;
    category?: string;
  } | null> {
    try {
      const url = `${this.baseUrl}/${this.apiVersion}/${encodeURIComponent(usernameOrId)}?fields=id,name,category&access_token=${this.currentToken}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        console.log(`Page lookup failed for "${usernameOrId}": ${response.status}`);
        return null;
      }

      const data = await response.json();
      return { id: data.id, name: data.name, category: data.category };
    } catch (error) {
      console.log(`Page lookup error for "${usernameOrId}":`, error);
      return null;
    }
  }

  /**
   * Build the API URL with parameters
   */
  private buildUrl(endpoint: string, params: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}/${this.apiVersion}${endpoint}`);
    url.searchParams.set('access_token', this.currentToken);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /**
   * Make API request with token rotation on rate limit errors.
   *
   * Error handling:
   * - REAL rate limits (4, 17, 32, 613): 10min cooldown per token.
   *   With wait_for_rate_limit=true: waits indefinitely for cooldown expiry.
   *   With wait_for_rate_limit=false: throws after 3 rounds (Edge Function mode).
   * - Transient errors (1, 2): NOT a token problem — Meta server overload.
   *   Retries up to 5 times with 30s delay, then throws (brand gets skipped).
   * - Token errors (190, 102, 463): marks token dead, tries other tokens.
   */
  private async fetchWithRetry<T>(url: string): Promise<T> {
    const maxRounds = this.waitForRateLimit ? Infinity : 3;
    let round = 0;
    let transientRetries = 0;

    while (round < maxRounds) {
      // Find an available token (not in cooldown)
      const availableIdx = this.findAvailableToken();

      if (availableIdx === -1) {
        // ALL tokens in cooldown
        if (!this.waitForRateLimit) {
          if (round >= 2) break; // Edge Function mode: throw below
        }

        const soonest = this.getSoonestCooldownExpiry();
        const waitMs = Math.max(soonest - Date.now() + 1000, 10000);
        const waitSec = Math.round(waitMs / 1000);

        const cooldownStatus = this.accessTokens.map((_, i) => {
          const remaining = this.getTokenCooldownRemaining(i);
          return `T${i + 1}:${remaining}s`;
        }).join(', ');
        console.log(`[MetaAPI] All ${this.accessTokens.length} tokens in cooldown [${cooldownStatus}]. Waiting ${waitSec}s...`);

        // Wait in chunks of 60s with heartbeat
        let waited = 0;
        while (waited < waitMs) {
          const chunk = Math.min(60000, waitMs - waited);
          await this.delay(chunk);
          waited += chunk;
          if (waited < waitMs && waited >= 60000) {
            console.log(`[MetaAPI] Still waiting for cooldown... ${Math.round((waitMs - waited) / 1000)}s remaining`);
          }
        }

        // Reset usage for tokens whose cooldown has expired
        for (let i = 0; i < this.accessTokens.length; i++) {
          if (!this.isTokenInCooldown(i)) {
            this.tokenUsage[i] = { call_count: 0, total_cputime: 0, total_time: 0 };
          }
        }

        round++;
        continue;
      }

      // Use the available token
      this.currentTokenIdx = availableIdx;
      const parsed = new URL(url);
      parsed.searchParams.set('access_token', this.currentToken);
      const currentUrl = parsed.toString();
      const masked = this.currentToken.slice(-6);

      try {
        const response = await fetch(currentUrl, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });

        this.updateUsageFromHeader(response);

        if (!response.ok) {
          let errorData: Record<string, unknown> = {};
          try {
            errorData = await response.json();
          } catch {
            if (response.status === 429) {
              errorData = { error: { message: 'Too Many Requests', code: 4 } };
            }
          }

          const error = new MetaApiError(
            (errorData.error as Record<string, unknown>)?.message as string || `HTTP ${response.status}`,
            (errorData.error as Record<string, unknown>)?.code as number | undefined,
            (errorData.error as Record<string, unknown>)?.error_subcode as number | undefined
          );

          // ===== TRANSIENT SERVER ERRORS (code 1, 2) =====
          // NOT a token problem — Meta servers are overloaded or having issues.
          // Retry a few times with delay, then give up (brand gets skipped).
          if (isTransientError(error)) {
            transientRetries++;
            console.log(`[MetaAPI] Transient error (code ${error.code}) on token ***${masked} — retry ${transientRetries}/${MetaAdLibraryClient.MAX_TRANSIENT_RETRIES}`);

            if (transientRetries >= MetaAdLibraryClient.MAX_TRANSIENT_RETRIES) {
              console.log(`[MetaAPI] Transient error persisted after ${transientRetries} retries — giving up (brand will be skipped)`);
              throw error;
            }

            // Short wait, then retry (don't put token in cooldown — it's not the token's fault)
            await this.delay(MetaAdLibraryClient.TRANSIENT_RETRY_DELAY_MS);
            continue;
          }

          // ===== REAL RATE LIMITS (code 4, 17, 32, 613) =====
          // Token-specific: this token hit its limit. Set 10min cooldown, try next token.
          if (isRateLimitCode(error)) {
            this.tokenErrorCounts[this.currentTokenIdx]++;
            this.tokenUsage[this.currentTokenIdx] = { call_count: 100, total_cputime: 100, total_time: 100 };
            this.tokenCooldownUntil[this.currentTokenIdx] = Date.now() + MetaAdLibraryClient.RATE_LIMIT_COOLDOWN_MS;
            console.log(`[MetaAPI] Rate limit (code ${error.code}) on token ***${masked} — 600s cooldown`);
            continue;
          }

          // ===== TOKEN ERRORS (190, 102, 463) =====
          // Token is dead/expired. Set cooldown, try other tokens.
          if (isTokenDeadError(error)) {
            this.tokenCooldownUntil[this.currentTokenIdx] = Date.now() + MetaAdLibraryClient.RATE_LIMIT_COOLDOWN_MS;
            console.log(`[MetaAPI] Token error (code ${error.code}) on token ***${masked} — token dead, trying others`);
            continue;
          }

          // Non-retryable error → throw immediately
          throw error;
        }

        const data = await response.json();

        // Smart rotation: rotate if current token is getting hot (> 40% usage)
        if (this.accessTokens.length > 1 && this.getCurrentUsage() > 40) {
          const bestIdx = this.findLowestUsageToken();
          if (bestIdx !== this.currentTokenIdx && !this.isTokenInCooldown(bestIdx)) {
            this.currentTokenIdx = bestIdx;
            console.log(`[MetaAPI] Smart rotate to token ${bestIdx + 1} (lowest usage, current was ${this.getCurrentUsage()}%)`);
          }
        }

        return data;
      } catch (err) {
        if (!(err instanceof MetaApiError)) {
          // Network error — short cooldown, try next token
          console.log(`[MetaAPI] Network error on token ***${masked}: ${err}`);
          this.tokenCooldownUntil[this.currentTokenIdx] = Date.now() + 30000;
          continue;
        }
        // MetaApiError that wasn't caught above — re-throw
        throw err;
      }
    }

    throw new MetaApiError('All tokens exhausted after retry (rate-limited or invalid)', 429);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Custom error class for Meta API errors
 */
export class MetaApiError extends Error {
  code?: number;
  subcode?: number;

  constructor(message: string, code?: number, subcode?: number) {
    super(message);
    this.name = 'MetaApiError';
    this.code = code;
    this.subcode = subcode;
  }
}

/** Check if error is a REAL rate limit (token-specific, needs long cooldown) */
function isRateLimitCode(error: MetaApiError): boolean {
  return error.code === 4 || error.code === 17 || error.code === 32 || error.code === 613;
}

/** Check if error is transient server overload (NOT token-specific, short retry) */
function isTransientError(error: MetaApiError): boolean {
  return error.code === 1 || error.code === 2;
}

/** Check if token is dead/expired/invalid */
function isTokenDeadError(error: MetaApiError): boolean {
  return error.code === 190 || error.code === 102 || error.code === 463;
}

/**
 * Check if error is rate limit related (exported for external use)
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof MetaApiError) {
    return error.code === 613 || error.code === 4 || error.code === 17 || error.code === 32;
  }
  return false;
}

/**
 * Check if error is retryable with token rotation (rate limit OR token expired/invalid)
 */
export function isRetryableTokenError(error: unknown): boolean {
  if (error instanceof MetaApiError) {
    if (error.code === 4 || error.code === 17 || error.code === 32 || error.code === 613) return true;
    if (error.code === 2 || error.code === 1) return true;
    if (error.code === 190 || error.code === 102 || error.code === 463) return true;
  }
  return false;
}
