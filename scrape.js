/**
 * Standalone scraper that fetches Kleinanzeigen ads.
 * Loads categories from the live app's admin API so any changes
 * in the admin panel are automatically picked up.
 * Runs via GitHub Actions cron every 15 minutes.
 */

const cheerio = require('cheerio');

const APP_URL = process.env.APP_URL || 'https://search-console-two.vercel.app';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Kleinanzeigen section mappings (same as in the app)
const SECTIONS = {
  'alle':              { slug: '',                    code: '' },
  'dienstleistungen':  { slug: 's-dienstleistungen',  code: 'c297' },
  'haus-garten':       { slug: 's-haus-garten',       code: 'c80'  },
  'elektronik':        { slug: 's-elektronik',         code: 'c161' },
  'auto-rad-boot':     { slug: 's-autos',             code: 'c216' },
  'immobilien':        { slug: 's-immobilien',         code: 'c195' },
  'jobs':              { slug: 's-jobs',               code: 'c102' },
  'familie-kind-baby': { slug: 's-familie-kind-baby',  code: 'c17'  },
  'freizeit-nachbarschaft': { slug: 's-freizeit-nachbarschaft', code: 'c185' },
  'heimwerken':        { slug: 's-heimwerken',         code: 'c88'  },
  'musik-film-buecher':{ slug: 's-musik-film-buecher', code: 'c73'  },
  'mode-beauty':       { slug: 's-mode-beauty',        code: 'c153' },
  'haustiere':         { slug: 's-haustiere',          code: 'c130' },
  'unterricht-kurse':  { slug: 's-unterricht-kurse',   code: 'c33'  },
  'verschenken':       { slug: 's-zu-verschenken',     code: 'c272' },
};

const SECTION_CATEGORY_CODES = {
  'auto-rad-boot':     ['216','210','223','211','222','224'],
  'immobilien':        ['195','196','197','198','199'],
  'jobs':              ['102','103','104','105','106','107'],
  'haustiere':         ['130','131','132','133','134'],
  'familie-kind-baby': ['17','18','19','20','21','22'],
  'elektronik':        ['161','162','163','164','165','166','167','168'],
  'mode-beauty':       ['153','154','155','156','157'],
  'musik-film-buecher':['73','74','75','76','77'],
  'heimwerken':        ['88','89','90','91'],
  'freizeit-nachbarschaft': ['185','186','187','188'],
  'dienstleistungen':  ['297','298','299','300','301'],
  'haus-garten':       ['80','81','82','83','84','85','86','87'],
  'unterricht-kurse':  ['33','34','35'],
  'verschenken':       ['272'],
};

// Fallback categories if API is unreachable
const FALLBACK_CATEGORIES = [
  {
    id: 'klimaanlagen', name: 'Klimaanlagen',
    keywords: ['Klimaanlage', 'Split Klimaanlage', 'Klimaanlage Montage', 'Klimaanlage Installation'],
    location: '46286', radius: 100,
    kleinanzeigenSection: 'alle', searchType: 'anbieter:privat', offerType: '',
    excludeSections: ['auto-rad-boot', 'immobilien', 'dienstleistungen', 'haus-garten', 'elektronik'],
    excludeTerms: ['Golf', 'Verkauf', 'quick', 'guter Zustand', 'Praktikant', 'Verstärkung', 'Festanstellung'],
    enabled: true,
  }
];

function buildUrl(keyword, location, radius, sectionKey, searchType, offerType) {
  const encoded = encodeURIComponent(keyword);
  const sectionInfo = SECTIONS[sectionKey] || { slug: '', code: '' };
  const parts = ['https://www.kleinanzeigen.de'];
  parts.push(sectionInfo.slug || 's');
  parts.push(location);
  if (searchType) parts.push(searchType);
  if (offerType) parts.push(offerType);
  parts.push(encoded);
  parts.push(`k0${sectionInfo.code}l1758r${radius}`);
  return parts.join('/');
}

