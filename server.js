const express = require('express');
const app = express();

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const SECRET = process.env.PROXY_SECRET || '';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/fetch', async (req, res) => {
  // Optional secret check
  if (SECRET && req.headers['x-proxy-secret'] !== SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const url = req.query.url;
  if (!url || !url.startsWith('https://www.kleinanzeigen.de/')) {
    return res.status(400).json({ error: 'Invalid URL - only kleinanzeigen.de allowed' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error: ${response.status}` });
    }

    const html = await response.text();
    res.header('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: 'Proxy fetch failed' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
