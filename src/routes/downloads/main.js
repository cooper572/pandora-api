import { getDownloads as getTrendiDownloads, getDownloadsTv as getTrendiDownloadsTv } from './sources/trendimovies.js';

async function mergeDownloads(tmdbId, season, episode) {
    const [sTrendi] = await Promise.allSettled([
        season ? getTrendiDownloadsTv(tmdbId, season, episode) : getTrendiDownloads(tmdbId),
    ]);
    return [
        ...(sTrendi.status === 'fulfilled' ? sTrendi.value : []),
    ];
}

function respondDownload(corsHeaders, fn) {
    return fn()
        .then(downloads => ({
            status: 200,
            body: JSON.stringify({ downloads }, null, 2),
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }))
        .catch(e => ({
            status: 500,
            body: JSON.stringify({ error: e.message }),
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }));
}

export const handleDownloadMovie = (id, corsHeaders) =>
    respondDownload(corsHeaders, () => mergeDownloads(id, null, null));

export const handleDownloadTv = (id, season, episode, corsHeaders) =>
    respondDownload(corsHeaders, () => mergeDownloads(id, season, episode));