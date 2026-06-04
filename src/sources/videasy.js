import { getTmdbInfo } from '../utils/helpers.js';

const DEC_API = 'https://enc-dec.app/api/dec-videasy';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', 'Accept': 'application/json, */*; q=0.01', 'Referer': 'https://player.videasy.net/', 'Origin': 'https://player.videasy.net' };
const SERVERS = [
    { name: 'cuevana', url: 'https://api2.videasy.net/cuevana/sources-with-title', language: 'english' },
    { name: 'mb-flix', url: 'https://api.videasy.net/mb-flix/sources-with-title', language: 'english' },
    { name: '1movies', url: 'https://api.videasy.net/1movies/sources-with-title', language: 'english' },
    { name: 'cdn', url: 'https://api.videasy.net/cdn/sources-with-title', language: 'english' },
    { name: 'superflix', url: 'https://api.videasy.net/superflix/sources-with-title', language: 'english' },
    { name: 'lamovie', url: 'https://api.videasy.net/lamovie/sources-with-title', language: 'english' },
];
const BLOCKED_DOMAINS = ['easy.speedsterwave.app'];
const decCache = new Map();

function blobKey(tmdbId, blob) { return `${tmdbId}:${blob.slice(0, 32)}`; }
function isBlockedUrl(url) { try { const urlObj = new URL(url); return BLOCKED_DOMAINS.some(domain => urlObj.hostname.includes(domain)); } catch { return false; } }

async function decrypt(blob, tmdbId) {
    if (!blob || blob.length < 10) return null;
    const key = blobKey(tmdbId, blob);
    if (decCache.has(key)) return decCache.get(key);
    try {
        const res = await fetch(DEC_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: blob, id: tmdbId }) });
        if (!res?.ok) return null;
        const json = await res.json();
        if (json.status !== 200 || !json.result?.sources) return null;
        const payload = { sources: json.result.sources ?? [], subtitles: json.result.subtitles ?? [] };
        decCache.set(key, payload);
        return payload;
    } catch { return null; }
}

async function fetchServer(server, id, s, e, title) {
    try {
        const params = new URLSearchParams({ title: title ?? '', mediaType: s != null ? 'tv' : 'movie', tmdbId: String(id), imdbId: '', episodeId: String(e ?? 1), seasonId: String(s ?? 1) });
        const url = `${server.url}?${params}`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res?.ok) return null;
        const blob = await res.text();
        if (!blob || blob.length < 10) return null;
        const decrypted = await decrypt(blob, String(id));
        if (!decrypted || !decrypted.sources.length) return null;
        return decrypted.sources.filter(st => st?.url && !isBlockedUrl(st.url)).map(st => st.url);
    } catch { return null; }
}

export async function getStream({ id, s, e }) {
    const info = await getTmdbInfo(id, s ? 'tv' : 'movie', s);
    const titleStr = info.titles?.[0] || '';
    const results = await Promise.all(SERVERS.map(srv => fetchServer(srv, id, s, e, titleStr)));
    for (let i = 0; i < results.length; i++) {
        const urls = results[i];
        if (urls && urls.length) return { url: urls[0], headers: HEADERS };
    }
    return null;
}