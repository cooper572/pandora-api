export async function getStream({ id, s, e }) {
    try {
        const url = s && e
            ? `https://api.dmvdriverseducation.org/v1/tv/${id}/seasons/${s}/episodes/${e}`
            : `https://api.dmvdriverseducation.org/v1/movies/${id}`;

        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });

        if (!res.ok) return null;

        const data = await res.json();

        const fixUrl = (u) => u?.replace('http://localhost:3030', 'https://api.dmvdriverseducation.org');

        if (Array.isArray(data.sources) && data.sources.length > 0) {
            const sources = data.sources
                .filter(s => s?.url)
                .map(s => ({
                    url: fixUrl(s.url),
                    quality: s.quality || 'unknown',
                    type: s.type || 'hls',
                    audioTracks: s.audioTracks || [],
                    provider: s.provider || null
                }));

            if (sources.length === 0) return null;

            return {
                url: sources[0].url,
                sources
            };
        }

        const streamUrl = data.url || data.stream || data.source || data.file
            || (data.data && data.data.url);

        if (!streamUrl) return null;

        return { url: fixUrl(streamUrl) };

    } catch {
        return null;
    }
}