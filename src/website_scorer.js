import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Blacklisted domains that are NOT company official websites
 */
const BLACKLISTED_DOMAINS = [
  'facebook.com', 'fb.me', 'fb.com',
  'linkedin.com',
  'instagram.com',
  'youtube.com', 'youtu.be',
  'twitter.com', 'x.com',
  'tiktok.com',
  'alibaba.com', 'aliexpress.com',
  'made-in-china.com',
  'globalsources.com',
  'yellowpages.com', 'yellowpages.com.au',
  'indiamart.com',
  'tradeindia.com',
  'exportersindia.com',
  'tradekey.com',
  'ec21.com',
  'shopee.vn', 'shopee.com',
  'lazada.vn', 'lazada.com',
  'amazon.com',
  'yelp.com',
  'tripadvisor.com',
  'zalo.me',
  'pinterest.com',
  'vk.com',
  'trustpilot.com',
  'glassdoor.com',
  'crunchbase.com',
  'bloomberg.com',
  'reuters.com',
  'wikipedia.org',
  'wikidata.org',
  'dnb.com',
  'kompass.com'
];

/**
 * Score a candidate URL against a company name.
 * Returns a numeric score and a breakdown object.
 *
 * Score >= 70 → accept as official website
 * Score < 0   → definitely not the company website
 *
 * @param {string} url - Candidate URL to score
 * @param {string} companyName - Company name to match against
 * @param {object} [pageData] - Optional pre-fetched page data { title, hasContact, hasAbout, hasEmail, hasPhone, hasLogo }
 * @returns {{ score: number, breakdown: object, accepted: boolean }}
 */
export function scoreWebsite(url, companyName, pageData = null) {
  const breakdown = {};
  let score = 0;

  if (!url || typeof url !== 'string') {
    return { score: -999, breakdown: { invalid_url: -999 }, accepted: false };
  }

  let hostname = '';
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return { score: -999, breakdown: { invalid_url: -999 }, accepted: false };
  }

  // ─── Blacklist check (-100 immediate) ──────────────────────────────────
  const isBlacklisted = BLACKLISTED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  if (isBlacklisted) {
    breakdown.blacklisted = -100;
    return { score: -100, breakdown, accepted: false };
  }

  // ─── Domain similarity to company name (+50) ────────────────────────────
  const companySlug = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') // strip punctuation
    .trim();

  const domainSlug = hostname.split('.')[0].replace(/[^a-z0-9]/g, '');

  if (companySlug.length >= 3 && domainSlug.length >= 3) {
    if (domainSlug === companySlug) {
      score += 50;
      breakdown.domain_exact_match = 50;
    } else if (domainSlug.includes(companySlug) || companySlug.includes(domainSlug)) {
      score += 30;
      breakdown.domain_partial_match = 30;
    } else if (longestCommonSubstring(domainSlug, companySlug) / companySlug.length > 0.6) {
      score += 15;
      breakdown.domain_fuzzy_match = 15;
    }
  }

  // ─── Page-level checks (from fetched data) ────────────────────────────
  if (pageData) {
    // Company name in page title (+50)
    if (pageData.title) {
      const titleClean = pageData.title.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      const companyWords = companyName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const matchedWords = companyWords.filter(w => titleClean.includes(w));
      if (matchedWords.length >= Math.ceil(companyWords.length * 0.6)) {
        score += 50;
        breakdown.company_in_title = 50;
      } else if (matchedWords.length > 0) {
        score += 20;
        breakdown.partial_company_in_title = 20;
      }
    }

    if (pageData.hasContact) { score += 20; breakdown.has_contact = 20; }
    if (pageData.hasAbout)   { score += 20; breakdown.has_about = 20; }
    if (pageData.hasEmail)   { score += 20; breakdown.has_email = 20; }
    if (pageData.hasPhone)   { score += 15; breakdown.has_phone = 15; }
    if (pageData.hasLogo)    { score += 10; breakdown.has_logo = 10; }

    // Penalty: page has "marketplace" / "directory" signals
    if (pageData.isDirectory) { score -= 50; breakdown.is_directory = -50; }
  } else {
    // No page data yet — give a small base for having a valid domain
    score += 10;
    breakdown.valid_domain_base = 10;
  }

  return {
    score,
    breakdown,
    accepted: score >= 70
  };
}

/**
 * Fetch a URL and extract scoring signals for scoreWebsite()
 * Returns null on fetch failure.
 *
 * @param {string} url
 * @param {string} companyName
 * @returns {Promise<{ score, breakdown, accepted, url } | null>}
 */
export async function fetchAndScore(url, companyName) {
  try {
    const res = await axios.get(url, {
      timeout: 7000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
      },
      maxRedirects: 3,
      validateStatus: s => s < 500
    });

    const html = res.data;
    if (!html || typeof html !== 'string') return null;

    const $ = cheerio.load(html);
    const title = $('title').text().trim();
    const bodyText = $('body').text().toLowerCase();

    const pageData = {
      title,
      hasContact: bodyText.includes('contact') || bodyText.includes('liên hệ'),
      hasAbout: bodyText.includes('about') || bodyText.includes('giới thiệu'),
      hasEmail: !!$('a[href^="mailto:"]').length || /@[a-z0-9.-]+\.[a-z]{2,}/.test(bodyText),
      hasPhone: !!$('a[href^="tel:"]').length,
      hasLogo: !!$('img[class*="logo"], img[id*="logo"], .logo img, header img').length,
      isDirectory: /\b(directory|marketplace|supplier list|exhibitor list|trade platform)\b/i.test(bodyText)
    };

    const result = scoreWebsite(url, companyName, pageData);
    return { ...result, url };
  } catch {
    return null;
  }
}

/**
 * Pick the best URL from a list of candidates by scoring each one.
 *
 * @param {string[]} candidates - Array of URLs to evaluate
 * @param {string} companyName
 * @returns {Promise<string | null>} Best URL or null if none accepted
 */
export async function pickBestWebsite(candidates, companyName) {
  if (!candidates || candidates.length === 0) return null;

  const results = await Promise.all(
    candidates.map(url => fetchAndScore(url, companyName))
  );

  const valid = results
    .filter(r => r !== null)
    .sort((a, b) => b.score - a.score);

  if (valid.length === 0) return null;

  const best = valid[0];
  return best.accepted ? best.url : null;
}

// ─── Helper: Longest Common Substring length ─────────────────────────────
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let max = 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > max) max = dp[i][j];
      }
    }
  }
  return max;
}
