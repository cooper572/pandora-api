import { BaseProvider } from '@omss/framework';
import type { ProviderCapabilities, ProviderMediaObject, ProviderResult, Source, Subtitle } from '@omss/framework';
import axios from 'axios';

const UEMBED_API = 'https://uembed.xyz/api/video/tmdb';
const VXR_API = 'https://cdn.madplay.site/vxr';
const HOLLY_API = 'https://api.madplay.site/api/movies/holly';
const ROGFLIX_API = 'https://api.madplay.site/api/rogflix';

export class UembedProvider extends BaseProvider {
    readonly id = 'uembed';
    readonly name = 'Uembed';
    readonly enabled = true;
    readonly BASE_URL  = 'https://madplay.site';
    readonly HEADERS = {
        Origin: this.BASE_URL,
        Referer: this.BASE_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36',
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv'],
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            const apis = [{ url: this.buildUembedUrl(media), name: 'uembed' }, ...(media.type === 'movie' ? [{ url: this.buildVxrUrl(media), name: 'vxr' }] : []), { url: this.buildHollyUrl(media), name: 'holly' }, { url: this.buildRogflixUrl(media), name: 'rogflix' }];

            const apiPromises = apis.map((api) => this.fetchApi(api.url).catch(() => null));
            const results = await Promise.all(apiPromises);

            const successfulResult = results.find((result) => result !== null);
            if (!successfulResult?.length) {
                return this.emptyResult('All APIs failed');
            }

            const sources = await this.processStreams(successfulResult, 'mixed');
            const subtitles: Subtitle[] = [];

            return {
                sources,
                subtitles,
                diagnostics: [],
            };
        } catch (error) {
            return this.emptyResult(error instanceof Error ? error.message : 'Unknown error');
        }
    }

    private async fetchApi(url: string): Promise<any[]> {
        const response = await axios.get(url, {
            headers: this.HEADERS,
            timeout: 10000,
        });

        if (response.status !== 200 || !Array.isArray(response.data)) {
            throw new Error(`HTTP ${response.status}`);
        }

        return response.data;
    }

    private async processStreams(data: any[], apiSource: string): Promise<Source[]> {
        const sources: Source[] = [];

        const streams = data.filter((stream) => stream?.file && typeof stream.file === 'string');

        for (const stream of streams) {
            const language = 'eng';

            try {
                const m3u8Result = await this.resolveM3u8(stream.file);

                for (const variant of m3u8Result.variants) {
                    const urlOrigin = new URL(variant.url).origin;

                    sources.push({
                        url: this.createProxyUrl(variant.url, {
                            ...this.HEADERS,
                            Referer: `${urlOrigin}/`,
                            Origin: urlOrigin,
                        }),
                        type: 'hls',
                        quality: variant.quality,
                        audioTracks: [
                            {
                                language,
                                label: stream.title || 'Unknown',
                            },
                        ],
                        provider: { id: this.id, name: this.name },
                    });
                }
            } catch {
                const urlOrigin = new URL(stream.file).origin;

                sources.push({
                    url: this.createProxyUrl(stream.file, {
                        ...this.HEADERS,
                        Referer: `${urlOrigin}/`,
                        Origin: urlOrigin,
                    }),
                    type:'hls',
                    quality: this.extractQualityFromUrl(stream.file),
                    audioTracks: [
                        {
                            language,
                            label: stream.title || 'Unknown',
                        },
                    ],
                    provider: { id: this.id, name: this.name },
                });
            }
        }

        return this.sortAndDeduplicate(sources);
    }

    private async resolveM3u8(url: string): Promise<{ variants: Array<{ url: string; quality: string }> }> {
        const response = await axios.get(url, {
            headers: {
                ...this.HEADERS,
                Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
            },
            timeout: 10000,
            responseType: 'text',
        });

        const content = response.data;

        if (content.includes('#EXT-X-STREAM-INF')) {
            return {
                variants: this.parseM3u8Master(content, url)
                    .map((v) => ({
                        url: v.url,
                        quality: this.qualityFromResolutionOrBandwidth(v),
                    }))
                    .sort((a, b) => this.qualityPriority(b.quality) - this.qualityPriority(a.quality)),
            };
        }

        return {
            variants: [
                {
                    url,
                    quality: this.extractQualityFromUrl(url),
                },
            ],
        };
    }

    private parseM3u8Master(content: string, baseUrl: string): Array<{ url: string; resolution?: string; bandwidth?: number }> {
        const lines = content.split('\n');
        const streams: Array<{ url: string; resolution?: string; bandwidth?: number }> = [];
        let current: any = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
                current = {};
                const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/);
                if (bwMatch) current.bandwidth = parseInt(bwMatch[1]);

                const resMatch = trimmed.match(/RESOLUTION=(\d+x\d+)/);
                if (resMatch) current.resolution = resMatch[1];
            } else if (current && !trimmed.startsWith('#')) {
                current.url = this.resolveUrlRelative(trimmed, baseUrl);
                streams.push(current);
                current = null;
            }
        }

        return streams;
    }

    private qualityFromResolutionOrBandwidth(stream: any): string {
        if (stream?.resolution) {
            const height = parseInt(stream.resolution.split('x')[1]);
            const map: Record<number, string> = {
                2160: '4K',
                1440: '1440p',
                1080: '1080p',
                720: '720p',
                480: '480p',
                360: '360p',
                240: '240p',
            };
            return map[height] || 'Unknown';
        }

        if (stream?.bandwidth) {
            const mbps = stream.bandwidth / 1000000;
            const map: Record<number, string> = { 15: '4K', 8: '1440p', 5: '1080p', 3: '720p' };
            for (const [threshold, quality] of Object.entries(map)) {
                if (mbps >= parseFloat(threshold)) return quality;
            }
        }

        return 'Unknown';
    }

    private qualityPriority(quality: string): number {
        const priorities: Record<string, number> = {
            '4K': 8,
            '2160p': 8,
            '1440p': 7,
            '1080p': 6,
            '720p': 5,
            '480p': 4,
            '360p': 3,
            '240p': 2,
            HD: 2,
            Unknown: 1,
        };
        return priorities[quality] || 1;
    }

    private sortAndDeduplicate(sources: Source[]): Source[] {
        return sources
            .sort((a, b) => {
                if (a.audioTracks?.[0]?.language !== b.audioTracks?.[0]?.language) {
                    return (a.audioTracks?.[0]?.language || 'zz').localeCompare(b.audioTracks?.[0]?.language || 'zz');
                }
                return this.qualityPriority(b.quality) - this.qualityPriority(a.quality);
            })
            .filter((source, index, self) => index === self.findIndex((s) => s.audioTracks?.[0]?.language === source.audioTracks?.[0]?.language && s.quality === source.quality));
    }

    private extractQualityFromUrl(url: string): string {
        const patterns = [/(\d{3,4})p/i, /(\d{3,4})k/i, /quality[_-](\d{3,4})/i, /res[_-](\d{3,4})/i, /(\d{3,4})x\d{3,4}/i];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) {
                const q = parseInt(match[1]);
                if (q >= 240 && q <= 4320) return `${q}p`;
            }
        }
        return 'Unknown';
    }

    private resolveUrlRelative(url: string, baseUrl: string): string {
        if (url.startsWith('http')) return url;
        try {
            return new URL(url, baseUrl).toString();
        } catch {
            return url;
        }
    }

    private buildUembedUrl(media: ProviderMediaObject): string {
        return `${UEMBED_API}?id=${media.tmdbId}`;
    }

    private buildVxrUrl(media: ProviderMediaObject): string {
        if (media.type !== 'movie') throw new Error('VXR only supports movies');
        return `${VXR_API}?id=${media.tmdbId}&type=movie`;
    }

    private buildHollyUrl(media: ProviderMediaObject): string {
        const params = new URLSearchParams({ id: media.tmdbId.toString(), token: 'thestupidthings' });
        if (media.type === 'movie') {
            params.append('type', 'movie');
        } else {
            params.append('type', 'series');
            params.append('season', (media.s || 1).toString());
            params.append('episode', (media.e || 1).toString());
        }
        return `${HOLLY_API}?${params.toString()}`;
    }

    private buildRogflixUrl(media: ProviderMediaObject): string {
        const params = new URLSearchParams({ id: media.tmdbId.toString(), token: 'thestupidthings' });
        if (media.type === 'movie') {
            params.append('type', 'movie');
        } else {
            params.append('type', 'series');
            params.append('season', (media.s || 1).toString());
            params.append('episode', (media.e || 1).toString());
        }
        return `${ROGFLIX_API}?${params.toString()}`;
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error',
                },
            ],
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await axios.head(UEMBED_API, { timeout: 5000 });
            return response.status === 200;
        } catch {
            return false;
        }
    }
}
