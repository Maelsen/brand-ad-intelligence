/**
 * Brand Ad Intelligence System - Type Definitions
 * Based on Meta Ad Library API v24.0
 */

// ============================================
// Meta Ad Library API Response Types
// ============================================

export interface MetaAdArchiveResponse {
  data: MetaAd[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
    previous?: string;
  };
}

export interface MetaAd {
  id: string;
  ad_creation_time?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  ad_creative_link_captions?: string[];
  ad_snapshot_url?: string;
  page_id?: string;
  page_name?: string;
  publisher_platforms?: string[];
  languages?: string[];
  // EU-specific fields (only available for EU ads)
  eu_total_reach?: number;
  target_ages?: string;
  target_gender?: string;
  target_locations?: TargetLocation[];
  age_country_gender_reach_breakdown?: AgeCountryGenderBreakdown[];
  beneficiary_payers?: BeneficiaryPayer[];
}

export interface TargetLocation {
  name: string;
  type: string;
}

export interface AgeCountryGenderBreakdown {
  country: string;
  age_range: string;
  male: number;
  female: number;
  unknown: number;
}

export interface BeneficiaryPayer {
  beneficiary?: string;
  payer?: string;
}

// ============================================
// API Request Types
// ============================================

export interface BrandSearchRequest {
  brand: string;
  country?: string;
  countries?: string[];
  active_only?: boolean;
  limit?: number;
}

export interface DomainsRequest {
  brand: string;
  country?: string;
}

// ============================================
// API Response Types (Our API)
// ============================================

export interface BrandSearchResponse {
  success: boolean;
  brand: string;
  total_ads: number;
  pages: PagesMapping;
  domains: string[];
  ads: ProcessedAd[];
  error?: string;
}

export interface ProcessedAd {
  id: string;
  creative_url: string | null;
  primary_text: string | null;
  headline: string | null;
  description: string | null;
  start_date: string | null;
  status: 'active' | 'inactive';
  landing_page_url: string | null;
  landing_page_domain: string | null;
  reach: number | null;
  reach_formatted: string | null; // e.g., "10K-50K" or "125.000"
  page_id: string | null;
  page_name: string | null;
  platforms: string[];
  languages: string[];
}

export interface PageInfo {
  page_id: string;
  page_name: string;
  ad_count: number;
  is_official?: boolean;
}

export interface PagesMapping {
  official: PageInfo[];
  third_party: PageInfo[];
}

export interface DomainsResponse {
  success: boolean;
  brand: string;
  pages: PagesMapping;
  domains: {
    presell: string[];
    redirect: string[];
    final_shop: string[];
    all: string[];
  };
  top_landing_pages: LandingPageInfo[];
  redirect_chains: RedirectChain[];
  // Enhanced presell chain tracking
  presell_chains?: PresellChainInfo[];
  // Intelligent domain classification
  domain_classifications?: DomainClassificationInfo[];
  // Checkout detection results (deep_scan)
  checkout_detections?: Array<{
    domain: string;
    brand_name: string | null;
    shop_domain: string | null;
    confidence: number;
  }>;
  error?: string;
}

// NEW: Presell chain tracking result
export interface PresellChainInfo {
  initial_url: string;
  cta_url: string | null;
  final_url: string | null;
  chain: string[];
  is_presell: boolean;
  shop_domain: string | null;
  confidence: number;
  extraction_method: string | null;
}

// NEW: Domain classification result
export interface DomainClassificationInfo {
  domain: string;
  type: 'presell' | 'affiliate' | 'shop' | 'redirect' | 'unknown';
  confidence: number;
  indicators: string[];
  final_url?: string;
}

export interface LandingPageInfo {
  url: string;
  count: number;
  domain: string;
  full_path?: string;       // /discount/HOLY?utm_source=facebook&utm_medium=...
  leads_to?: string;        // Final shop domain (for presell pages)
  extraction_method?: string; // How this URL was obtained
}

// Full URL Cache entry
export interface FullUrlCacheEntry {
  ad_id: string;
  page_id?: string;
  snapshot_url: string;
  domain?: string;
  extracted_url?: string;
  final_url?: string;
  full_path?: string;
  redirect_chain: string[];
  extraction_method?: string;
  confidence: number;
  scrape_success: boolean;
}

// Third-Party Page with connection info
export interface ThirdPartyPageInfo extends PageInfo {
  connection_type: 'domain_match' | 'checkout_match' | 'content_match' | 'content_link' | 'redirect_match' | 'redirect' | 'presell_cta' | 'shopify_vendor' | 'direct';
  confidence: number;
  discovered_via: string;
  domains_used: string[];
}

