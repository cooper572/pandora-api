import { OMSSServer } from '@omss/framework';
import 'dotenv/config';

import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
    const server = new OMSSServer({
        name: 'CinePro',
        version: '1.0.0',

        // Network
        host: process.env.HOST ?? '0.0.0.0',
        port: Number(process.env.PORT ?? 3000),
        publicUrl: process.env.PUBLIC_URL,

        // Cache (memory for dev, Redis for prod)
        cache: {
            type: process.env.CACHE_TYPE as 'memory' | 'redis' ?? 'memory',
            ttl: {
                sources: 60 * 60,
                subtitles: 60 * 60 * 24,
            },
            redis: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
                password: process.env.REDIS_PASSWORD,
            },
        },

        // TMDB
        tmdb: {
            apiKey: process.env.TMDB_API_KEY!,
            cacheTTL: 24 * 60 * 60, // 24h
        },
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'))

    // Register proxy endpoint
    const app = server.getApp();
    app.get('/v1/proxy', async (req: any, res: any) => {
        try {
            const { data } = req.query;
            
            if (!data || typeof data !== 'string') {
                return res.status(400).json({ error: 'Missing or invalid data parameter' });
            }

            const proxyData = JSON.parse(decodeURIComponent(data));
            const { url, headers } = proxyData;

            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Invalid URL in proxy data' });
            }

            const response = await fetch(url, {
                headers: headers || {},
            });

            if (!response.ok) {
                return res.status(response.status).json({ error: `Upstream returned ${response.status}` });
            }

            // Copy relevant headers
            const contentType = response.headers.get('content-type');
            if (contentType) res.setHeader('Content-Type', contentType);
            
            const contentLength = response.headers.get('content-length');
            if (contentLength) res.setHeader('Content-Length', contentLength);
            
            // Stream the response
            const reader = response.body?.getReader();
            if (reader) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(Buffer.from(value as any));
                    }
                } finally {
                    reader.releaseLock();
                }
            }
            res.end();
        } catch (error) {
            console.error('[ProxyService] Error:', error instanceof Error ? error.message : 'Unknown error');
            res.status(500).json({ error: 'Proxy request failed' });
        }
    });

    await server.start();
}

main().catch(() => {
    process.exit(1);
});
