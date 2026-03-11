/**
 * Browser Renderer — Self-hosted headless Chromium on VPS
 * All rendering is done locally. Zero external API cost.
 *
 * Uses Puppeteer-core to connect to system-installed Chromium.
 * Manages a pool of browser tabs for concurrent rendering.
 * 3-attempt retry with extended timeout on failure.
 *
 * Usage:
 *   const renderer = BrowserRenderer.getInstance();
 *   const html = await renderer.renderPage('https://example.com');
 *   const html2 = await renderer.renderPageWithClick('https://example.com', '#buy-button');
 */

import puppeteer, { Browser, Page } from 'npm:puppeteer-core@23';

// ============================================
// Configuration
// ============================================

const CHROMIUM_PATH = '/snap/bin/chromium';  // Ubuntu snap install
const CHROMIUM_PATH_ALT = '/usr/bin/chromium-browser';
const MAX_CONCURRENT_TABS = 12;          // Hostinger KVM 2: 8GB RAM + 4GB swap (15 caused crash cascades)
const MAX_CONCURRENT_FACEBOOK = 2;       // Facebook pages heavy (~300KB HTML) — keep conservative
const PAGE_TIMEOUT_MS = 20000;          // 20s per page load
const RENDER_WAIT_MS = 2000;            // 2s extra wait after networkidle2 (safety buffer for late JS)
const BROWSER_RESTART_INTERVAL = 100;   // Restart browser every N renders (memory cleanup)
const MAX_PAGE_HTML_SIZE = 2_000_000;   // 2MB max HTML to return
const EXTENDED_TIMEOUT_MS = 30000;     // 30s extended timeout for retry attempts

// ============================================
// Types
// ============================================

export interface RenderOptions {
  wait_ms?: number;          // How long to wait for JS rendering (default 6000)
  timeout_ms?: number;       // Total timeout per render (default 20000)
  click_selector?: string;   // CSS selector to click before extracting HTML
  click_wait_ms?: number;    // Wait after click (default 2000)
  scroll_y?: number;         // Scroll down this many pixels before extracting
}

export interface RenderResult {
  html: string;
  final_url: string;
  status_code: number;
  credits_used: number;      // Always 0 (local rendering only)
  renderer: 'local';
  error?: string;
  extracted_urls?: ExtractedUrls;  // DOM-queried URLs (for Facebook ad snapshots)
}

export interface ExtractedUrls {
  lphp_links: string[];      // l.facebook.com/l.php?u=... links
  lynx_uris: string[];       // data-lynx-uri attributes
  external_links: string[];  // Non-Facebook external links
}

// ============================================
// Browser Pool Manager (Singleton)
// ============================================

export class BrowserRenderer {
  private static instance: BrowserRenderer | null = null;

  private browser: Browser | null = null;
  private renderCount = 0;
  private launchPromise: Promise<Browser> | null = null;  // Replaces spin-wait lock
  private activePages = 0;
  private activeFacebookPages = 0;
  private semaphore: Promise<void>[] = [];

  // Circuit breaker: pause after consecutive crashes to let system recover
  private consecutiveCrashes = 0;
  private readonly MAX_CONSECUTIVE_CRASHES = 3;
  private readonly CRASH_COOLDOWN_MS = 10000;  // 10s pause

  private constructor() {}

  static getInstance(): BrowserRenderer {
    if (!BrowserRenderer.instance) {
      BrowserRenderer.instance = new BrowserRenderer();
    }
    return BrowserRenderer.instance;
  }

