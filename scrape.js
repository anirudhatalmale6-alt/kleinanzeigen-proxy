/**
 * Standalone scraper that fetches Kleinanzeigen ads and updates a GitHub Gist.
 * Runs via GitHub Actions cron every 15 minutes.
 */

const cheerio = require('cheerio');

const CATEGORIES = [
  {
    id: 'klimaanlagen',
    name: 'Klimaanlagen',
    keywords: ['Klimaanlage', 'Split Klimaanlage', 'Klimaanlage Montage', 'Klimaanlage Installation'],
    location: '46286',
    radius: 50,
    section: '',
    sectionCode: '',
    searchType: 'anbieter:privat',
    offerType: 'anzeige:gesuche',
    excludeSections: { 'auto-rad-boot': ['216','210','223','211','222','224'] },
    excludeTerms: ['Praktikant', 'Verstärkung', 'Festanstellung'],
  }
];

function buildUrl(keyword, location, radius, section, sectionCode, searchType, offerType) {
  const encoded = encodeURIComponent(keyword);
  const parts = ['https://www.kleinanzeigen.de'];
  parts.push(section || 's');
  parts.push(location);
  if (searchType) parts.push(searchType);
  if (offerType) parts.push(offerType);
  parts.push(encoded);
  parts.push(`k0${sectionCode}l1758r${radius}`);
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

async function fetchKeyword(keyword, loc, radius, catName, section, sectionCode, searchType, offerType) {
  const url = buildUrl(keyword, loc, radius, section, sectionCode, searchType, offerType);
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
  console.log(`Scraping: ${cat.name}`);
  const promises = cat.keywords.map(kw =>
    fetchKeyword(kw, cat.location, cat.radius, cat.name, cat.section, cat.sectionCode, cat.searchType, cat.offerType)
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

  // Filter excluded sections
  const excludedCodes = Object.values(cat.excludeSections).flat();
  if (excludedCodes.length > 0) {
    allAds = allAds.filter(ad => {
      const match = ad.link.match(/\/(\d+)-(\d+)-(\d+)$/);
      return !match || !excludedCodes.includes(match[2]);
    });
  }

  // Filter exclude terms
  if (cat.excludeTerms.length > 0) {
    const lower = cat.excludeTerms.map(t => t.toLowerCase());
    allAds = allAds.filter(ad => {
      const lt = ad.title.toLowerCase(), ld = ad.description.toLowerCase();
      return !lower.some(t => lt.includes(t) || ld.includes(t));
    });
  }

  console.log(`  Total after filters: ${allAds.length}`);
  return allAds;
}

async function saveResults(data) {
  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, 'ads.json');
  fs.writeFileSync(outPath, JSON.stringify(data));
  console.log(`Results saved to ${outPath}`);
}

async function main() {
  // Also load categories from Redis if REDIS_URL is set
  let categories = CATEGORIES;

  // Try to load custom categories from Redis
  if (process.env.REDIS_URL) {
    try {
      const Redis = require('ioredis');
      const redis = new Redis(process.env.REDIS_URL, { connectTimeout: 5000, commandTimeout: 5000 });
      const raw = await redis.get('kleinanzeigen:categories');
      redis.disconnect();
      if (raw) {
        const stored = JSON.parse(raw);
        if (Array.isArray(stored) && stored.length > 0) {
          categories = stored.filter(c => c.enabled !== false).map(c => ({
            id: c.id,
            name: c.name,
            keywords: c.keywords,
            location: c.location || '46286',
            radius: c.radius || 50,
            section: '',
            sectionCode: '',
            searchType: c.searchType || '',
            offerType: c.offerType || '',
            excludeSections: {},
            excludeTerms: c.excludeTerms || [],
          }));
          console.log(`Loaded ${categories.length} categories from Redis`);
        }
      }
    } catch (err) {
      console.error('Redis load failed, using defaults:', err.message);
    }
  }

  const result = { timestamp: new Date().toISOString(), categories: [] };

  for (const cat of categories) {
    const ads = await scrapeCategory(cat);
    result.categories.push({ id: cat.id, name: cat.name, count: ads.length, ads });
  }

  await saveResults(result);
}

main().catch(err => { console.error(err); process.exit(1); });
