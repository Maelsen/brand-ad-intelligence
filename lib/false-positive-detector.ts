/**
 * False Positive Detector (LEGACY — kept for backward compatibility)
 *
 * The main verification logic has moved to ai-brand-verifier.ts which provides:
 * - verifyThirdPartyPages() — stronger batch AI verification with auto-remove
 * - quickAIVerify() — inline checkout match guard
 * - applyVerificationResults() — split pages into kept/removed
 *
 * This file still exports the old API for any code that hasn't migrated yet.
 */

import type { ThirdPartyPageInfo, BrandInfo } from './types.ts';

export interface FalsePositiveCheckResult {
  flagged_page_ids: Array<{
    page_id: string;
    reason: string;
  }>;
  total_checked: number;
  total_flagged: number;
}

/**
 * @deprecated Use verifyThirdPartyPages() from ai-brand-verifier.ts instead.
 * This still works but only flags (never auto-removes).
 */
export async function checkFalsePositives(
  pages: ThirdPartyPageInfo[],
  brandInfo: BrandInfo,
  openaiKey?: string
): Promise<FalsePositiveCheckResult | null> {
  if (!openaiKey || pages.length === 0) return null;

  // Delegate to the new verifier
  try {
    const { verifyThirdPartyPages } = await import('./ai-brand-verifier.ts');
    const result = await verifyThirdPartyPages(pages, brandInfo, openaiKey);
    if (!result) return null;

    // Convert new format to old format (only flagged, not auto-removed)
    const flagged = result.results
      .filter(r => r.verdict === 'confirmed_false_positive' && r.confidence >= 0.7)
      .map(r => ({ page_id: r.page_id, reason: r.reason }));

    return {
      flagged_page_ids: flagged,
      total_checked: result.total_checked,
      total_flagged: flagged.length,
    };
  } catch (error) {
    console.log(`[FP-Check] Legacy wrapper error: ${error}`);
    return null;
  }
}

/**
 * @deprecated Use applyVerificationResults() from ai-brand-verifier.ts instead.
 */
export function applyFalsePositiveFlags(
  pages: ThirdPartyPageInfo[],
  checkResult: FalsePositiveCheckResult | null
): void {
  if (!checkResult || checkResult.flagged_page_ids.length === 0) return;

  const flagMap = new Map(
    checkResult.flagged_page_ids.map(f => [f.page_id, f.reason])
  );

  for (const page of pages) {
    const reason = flagMap.get(page.page_id);
    if (reason) {
      page.flagged_suspicious = true;
      page.flag_reason = reason;
    }
  }
}
