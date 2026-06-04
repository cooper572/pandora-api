import { getTmdbInfo } from '../utils/helpers.js';
const BASE_URL = 'https://www.fsonic.net';
const FSHARE_BASE = 'https://fsharetv.co';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

function pickBestUrls(json) {
    const allGroups = [];
    const sources = json.data?.file?.sources ?? [];
    if (sources.length) allGroups.push(sources);
    const alternatives = json.data?.file?.alternatives ?? [];
    for (const group of alternatives) { if (group?.length) allGroups.push(group); }
    const urls = [];
    for (const group of allGroups) {
        const sorted = [...group].filter(s => s?.src).sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
        if (sorted.length) {
            const best = sorted[0];
            const src = best.src;
            urls.push(src.startsWith('http') ? src : `${FSHARE_BASE}${src}`);
        }
    }
    return [...new Set(urls)];
}

async function findWatchSlug(title, year) {
    try {
        const query = encodeURIComponent(title);
        const res = await fetch(`${BASE_URL}/movie/search/${query}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const html = await res.text();
        const matches = [...html.matchAll(/href="(\/watch\/[^"]+)"/g)];
        if (!matches.length) return null;
        const yearStr = String(year);
        for (const m of matches) { if (m[1].includes(yearStr)) return m[1]; }
        return matches[0][1];
    } catch { return null; }
}

async function extractInitParams(watchSlug) {
    try {
        const res = await fetch(`${BASE_URL}${watchSlug}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const html = await res.text();
        let match = html.match(/ng-init="init\('([^']+)',\s*'[^']*',\s*'([^']+)'/);
        if (!match) match = html.match(/ng-init="init\('([^']+)',\s*'([^']+)'/);
        if (!match) {
            const tokenMatch = html.match(/init\('([^']+)'/);
            const trailerMatch = html.match(/trailer['":\s]+['"]([^'"]+)['"]/);
            if (tokenMatch && trailerMatch) return { token: tokenMatch[1], trailer: trailerMatch[1] };
            return null;
        }
        return { token: match[1], trailer: match[2] };
    } catch { return null; }
}

export async function getStream({ id, s }) {
    if (s != null) return null;
    try {
        const info = await getTmdbInfo(id, 'movie');
        const titles = info.titles || [];
        if (!titles.length) return null;
        let watchSlug = null;
        for (const title of titles) {
            watchSlug = await findWatchSlug(title, info.year);
            if (watchSlug) break;
        }
        if (!watchSlug) return null;
        const params = await extractInitParams(watchSlug);
        if (!params) return null;
        const apiUrl = `${BASE_URL}/api/source/${params.token}?trailer=${params.trailer}&type=watch`;
        const res = await fetch(apiUrl, { headers: { ...HEADERS, 'Accept': 'application/json, text/plain, */*', 'Referer': `${BASE_URL}${watchSlug}` }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const json = await res.json();
        if (json.status !== 'ok') return null;
        const urls = pickBestUrls(json);
        if (!urls.length) return null;
        const refererHeaders = { ...HEADERS, 'Referer': `${FSHARE_BASE}/` };
        return { allUrls: urls.map(url => ({ url, headers: refererHeaders, skipProxy: false })) };
    } catch { return null; }
}