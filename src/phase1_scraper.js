import { chromium } from 'playwright';
import axios from 'axios';
import * as cheerio from 'cheerio';

const NAV_BLACKLIST = [
  'trang chủ', 'giới thiệu', 'giới thiệu chung', 'thông tin chung',
  'triển lãm', 'sơ đồ triển lãm', 'tài liệu triển lãm', 'tài liệu hướng dẫn',
  'chi phí mua gian hàng', 'đăng ký gian hàng', 'tham quan',
  'danh sách các nhà triển lãm', 'ngành hàng trưng bày', 'e-catalogue',
  'thông tin khách sạn', 'danh sách b2b', 'đăng ký tham quan', 'thư viện',
  'báo chí', 'thông cáo báo chí', 'tin tức báo chí', 'tin tức', 'liên hệ',
  'tiếng việt', 'english', 'đơn vị tổ chức', 'đối tác', 'bảo trợ thông tin',
  'vietdrink', 'show report', 'chương trình triển lãm',
  'home', 'about', 'about us', 'contact', 'contact us', 'news', 'press',
  'floor plan', 'exhibitors', 'exhibitor list', 'register', 'privacy policy', 'terms'
];

const SPONSOR_DOMAINS_BLACKLIST = [
  'vinexad.com.vn', 'vafost.org.vn', 'vba.com.vn', 'ffa.com.vn', 'lzlchinafood.com',
  'asiatradehub.com', 'made-in-china.com', '21food.com', 'polandfruits.pl', 'allma.net',
  'asiapackage.com.tw', 'fnbvietnam.vn', 'interpack-cn.com', 'foodexvietnam.com',
  'vietofficexpo.com.vn', 'medipharmexpo.com', 'vietnamcycle.vn', 'sportshow.com.vn',
  'hardwaretools.com.vn', 'gardenexpo.com.vn', 'ieae.com.vn', 'vilog.vn',
  'elevatorexpo.vn', 'vietnamexpo.com.vn', 'ighe.com.vn', 'ibte.com.vn',
  'virecexpo.com.vn', 'online.gov.vn', 'masanconsumer.com', 'adlnk.cn',
  'facebook.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'zalo.me', 'zalo.vn'
];

function isNavOrMenu(text) {
  if (!text || typeof text !== 'string') return true;
  const clean = text.trim().toLowerCase();

  if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('www.')) {
    return true;
  }
  if (clean.length < 2 || clean.length > 200) return true;

  return NAV_BLACKLIST.some(keyword => clean === keyword || clean.includes(keyword));
}

function isBlacklistedDomain(urlStr, originDomain) {
  if (!urlStr || typeof urlStr !== 'string') return true;
  const lower = urlStr.toLowerCase();

  if (originDomain && lower.includes(originDomain.toLowerCase())) return true;

  return SPONSOR_DOMAINS_BLACKLIST.some(domain => lower.includes(domain));
}

/**
 * Fetch exhibitor detail page if website wasn't directly found on list card
 */
async function fetchExhibitorDetail(detailUrl, originDomain) {
  const detailData = {
    company: '',
    product: '',
    booth: '',
    websiteRaw: ''
  };

  if (!detailUrl) return detailData;

  try {
    const res = await axios.get(detailUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!res.data || typeof res.data !== 'string') return detailData;

    const $ = cheerio.load(res.data);
    $('footer, header, nav, .footer, .header, .nav, .sidebar, .partner-section, .sponsor-section').remove();

    const bodyText = $('body').text();

    const pageTitle = $('h1, h2.title, .company-name, .exhibitor-title').first().text().trim();
    if (pageTitle && !isNavOrMenu(pageTitle)) {
      detailData.company = pageTitle;
    }

    const boothMatch = bodyText.match(/(?:gian hàng|booth|stand|hall)\s*[:#]?\s*([A-Za-z0-9\-]+)/i);
    if (boothMatch) {
      detailData.booth = boothMatch[1].trim();
    }

    const productEl = $('.product, .category, [class*="product"], [class*="category"]').first();
    if (productEl.length) {
      detailData.product = productEl.text().trim();
    }

    const websitesFound = new Set();
    $('*').each((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      if ((text.startsWith('website') || text.startsWith('trang web') || text.startsWith('web:')) && text.length < 80) {
        const parent = $(el).parent();
        const link = parent.find('a[href^="http"], a[href^="www."]').first().attr('href') ||
                     parent.next().find('a[href^="http"], a[href^="www."]').first().attr('href');
        
        if (link && !isBlacklistedDomain(link, originDomain)) {
          websitesFound.add(link);
        }
      }
    });

    if (websitesFound.size === 0) {
      const scope = $('.entry-content, main, article, .detail-content, .info-box').first();
      const targetScope = scope.length ? scope : $('body');
      targetScope.find('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if ((href.startsWith('http') || href.startsWith('www.')) && !isBlacklistedDomain(href, originDomain)) {
          websitesFound.add(href);
        }
      });
    }

    detailData.websiteRaw = Array.from(websitesFound).join('; ');
  } catch (err) {}

  return detailData;
}