  /**
   * Ensure browser is launched and ready.
   * Uses a shared launch promise to prevent race conditions when multiple
   * concurrent tasks discover the browser is dead simultaneously.
   */
  private async ensureBrowser(): Promise<Browser> {
    // Restart browser periodically to prevent memory leaks
    if (this.browser && this.renderCount >= BROWSER_RESTART_INTERVAL && this.activePages === 0) {
      console.log(`[Browser] Restarting after ${this.renderCount} renders (memory cleanup)`);
      await this.closeBrowser();
    }

    // Check if browser process is still alive
    if (this.browser) {
      try {
        const proc = this.browser.process();
        if (proc && proc.exitCode !== null) {
          console.log(`[Browser] Process exited (code ${proc.exitCode}), relaunching...`);
          this.browser = null;
          this.activePages = 0;
          this.activeFacebookPages = 0;
        }
      } catch {
        console.log('[Browser] Process check failed, relaunching...');
        this.browser = null;
        this.activePages = 0;
        this.activeFacebookPages = 0;
      }
    }

    if (this.browser) return this.browser;

    // If already launching, await the SAME promise (no race condition)
    if (this.launchPromise) {
      return this.launchPromise;
    }

    // Launch browser — all concurrent callers will share this one promise
    this.launchPromise = this.launchBrowser();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  /**
   * Internal: launch a fresh Chromium instance
   */
  private async launchBrowser(): Promise<Browser> {
    try {
      // Find Chromium executable
      let execPath = CHROMIUM_PATH;
      try {
        await Deno.stat(execPath);
      } catch {
        execPath = CHROMIUM_PATH_ALT;
      }

      this.browser = await puppeteer.launch({
        executablePath: execPath,
        headless: 'new',  // New headless mode — less detectable by Facebook
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',     // Use /tmp instead of /dev/shm (limited in containers)
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--disable-hang-monitor',
          '--disable-prompt-on-repost',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--disable-blink-features=AutomationControlled',  // Hide automation flag from sites
          '--window-size=1280,800',
          '--disk-cache-size=104857600',           // Cap disk cache to 100MB (prevent /tmp bloat)
          '--js-flags=--max-old-space-size=512',  // Cap V8 heap to 512MB (prevent OOM on 3.7GB VPS)
        ],
      });

      this.renderCount = 0;
      console.log(`[Browser] Chromium launched (PID: ${this.browser.process()?.pid})`);
      return this.browser;
    } catch (error) {
      console.error('[Browser] Failed to launch Chromium:', error);
      throw error;
    }
  }

