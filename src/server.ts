import { OMSSServer } from '@omss/framework';
import 'dotenv/config';
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { knownThirdPartyProxies } from './config.js';

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

        // Third Party Proxy removal
        proxyConfig: {
            knownThirdPartyProxies: knownThirdPartyProxies
        }
    });

    // Register providers
    const registry = server.getRegistry();
    await registry.discoverProviders(path.join(__dirname, './providers/'))

    // Extend CORS headers (framework already registers @fastify/cors)
    const app = server.getInstance();
    app.addHook('onSend', (request, reply, payload, done) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
        reply.header(
            'Access-Control-Allow-Headers',
            'Content-Type, Accept, Authorization, Range, User-Agent, Referer, Origin, Accept-Language'
        );
        reply.header('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Content-Range, Accept-Ranges');
        done(null, payload);
    });

    await server.start();
}

main().catch((error) => {
    console.error('[Server] Startup failed:', error);
    process.exit(1);
});
