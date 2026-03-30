export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  const secret = req.headers.get('x-proxy-secret') || '';
  const expectedSecret = process.env.PROXY_SECRET || '';

  if (expectedSecret && secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
  }

  if (!url || !url.startsWith('https://www.kleinanzeigen.de/')) {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), { status: 400 });
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
      return new Response(JSON.stringify({ error: `Upstream: ${response.status}` }), { status: response.status });
    }

    const html = await response.text();
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy fetch failed' }), { status: 500 });
  }
}
