const BASE = 'https://toustream.xyz';

export const SKIP_VERIFY = true;

export const CDN_HEADERS = [
    {
        pattern: /toustream\.xyz/,
        headers: { 'Referer': 'https://toustream.xyz/' },
    },
];

async function fetchServers(id, s, e) {
    const isMovie = !s || !e;
    const pagePath = isMovie
        ? `/tou/movies/${id}`
        : `/tou/tv/${id}/${s}/${e}`;
    try {
        const res = await fetch(`${BASE}${pagePath}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const html = await res.text();
        const servers = [];
        const re = /data-server="([^"]+)"/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            if (!servers.includes(m[1])) servers.push(m[1]);
        }
        return servers.length ? servers : null;
    } catch {
        return null;
    }
}

export async function getStream(id, s, e, clientIP, absoluteBase, audio) {
    const isMovie = !s || !e;
    const apiPath = isMovie
        ? `/tou/get-source/movie/${id}`
        : `/tou/get-source/tv/${id}/${s}/${e}`;
    const referer = `${BASE}/tou/${isMovie ? 'movies' : 'tv'}/${id}${isMovie ? '' : `/${s}/${e}`}`;

    const servers = await fetchServers(id, s, e);
    if (!servers) return null;

    for (const server of servers) {
        try {
            const res = await fetch(`${BASE}${apiPath}?server=${server}`, {
                headers: { 'Referer': referer, 'Accept': 'application/json' },
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) continue;
            const data = await res.json();
            if (!data?.streamUrl || !data?.isHls) continue;
            const url = data.streamUrl.startsWith('http')
                ? data.streamUrl
                : `${BASE}${data.streamUrl}`;
            return {
                url,
                headers: { 'Referer': 'https://toustream.xyz/' },
                skipHlsCheck: true,
            };
        } catch { }
    }

    return null;
}