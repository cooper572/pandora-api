const tmdbInfoCache = new Map();
const anilistCache = new Map();

export async function getTmdbInfo(tmdbId, mediaType, season) {
    const key = `${tmdbId}-${mediaType}-${season || ''}`;
    if (tmdbInfoCache.has(key)) return tmdbInfoCache.get(key);
    const k = process.env.TMDB_API_KEY;
    if (!k) return { isAnime: false, titles: [], year: null, imdbId: null };
    try {
        const [mainRes, seasonRes] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${k}&append_to_response=external_ids`, { signal: AbortSignal.timeout(5000) }),
            season && mediaType === 'tv' ? fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?api_key=${k}`, { signal: AbortSignal.timeout(5000) }) : Promise.resolve(null),
        ]);
        let mainData = null, seasonData = null;
        if (mainRes.ok) mainData = await mainRes.json(); else mainRes.body?.cancel();
        if (seasonRes) { if (seasonRes.ok) seasonData = await seasonRes.json(); else seasonRes.body?.cancel(); }
        const genres = mainData?.genres || [];
        const originCountry = mainData?.origin_country || [];
        const originalLanguage = mainData?.original_language || '';
        const isAnime = genres.some(g => g.id === 16) && (originCountry.includes('JP') || originalLanguage === 'ja');
        const titles = [];
        if (seasonData?.name) titles.push(seasonData.name);
        const t = mainData?.title || mainData?.name || '';
        const ot = mainData?.original_title || mainData?.original_name || '';
        if (t) titles.push(t);
        if (ot && ot !== t) titles.push(ot);
        let year = null;
        const dateStr = seasonData?.air_date || mainData?.release_date || mainData?.first_air_date || '';
        if (dateStr) year = parseInt(dateStr.slice(0, 4), 10);
        const result = { isAnime, titles: [...new Set(titles.filter(Boolean))], year, imdbId: mainData?.imdb_id || mainData?.external_ids?.imdb_id || null };
        tmdbInfoCache.set(key, result);
        setTimeout(() => tmdbInfoCache.delete(key), 600000);
        return result;
    } catch { return { isAnime: false, titles: [], year: null, imdbId: null }; }
}

export async function tmdbToAnilist(tmdbId, mediaType, season, titles = [], year = null) {
    const key = `${tmdbId}-${mediaType}-${season || ''}`;
    if (anilistCache.has(key)) return anilistCache.get(key);
    try {
        const res = await fetch(`https://api.ani.zip/mappings?tmdb_id=${tmdbId}&type=${mediaType}&season=${season || 1}`, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
            const data = await res.json();
            const id = data?.mappings?.[0]?.anilist_id;
            if (id) {
                anilistCache.set(key, id);
                setTimeout(() => anilistCache.delete(key), 600000);
                return id;
            }
        } else res.body?.cancel();
    } catch { }
    if (!titles.length) return null;
    const query = `query ($s: String) { Page(page:1,perPage:10) { media(search:$s,type:ANIME) { id title { romaji english native } startDate { year } format } } }`;
    let bestId = null, bestScore = -1;
    for (const searchTitle of titles) {
        try {
            const res = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables: { s: searchTitle } }), signal: AbortSignal.timeout(6000) });
            if (!res.ok) { res.body?.cancel(); continue; }
            const data = await res.json();
            for (const entry of data?.data?.Page?.media || []) {
                const entryTitles = [entry.title?.romaji, entry.title?.english, entry.title?.native].filter(Boolean).map(t => t.toLowerCase());
                const sl = searchTitle.toLowerCase();
                let score = 0;
                if (entryTitles.some(t => t === sl)) score += 5;
                else if (entryTitles.some(t => t.includes(sl) || sl.includes(t))) score += 3;
                else if (entryTitles.some(t => { const w = sl.split(/\s+/).filter(x => x.length > 3); return w.length > 0 && w.every(x => t.includes(x)); })) score += 2;
                else continue;
                if (year && entry.startDate?.year) {
                    const diff = Math.abs(entry.startDate.year - year);
                    if (diff === 0) score += 3;
                    else if (diff === 1) score += 1;
                    else if (diff > 2) score -= 3;
                }
                if (mediaType === 'tv' && ['TV', 'TV_SHORT', 'ONA', 'OVA'].includes(entry.format)) score += 1;
                if (mediaType === 'movie' && entry.format === 'MOVIE') score += 1;
                if (score > bestScore) { bestScore = score; bestId = entry.id; }
            }
            if (bestScore >= 8) break;
        } catch { }
    }
    if (bestId) {
        anilistCache.set(key, bestId);
        setTimeout(() => anilistCache.delete(key), 600000);
    }
    return bestId;
}

export function unwrapTulnexProxy(url) {
    if (!url) return { unwrapped: url, headers: null };
    if (url.includes('pronhub.tulnex.com/m3u8-proxy') || url.includes('prxy.tulnex.com')) {
        try {
            const u = new URL(url);
            const inner = u.searchParams.get('url');
            const headersRaw = u.searchParams.get('headers');
            if (inner) return { unwrapped: decodeURIComponent(inner), headers: headersRaw ? JSON.parse(decodeURIComponent(headersRaw)) : null };
        } catch { }
    }
    return { unwrapped: url, headers: null };
}