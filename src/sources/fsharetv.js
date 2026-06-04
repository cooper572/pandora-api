import { getTmdbInfo } from '../utils/helpers.js';
const BASE_URL = 'https://fsharetv.cc';
const TRAILER = 'Png81APqcxU';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
};
const API_HEADERS = { ...HEADERS, 'Accept': 'application/json, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' };

async function findWatchPage(imdbId) {
    try {
        const res = await fetch(`${BASE_URL}/movie/${imdbId}`, { headers: HEADERS });
        if (!res?.ok) return null;
        const html = await res.text();
        const match = html.match(/href="(\/w\/[^"]+)"/);
        return match ? match[1] : null;
    } catch (err) { return null; }
}

async function extractSourceId(watchPath) {
    try {
        const url = `${BASE_URL}${watchPath}`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res?.ok) return null;
        const html = await res.text();
        const patterns = [/Movie\.setSource\("([^"]+)"/, /setSource\("([^"]+)"/, /setSource\('([^']+)'/, /"source_id"\s*:\s*"([^"]+)"/, /source_id\s*=\s*"([^"]+)"/, /file_id\s*=\s*"([^"]+)"/, /"file_id"\s*:\s*"([^"]+)"/];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) return match[1];
        }
        return null;
    } catch (err) { return null; }
}

async function fetchSources(sourceId) {
    try {
        const url = `${BASE_URL}/api/file/${sourceId}/source?trailer=${TRAILER}&type=watch`;
        const res = await fetch(url, { headers: { ...API_HEADERS, 'Referer': `${BASE_URL}/` } });
        if (!res?.ok) return [];
        const json = await res.json();
        if (json.status !== 'ok') return [];
        const sources = json.data?.file?.sources ?? [];
        return sources.filter(s => s?.src).sort((a, b) => parseInt(b.quality) - parseInt(a.quality)).map(s => s.src.startsWith('http') ? s.src : `${BASE_URL}${s.src}`);
    } catch (err) { return []; }
}

export async function getStream({ id, s }) {
    if (s != null) return null;
    try {
        const info = await getTmdbInfo(id, 'movie');
        if (!info.imdbId) return null;
        const watchPath = await findWatchPage(info.imdbId);
        if (!watchPath) return null;
        const sourceId = await extractSourceId(watchPath);
        if (!sourceId) return null;
        const urls = await fetchSources(sourceId);
        if (!urls.length) return null;
        return { url: urls[0], headers: HEADERS };
    } catch (err) { return null; }
}

export async function getSources({ id, s }) {
    if (s != null) return [];
    try {
        const info = await getTmdbInfo(id, 'movie');
        if (!info.imdbId) return [];
        const watchPath = await findWatchPage(info.imdbId);
        if (!watchPath) return [];
        const sourceId = await extractSourceId(watchPath);
        if (!sourceId) return [];
        return await fetchSources(sourceId);
    } catch { return []; }
}

export async function proxyStream({ url, res, proxyUtils: { fetchUpstream } }) {
    try {
        const upstream = await fetchUpstream(url, 0, HEADERS);
        if (!upstream) { res.writeHead(502, { 'Content-Type': 'text/plain' }); return res.end('No upstream'); }
        const ct = (upstream.headers?.['content-type'] || 'video/mp4').toLowerCase();
        res.setHeader('Content-Type', ct);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        upstream.pipe(res);
    } catch {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Proxy failed'); }
    }
}