const BASE = 'https://apii.freehandyflix.online';

export const SKIP_VERIFY = true;
export const MULTI_URL = true;

function titleSimilarity(a, b) {
    a = a.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    b = b.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (a === b) return 1;
    if (b.startsWith(a) || a.startsWith(b)) return 0.9;
    const aWords = new Set(a.split(' '));
    const bWords = b.split(' ');
    const common = bWords.filter(w => aWords.has(w)).length;
    return common / Math.max(aWords.size, bWords.length);
}

async function getMovieBoxId(tmdbId, isMovie) {
    const tmdbRes = await fetch(
        `https://api.themoviedb.org/3/${isMovie ? 'movie' : 'tv'}/${tmdbId}?api_key=${process.env.TMDB_API_KEY}&append_to_response=external_ids`,
        { signal: AbortSignal.timeout(5000) }
    );
    if (!tmdbRes.ok) return null;
    const meta = await tmdbRes.json();
    const title = meta.title || meta.name;
    if (!title) return null;
    const year = (meta.release_date || meta.first_air_date || '').slice(0, 4);
    const imdbId = meta.imdb_id || meta.external_ids?.imdb_id || null;

    const queries = [title];
    if (imdbId) queries.push(imdbId);

    const subjectType = isMovie ? 1 : 2;

    for (const query of queries) {
        const searchRes = await fetch(`${BASE}/api/search/${encodeURIComponent(query)}`, {
            signal: AbortSignal.timeout(8000),
        });
        if (!searchRes.ok) continue;
        const searchData = await searchRes.json();
        const items = searchData?.data?.items ?? searchData?.results ?? (Array.isArray(searchData) ? searchData : []);
        if (!items.length) continue;

        const sameType = items.filter(r => r.subjectType === subjectType);
        const pool = sameType.length ? sameType : items;

        const scored = pool.map(r => ({
            r,
            score: titleSimilarity(title, r.title) + (year && r.releaseDate?.startsWith(year) ? 0.5 : 0),
        })).sort((a, b) => b.score - a.score);

        if (scored[0]?.score >= 0.8) return scored[0].r.subjectId;
    }

    return null;
}

export async function getDownloads(tmdbId, season, episode) {
    const isMovie = !season;
    const mbId = await getMovieBoxId(tmdbId, isMovie);
    if (!mbId) return [];

    const qs = season ? `?season=${season}&episode=${episode}` : '';
    const res = await fetch(`${BASE}/api/sources/${mbId}${qs}`, {
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();

    const sources = data?.data?.processedSources;
    if (!Array.isArray(sources) || !sources.length) return [];

    return sources
        .sort((a, b) => b.quality - a.quality)
        .map(s => ({
            quality: `${s.quality}p`,
            url: s.proxyUrl || s.directUrl,
            size: s.size ? `${(parseInt(s.size) / 1024 / 1024).toFixed(0)} MB` : null,
            format: s.format || 'mp4',
            server: 4,
        }));
}

export async function getStream(tmdbId, season, episode) {
    const isMovie = !season;
    const mbId = await getMovieBoxId(tmdbId, isMovie);
    if (!mbId) return null;

    const qs = season ? `?season=${season}&episode=${episode}` : '';
    const res = await fetch(`${BASE}/api/sources/${mbId}${qs}`, {
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();

    const sources = data?.data?.processedSources;
    if (!Array.isArray(sources) || !sources.length) return null;

    const urls = [];
    for (const quality of [1080, 720, 480, 360]) {
        const src = sources.find(s => s.quality === quality);
        if (src?.proxyUrl) urls.push({ url: src.proxyUrl, skipProxy: true });
        else if (src?.directUrl) urls.push(src.directUrl);
    }

    if (!urls.length) return null;
    return { allUrls: urls };
}