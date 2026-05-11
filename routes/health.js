import { SOURCES, SOURCE_MAP, HEALTH_PROBE_ID } from '../config.js';

export async function handleHealth(SOURCE_MODULES, cache, verifyStream) {
    const results = await Promise.allSettled(
        SOURCES.filter(cfg => !cfg.disabled).map(cfg => (async () => {
            const t = Date.now();
            const mod = SOURCE_MODULES[cfg.key];
            let url = null;
            let verified = false;
            try {
                if (cfg.multiBase) {
                    for (const base of mod.BASES) {
                        url = await Promise.race([
                            (async () => {
                                for (let i = 0; i < 2; i++) {
                                    try {
                                        const r = await mod.getStream(HEALTH_PROBE_ID, null, null, base);
                                        if (r) return r;
                                    } catch { }
                                }
                                return null;
                            })(),
                            new Promise(resolve => setTimeout(() => resolve(null), cfg.timeout))
                        ]);
                        if (url) break;
                    }
                } else {
                    url = await Promise.race([
                        (async () => {
                            for (let i = 0; i < cfg.retries; i++) {
                                try {
                                    const r = await mod.getStream(HEALTH_PROBE_ID, null, null);
                                    if (r) return r;
                                } catch { }
                            }
                            return null;
                        })(),
                        new Promise(resolve => setTimeout(() => resolve(null), cfg.timeout))
                    ]);
                }
                if (url) {
                    const raw = typeof url === 'object' ? url.url : url;
                    verified = await verifyStream(raw, cfg.key);
                }
            } catch { }
            return { ok: verified, ms: Date.now() - t };
        })())
    );

    function unwrap(r) {
        return r.status === 'fulfilled' ? r.value : { ok: false, ms: null, error: r.reason?.message };
    }

    const enabledSources = SOURCES.filter(cfg => !cfg.disabled);
    const byKey = Object.fromEntries(enabledSources.map((cfg, i) => [cfg.key, unwrap(results[i])]));
    const allOk = Object.values(byKey).every(v => v.ok);

    return {
        status: allOk ? 200 : 207,
        body: JSON.stringify({
            status: allOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            tmdb: !!process.env.TMDB_API_KEY,
            cache: cache.size,
            probe_id: HEALTH_PROBE_ID,
            sources: byKey,
        }, null, 2),
        contentType: 'application/json',
    };
}