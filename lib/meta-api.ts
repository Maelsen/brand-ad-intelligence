/**
 * Meta Ad Library API Client
 * Documentation: https://developers.facebook.com/docs/marketing-api/reference/ads_archive/
 */

import {
  MetaAdArchiveResponse,
  MetaAd,
  MetaApiConfig,
  DEFAULT_META_API_CONFIG,
  META_AD_FIELDS,
} from './types.ts';

export class MetaAdLibraryClient {
  private accessToken: string;
  private apiVersion: string;
  private baseUrl: string;

  constructor(config: MetaApiConfig) {
    this.accessToken = config.access_token;
    this.apiVersion = config.api_version || DEFAULT_META_API_CONFIG.api_version!;
    this.baseUrl = config.base_url || DEFAULT_META_API_CONFIG.base_url!;
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

    return this.fetch<MetaAdArchiveResponse>(url);
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

    return this.fetch<MetaAdArchiveResponse>(url);
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

      // Rate limiting protection - small delay between requests
      await this.delay(200);
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
    const maxResults = params.max_results || 10000; // Higher default for page-specific search

    console.log(`Fetching ads from page ${params.page_id}...`);

    while (allAds.length < maxResults) {
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

      // Check for next page
      if (response.paging?.cursors?.after) {
        cursor = response.paging.cursors.after;
      } else {
        break;
      }

      // Rate limiting protection
      await this.delay(200);
    }

    console.log(`Total: ${allAds.length} ads from page ${params.page_id}`);
    return allAds;
  }

  /**
   * Get Facebook Page info by username or page ID
   * Uses Graph API: GET /{page-id-or-username}?fields=id,name,category
   */
  async getPageInfo(usernameOrId: string): Promise<{
    id: string;
    name: string;
    category?: string;
  } | null> {
    try {
      const url = `${this.baseUrl}/${this.apiVersion}/${encodeURIComponent(usernameOrId)}?fields=id,name,category&access_token=${this.accessToken}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        console.log(`Page lookup failed for "${usernameOrId}": ${response.status}`);
        return null;
      }

      const data = await response.json();
      return {
        id: data.id,
        name: data.name,
        category: data.category,
      };
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
    url.searchParams.set('access_token', this.accessToken);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }

  /**
   * Make API request with error handling
   */
  private async fetch<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new MetaApiError(
        errorData.error?.message || `HTTP ${response.status}`,
        errorData.error?.code,
        errorData.error?.error_subcode
      );
    }

    return response.json();
  }

  /**
   * Simple delay helper
   */
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

/**
 * Check if error is rate limit related
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof MetaApiError) {
    return error.code === 613 || error.code === 4;
  }
  return false;
}
