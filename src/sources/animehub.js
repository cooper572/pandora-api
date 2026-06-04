import { getTmdbInfo } from '../utils/helpers.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function searchSlugs(keyword) {
    try {
        const res = await fetch(
            `https://123animehub.cc/ajax/film/search?keyword=${encodeURIComponent(keyword)}&_=${Date.now()}`,
            {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': 'https://123animehub.cc',
                    'Accept': 'application/json',
                    'User-Agent': UA,
                },
                signal: AbortSignal.timeout(8000),
            }
        );
        if (!res.ok) return [];
        const data = await res.json();
        const slugs = [];
        const re = /href="\/anime\/([^"]+)"/g;
        let m;
        while ((m = re.exec(data.html || '')) !== null) {
            if (!slugs.includes(m[1])) slugs.push(m[1]);
        }
        return slugs;
    } catch {
        return [];
    }
}

function buildSearchKeywords(titles) {
    const keywords = new Set();
    for (const title of titles) {
        keywords.add(title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim());
        const words = title.split(/[\s:]+/).filter(w => w.length > 2);
        if (words.length >= 2) keywords.add(words.slice(0, 3).join(' ').toLowerCase());
    }
    return [...keywords];
}

async function resolveSlug(id, s, e, info) {
    const titles = (info && info.titles) || [];
    const keywords = buildSearchKeywords(titles);

    const slugCandidates = [];
    for (const keyword of keywords) {
        const found = await searchSlugs(keyword);
        for (const slug of found) {
            if (!slugCandidates.includes(slug)) slugCandidates.push(slug);
        }
        if (slugCandidates.length > 0) break;
    }

    for (const slug of slugCandidates) {
        try {
            const epr = s ? `${slug}/${s}/${e}` : `${slug}/1`;
            const infoRes = await fetch(
                `https://123animehub.cc/ajax/episode/info?epr=${encodeURIComponent(epr)}&ts=1&_=${Date.now()}`,
                {
                    headers: {
                        'Referer': `https://123animehub.cc/anime/${slug}`,
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'User-Agent': UA,
                    },
                    signal: AbortSignal.timeout(10000),
                }
            );
            if (!infoRes.ok) continue;
            const data = await infoRes.json();
            if (data && data.target) return { slug, eprData: data };
        } catch {
            continue;
        }
    }
    return null;
}

async function extractEchoSources(embedUrl) {
    const embedMatch = embedUrl.match(/\/embed-[^/]+\/([A-Za-z0-9+/=]+)$/);
    if (!embedMatch) return null;
    const encodedId = embedMatch[1];
    const origin = new URL(embedUrl).origin;

    const embedRes = await fetch(embedUrl, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
    });
    if (!embedRes.ok) return null;

    const setCookie = embedRes.headers.get('set-cookie');
    const cookie = setCookie ? setCookie.split(';')[0].trim() : '';

    const sourcesRes = await fetch(
        `${origin}/hs/getSources?id=${encodedId}`,
        {
            headers: {
                'Referer': embedUrl,
                'Accept': '*/*',
                'User-Agent': UA,
                ...(cookie ? { 'Cookie': cookie } : {}),
            },
            signal: AbortSignal.timeout(10000),
        }
    );
    if (!sourcesRes.ok) return null;
    const data = await sourcesRes.json();
    if (!data) return null;

    if (typeof data.sources === 'string' && data.sources.length > 0) return data.sources;
    if (Array.isArray(data.sources) && data.sources.length > 0) {
        return data.sources[0].file || data.sources[0].src || data.sources[0].url || null;
    }
    return null;
}

export async function getStream({ id, s, e }) {
    if (!s) return null;
    const info = await getTmdbInfo(id, 'tv', s);
    if (!info.isAnime) return null;
    const resolved = await resolveSlug(id, s, e, info);
    if (!resolved) return null;
    const { eprData } = resolved;
    const target = eprData.target;
    if (!target) return null;
    const hlsUrl = await extractEchoSources(target);
    if (!hlsUrl) return null;
    return {
        url: hlsUrl,
        headers: {
            'Referer': 'https://play2.echovideo.ru/',
            'Origin': 'https://play2.echovideo.ru',
        },
    };
}