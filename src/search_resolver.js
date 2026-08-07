import axios from 'axios';
import * as cheerio from 'cheerio';
import { pickBestWebsite, scoreWebsite } from './website_scorer.js';

/**
 * Build multiple search query variants for a company.
 * @param {string} companyName
 * @param {object} hints - { product?, country? }
 * @returns {string[]} Array of queries to try in order
 */
function buildQueries(companyName, hints = {}) {
  const base = companyName.trim();
  const queries = [`"${base}" official website`];

  if (hints.product) {
    queries.push(`"${base}" ${hints.product} manufacturer`);
  }
  if (hints.country) {
    queries.push(`"${base}" ${hints.country}`);
  }
  queries.push(`"${base}" company`);
  queries.push(base); // broad fallback

  return queries;
}

/**
 * Search DuckDuckGo HTML and extract top result URLs.
 * DuckDuckGo does not require an API key.
 *
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<string[]>}
 */
async function searchDuckDuckGo(query, maxResults = 5) {
  const urls = [];
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await axios.get(searchUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    const $ = cheerio.load(res.data);

    // DuckDuckGo HTML result links are in .result__url or .result__a
    $('.result__url, .result__a').each((_, el) => {
      if (urls.length >= maxResults) return false;
      let href = $(el).attr('href') || $(el).text().trim();

      // DDG wraps links with a redirect — extract the real URL
      if (href.includes('uddg=')) {
        try {
          const u = new URL('https://html.duckduckgo.com' + href);
          href = decodeURIComponent(u.searchParams.get('uddg') || href);
        } catch {}
      }

      // Normalize to root domain
      try {
        const parsed = new URL(href.startsWith('http') ? href : 'https://' + href);
        const rootUrl = `${parsed.protocol}//${parsed.hostname}`;
        if (!urls.includes(rootUrl)) {
          urls.push(rootUrl);
        }
      } catch {}
    });
  } catch (err) {
    // Silently fail — caller handles fallback
  }

  return urls;
}

/**
 * Try Bing HTML search as a fallback when DuckDuckGo returns nothing.
 *
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<string[]>}
 */
async function searchBingFallback(query, maxResults = 5) {
  const urls = [];
  try {
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const res = await axios.get(searchUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    const $ = cheerio.load(res.data);

    $('li.b_algo h2 a, .b_algo .b_title a').each((_, el) => {
      if (urls.length >= maxResults) return false;
      const href = $(el).attr('href') || '';
      if (href.startsWith('http')) {
        try {
          const parsed = new URL(href);
          const rootUrl = `${parsed.protocol}//${parsed.hostname}`;
          if (!urls.includes(rootUrl)) {
            urls.push(rootUrl);
          }
        } catch {}
      }
    });
  } catch {}

  return urls;
}

/**
 * Main Search Resolver.
 *
 * Given a company with no website, search online and find the best official website.
 *
 * @param {object} company - { company, product?, country? }
 * @returns {Promise<{ websiteFound: string | null, searchSource: string }>}
 */
export async function resolveWebsiteBySearch(company) {
  const { company: name, product, country } = company;

  if (!name || name.length < 2) {
    return { websiteFound: null, searchSource: 'none' };
  }

  const queries = buildQueries(name, { product, country });

  for (const query of queries) {
    // Try DuckDuckGo first
    let candidates = await searchDuckDuckGo(query, 5);

    // If DDG returned nothing, try Bing
    if (candidates.length === 0) {
      candidates = await searchBingFallback(query, 5);
    }

    if (candidates.length > 0) {
      const best = await pickBestWebsite(candidates, name);
      if (best) {
        return {
          websiteFound: best,
          searchSource: 'search-engine',
          searchQuery: query,
          candidatesEvaluated: candidates.length
        };
      }
    }

    // Small delay between queries to avoid rate-limiting
    await new Promise(r => setTimeout(r, 800));
  }

  return { websiteFound: null, searchSource: 'none' };
}