  /**
   * Close browser and clean up
   */
  async closeBrowser(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Force kill if graceful close fails
        this.browser.process()?.kill();
      }
      this.browser = null;
      // Kill any orphaned child processes (gpu-process, renderer, etc.)
      await killAllChromiumProcesses();
      console.log('[Browser] Closed');
    }
  }

  /**
   * Acquire a concurrency slot (semaphore)
   * Facebook pages get a stricter limit to prevent Chromium crashes.
   */
  private async acquireSlot(url?: string): Promise<void> {
    const isFacebook = url ? (url.includes('facebook.com') || url.includes('fb.com')) : false;
    while (this.activePages >= MAX_CONCURRENT_TABS ||
           (isFacebook && this.activeFacebookPages >= MAX_CONCURRENT_FACEBOOK)) {
      await new Promise(r => setTimeout(r, 50));
    }
    this.activePages++;
    if (isFacebook) this.activeFacebookPages++;
  }

  /**
   * Release a concurrency slot
   */
  private releaseSlot(url?: string): void {
    this.activePages--;
    const isFacebook = url ? (url.includes('facebook.com') || url.includes('fb.com')) : false;
    if (isFacebook) this.activeFacebookPages--;
  }

  /**
   * Render a page and return its HTML
   * 3-attempt retry: normal → crash recovery → extended timeout (30s)
   */
  async renderPage(url: string, options: RenderOptions = {}): Promise<RenderResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Third attempt: use extended timeout (30s, matching what ScrapingBee used)
        const attemptOptions = attempt === 2
          ? { ...options, timeout_ms: Math.max(options.timeout_ms || PAGE_TIMEOUT_MS, EXTENDED_TIMEOUT_MS) }
          : options;
        const result = await this.renderLocal(url, attemptOptions);
        return result;
      } catch (error) {
        const errMsg = String(error);
        if (attempt < 2) {
          console.log(`[Browser] Attempt ${attempt + 1} failed for ${url.substring(0, 60)}: ${errMsg.substring(0, 80)}`);
          continue; // renderLocal already resets browser on crash
        }
        // All 3 attempts exhausted
        console.log(`[Browser] All 3 attempts failed for ${url.substring(0, 60)}: ${errMsg.substring(0, 100)}`);
        return {
          html: '',
          final_url: url,
          status_code: 0,
          credits_used: 0,
          renderer: 'local',
          error: errMsg,
        };
      }
    }
    return { html: '', final_url: url, status_code: 0, credits_used: 0, renderer: 'local', error: 'Max retries' };
  }

  /**
   * Render a page, click an element, then return HTML
   * Used for anchor links (#zumangebot) and JS-triggered CTAs
   */
  async renderPageWithClick(url: string, clickSelector: string, options: RenderOptions = {}): Promise<RenderResult> {
    return this.renderPage(url, {
      ...options,
      click_selector: clickSelector,
      click_wait_ms: options.click_wait_ms ?? 2000,
    });
  }

  /**
   * Extract ad creative image/video URL from a Facebook ad snapshot.
   * Renders the snapshot page with images enabled (unlike the URL extraction path)
   * and picks the largest image (600x600 creative vs 60x60 profile pic).
   * Used by Worker pipeline Step 2c to cache previews for instant frontend display.
   */
  async extractAdPreview(snapshotUrl: string): Promise<{
    image_url: string | null;
    video_url: string | null;
    type: 'image' | 'video' | 'unknown';
  }> {
    // Use Facebook-limited slot — snapshot URLs are facebook.com pages
    await this.acquireSlot(snapshotUrl);
    let page: Page | null = null;

    try {
      const browser = await this.ensureBrowser();
      page = await browser.newPage();

      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );

      // Hide webdriver flag so Facebook renders video players
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      // Block fonts/stylesheets but KEEP images AND media
      // Media must NOT be blocked — Facebook checks media capability before rendering <video> elements
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (['font', 'stylesheet'].includes(type)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(snapshotUrl, {
        waitUntil: 'networkidle2',  // networkidle0 hangs on Facebook tracking pixels
        timeout: 20000,
      });

      // Extra wait for lazy-loaded scontent images
      await new Promise(r => setTimeout(r, 1500));

      // Extract image and video URLs from rendered DOM
      const result = await page.evaluate(() => {
        // Find all images from Facebook CDN
        const imgs = Array.from(document.querySelectorAll('img'))
          .filter(img => img.src && img.src.includes('scontent') && img.src.includes('fbcdn.net'))
          .map(img => ({
            url: img.src,
            width: img.naturalWidth || 0,
          }));

        // Creative = largest image (naturalWidth > 100), profile pic = 60x60
        // Only accept large images — skip tiny logos that would appear blurry
        const creative = imgs.find(i => i.width > 100);

        // Check for video elements
        const videoEl = document.querySelector('video[src*="fbcdn.net"]') as HTMLVideoElement | null;
        const sourceEl = document.querySelector('video source[src*="fbcdn.net"]') as HTMLSourceElement | null;
        const videoUrl = videoEl?.src || sourceEl?.src || null;

        // Video poster = dedicated HD thumbnail for video ads
        const videoPoster = (document.querySelector('video[poster]') as HTMLVideoElement)?.poster || null;

        // Priority: 1. large <img> (image ads), 2. video poster (video ads), 3. URL-length fallback
        return {
          image_url: creative?.url || videoPoster || imgs.sort((a, b) => b.url.length - a.url.length)[0]?.url || null,
          video_url: videoUrl,
        };
      });

      const type = result.video_url ? 'video' : result.image_url ? 'image' : 'unknown';
      this.renderCount++;
      this.consecutiveCrashes = 0;

      return { ...result, type };
    } catch (error) {
      const errMsg = String(error);
      const isCrash = errMsg.includes('Protocol error') || errMsg.includes('Target closed')
        || errMsg.includes('Connection closed') || errMsg.includes('Session closed')
        || errMsg.includes('frame was detached');

      if (isCrash) {
        const isConnectionDead = errMsg.includes('Connection closed') || errMsg.includes('Session closed');
        const proc = this.browser?.process();
        const processExited = !proc || proc.exitCode !== null;

        if (isConnectionDead || processExited) {
          console.log('[Browser] Browser connection lost during preview extraction, resetting');
          try { this.browser?.process()?.kill(); } catch { /* ignore */ }
          this.browser = null;
        }

        this.consecutiveCrashes++;
        if (this.consecutiveCrashes >= this.MAX_CONSECUTIVE_CRASHES) {
          console.log(`[Browser] ${this.consecutiveCrashes} consecutive crashes — cooling down ${this.CRASH_COOLDOWN_MS / 1000}s`);
          await new Promise(r => setTimeout(r, this.CRASH_COOLDOWN_MS));
          this.consecutiveCrashes = 0;
        }
      }

      console.log(`[Browser] Preview extraction failed: ${errMsg.substring(0, 100)}`);
      return { image_url: null, video_url: null, type: 'unknown' };
    } finally {
      if (page) {
        try { await page.close(); } catch { /* ignore */ }
      }
      this.releaseSlot(snapshotUrl);
    }
  }

  /**
   * Local Chromium rendering
   */
  private async renderLocal(url: string, options: RenderOptions): Promise<RenderResult> {
    await this.acquireSlot(url);
    let page: Page | null = null;

    try {
      const browser = await this.ensureBrowser();
      page = await browser.newPage();

      // Set viewport and user agent
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Block heavy resources to speed up rendering
      const isFacebookPage = url.includes('facebook.com') || url.includes('fb.com');
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        if (isFacebookPage) {
          // Facebook: Keep CSS (React needs it for element visibility), block images/media/fonts
          if (['image', 'media', 'font'].includes(type)) {
            req.abort();
          } else {
            req.continue();
          }
        } else {
          // Other sites: block all heavy resources
          if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
            req.abort();
          } else {
            req.continue();
          }
        }
      });

      const timeoutMs = options.timeout_ms ?? PAGE_TIMEOUT_MS;
      let statusCode = 0;

      if (isFacebookPage) {
        // Facebook ad snapshots: fast path — only wait for DOM + the selectors we need
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        statusCode = response?.status() ?? 0;
        // Wait for the l.php links to appear in DOM (max 8s)
        await page.waitForSelector(
          'a[href*="l.facebook.com/l.php"], [data-lynx-uri], a[href^="http"]:not([href*="facebook.com"])',
          { timeout: 8000 }
        ).catch(() => { /* selector not found, extract whatever is available */ });
      } else {
        // Other pages: full networkidle2 wait
        const response = await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: timeoutMs,
        });
        statusCode = response?.status() ?? 0;
        // Extra wait for JS-rendered CTAs
        const waitMs = options.wait_ms ?? 2000;
        if (waitMs > 0) {
          await new Promise(r => setTimeout(r, waitMs));
        }
      }

      // Click element if requested
      if (options.click_selector) {
        try {
          await page.click(options.click_selector);
          const clickWait = options.click_wait_ms ?? 2000;
          await new Promise(r => setTimeout(r, clickWait));
        } catch {
          // Element not found or not clickable — continue anyway
        }
      }

      // Scroll if requested
      if (options.scroll_y) {
        await page.evaluate((y) => window.scrollTo(0, y), options.scroll_y);
        await new Promise(r => setTimeout(r, 1000));
      }

      // Extract URLs from DOM BEFORE getting HTML (live DOM queries, like ScrapingBee extract_rules)
      // This is critical for Facebook ad snapshots where URLs are in React-rendered DOM
      // but don't appear reliably in serialized HTML.
      let extracted_urls: ExtractedUrls | undefined;
      if (isFacebookPage) {
        try {
          extracted_urls = await page.evaluate(() => {
            // Same CSS selectors as ScrapingBee extract_rules
            const lphp = Array.from(
              document.querySelectorAll('a[href*="l.facebook.com/l.php"], a[href*="l.instagram.com/l.php"]')
            ).map(a => a.getAttribute('href')).filter(Boolean) as string[];

            const lynx = Array.from(
              document.querySelectorAll('[data-lynx-uri*="l.facebook.com"]')
            ).map(el => el.getAttribute('data-lynx-uri')).filter(Boolean) as string[];

            const external = Array.from(
              document.querySelectorAll('a[href^="http"]:not([href*="facebook.com"]):not([href*="instagram.com"]):not([href*="fb.com"]):not([href*="meta."])')
            ).map(a => a.getAttribute('href')).filter(Boolean) as string[];

            return { lphp_links: lphp, lynx_uris: lynx, external_links: external };
          });
        } catch {
          // DOM query failed, continue with HTML extraction
        }
      }

      // For Facebook: we only need the extracted URLs, skip expensive page.content()
      if (isFacebookPage && extracted_urls) {
        const finalUrl = page.url();
        this.renderCount++;
        this.consecutiveCrashes = 0;
        return {
          html: '',
          final_url: finalUrl,
          status_code: statusCode,
          credits_used: 0,
          renderer: 'local',
          extracted_urls,
        };
      }

      // Get rendered HTML (non-Facebook pages, or Facebook without extracted URLs)
      let html = await page.content();

      // Truncate if too large
      if (html.length > MAX_PAGE_HTML_SIZE) {
        html = html.substring(0, MAX_PAGE_HTML_SIZE);
      }

      const finalUrl = page.url();
      this.renderCount++;
      this.consecutiveCrashes = 0;  // Reset circuit breaker on success

      return {
        html,
        final_url: finalUrl,
        status_code: statusCode,
        credits_used: 0,
        renderer: 'local',
        extracted_urls,
      };
    } catch (error) {
      // Detect browser crash and reset for next call
      const errMsg = String(error);
      const isCrash = errMsg.includes('Protocol error') || errMsg.includes('Target closed') || errMsg.includes('Connection closed') || errMsg.includes('Session closed') || errMsg.includes('frame was detached');
      if (isCrash) {
        // Distinguish between connection-level and tab-level crashes:
        // - "Connection closed" / "Session closed" = WebSocket to browser is dead → MUST reset
        // - "Target closed" / "frame was detached" = single tab died → browser might be fine
        const isConnectionDead = errMsg.includes('Connection closed') || errMsg.includes('Session closed');
        const proc = this.browser?.process();
        const processExited = !proc || proc.exitCode !== null;

        if (isConnectionDead || processExited) {
          // Browser connection is dead or process exited → must reset
          console.log(`[Browser] Browser connection lost (${isConnectionDead ? 'connection closed' : 'process exited'}), resetting`);
          try { this.browser?.process()?.kill(); } catch { /* ignore */ }
          this.browser = null;
        } else {
          // Browser is still alive and reachable! Only this tab crashed.
          // Do NOT kill the browser — other tabs continue working.
          console.log(`[Browser] Tab crashed but browser still alive (${this.activePages} tabs active), continuing`);
        }

        // Circuit breaker: pause after repeated crashes to let system recover
        this.consecutiveCrashes++;
        if (this.consecutiveCrashes >= this.MAX_CONSECUTIVE_CRASHES) {
          console.log(`[Browser] ${this.consecutiveCrashes} consecutive crashes — cooling down ${this.CRASH_COOLDOWN_MS / 1000}s`);
          await new Promise(r => setTimeout(r, this.CRASH_COOLDOWN_MS));
          this.consecutiveCrashes = 0;
        }
      }
      throw error;
    } finally {
      if (page) {
        try { await page.close(); } catch { /* ignore */ }
      }
      this.releaseSlot(url);
    }
  }

  /**
   * Get current stats
   */
  getStats(): { active_pages: number; total_renders: number; browser_alive: boolean } {
    return {
      active_pages: this.activePages,
      total_renders: this.renderCount,
      browser_alive: this.browser !== null,
    };
  }
}

