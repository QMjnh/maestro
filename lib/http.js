const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function fetchText(url, { headers = {}, timeout = 12000, ...opts } = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${new URL(url).host} responded ${res.status}`);
    err.status = res.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  return text;
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

/** Pull an embedded JSON blob (e.g. `var ytInitialData = {...};`) out of an HTML page. */
function extractJson(html, re) {
  const m = html.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Depth-first search for every object stored under `key`. */
function findAll(obj, key, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out);
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k]);
    else findAll(obj[k], key, out);
  }
  return out;
}

/** "1:02:03" / "3:45" -> milliseconds */
function clockToMs(str) {
  if (!str) return null;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

module.exports = { UA, fetchText, fetchJson, extractJson, findAll, clockToMs };
