import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('./data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'domain_cache.json');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// In-memory cache Map<domain, enrichedContactData>
const memoryCache = new Map();

// Load persisted cache from disk on startup
function loadFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      for (const [domain, data] of Object.entries(parsed)) {
        memoryCache.set(domain, data);
      }
      console.log(`[DomainCache] Loaded ${memoryCache.size} cached domains from disk.`);
    }
  } catch (err) {
    console.warn(`[DomainCache] Could not load cache: ${err.message}`);
  }
}

// Persist cache to disk
function saveToDisk() {
  try {
    const obj = {};
    for (const [domain, data] of memoryCache.entries()) {
      obj[domain] = data;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[DomainCache] Could not save cache: ${err.message}`);
  }
}

/**
 * Extract root domain from a URL string
 * e.g. "https://www.abc.com/about" -> "abc.com"
 */
export function extractDomain(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check if a domain has cached enrichment data
 */
export function getCachedDomain(domain) {
  if (!domain) return null;
  return memoryCache.get(domain) || null;
}

/**
 * Store enrichment result for a domain
 * @param {string} domain - root domain (e.g. "abc.com")
 * @param {object} data - { email, phone, address, country, websiteStatus, emailStatus }
 */
export function setCachedDomain(domain, data) {
  if (!domain) return;
  memoryCache.set(domain, { ...data, cachedAt: new Date().toISOString() });
  // Debounced disk save (save after each set but don't block)
  setImmediate(saveToDisk);
}

/**
 * Clear all cached domains (for maintenance)
 */
export function clearCache() {
  memoryCache.clear();
  try {
    if (fs.existsSync(CACHE_FILE)) {
      fs.unlinkSync(CACHE_FILE);
    }
  } catch {}
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    totalCachedDomains: memoryCache.size,
    cacheFile: CACHE_FILE
  };
}

// Initialize: load persisted cache on module import
loadFromDisk();
