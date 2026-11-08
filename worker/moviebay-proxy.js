// moviebay-proxy (Cloudflare Worker)
// Routes: /  (JSON API proxy)   /video  (stream proxy)   /download (legacy)   /dl  (NEW: smart download)
// /dl re-creates the stream link and downloads it in the SAME request, retrying on "ip-mismatch",
// because s-u.in locks each stream link to the IP that created it.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    // Video proxy endpoint
    if (path === '/video' || path === '/video/') {
      return handleVideo(request);
    }

    // Download endpoint (forces attachment)
    if (path === '/download' || path === '/download/') {
      return handleDownload(request);
    }

    // Smart download: mint + download in one request, retry on ip-mismatch
    if (path === '/dl' || path === '/dl/') {
      return handleSmartDownload(request);
    }

    // JSON API proxy
    return handleApi(request);
  }
};

async function handleApi(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');

  if (!target) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const resp = await fetch(target, {
      headers: {
        'Referer': 'https://s-u.in/',
        'Origin': 'https://s-u.in',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Cache-Control': 'public, max-age=300'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

async function handleVideo(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');

  if (!target) {
    return new Response('Missing url parameter', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    const headers = {
      'Referer': 'https://s-u.in/',
      'Origin': 'https://s-u.in',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };

    // Forward Range header for seeking
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      headers['Range'] = rangeHeader;
    }

    const resp = await fetch(target, { headers });

    const respHeaders = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Content-Type': resp.headers.get('Content-Type') || 'video/mp4',
    });

    if (resp.headers.get('Content-Length')) respHeaders.set('Content-Length', resp.headers.get('Content-Length'));
    if (resp.headers.get('Content-Range')) respHeaders.set('Content-Range', resp.headers.get('Content-Range'));
    if (resp.headers.get('Accept-Ranges')) respHeaders.set('Accept-Ranges', resp.headers.get('Accept-Ranges'));

    return new Response(resp.body, {
      status: resp.status,
      headers: respHeaders
    });
  } catch (err) {
    return new Response('Proxy error: ' + err.message, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}

async function handleDownload(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  const name = url.searchParams.get('name') || 'video.mp4';

  if (!target) {
    return new Response('Missing url parameter', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    const resp = await fetch(target, {
      headers: {
        'Referer': 'https://s-u.in/',
        'Origin': 'https://s-u.in',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      }
    });

    const safeName = name.replace(/[^a-zA-Z0-9._\- ]/g, '_');

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': resp.headers.get('Content-Type') || 'video/mp4',
        'Content-Disposition': 'attachment; filename="' + safeName + '"',
        'Content-Length': resp.headers.get('Content-Length') || '',
      }
    });
  } catch (err) {
    return new Response('Download error: ' + err.message, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}

// ---------------------------------------------------------------
// Smart download
//   /dl?api=<s-u.in stream .json url>&vj=<vj name>&sig=<stream name>&name=<file name>
// ---------------------------------------------------------------
function jsonErr(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function bestMp4Url(s) {
  const strip = (u) => String(u || '').replace(/[?&]download=\d+/gi, '').replace(/\?$/, '').replace(/\?&/, '?');
  const ok = (u) => u && u.indexOf('.m3u8') === -1 && u.indexOf('/stream/hls/') === -1;
  for (const k of ['downloadUrl', 'fallbackUrl', 'url']) {
    if (s && s[k]) { const u = strip(s[k]); if (ok(u)) return u; }
  }
  return null;
}

function vjOf(s) {
  const direct = s.vj || s.vjName || s.translator;
  if (direct && String(direct).trim()) return String(direct).trim().toLowerCase();
  const n = String(s.name || s.title || s.sourceName || '');
  return n.split(/\s*(?:\||\s-\s|\s:\s)\s*/)[0].trim().toLowerCase();
}

function pickStream(streams, vj, sig) {
  const usable = streams.filter((s) => bestMp4Url(s));
  if (!usable.length) return null;
  if (sig) { const m = usable.find((s) => String(s.name || s.title || '') === sig); if (m) return m; }
  if (vj) { const m = usable.find((s) => vjOf(s) === vj); if (m) return m; }
  return usable[0];
}

async function handleSmartDownload(request) {
  const url = new URL(request.url);
  const api = url.searchParams.get('api');
  const vj = (url.searchParams.get('vj') || '').trim().toLowerCase();
  const sig = (url.searchParams.get('sig') || '').trim();
  const safeName = (url.searchParams.get('name') || 'video.mp4').replace(/[^a-zA-Z0-9._\- ]/g, '_');

  if (!api || !/^https:\/\/s-u\.in\//.test(api)) {
    return jsonErr(400, { ok: false, error: 'Missing or invalid api parameter' });
  }

  const base = { 'Referer': 'https://s-u.in/', 'Origin': 'https://s-u.in', 'User-Agent': UA };
  let lastErr = 'unknown error';
  const MAX_ATTEMPTS = 6;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 1) mint a fresh stream link (bound to the IP of THIS request)
      const apiResp = await fetch(api, { headers: { ...base, 'Accept': 'application/json, text/plain, */*', 'Cache-Control': 'no-cache' } });
      const data = await apiResp.json();
      const stream = pickStream((data && data.streams) || [], vj, sig);
      const fileUrl = stream && bestMp4Url(stream);
      if (!fileUrl) { lastErr = 'No downloadable (non-HLS) stream found'; break; }

      // 2) download it straight away
      const resp = await fetch(fileUrl, { headers: { ...base, 'Accept': '*/*' } });
      if (resp.status === 200 || resp.status === 206) {
        const h = new Headers({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition',
          'Content-Type': resp.headers.get('Content-Type') || 'video/mp4',
          'Content-Disposition': 'attachment; filename="' + safeName + '"',
        });
        if (resp.headers.get('Content-Length')) h.set('Content-Length', resp.headers.get('Content-Length'));
        return new Response(resp.body, { status: 200, headers: h });
      }

      const text = (await resp.text()).slice(0, 200);
      lastErr = text || ('upstream status ' + resp.status);
      if (!/ip-mismatch/i.test(text)) break;   // a different failure: retrying will not help
    } catch (err) {
      lastErr = err.message;
    }
  }

  return jsonErr(502, { ok: false, error: lastErr, attempts: MAX_ATTEMPTS });
}