export async function runPhase1Scraper(targetUrl, options = {}, onProgress = () => {}) {
  const maxPages = options.maxPages || 50;
  const isHeadless = options.headless !== false;
  let browser = null;
  const collectedCompanies = [];

  let originDomain = '';
  try {
    originDomain = new URL(targetUrl).hostname.replace('www.', '');
  } catch {}

  try {
    onProgress({ status: 'starting', message: `Initializing browser engine...` });
    browser = await chromium.launch({
      headless: isHeadless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });

    const page = await context.newPage();

    onProgress({ status: 'navigating', message: `Opening target URL: ${targetUrl}` });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    let pageNum = 1;
    let hasNext = true;

    while (hasNext && pageNum <= maxPages) {
      if (options.shouldStop?.()) {
        onProgress({ status: 'stopped', message: 'User requested stop during Phase 1.' });
        break;
      }

      onProgress({ status: 'parsing', page: pageNum, message: `Parsing exhibitor list on page ${pageNum}...` });

      // Step 1: Extract cards using user's explicit selector .gh-type-list-item and fallback card selectors
      const candidateList = await page.evaluate(({ originDomain }) => {
        const items = [];
        const NAV_KEYWORDS = [
          'trang chủ', 'giới thiệu', 'thông tin chung', 'triển lãm', 'sơ đồ',
          'tài liệu', 'chi phí', 'đăng ký', 'tham quan', 'danh sách', 'ngành hàng',
          'catalogue', 'khách sạn', 'b2b', 'thư viện', 'báo chí', 'liên hệ',
          'tiếng việt', 'english', 'đơn vị tổ chức', 'đối tác', 'bảo trợ'
        ];

        function isNav(txt) {
          if (!txt) return true;
          const clean = txt.trim().toLowerCase();
          if (clean.length < 2 || clean.length > 150) return true;
          if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('www.')) return true;
          return NAV_KEYWORDS.some(k => clean.includes(k));
        }

        const selectors = [
          '.gh-type-list-item', '.exhibitor-item', '.exhibitor-card',
          '.company-card', '.list-item', '.exhibitor', '.company-item', 'tr', 'article', '.gian-hang'
        ];

        let elements = [];
        for (const sel of selectors) {
          const found = Array.from(document.querySelectorAll(sel));
          if (found.length >= 1) {
            elements = found;
            break;
          }
        }

        if (elements.length === 0) {
          elements = Array.from(document.querySelectorAll('a[href*="/exhibitor/"], a[href*="/gian-hang/"], a[href*="/company/"]'));
        }

        elements.forEach(el => {
          let company = '';
          let product = '';
          let booth = '';
          let websiteRaw = '';
          let detailUrl = '';

          // 1. Extract Company Name
          const titleEl = el.querySelector('.gh-type-list-item--title, h1, h2, h3, h4, h5, .title, .name, strong') || el.querySelector('a');
          company = titleEl ? titleEl.innerText.trim() : '';

          // 2. Extract Product
          const prodEl = el.querySelector('.gh-type-list-item--category, .product, .category, .desc');
          product = prodEl ? prodEl.innerText.trim() : '';

          // 3. Extract Booth
          const boothEl = el.querySelector('.gh-type-list-item--booth, .booth, .stand');
          booth = boothEl ? boothEl.innerText.trim() : '';
          if (!booth) {
            const boothMatch = el.innerText.match(/(?:booth|gian hàng|stand|hall)\s*[:#]?\s*([A-Za-z0-9\-]+)/i);
            if (boothMatch) booth = boothMatch[1];
          }

          // 4. Extract Website using user's explicit selector: .gh-type-list-item--link a
          const webNode = el.querySelector('.gh-type-list-item--link a, .website a, [class*="website"] a, a[target="_blank"][href^="http"]');
          if (webNode) {
            websiteRaw = webNode.getAttribute('href') || webNode.innerText.trim() || '';
          }

          // Filter out exhibition domain
          if (websiteRaw && originDomain && websiteRaw.toLowerCase().includes(originDomain.toLowerCase())) {
            websiteRaw = '';
          }

          // 5. Extract Detail URL
          const detailNode = el.querySelector('a[href*="/exhibitor/"], a[href*="/gian-hang/"], a[href*="/company/"]') || el.querySelector('a');
          detailUrl = detailNode ? detailNode.href : '';

          if (company && !isNav(company)) {
            items.push({ company, product, booth, websiteRaw, detailUrl });
          }
        });

        return items;
      }, { originDomain });

      let addedThisPage = 0;
      for (const item of candidateList) {
        if (options.shouldStop?.()) break;

        if (item.company && !collectedCompanies.some(c => c.company.toLowerCase() === item.company.toLowerCase())) {
          let finalWebsite = item.websiteRaw;
          let finalProduct = item.product;
          let finalBooth = item.booth;

          // If website was missing on list card, fetch detail page
          if (!finalWebsite && item.detailUrl) {
            onProgress({
              status: 'fetching_detail',
              page: pageNum,
              message: `Fetching detail page for: ${item.company}...`
            });
            const detail = await fetchExhibitorDetail(item.detailUrl, originDomain);
            if (detail.websiteRaw) finalWebsite = detail.websiteRaw;
            if (detail.product) finalProduct = detail.product;
            if (detail.booth) finalBooth = detail.booth;
          }

          collectedCompanies.push({
            id: collectedCompanies.length + 1,
            company: item.company,
            detailUrl: item.detailUrl || '',
            product: finalProduct || '',
            booth: finalBooth || '',
            websiteRaw: finalWebsite || '',
            pageScraped: pageNum
          });
          addedThisPage++;
        }
      }

      onProgress({
        status: 'page_complete',
        page: pageNum,
        newFound: addedThisPage,
        totalFound: collectedCompanies.length,
        message: `Page ${pageNum} complete: found ${addedThisPage} valid exhibitors (Total: ${collectedCompanies.length})`
      });

      // Check for Next button
      const nextButton = await page.evaluateHandle(() => {
        const candidateSelectors = [
          'a[rel="next"]', 'link[rel="next"]', '.pagination .next a',
          '.page-next', 'a.next', 'button.next', 'li.next a', '[aria-label="Next"]'
        ];

        for (const sel of candidateSelectors) {
          const el = document.querySelector(sel);
          if (el && !el.classList.contains('disabled') && el.getAttribute('aria-disabled') !== 'true') {
            return el;
          }
        }

        const clickables = Array.from(document.querySelectorAll('a, button, span.page-link'));
        for (const el of clickables) {
          const txt = (el.innerText || '').trim().toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

          if (
            txt === 'next' || txt === 'trang sau' || txt === 'kế tiếp' || txt === '»' || txt === '>' ||
            txt.includes('next page') || title.includes('next') || ariaLabel.includes('next')
          ) {
            const isDisabled = el.classList.contains('disabled') || 
                               el.getAttribute('disabled') !== null || 
                               el.getAttribute('aria-disabled') === 'true' ||
                               el.parentElement?.classList.contains('disabled');
            if (!isDisabled) return el;
          }
        }

        return null;
      });

      const hasNextElement = await nextButton.asElement();

      if (hasNextElement) {
        try {
          onProgress({ status: 'clicking_next', page: pageNum, message: `Clicking Next button for page ${pageNum + 1}...` });
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
            hasNextElement.click()
          ]);
          await page.waitForTimeout(2000);
          pageNum++;
        } catch (err) {
          onProgress({ status: 'next_failed', message: `Could not navigate to next page: ${err.message}. Stopping pagination.` });
          hasNext = false;
        }
      } else {
        onProgress({ status: 'no_next', message: `No active Next button found on page ${pageNum}. Phase 1 complete.` });
        hasNext = false;
      }
    }

    onProgress({
      status: 'complete',
      totalCount: collectedCompanies.length,
      message: `Phase 1 completed successfully! Total valid exhibitors collected: ${collectedCompanies.length}`
    });

    return collectedCompanies;
  } catch (err) {
    onProgress({ status: 'error', message: `Phase 1 error: ${err.message}` });
    throw err;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
