const BASE_URL = 'https://pro.vidify.top';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36', 'Referer': BASE_URL + '/' };
const PLAYER_DOMAINS = { '{v1}': 'neonhorizonworkshops.com', '{v2}': 'wanderlynest.com', '{v3}': 'orchidpixelgardens.com', '{v4}': 'cloudnestra.com' };
const PROXY_HEADERS = { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://cloudnestra.com/', 'Origin': 'https://cloudnestra.com', 'Accept': '*/*' };
const STEP_TIMEOUT_MS = 7000;

function makeAbort(ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    return { signal: c.signal, clear: () => clearTimeout(t) };
}

async function fetchHtml(url, extraHeaders = {}, outerSignal = null) {
    if (url.startsWith('//')) url = 'https:' + url;
    const { signal, clear } = makeAbort(STEP_TIMEOUT_MS);
    const combined = outerSignal ? AbortSignal.any([outerSignal, signal]) : signal;
    try {
        const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, signal: combined, redirect: 'follow' });
        if (!res || res.status !== 200) throw new Error(`HTTP ${res?.status ?? 'null'}`);
        return await res.text();
    } finally { clear(); }
}

function extractDataServerB64(html) { return html.match(/data-server=["']([A-Za-z0-9+/=\-]+)["']/i)?.[1] ?? null; }
function extractProrcp(html) { return html.match(/src:\s*['"]([^'"]*\/prorcp\/[^'"]+)['"]/i)?.[1] ?? null; }
function rcpToProrcp(rcpUrl) { return rcpUrl.replace('/rcp/', '/prorcp/'); }

function extractM3u8Urls(html) {
    const fileField = html.match(/file\s*:\s*["']([^"']+)["']/i)?.[1];
    if (!fileField) return null;
    const urls = fileField.split(/\s+or\s+/i).map(template => {
        let url = template;
        for (const [placeholder, domain] of Object.entries(PLAYER_DOMAINS)) url = url.replace(placeholder, domain);
        return (url.includes('{') || url.includes('}')) ? null : url;
    }).filter(Boolean);
    return urls.length ? urls : null;
}

export async function getStream({ id, s, e }) {
    const controller = new AbortController();
    const { signal } = controller;
    try {
        const pageUrl = s ? `${BASE_URL}/embed/tv/${id}/${s}/${e}` : `${BASE_URL}/embed/movie/${id}`;
        let html1;
        try { html1 = await fetchHtml(pageUrl, {}, signal); } catch { return null; }
        const b64 = extractDataServerB64(html1);
        if (!b64) return null;
        let rcpUrl;
        try { rcpUrl = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { return null; }
        if (!rcpUrl.startsWith('http')) return null;
        let html2;
        try { html2 = await fetchHtml(rcpUrl, { 'Referer': 'https://cloudnestra.com/' }, signal); } catch { return null; }
        let prorcp = extractProrcp(html2);
        let playerUrl;
        if (prorcp) {
            const base = rcpUrl.slice(0, rcpUrl.indexOf('/', rcpUrl.indexOf('//') + 2));
            playerUrl = prorcp.startsWith('http') ? prorcp : base + prorcp;
        } else playerUrl = rcpToProrcp(rcpUrl);
        let html3;
        try { html3 = await fetchHtml(playerUrl, { 'Referer': rcpUrl }, signal); } catch { return null; }
        const urls = extractM3u8Urls(html3);
        if (!urls?.length) return null;
        return { url: urls[0], headers: PROXY_HEADERS, allUrls: urls.map(u => ({ url: u, headers: PROXY_HEADERS })) };
    } finally { controller.abort(); }
}