// Brand Domain Mapping
export interface BrandDomainMap {
  brand: string;
  domain: string;
  domain_type: 'presell' | 'redirect' | 'shop' | 'affiliate' | 'unknown';
  confidence: number;
  discovered_via: string;
  page_id?: string;
  page_name?: string;
  sample_urls: string[];
  ad_count: number;
}

export interface RedirectChain {
  initial_url: string;
  final_url: string;
  chain: string[];
}

// ============================================
// Brand Discovery Types
// ============================================

export interface BrandDiscoveryRequest {
  brand: string;
  country?: string;
  countries?: string[];
  keywords?: string[];       // Optional manual keywords
  max_keyword_ads?: number;  // Max ads per keyword search (default 500)
  use_headless?: boolean;    // Enable ScrapingBee fallback
  force_refresh?: boolean;   // Skip cache, force fresh discovery
}

export interface BrandDiscoveryResponse {
  success: boolean;
  status: 'completed' | 'processing' | 'cached' | 'error';
  brand: string;
  brand_domain: string | null;
  brand_platform: ShopifyDetectionResult['platform'] | null;

  // A) All FB Pages
  pages: {
    official: PageInfo[];
    third_party: ThirdPartyPageInfo[];
  };

  // B) All Domains
  domains: {
    presell: string[];
    redirect: string[];
    final_shop: string[];
    all: string[];
  };

  // B2) Full URLs per domain (from ad captions with paths)
  domain_urls?: Record<string, { url: string; count: number }[]>;

  // C) Top Landing Pages (FULL URLs)
  top_landing_pages: LandingPageInfo[];

  // Scan statistics
  scan_stats: {
    keywords_used: string[];
    total_ads_scanned: number;
    unique_domains_checked: number;
    matches_found: number;
    scan_duration_seconds: number;
    detection_methods: Record<string, number>;
  };

  error?: string;
  job_id?: string;
}

export interface BrandInfo {
  brand_name: string;
  brand_domain: string | null;
  brand_aliases: string[];         // e.g., ["miavola", "mia vola"]
  shopify_store: string | null;    // e.g., "miavola.myshopify.com"
  vendor_name: string | null;      // From /products.json
  platform: ShopifyDetectionResult['platform'] | null;
  official_page_ids: string[];
  brand_payers?: string[];         // Beneficiary/payer from EU ad transparency data
}

export interface DomainBrandCheck {
  domain: string;
  is_match: boolean;
  match_type: 'direct' | 'redirect' | 'shopify_vendor' | 'presell_cta' | 'checkout_match' | 'content_link' | 'content_match' | 'none';
  confidence: number;
  final_url: string | null;
  redirect_chain: string[];
  shop_domain: string | null;
  vendor_name: string | null;
  page_ids: string[];           // FB pages using this domain
  ad_count: number;             // Number of ads using this domain
}

// ============================================
// Shopify Detection Types
// ============================================

export interface ShopifyDetectionResult {
  is_shopify: boolean;
  domain: string;
  platform: 'shopify' | 'woocommerce' | 'magento' | 'custom' | 'unknown';
  store_name: string | null;       // e.g., "miavola"
  myshopify_domain: string | null; // e.g., "miavola.myshopify.com"
  vendor_name: string | null;      // From /products.json vendor field
  vendors: string[];               // All unique vendors
  og_site_name: string | null;     // From <meta property="og:site_name">
  confidence: number;
  detection_methods: string[];
}

// ============================================
// Keyword Generator Types
// ============================================

export interface KeywordGeneratorResult {
  keywords: string[];
  keyword_scores: Array<{
    keyword: string;
    frequency: number;
    source: 'body' | 'title' | 'description';
  }>;
  total_ads_analyzed: number;
}

// ============================================
// Cache Types (for PostgreSQL)
// ============================================

export interface CachedBrandSearch {
  id: string;
  brand: string;
  country: string;
  data: BrandSearchResponse;
  created_at: string;
  expires_at: string;
}

export interface CachedDomainMapping {
  id: string;
  brand: string;
  data: DomainsResponse;
  created_at: string;
  expires_at: string;
}

// ============================================
// Meta API Configuration
// ============================================

export interface MetaApiConfig {
  access_token: string;
  api_version?: string;
  base_url?: string;
}

export const DEFAULT_META_API_CONFIG: Partial<MetaApiConfig> = {
  api_version: 'v24.0',
  base_url: 'https://graph.facebook.com',
};

// ============================================
// API Fields Configuration
// ============================================

export const META_AD_FIELDS = [
  'id',
  'ad_creation_time',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'ad_creative_link_captions',
  'ad_snapshot_url',
  'page_id',
  'page_name',
  'publisher_platforms',
  'languages',
  'eu_total_reach',
  'target_ages',
  'target_gender',
  'target_locations',
  'age_country_gender_reach_breakdown',
  'beneficiary_payers',
].join(',');