function parseAds($, categoryName) {
  const ads = [];
  $('article.aditem').each((_, el) => {
    const $el = $(el);
    if ($el.attr('id')?.includes('altads')) return;

    const titleEl = $el.find('a.ellipsis');
    const title = titleEl.text().trim() || 'Kein Titel';
    const price = $el.find('p.aditem-main--middle--price-shipping--price').text().trim() || '';
    const linkHref = titleEl.attr('href') || '';
    const link = linkHref.startsWith('http') ? linkHref : `https://www.kleinanzeigen.de${linkHref}`;

    const imgEl = $el.find('.aditem-image img, .imagebox img');
    let imageUrl = imgEl.attr('data-src') || imgEl.attr('src') || '';
    if (!imageUrl || imageUrl.includes('placeholder')) {
      const srcset = imgEl.attr('data-srcset') || imgEl.attr('srcset') || '';
      if (srcset) imageUrl = srcset.split(',')[0].trim().split(' ')[0];
    }
    if (!imageUrl) imageUrl = 'https://static.kleinanzeigen.de/static/img/common/logo/logo-kleinanzeigen-horizontal.svg';

    const description = $el.find('.aditem-main--middle--description').text().trim() || '';
    const date = $el.find('.aditem-main--top--right').text().trim() || '';
    const locationText = $el.find('.aditem-main--top--left').text().trim();
    const locationMatch = locationText.match(/(\d{5}\s+[^\(]+)/);
    const location = locationMatch ? locationMatch[1].trim() : '';
    const distanceMatch = locationText.match(/\((\d+)\s*km\)/);
    const distance = distanceMatch ? `${distanceMatch[1]} km` : '';

    ads.push({ title, price, link, imageUrl, description, date, location, distance, category: categoryName, adSection: '' });
  });
  return ads;
}

async function fetchKeyword(keyword, loc, radius, catName, sectionKey, searchType, offerType) {
  const url = buildUrl(keyword, loc, radius, sectionKey, searchType, offerType);
  console.log(`  Fetching: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) { console.error(`  HTTP ${res.status}`); return []; }
    const html = await res.text();
    const $ = cheerio.load(html);
    const ads = parseAds($, catName);
    console.log(`  Found ${ads.length} ads`);
    return ads;
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    return [];
  }
}

async function scrapeCategory(cat) {
  console.log(`Scraping: ${cat.name} (${cat.keywords.length} keywords, ${cat.radius}km)`);
  const promises = cat.keywords.map(kw =>
    fetchKeyword(kw, cat.location, cat.radius, cat.name, cat.kleinanzeigenSection || 'alle', cat.searchType, cat.offerType)
  );
  const results = await Promise.all(promises);
  let allAds = results.flat();

  // Deduplicate
  const seen = new Set();
  allAds = allAds.filter(ad => { if (seen.has(ad.link)) return false; seen.add(ad.link); return true; });

  // Filter by radius
  allAds = allAds.filter(ad => {
    if (!ad.distance) return true;
    const km = parseInt(ad.distance, 10);
    return isNaN(km) || km <= cat.radius;
  });

  // Filter excluded sections by category codes in ad URLs
  if (cat.excludeSections && cat.excludeSections.length > 0) {
    const excludedCodes = cat.excludeSections.flatMap(s => SECTION_CATEGORY_CODES[s] || []);
    if (excludedCodes.length > 0) {
      allAds = allAds.filter(ad => {
        const match = ad.link.match(/\/(\d+)-(\d+)-(\d+)$/);
        return !match || !excludedCodes.includes(match[2]);
      });
    }
  }

  // Filter exclude terms
  if (cat.excludeTerms && cat.excludeTerms.length > 0) {
    const lower = cat.excludeTerms.map(t => t.toLowerCase());
    allAds = allAds.filter(ad => {
      const lt = ad.title.toLowerCase(), ld = ad.description.toLowerCase();
      return !lower.some(t => lt.includes(t) || ld.includes(t));
    });
  }

  console.log(`  Total after filters: ${allAds.length}`);
  return allAds;
}

async function loadCategoriesFromApp() {
  try {
    console.log(`Loading categories from ${APP_URL}/api/admin/categories`);
    const res = await fetch(`${APP_URL}/api/admin/categories`, {
      headers: { 'Authorization': `Bearer ${ADMIN_PASSWORD}` },
    });
    if (!res.ok) {
      console.error(`Admin API returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data.categories && Array.isArray(data.categories)) {
      const enabled = data.categories.filter(c => c.enabled !== false);
      console.log(`Loaded ${enabled.length} enabled categories from app`);
      return enabled;
    }
    return null;
  } catch (err) {
    console.error(`Failed to load from app: ${err.message}`);
    return null;
  }
}

async function saveResults(data) {
  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, 'ads.json');
  fs.writeFileSync(outPath, JSON.stringify(data));
  console.log(`Results saved to ${outPath}`);
}

async function main() {
  // Load categories from the live app (picks up admin changes automatically)
  let categories = await loadCategoriesFromApp();

  if (!categories || categories.length === 0) {
    console.log('Using fallback categories');
    categories = FALLBACK_CATEGORIES;
  }

  const result = { timestamp: new Date().toISOString(), categories: [] };

  for (const cat of categories) {
    const ads = await scrapeCategory(cat);
    result.categories.push({ id: cat.id, name: cat.name, count: ads.length, ads });
  }

  await saveResults(result);
}

main().catch(err => { console.error(err); process.exit(1); });
