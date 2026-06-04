import { getTmdbInfo, tmdbToAnilist } from '../utils/helpers.js';

async function fetchTkFromEmbedPage(anilistId, episode, audio) {
    const embedUrl = `https://tryembed.us.cc/embed/anime/${anilistId}/${episode}/${audio}`;
    const res = await fetch(embedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
        signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) { res.body?.cancel(); return null; }
    const html = await res.text();
    const match = html.match(/window\.RAW_PAYLOAD\s*=\s*"([^"]+)"/);
    if (!match) return null;
    try {
        const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
        return decoded?.meta?.tk ?? null;
    } catch { return null; }
}

async function fetchTokens(anilistId, season, episode, audio) {
    const s = season ? parseInt(season, 10) : 1;
    const e = episode ? parseInt(episode, 10) : 1;
    const tk = await fetchTkFromEmbedPage(anilistId, e, audio);
    const base = `https://tryembed.us.cc/api/stream_data?id=${anilistId}&episode=${e}&season=${s}&audio=${audio}`;
    const url = tk ? `${base}&tk=${tk}` : base;
    const headers = { 'Referer': `https://tryembed.us.cc/embed/anime/${anilistId}/${e}/${audio}`, 'Origin': 'https://tryembed.us.cc', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0' };
    try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
        if (res.ok) {
            const data = await res.json();
            if (data?.providers?.length) return data;
        } else res.body?.cancel();
    } catch { }
    if (tk) {
        try {
            const res = await fetch(base, { headers, signal: AbortSignal.timeout(20000) });
            if (res.ok) return await res.json();
            res.body?.cancel();
        } catch { }
    }
    return null;
}

function extractUrls(data) {
    const urls = [];
    const providers = data?.providers || [];
    for (const provider of providers) {
        for (const q of provider.qualities || []) {
            if (q.token) urls.push({ url: `https://tryembed.us.cc/s/${q.token}.m3u8`, headers: { 'Referer': 'https://tryembed.us.cc/', 'Origin': 'https://tryembed.us.cc', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0' }, providerName: provider.name || '' });
        }
    }
    return urls;
}

export async function getStream({ id, s, e, audio = 'sub' }) {
    const mediaType = s ? 'tv' : 'movie';
    if (mediaType === 'movie') return null;
    const info = await getTmdbInfo(id, mediaType, s);
    if (!info.isAnime) return null;
    const anilistId = await tmdbToAnilist(id, mediaType, s, info.titles, info.year);
    if (!anilistId) return null;
    const data = await fetchTokens(anilistId, s, e, audio);
    if (!data) return null;
    const rawUrls = extractUrls(data);
    if (!rawUrls.length) return null;
    return { allUrls: rawUrls, skipProxy: false, skipCache: true };
}