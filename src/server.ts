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

    // Access the underlying Fastify instance to add CORS middleware
    const fastify = server.getInstance();
    
    // Register CORS plugin for Fastify
    fastify.register(import('@fastify/cors'), {
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
        exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Range', 'Accept-Ranges']
    });

    await server.start();
}

main().catch(() => {
    process.exit(1);
});
