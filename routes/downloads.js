import { getDownloads as get02movieDownloads } from '../sources/02movie.js';
import { getDownloads as getMovieBoxDownloads } from '../sources/moviebox.js';

async function mergeDownloads(tmdbId, season, episode) {
    const [s02, smb] = await Promise.allSettled([
        get02movieDownloads(tmdbId, season, episode),
        getMovieBoxDownloads(tmdbId, season, episode),
    ]);
    return [
        ...(s02.status === 'fulfilled' ? s02.value : []),
        ...(smb.status === 'fulfilled' ? smb.value : []),
    ];
}

export async function handleDownloadMovie(id, corsHeaders) {
    try {
        const downloads = await mergeDownloads(id, null, null);
        return {
            status: 200,
            body: JSON.stringify({ downloads }, null, 2),
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        };
    } catch (e) {
        return {
            status: 500,
            body: JSON.stringify({ error: e.message }),
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        };
    }
}

export async function handleDownloadTv(id, season, episode, corsHeaders) {
    try {
        const downloads = await mergeDownloads(id, season, episode);
        return {
            status: 200,
            body: JSON.stringify({ downloads }, null, 2),
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        };
    } catch (e) {
        return {
            status: 500,
            body: JSON.stringify({ error: e.message }),
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        };
    }
}