import { BaseProvider, type Subtitle, type SourceType } from '@omss/framework';
import type { ProviderCapabilities, ProviderMediaObject, ProviderResult, Source } from '@omss/framework';
import type { StreamResponse } from './vidzee.types.js';
import axios from 'axios';
import decrypt from './decrypt.js';

export class VidZeeProvider extends BaseProvider {
    readonly id = 'vidzee';
    readonly name = 'VidZee';
    readonly enabled = true;
    readonly BASE_URL = 'https://player.vidzee.wtf';
    readonly HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: this.BASE_URL,
        Origin: this.BASE_URL,
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv'],
    };

    /**
     * Fetch movie sources
     */
    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, { type: 'movie' });
    }

    /**
     * Fetch TV episode sources
     */
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media, {
            type: 'tv',
            season: media.s?.toString(),
            episode: media.e?.toString(),
        });
    }

    /**
     * Main scraping logic - Parallel servers + decryption
     */
    private async getSources(media: ProviderMediaObject, params: { type: 'movie' | 'tv'; season?: string; episode?: string }): Promise<ProviderResult> {
        try {
            const tmdbId = media.tmdbId;
            this.console.debug('VidZee scrape started', {
                tmdbId,
                type: params.type,
                ...(params.season && { season: params.season }),
                ...(params.episode && { episode: params.episode }),
            });

            // 1. Parallel server requests
            const serverPromises = Array.from({ length: 14 }, (_, serverId) => this.fetchServer(tmdbId, serverId, params));
            const results = await Promise.allSettled(serverPromises);
            const successfulResponses: StreamResponse[] = [];

            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                if (result.status === 'fulfilled' && result.value) {
                    successfulResponses.push(result.value);
                }
            }

            if (successfulResponses.length === 0) {
                return this.emptyResult('No working servers', media);
            }

            // 2. Parallel decryption of ALL urls from ALL successful servers
            const decryptPromises = successfulResponses.map((response) => decrypt(response.url).then((decryptedLinks) => ({ response, decryptedLinks })));

            const decryptionResults = await Promise.all(decryptPromises);

            // Flatten and deduplicate decrypted links
            const allDecryptedLinks: string[] = [];
            const allSubtitles = new Map<string, Subtitle>();

            for (const { response, decryptedLinks } of decryptionResults) {
                allDecryptedLinks.push(...decryptedLinks);

                // Process subtitles
                for (const track of response.tracks) {
                    if (track.url && track.lang) {
                        const proxySubUrl = this.createProxyUrl(track.url, this.HEADERS);
                        const subKey = `${track.lang}_${response.serverInfo.number}`;

                        if (!allSubtitles.has(subKey)) {
                            allSubtitles.set(subKey, {
                                url: proxySubUrl,
                                label: track.lang.replace(/\d+/g, '').trim(),
                                format: 'vtt',
                            });
                        }
                    }
                }
            }

            // Deduplicate links
            const uniqueLinks = [...new Set(allDecryptedLinks)].filter((link) => link && link.startsWith('http'));

            const sources: Source[] = uniqueLinks.map((link) => ({
                url: this.createProxyUrl(link, {
                    ...this.HEADERS,
                    Referer: `${this.BASE_URL}/`,
                }),
                type: this.inferType(link) as SourceType,
                quality: this.inferQuality(link),
                audioTracks: [
                    {
                        language: 'eng',
                        label: 'English',
                    },
                ],
                provider: {
                    id: this.id,
                    name: this.name,
                },
            }));

            this.console.success(`${sources.length} unique decrypted sources, ${allSubtitles.size} subtitles`, media);

            return {
                sources,
                subtitles: Array.from(allSubtitles.values()),
                diagnostics: [],
            };
        } catch (error) {
            this.console.error('VidZee failed completely', error, media);
            return this.emptyResult(error instanceof Error ? error.message : 'Unknown error', media);
        }
    }

    /**
     * Fetch single server response
     */
    private async fetchServer(tmdbId: string, serverId: number, params: { type: 'movie' | 'tv'; season?: string; episode?: string }): Promise<StreamResponse | null> {
        try {
            let url = `https://player.vidzee.wtf/api/server?id=${tmdbId}&sr=${serverId}`;

            if (params.type === 'tv' && params.season && params.episode) {
                url += `&ss=${params.season}&ep=${params.episode}`;
            }

            const response = await axios.get(url, {
                headers: this.HEADERS,
                timeout: 8000,
            });

            return response.data as StreamResponse;
        } catch {
            return null;
        }
    }

    /**
     * Return empty result with diagnostic
     */
    private emptyResult(message: string, media: ProviderMediaObject): ProviderResult {
        // @ts-ignore
        this.console.warn('VidZee: Empty result', { message, tmdbId: media.tmdbId });
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

    /**
     * Health check
     */
    async healthCheck(): Promise<boolean> {
        try {
            const response = await axios.head(this.BASE_URL, {
                timeout: 5000,
                headers: this.HEADERS,
            });
            return response.status === 200;
        } catch {
            return false;
        }
    }
}
