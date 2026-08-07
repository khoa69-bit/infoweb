import axios from 'axios';
import * as cheerio from 'cheerio';
import { resolveWebsiteBySearch } from './search_resolver.js';
import { filterAndPrioritizeEmails, batchValidateEmails } from './email_validator.js';
import { getCachedDomain, setCachedDomain, extractDomain } from './domain_cache.js';

// ─────────────────────────────────────────────────────────────────────────────
// Social media domain blacklist (do not treat as company website)
// ─────────────────────────────────────────────────────────────────────────────
const SOCIAL_DOMAINS = [
  'facebook.com', 'fb.me', 'fb.com',
  'linkedin.com',
  'instagram.com',
  'youtube.com', 'youtu.be',
  'zalo.me', 'zalo.vn',
  'tiktok.com',
  'twitter.com', 'x.com',
  'shopee.vn', 'shopee.com',
  'lazada.vn', 'lazada.com',
  'pinterest.com', 'vk.com'
];

// ─────────────────────────────────────────────────────────────────────────────
// TLD → Country mapping (Step 9)
// ─────────────────────────────────────────────────────────────────────────────
const TLD_COUNTRY_MAP = {
  '.co.jp': 'Japan', '.jp': 'Japan',
  '.com.au': 'Australia', '.net.au': 'Australia', '.org.au': 'Australia',
  '.com.vn': 'Vietnam', '.net.vn': 'Vietnam', '.org.vn': 'Vietnam', '.vn': 'Vietnam',
  '.co.uk': 'United Kingdom', '.uk': 'United Kingdom',
  '.co.in': 'India', '.in': 'India',
  '.co.kr': 'Korea', '.kr': 'Korea',
  '.com.cn': 'China', '.cn': 'China',
  '.com.tw': 'Taiwan', '.tw': 'Taiwan',
  '.co.th': 'Thailand', '.th': 'Thailand',
  '.com.sg': 'Singapore', '.sg': 'Singapore',
  '.co.id': 'Indonesia', '.id': 'Indonesia',
  '.com.my': 'Malaysia', '.my': 'Malaysia',
  '.com.ph': 'Philippines', '.ph': 'Philippines',
  '.de': 'Germany',
  '.fr': 'France',
  '.it': 'Italy',
  '.es': 'Spain',
  '.nl': 'Netherlands',
  '.be': 'Belgium',
  '.ru': 'Russia',
  '.br': 'Brazil',
  '.com.br': 'Brazil',
  '.mx': 'Mexico',
  '.ca': 'Canada',
  '.nz': 'New Zealand',
  '.co.nz': 'New Zealand',
  '.za': 'South Africa',
  '.co.za': 'South Africa',
  '.pk': 'Pakistan',
  '.bd': 'Bangladesh',
  '.lk': 'Sri Lanka',
  '.com.lk': 'Sri Lanka'
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Website Normalizer (upgraded)
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeWebsite(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { urls: [], primaryUrl: null, status: 'Invalid' };
  }

  const parts = rawUrl.split(/;|\s+/).filter(Boolean);
  const validUrls = [];

  for (let part of parts) {
    let cleaned = part.trim();

    if (cleaned.toLowerCase().startsWith('mailto:') || cleaned.toLowerCase().startsWith('tel:')) continue;

    // Skip social domains
    if (SOCIAL_DOMAINS.some(domain => cleaned.toLowerCase().includes(domain))) continue;

    // Fix protocol format: //www.domain.com → https://www.domain.com
    if (cleaned.startsWith('//')) {
      cleaned = 'https:' + cleaned;
    }

    // Add protocol if missing
    if (!cleaned.toLowerCase().startsWith('http://') && !cleaned.toLowerCase().startsWith('https://')) {
      cleaned = 'https://' + cleaned;
    }

    try {
      const parsed = new URL(cleaned);
      if (!parsed.hostname || !parsed.hostname.includes('.')) continue;

      // Strip path, query, hash — keep only origin (root domain)
      // e.g. https://abc.com/about → https://abc.com
      // e.g. https://abc.com?x=1 → https://abc.com
      // e.g. https://abc.com/index.html → https://abc.com
      const rootUrl = `${parsed.protocol}//${parsed.hostname}`;
      if (!validUrls.includes(rootUrl)) {
        validUrls.push(rootUrl);
      }
    } catch {}
  }

  if (validUrls.length === 0) {
    return { urls: [], primaryUrl: null, status: 'Invalid' };
  }

  return {
    urls: validUrls,
    primaryUrl: validUrls[0],
    status: 'Valid'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 7: Phone Normalizer
// ─────────────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  // Remove all non-digit/non-plus chars
  let cleaned = raw.replace(/[\s\-().]/g, '').trim();

  // Vietnam: 0xxx → +84xxx
  if (/^0[235789]\d{8}$/.test(cleaned)) {
    cleaned = '+84' + cleaned.slice(1);
  }
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 9 / 12: Address & Country Resolver (with TLD fallback)
// ─────────────────────────────────────────────────────────────────────────────
export function resolveCountryFromTLD(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const hostname = new URL(websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
    // Check compound TLDs first (longest match)
    const sortedTlds = Object.keys(TLD_COUNTRY_MAP).sort((a, b) => b.length - a.length);
    for (const tld of sortedTlds) {
      if (hostname.endsWith(tld)) {
        return TLD_COUNTRY_MAP[tld];
      }
    }
  } catch {}
  return null;
}

/**
 * Step 12: Normalize Vietnamese address abbreviations
 */
export function normalizeAddress(raw) {
  if (!raw || typeof raw !== 'string') return raw;

  return raw
    .replace(/\bTP\.?\s*HCM\b/gi, 'Ho Chi Minh City')
    .replace(/\bHCM\b/g, 'Ho Chi Minh City')
    .replace(/\bTP\.?\s*Hồ Chí Minh\b/gi, 'Ho Chi Minh City')
    .replace(/\bHồ Chí Minh\b/gi, 'Ho Chi Minh City')
    .replace(/\bSài Gòn\b/gi, 'Ho Chi Minh City')
    .replace(/\bSaigon\b/gi, 'Ho Chi Minh City')
    .replace(/\bHà Nội\b/gi, 'Hanoi')
    .replace(/\bHanoi\b/gi, 'Hanoi')
    .replace(/\bHa Noi\b/gi, 'Hanoi')
    .replace(/\bĐà Nẵng\b/gi, 'Da Nang')
    .replace(/\bDa Nang\b/gi, 'Da Nang')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 9: Country & Region Classifier (upgraded with TLD fallback)
// ─────────────────────────────────────────────────────────────────────────────
export function classifyRegion(address = '', phone = '', countryFound = '', websiteUrl = '') {
  const normAddr = address.toLowerCase();

  // If country was explicitly found from schema.org
  if (countryFound && countryFound.toLowerCase() !== 'unknown') {
    const cLower = countryFound.toLowerCase();
    if (cLower.includes('vietnam') || cLower.includes('việt nam') || cLower === 'vn') {
      // Fall through to VN city classification
    } else {
      return { country: countryFound, sheetGroup: 'Quốc tế' };
    }
  }

  // Vietnamese city keywords
  const hcmKeywords = [
    'hồ chí minh', 'ho chi minh', 'hcm', 'tphcm', 'tp.hcm', 'sài gòn', 'saigon',
    'quận 1', 'quận 2', 'quận 3', 'quận 4', 'quận 5', 'quận 6', 'quận 7', 'quận 8',
    'quận 9', 'quận 10', 'quận 11', 'quận 12', 'bình thạnh', 'tân bình', 'phú nhuận',
    'gò vấp', 'thủ đức', 'bình tân', 'tân phú', 'hóc môn', 'củ chi', 'nhà bè'
  ];
  const hanoiKeywords = [
    'hà nội', 'ha noi', 'hanoi', 'ba đình', 'hoàn kiếm', 'tây hồ', 'long biên',
    'cầu giấy', 'đống đa', 'hai bà trưng', 'hoàng mai', 'thanh xuân', 'nam từ liêm',
    'bắc từ liêm', 'hà đông', 'thanh trì', 'gia lâm', 'đông anh', 'sóc sơn'
  ];
  const danangKeywords = [
    'đà nẵng', 'da nang', 'danang', 'hải châu', 'thanh khê', 'sơn trà',
    'ngũ hành sơn', 'liên chiểu', 'cẩm lệ', 'hòa vần'
  ];

  // International keyword mapping
  const countries = [
    { name: 'India', keywords: ['india', 'ấn độ', 'mumbai', 'delhi', 'maharashtra', 'gujarat', 'pvt ltd', 'bengaluru', 'bangalore', 'chennai', 'hyderabad', 'pune', 'kolkata'] },
    { name: 'China', keywords: ['china', 'trung quốc', 'beijing', 'shanghai', 'shenzhen', 'guangzhou', 'qingdao', 'anhui', 'zhejiang', 'jiangsu', 'shandong', 'fujian', 'liaoning'] },
    { name: 'Japan', keywords: ['japan', 'nhật bản', 'tokyo', 'osaka', 'yokohama', 'chiba', 'nagoya', 'kyoto', 'fukuoka'] },
    { name: 'Korea', keywords: ['korea', 'hàn quốc', 'seoul', 'busan', 'incheon', 'gyeonggi', 'daegu', 'daejeon'] },
    { name: 'Thailand', keywords: ['thailand', 'thái lan', 'bangkok', 'chiang mai', 'pattaya'] },
    { name: 'Taiwan', keywords: ['taiwan', 'đài loan', 'taipei', 'taichung', 'kaohsiung'] },
    { name: 'Singapore', keywords: ['singapore'] },
    { name: 'Germany', keywords: ['germany', 'đức', 'berlin', 'munich', 'frankfurt', 'hamburg', 'cologne', 'düsseldorf', 'gmbh'] },
    { name: 'USA', keywords: ['usa', 'united states', 'mỹ', 'california', 'new york', 'texas', 'illinois', 'florida', 'inc.', 'llc'] },
    { name: 'Malaysia', keywords: ['malaysia', 'kuala lumpur', 'sdn bhd', 'penang', 'johor'] },
    { name: 'Russia', keywords: ['russia', 'nga', 'moscow', 'ooo ', 'cjsc', 'zao '] },
    { name: 'Australia', keywords: ['australia', 'úc', 'sydney', 'melbourne', 'brisbane', 'perth', 'pty ltd'] },
    { name: 'France', keywords: ['france', 'pháp', 'paris', 'lyon', 'marseille', 's.a.s', 'sarl'] },
    { name: 'Italy', keywords: ['italy', 'ý', 'milan', 'rome', 'turin', 's.r.l', 's.p.a'] },
    { name: 'Netherlands', keywords: ['netherlands', 'amsterdam', 'rotterdam', 'b.v.'] },
    { name: 'Indonesia', keywords: ['indonesia', 'jakarta', 'surabaya', 'bandung', 'pt '] },
    { name: 'Philippines', keywords: ['philippines', 'manila', 'cebu', 'davao'] }
  ];

  // Vietnam detection
  const isVNPhone = phone.includes('+84') || /(?:^|\s)(?:0[235789])[0-9]{8}\b/.test(phone);
  const isVNAddr = normAddr.includes('vietnam') || normAddr.includes('việt nam') ||
                   hcmKeywords.some(k => normAddr.includes(k)) ||
                   hanoiKeywords.some(k => normAddr.includes(k)) ||
                   danangKeywords.some(k => normAddr.includes(k));

  if (isVNAddr || isVNPhone) {
    if (hcmKeywords.some(k => normAddr.includes(k))) return { country: 'Vietnam', sheetGroup: 'Hồ Chí Minh' };
    if (hanoiKeywords.some(k => normAddr.includes(k))) return { country: 'Vietnam', sheetGroup: 'Hà Nội' };
    if (danangKeywords.some(k => normAddr.includes(k))) return { country: 'Vietnam', sheetGroup: 'Đà Nẵng' };
    return { country: 'Vietnam', sheetGroup: 'Khác' };
  }

  // International keyword match
  for (const c of countries) {
    if (c.keywords.some(k => normAddr.includes(k))) {
      return { country: c.name, sheetGroup: 'Quốc tế' };
    }
  }

  // ── Fallback: TLD-based country resolution (Step 9)
  if (websiteUrl) {
    const tldCountry = resolveCountryFromTLD(websiteUrl);
    if (tldCountry) {
      if (tldCountry === 'Vietnam') {
        return { country: 'Vietnam', sheetGroup: 'Khác' };
      }
      return { country: tldCountry, sheetGroup: 'Quốc tế' };
    }
  }

  return { country: 'Unknown', sheetGroup: 'Quốc tế' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps 5–8: Crawl website & extract email, phone, address
// ─────────────────────────────────────────────────────────────────────────────
const PRIORITY_PATHS = [
  '', '/contact', '/contact-us', '/contacts',
  '/about', '/about-us', '/company',
  '/en/contact', '/en/about',
  '/vi/contact', '/vi/lien-he',
  '/office', '/locations', '/reach-us'
];

const HTTP_CLIENT = axios.create({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
  },
  maxRedirects: 3
});

async function crawlAndExtract(baseUrl) {
  const rawEmails = new Set();
  const rawPhones = new Set();
  let extractedAddress = '';
  let extractedCountry = '';
  let websiteDetailStatus = 'TIMEOUT';
  let crawledPages = 0;

  for (const pathSuffix of PRIORITY_PATHS) {
    if (crawledPages >= 20) break; // cap at 20 pages

    const pageUrl = pathSuffix ? `${baseUrl}${pathSuffix}` : baseUrl;
    try {
      const response = await HTTP_CLIENT.get(pageUrl);
      crawledPages++;

      const code = response.status;
      // Determine status
      if (code === 200 && crawledPages === 1) websiteDetailStatus = 'LIVE';
      else if ((code === 301 || code === 302) && crawledPages === 1) websiteDetailStatus = '301';

      if (!response.data || typeof response.data !== 'string') continue;

      const $ = cheerio.load(response.data);
      // Remove noise
      $('script, style, noscript, [class*="cookie"], [class*="banner"], [id*="cookie"]').remove();

      // ── Email extraction ──────────────────────────────────────
      // Priority A: mailto links
      $('a[href^="mailto:"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const email = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
        if (email && email.includes('@')) rawEmails.add(email);
      });

      // Priority B: regex from text
      const pageText = $('body').text();
      const emailMatches = pageText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      emailMatches.forEach(e => {
        const lower = e.toLowerCase();
        if (
          !lower.endsWith('.png') && !lower.endsWith('.jpg') && !lower.endsWith('.svg') &&
          !lower.includes('bootstrap') && !lower.includes('w3.org') &&
          !lower.includes('example.com') && !lower.includes('sentry.io') &&
          !lower.includes('schema.org') && !lower.includes('yoursite.') &&
          !lower.includes('domain.com')
        ) {
          rawEmails.add(lower);
        }
      });

      // ── Phone extraction ─────────────────────────────────────
      // Priority A: tel: links
      $('a[href^="tel:"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const phone = href.replace(/^tel:/i, '').trim();
        if (phone) rawPhones.add(normalizePhone(phone));
      });

      // Priority B: regex
      const phoneMatches = pageText.match(
        /(?:\+84|\+91|\+86|\+81|\+82|\+66|\+1|\+44|\+61|\+49|\+33|\+39|\+62|\+60|\+63|\+65|\+7|\+886|0)[\s\-.]?(?:\(?\d{1,4}\)?)[\s\-.]?\d{3,5}[\s\-.]?\d{3,5}(?:[\s\-.]?\d{2,4})?/g
      ) || [];
      phoneMatches.forEach(p => rawPhones.add(normalizePhone(p)));

      // ── Address extraction ────────────────────────────────────
      if (!extractedAddress) {
        // Priority A: schema.org PostalAddress
        $('script[type="application/ld+json"]').each((_, el) => {
          try {
            const json = JSON.parse($(el).html() || '{}');
            const candidates = Array.isArray(json) ? json : (json['@graph'] ? json['@graph'] : [json]);
            for (const item of candidates) {
              const addr = item.address;
              if (!addr) continue;
              if (typeof addr === 'string' && addr.length > 10) {
                extractedAddress = addr;
              } else if (typeof addr === 'object') {
                const parts = [
                  addr.streetAddress, addr.addressLocality,
                  addr.addressRegion, addr.addressCountry
                ].filter(Boolean);
                if (parts.length > 0) extractedAddress = parts.join(', ');
                if (addr.addressCountry) extractedCountry = addr.addressCountry;
              }
              if (extractedAddress) break;
            }
          } catch {}
        });
      }

      if (!extractedAddress) {
        // Priority B: <address> tag or .address class
        const addrEl = $('address, .address, [class*="address"]:not(script), [itemprop="address"]').first();
        const addrText = addrEl.text().replace(/\s+/g, ' ').trim();
        if (addrText.length > 10 && addrText.length < 350) {
          extractedAddress = addrText;
        }
      }

      if (!extractedAddress) {
        // Priority C: keyword search in footer/contact section
        const searchScope = $('footer, .footer, #footer, .contact, #contact, .contact-us, [class*="contact-info"]');
        const scopeText = searchScope.text();
        const lines = (scopeText || pageText).split('\n');
        for (const line of lines) {
          const l = line.trim();
          if (
            /(?:địa chỉ|trụ sở|văn phòng|address|office|head office|factory|location)\s*[:：]/i.test(l) &&
            l.length > 10 && l.length < 300
          ) {
            extractedAddress = l;
            break;
          }
        }
      }

    } catch (err) {
      // HTTPS failed, mark error type
      if (crawledPages === 0) {
        if (err.code === 'ECONNREFUSED') websiteDetailStatus = 'NO_WEBSITE';
        else if (err.code === 'CERT_HAS_EXPIRED' || err.code?.includes('SSL')) websiteDetailStatus = 'SSL_ERROR';
        else if (err.code === 'ECONNABORTED') websiteDetailStatus = 'TIMEOUT';
        else websiteDetailStatus = 'ERROR';
      }
    }

    // Early exit if we have all contact data
    if (rawEmails.size > 0 && rawPhones.size > 0 && extractedAddress) break;
  }

  return { rawEmails, rawPhones, extractedAddress, extractedCountry, websiteDetailStatus, crawledPages };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 11: Verify website is LIVE (with HTTPS→HTTP fallback)
// ─────────────────────────────────────────────────────────────────────────────
async function checkWebsiteReachable(url) {
  // Try HTTPS first
  try {
    const res = await HTTP_CLIENT.get(url, {
      validateStatus: s => s < 600,
      maxRedirects: 5,
      timeout: 8000
    });
    if (res.status < 400) return { reachable: true, finalUrl: url };
  } catch {}

  // Fallback: try HTTP
  const httpUrl = url.replace(/^https:\/\//, 'http://');
  if (httpUrl !== url) {
    try {
      const res = await HTTP_CLIENT.get(httpUrl, {
        validateStatus: s => s < 600,
        maxRedirects: 5,
        timeout: 8000
      });
      if (res.status < 400) return { reachable: true, finalUrl: httpUrl };
    } catch {}
  }

  return { reachable: false, finalUrl: url };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Enrichment Function (upgraded with all 14 steps)
// ─────────────────────────────────────────────────────────────────────────────
export async function enrichSingleCompany(companyItem) {
  const result = {
    ...companyItem,
    websiteNormalized: '',
    websiteStatus: 'Invalid',        // Step 11: LIVE | 301 | SSL_ERROR | TIMEOUT | ERROR | NO_WEBSITE
    websiteSource: 'scraped',        // 'scraped' | 'found-by-search' | 'none'
    email: '',
    emailStatus: '',                 // Step 10: MX_OK | MX_FAIL | INVALID_FORMAT
    phone: '',
    address: '',
    country: 'Unknown',
    sheetGroup: 'Quốc tế'
  };

  // ── Step 2: Normalize website URL ──────────────────────────────────────────
  let norm = normalizeWebsite(companyItem.websiteRaw);
  let primaryUrl = norm.primaryUrl;

  // ── Step 3: Search for website if missing ──────────────────────────────────
  if (!primaryUrl) {
    result.websiteSource = 'none';
    try {
      const searchResult = await resolveWebsiteBySearch({
        company: companyItem.company,
        product: companyItem.product,
        country: companyItem.country
      });
      if (searchResult.websiteFound) {
        primaryUrl = searchResult.websiteFound;
        result.websiteSource = 'found-by-search';
      }
    } catch {}
  }

  if (!primaryUrl) {
    result.websiteStatus = 'NO_WEBSITE';
    const region = classifyRegion('', '', '', '');
    result.country = region.country;
    result.sheetGroup = region.sheetGroup;
    return result;
  }

  result.websiteNormalized = primaryUrl;

  // ── Step 11: Check if website is reachable (HTTPS → HTTP fallback) ─────────
  const reachability = await checkWebsiteReachable(primaryUrl);
  if (!reachability.reachable) {
    result.websiteStatus = 'NO_WEBSITE';
    result.country = 'Unknown';
    return result;
  }
  const finalBaseUrl = reachability.finalUrl;

  // ── Domain Cache check ─────────────────────────────────────────────────────
  const domain = extractDomain(finalBaseUrl);
  const cached = domain ? getCachedDomain(domain) : null;

  if (cached) {
    // Reuse cached enrichment data — only fill contact fields
    result.email = cached.email || '';
    result.emailStatus = cached.emailStatus || '';
    result.phone = cached.phone || '';
    result.address = cached.address || '';
    result.websiteStatus = cached.websiteStatus || 'LIVE';
    const region = classifyRegion(cached.address || '', cached.phone || '', cached.country || '', finalBaseUrl);
    result.country = cached.country || region.country;
    result.sheetGroup = region.sheetGroup;
    return result;
  }

  // ── Steps 5–8: Crawl website and extract contact data ─────────────────────
  const crawlResult = await crawlAndExtract(finalBaseUrl);
  const { rawEmails, rawPhones, extractedAddress, extractedCountry, websiteDetailStatus } = crawlResult;

  result.websiteStatus = websiteDetailStatus;

  // ── Step 6: Filter and prioritize emails ───────────────────────────────────
  const filteredEmails = filterAndPrioritizeEmails(Array.from(rawEmails), 3);

  // ── Step 10: Validate emails (DNS MX check) ───────────────────────────────
  let bestEmail = '';
  let emailStatus = '';
  if (filteredEmails.length > 0) {
    try {
      const validations = await batchValidateEmails(filteredEmails);
      const deliverable = validations.find(v => v.status === 'MX_OK' || v.status === 'DELIVERABLE');
      const anyValid = validations.find(v => v.status !== 'INVALID_FORMAT');
      const chosen = deliverable || anyValid || validations[0];
      if (chosen) {
        bestEmail = chosen.email;
        emailStatus = chosen.status;
      }
    } catch {
      bestEmail = filteredEmails[0] || '';
      emailStatus = 'UNVERIFIED';
    }
  }

  // ── Step 7: Normalize phones ───────────────────────────────────────────────
  const normalizedPhones = Array.from(rawPhones)
    .map(normalizePhone)
    .filter(Boolean)
    .slice(0, 3);

  // ── Step 12: Normalize address ─────────────────────────────────────────────
  const normalizedAddress = normalizeAddress(extractedAddress);

  result.email = bestEmail;
  result.emailStatus = emailStatus;
  result.phone = normalizedPhones.join('; ');
  result.address = normalizedAddress;

  // ── Step 9: Resolve country ────────────────────────────────────────────────
  const regionInfo = classifyRegion(
    normalizedAddress,
    result.phone,
    extractedCountry,
    finalBaseUrl
  );
  result.country = regionInfo.country;
  result.sheetGroup = regionInfo.sheetGroup;

  // ── Save to domain cache ───────────────────────────────────────────────────
  if (domain) {
    setCachedDomain(domain, {
      email: result.email,
      emailStatus: result.emailStatus,
      phone: result.phone,
      address: result.address,
      country: result.country,
      websiteStatus: result.websiteStatus
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Batch Runner with concurrency control
// ─────────────────────────────────────────────────────────────────────────────
export async function runPhase2Enrichment(companies, onProgress = () => {}) {
  const enrichedList = [];
  const CONCURRENCY = 4; // Reduced from 5 to be gentler on rate-limits
  let processed = 0;

  // Stats tracking
  const stats = {
    total: companies.length,
    websiteFromScrape: 0,
    websiteFromSearch: 0,
    noWebsite: 0,
    emailFound: 0,
    phoneFound: 0,
    addressFound: 0,
    countryFound: 0
  };

  onProgress({
    status: 'enriching_start',
    total: companies.length,
    message: `Starting Phase 2 enrichment for ${companies.length} companies (concurrency: ${CONCURRENCY})...`
  });

  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    // Check for stop signal
    if (companies._stopped) break;

    const batch = companies.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(item => enrichSingleCompany(item)));

    enrichedList.push(...results);
    processed += results.length;

    // Update stats
    results.forEach(r => {
      if (r.websiteSource === 'scraped' && r.websiteStatus !== 'NO_WEBSITE') stats.websiteFromScrape++;
      else if (r.websiteSource === 'found-by-search') stats.websiteFromSearch++;
      else stats.noWebsite++;
      if (r.email) stats.emailFound++;
      if (r.phone) stats.phoneFound++;
      if (r.address) stats.addressFound++;
      if (r.country && r.country !== 'Unknown') stats.countryFound++;
    });

    onProgress({
      status: 'enriching_progress',
      processed,
      total: companies.length,
      stats,
      currentBatch: results.map(r => ({
        company: r.company,
        websiteStatus: r.websiteStatus,
        websiteSource: r.websiteSource,
        country: r.country,
        hasEmail: !!r.email,
        hasPhone: !!r.phone
      })),
      message: `Enriched ${processed}/${companies.length} companies`
    });
  }

  // Generate final pipeline report
  const report = generatePipelineReport(enrichedList, stats);

  onProgress({
    status: 'enriching_complete',
    total: enrichedList.length,
    stats,
    report,
    message: `Phase 2 complete! Enriched ${enrichedList.length} companies.`
  });

  return { enrichedList, report };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 14: Final Pipeline Report
// ─────────────────────────────────────────────────────────────────────────────
export function generatePipelineReport(companies, stats = {}) {
  const total = companies.length;
  if (total === 0) return null;

  const websiteFromSearch = companies.filter(c => c.websiteSource === 'found-by-search').length;
  const websiteFromScrape = companies.filter(c => c.websiteSource === 'scraped' && c.websiteStatus !== 'NO_WEBSITE').length;
  const noWebsite = companies.filter(c => c.websiteStatus === 'NO_WEBSITE').length;
  const emailFound = companies.filter(c => c.email).length;
  const phoneFound = companies.filter(c => c.phone).length;
  const addressFound = companies.filter(c => c.address).length;
  const countryFound = companies.filter(c => c.country && c.country !== 'Unknown').length;
  const emailMxOk = companies.filter(c => c.emailStatus === 'MX_OK' || c.emailStatus === 'DELIVERABLE').length;

  const pct = n => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';

  return {
    total,
    websiteFound: websiteFromScrape + websiteFromSearch,
    websiteFromScrape,
    websiteFromSearch,
    noWebsite,
    emailFound,
    emailMxOk,
    phoneFound,
    addressFound,
    countryFound,
    completionRate: pct(countryFound),
    summary: [
      `Total Companies    : ${total}`,
      `Website Found      : ${websiteFromScrape + websiteFromSearch} (${pct(websiteFromScrape + websiteFromSearch)})`,
      `  ├ Direct Scraped : ${websiteFromScrape}`,
      `  └ Found by Search: ${websiteFromSearch}`,
      `No Website         : ${noWebsite} (${pct(noWebsite)})`,
      `Email Found        : ${emailFound} (${pct(emailFound)})`,
      `  └ MX Verified    : ${emailMxOk}`,
      `Phone Found        : ${phoneFound} (${pct(phoneFound)})`,
      `Address Found      : ${addressFound} (${pct(addressFound)})`,
      `Country Found      : ${countryFound} (${pct(countryFound)})`
    ].join('\n')
  };
}
