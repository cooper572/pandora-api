import { BaseProvider } from '@omss/framework';
import type { ProviderCapabilities, ProviderMediaObject, ProviderResult, Source, Subtitle } from '@omss/framework';
import axios from 'axios';
import { RgShowsResponse } from './rgshows.types.js';

export class RgShowsProvider extends BaseProvider {
    readonly id = 'RgShows';
    readonly name = 'RgShows';
    readonly enabled = true;
    readonly BASE_URL = 'https://api.rgshows.ru/main';
    private readonly FRONTEND_URL = 'https://www.rgshows.ru';
    readonly HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: this.FRONTEND_URL,
        Origin: this.FRONTEND_URL,
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv'],
    };

    /**
     * Fetch movie sources
     */
    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    /**
     * Fetch TV episode sources
     */
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.getSources(media);
    }

    /**
     * Main scraping logic
     */
    private async getSources(media: ProviderMediaObject): Promise<ProviderResult> {
        try {
            // Build page URL
            const pageUrl = this.buildPageUrl(media);

            // Fetch page json
            const data = await this.fetchPage(pageUrl, media);
            if (!data) {
                return this.emptyResult('Failed to fetch page', media);
            }
            const resp: RgShowsResponse = data as unknown as RgShowsResponse;
            
            const result: ProviderResult = {
                sources: [{
                    url: this.createProxyUrl(resp.stream.url, this.HEADERS),
                    quality: 'Up to HD',
                    type: 'mp4',
                    audioTracks: [
                        {
                            label: 'English',
                            language: 'eng'
                        }
                    ],
                    provider: {
                        name: this.name,
                        id: this.id
                    }
                }],
                subtitles: [],
                diagnostics: []
            }

            return result;
        } catch (error) {
            return this.emptyResult(error instanceof Error ? error.message : 'Unknown provider error', media);
        }
    }

    /**
     * Build page URL based on media type
     */
    private buildPageUrl(media: ProviderMediaObject): string {
        if (media.type === 'movie') {
            return `${this.BASE_URL}/movie/${media.tmdbId}`;
        } else {
            return `${this.BASE_URL}/tv/${media.tmdbId}/${media.s}/${media.e}`;
        }
    }

    /**
     * Fetch page Json
     */
    private async fetchPage(url: string, media: ProviderMediaObject): Promise<string | null> {
        try {
            const response = await axios.get(url, {
                headers: this.HEADERS,
                timeout: 10000,
            });

            if (response.status !== 200) {
                return null;
            }

            return response.data;
        } catch (error) {
            return null;
        }
    }

    /**
     * Return empty result with diagnostic
     */
    private emptyResult(message: string, media: ProviderMediaObject): ProviderResult {
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

