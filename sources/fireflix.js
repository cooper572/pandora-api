export const SKIP_VERIFY = true;
export const MULTI_URL = true;

const BASE = 'https://fireflixplayer2.vercel.app';

const SOURCE_IDS = [
    'sf-netmirror', 'sf-castle', 'sf-dooflix', 'sf-vidnest', 'sf-movieboxhindi',
    'sf-allmovieland', 'mm-cinesu', 'mm-meowtv', 'mm-vidlink', 'mm-flixhq',
    'mm-vidrock', 'mm-icefy', 'mm-fsharetv', 'mm-vidzee', 'mm-vidfun',
    'mm-cinezo', 'mm-videasy', 'mm-vixsrc', 'sf-cinesu', 'sf-vidrock',
    'sf-videasy', 'sf-vixsrc', 'sf-vidsrc',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractStream(rawUrl) {
    if (!rawUrl) return null;
    const absolute = rawUrl.startsWith('http') ? rawUrl : BASE + (rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl);
    let parsed;
    try { parsed = new URL(absolute); } catch { return null; }
    const innerUrl = parsed.searchParams.get('url');
    if (!innerUrl) return { url: absolute, headers: {} };
    let headers = {};
    const rawHeaders = parsed.searchParams.get('proxyHeaders');
    if (rawHeaders) {
        try { headers = JSON.parse(decodeURIComponent(rawHeaders)); } catch {
            try { headers = JSON.parse(rawHeaders); } catch { }
        }
    }
    return { url: innerUrl, headers };
}

async function fetchStream(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Referer': BASE,
            'Origin': BASE,
        },
        signal: AbortSignal.timeout(12000),
    });
    if (res.status === 429) return { _rateLimit: true };
    if (!res.ok) return null;
    return res.json();
}

function extractCandidates(data, sourceId) {
    const candidates = [];
    if (!data) return candidates;
    if (data.sources && Array.isArray(data.sources)) {
        for (const src of data.sources) {
            if (src.url) candidates.push({ raw: src.url, label: src.label || sourceId, language: src.language || 'English', quality: src.quality || 'Auto' });
        }
    } else if (data.url) {
        candidates.push({ raw: data.url, label: data.sourceName || sourceId, language: 'English', quality: 'Auto' });
    } else if (data.multiStreams && Array.isArray(data.multiStreams)) {
        for (const ms of data.multiStreams) {
            if (ms.url) candidates.push({ raw: ms.url, label: ms.title || sourceId, language: ms.language || 'English', quality: ms.quality || 'Auto' });
        }
    }
    return candidates;
}

export async function getStream(id, s, e) {
    const isTV = s && e;
    const allUrls = [];
    const BATCH = 3;
    const DELAY = 500;

    for (let i = 0; i < SOURCE_IDS.length; i += BATCH) {
        const batch = SOURCE_IDS.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async (sourceId) => {
            try {
                const apiUrl = isTV
                    ? `${BASE}/api/stream?sourceId=${sourceId}&id=${id}&type=tv&season=${s}&episode=${e}`
                    : `${BASE}/api/stream?sourceId=${sourceId}&tmdbId=${id}&type=movie`;
                const data = await fetchStream(apiUrl);
                if (!data || data._rateLimit) return;
                for (const c of extractCandidates(data, sourceId)) {
                    const extracted = extractStream(c.raw);
                    if (!extracted?.url) continue;
                    allUrls.push({
                        url: extracted.url,
                        headers: Object.keys(extracted.headers).length ? extracted.headers : undefined,
                        label: c.label,
                        language: c.language,
                        quality: c.quality,
                    });
                }
            } catch { }
        }));
        if (allUrls.length > 0) break;
        if (i + BATCH < SOURCE_IDS.length) await sleep(DELAY);
    }

    if (allUrls.length === 0) return null;
    return { url: allUrls[0].url, headers: allUrls[0].headers, allUrls };
}