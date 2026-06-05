const BASE = "https://trendimovies.com";

const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://trendimovies.com/",
};

async function fetchPage(path) {
    const res = await fetch(`${BASE}${path}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`trendimovies ${res.status}`);
    return res.text();
}

function parseLinks(html) {
    const m = html.match(/DownloadSection[^>]*props="([^"]+)"/s) ||
        html.match(/props="([^"]+)"[^>]*ssr[^>]*client="load"[^>]*opts="[^"]*DownloadSection/s);
    if (!m) {
        const alt = html.match(/&quot;DownloadSection&quot;/);
        if (!alt) return [];
        const propsMatch = html.match(/props="({[^"]*DownloadSection[^"]*})"/s);
        if (!propsMatch) return [];
        return extractLinks(propsMatch[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
    }
    return extractLinks(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
}

function extractLinks(propsJson) {
    try {
        const parsed = JSON.parse(propsJson);
        const rawLinks = parsed?.links?.[1];
        if (!Array.isArray(rawLinks)) return [];
        return rawLinks
            .map(item => item?.[1])
            .filter(l => l && typeof l === "object")
            .map(l => ({
                url: unwrap(l.url),
                quality: unwrap(l.quality) || "HD",
                size: unwrap(l.file_size) || null,
                type: "mkv",
                active: unwrap(l.is_active) !== false,
            }))
            .filter(l => l.url && l.active);
    } catch {
        return [];
    }
}

function unwrap(v) {
    if (Array.isArray(v) && v.length === 2 && (v[0] === 0 || v[0] === 1)) return v[1];
    return v;
}

export async function getDownloads(tmdbId) {
    const html = await fetchPage(`/movie/${tmdbId}`);
    return parseLinks(html);
}

export async function getDownloadsTv(tmdbId, season, episode) {
    const html = await fetchPage(`/tv/${tmdbId}/season/${season}/episode/${episode}`);
    return parseLinks(html);
}