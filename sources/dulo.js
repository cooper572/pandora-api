const BASE = 'https://dulo-api.secrethackerman99.workers.dev';

export const SKIP_VERIFY = true;

export async function getStream(id, s, e) {
    const url = s && e
        ? `${BASE}/tv/${id}/${s}/${e}`
        : `${BASE}/movie/${id}`;

    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;
    const data = await res.json();

    if (!data?.success) return null;

    const streams = data?.streams;
    if (!Array.isArray(streams) || !streams.length) return null;

    const valid = streams.filter(s => s?.url);
    if (!valid.length) return null;

    const result = {
        url: valid[0].url,
    };

    if (valid.length > 1) {
        result.allUrls = valid.map(s => ({ url: s.url }));
    }

    return result;
}