// ============================================
// Convenience functions
// ============================================

/**
 * Render a page with headless browser (local Chromium only)
 */
export async function renderUrl(
  url: string,
  _scrapingbeeKey?: string, // Deprecated, kept for backward compat
  options: RenderOptions = {}
): Promise<RenderResult> {
  const renderer = BrowserRenderer.getInstance();
  return renderer.renderPage(url, options);
}

/**
 * Render a page and click an element (for CTA following)
 */
export async function renderUrlWithClick(
  url: string,
  clickSelector: string,
  _scrapingbeeKey?: string, // Deprecated, kept for backward compat
  options: RenderOptions = {}
): Promise<RenderResult> {
  const renderer = BrowserRenderer.getInstance();
  return renderer.renderPageWithClick(url, clickSelector, options);
}

/**
 * Shut down the browser (call on worker shutdown)
 */
export async function closeBrowser(): Promise<void> {
  const renderer = BrowserRenderer.getInstance();
  await renderer.closeBrowser();
}

/**
 * Kill ALL chromium processes on the system.
 * Used on startup and before Deno.exit() to prevent zombie processes.
 */
export async function killAllChromiumProcesses(): Promise<void> {
  try {
    const cmd = new Deno.Command('pkill', {
      args: ['-9', '-f', 'chromium'],
      stdout: 'null',
      stderr: 'null',
    });
    await cmd.output();
    console.log('[Browser] Killed all existing chromium processes');
  } catch {
    // pkill returns exit code 1 if no processes found — that's fine
  }
}
