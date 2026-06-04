import { getTmdbInfo, tmdbToAnilist } from '../utils/helpers.js';

const BASE = 'https://kiroku.vipstreamed.live/api';
const PROVIDER_ORDER = ['hop', 'bee', 'zoro', 'dune', 'jet', 'arc', 'bonk', 'ANIMEDUNYA', 'ally', 'moo', 'kiwi'];

async function tmdbToMalId(tmdbId, mediaType, season, titles, year) {
    try {
        const res = await fetch(
            `https://api.ani.zip/mappings?tmdb_id=${tmdbId}&type=${mediaType}&season=${season || 1}`,
            { signal: AbortSignal.timeout(6000) }
        );
        if (res.ok) {
            const data = await res.json();
            const malId = data?.mappings?.[0]?.mal_id;
            if (malId) return malId;
        } else {
            res.body?.cancel();
        }
    } catch { }

    if (!titles.length) return null;
    const query = `query ($s: String) { Page(page:1,perPage:5) { media(search:$s,type:ANIME) { id idMal title { romaji english } startDate { year } } } }`;
    for (const title of titles.slice(0, 2)) {
        try {
            const res = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ query, variables: { s: title } }),
                signal: AbortSignal.timeout(6000),
            });
            if (!res.ok) { res.body?.cancel(); continue; }
            const data = await res.json();
            for (const entry of data?.data?.Page?.media || []) {
                if (!entry.idMal) continue;
                const entryTitles = [entry.title?.romaji, entry.title?.english].filter(Boolean).map(t => t.toLowerCase());
                const sl = title.toLowerCase();
                const match = entryTitles.some(t => t === sl || t.includes(sl) || sl.includes(t));
                if (!match) continue;
                if (year && entry.startDate?.year && Math.abs(entry.startDate.year - year) > 2) continue;
                return entry.idMal;
            }
        } catch { }
    }
    return null;
}

async function getProviders(malId, audio) {
    try {
        const res = await fetch(`${BASE}/stream/episodes/${malId}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) { res.body?.cancel(); return null; }
        const data = await res.json();
        const providers = data?.providers || data?.availableProviders || data;
        if (!providers) return null;

        if (Array.isArray(data.availableProviders)) {
            return data.availableProviders
                .filter(p => p !== 'kiwi')
                .sort((a, b) => {
                    const ai = PROVIDER_ORDER.indexOf(a);
                    const bi = PROVIDER_ORDER.indexOf(b);
                    if (ai === -1 && bi === -1) return 0;
                    if (ai === -1) return 1;
                    if (bi === -1) return -1;
                    return ai - bi;
                });
        }

        const list = [];
        for (const [key, val] of Object.entries(providers)) {
            if (key === 'kiwi') continue;
            const hasSub = Array.isArray(val?.sub) && val.sub.length > 0;
            const hasDub = Array.isArray(val?.dub) && val.dub.length > 0;
            if (audio === 'dub' && hasDub) list.push(key);
            else if (audio !== 'dub' && hasSub) list.push(key);
        }
        return list.sort((a, b) => {
            const ai = PROVIDER_ORDER.indexOf(a);
            const bi = PROVIDER_ORDER.indexOf(b);
            if (ai === -1 && bi === -1) return 0;
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    } catch {
        return null;
    }
}

async function getSources(malId, episode, provider, audio) {
    try {
        const res = await fetch(
            `${BASE}/stream/sources/${malId}/${episode}?provider=${encodeURIComponent(provider)}&category=${audio}`,
            { signal: AbortSignal.timeout(12000) }
        );
        if (!res.ok) { res.body?.cancel(); return null; }
        const data = await res.json();
        const streams = Array.isArray(data) ? data : data.streams || data.results || [];
        const hls = streams.filter(s => s.type === 'hls' && s.url);
        return hls.length > 0 ? hls : null;
    } catch {
        return null;
    }
}

export async function getStream({ id, s, e, audio = 'sub' }) {
    const mediaType = s ? 'tv' : 'movie';
    if (mediaType === 'movie') return null;
    const info = await getTmdbInfo(id, mediaType, s || null);
    if (!info.isAnime) return null;
    const malId = await tmdbToMalId(id, mediaType, s, info.titles || [], info.year);
    if (!malId) return null;

    const episode = e || '1';
    const providers = await getProviders(malId, audio);
    if (!providers || providers.length === 0) return null;

    for (const provider of providers.slice(0, 4)) {
        const streams = await getSources(malId, episode, provider, audio);
        if (!streams || streams.length === 0) continue;
        const stream = streams[0];
        return {
            url: stream.url,
            skipProxy: true,
            headers: stream.referer ? { 'Referer': stream.referer } : {},
        };
    }
    return null;
}