export const SKIP_VERIFY = true;
export const MULTI_URL = true;

const RG_BASE = 'https://rg.watchott.ru';

const VIDEASY_SERVERS = [
    'vds-src-cdn',
    'vds-src-mb-flix',
    'vds-src-moviebox',
    'vds-src-1movies',
    'vds-src-m4uhd',
    'vds-src-hdmovie-en',
    'vds-src-hdmovie-hi',
    'vds-src-meine-de',
    'vds-src-meine-it',
    'vds-src-meine-fr',
    'vds-src-superflix',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function extractStream(proxiedUrl) {
    if (!proxiedUrl) return null;
    let parsed;
    try {
        parsed = new URL(proxiedUrl);
    } catch {
        return null;
    }
    const innerUrl = parsed.searchParams.get('url');
    if (!innerUrl) return { url: proxiedUrl, headers: {} };
    let headers = {};
    const rawHeaders = parsed.searchParams.get('headers');
    if (rawHeaders) {
        try {
            headers = JSON.parse(decodeURIComponent(rawHeaders));
        } catch {
            try { headers = JSON.parse(rawHeaders); } catch { }
        }
    }
    return { url: innerUrl, headers };
}

async function fetchProvider(url) {
    const res = await fetch(url, {
        headers: {
            'User-Agent': UA,
            'Referer': 'https://nf.watchott.ru/',
            'Origin': 'https://nf.watchott.ru',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
}

function parseSources(data) {
    const out = [];
    if (!data?.success) return out;
    const sources = data.sources || [];
    for (const src of sources) {
        const raw = src.proxiedUrl || src.url;
        if (!raw) continue;
        const extracted = extractStream(raw);
        if (!extracted?.url) continue;
        out.push({
            url: extracted.url,
            headers: Object.keys(extracted.headers).length ? extracted.headers : undefined,
            quality: src.quality || 'auto',
            label: src.server?.name || data.provider || 'watchott',
        });
    }
    return out;
}

export async function getStream(id, s, e, clientIP, absoluteBase, audio) {
    const isTV = s && e;
    const allUrls = [];

    const vidlinkUrl = isTV
        ? `${RG_BASE}/api/providers/vidlink/tv/${id}/${s}/${e}`
        : `${RG_BASE}/api/providers/vidlink/movie/${id}`;

    const videasyUrls = VIDEASY_SERVERS.map(srv =>
        isTV
            ? `${RG_BASE}/api/providers/videasy/src=${srv}/tv/${id}/${s}/${e}`
            : `${RG_BASE}/api/providers/videasy/src=${srv}/movie/${id}`
    );

    const allEndpoints = [vidlinkUrl, ...videasyUrls];

    await Promise.allSettled(
        allEndpoints.map(async (url) => {
            try {
                const data = await fetchProvider(url);
                const sources = parseSources(data);
                for (const src of sources) {
                    allUrls.push(src);
                }
            } catch { }
        })
    );

    if (allUrls.length === 0) return null;

    return {
        url: allUrls[0].url,
        headers: allUrls[0].headers,
        allUrls,
    };
}