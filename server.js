import cluster from 'cluster';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PostHog } from 'posthog-node';
import dotenv from 'dotenv';
import http from 'http';
import { Readable } from 'stream';
import { SOURCES, SOURCE_MAP, CACHE_TTL } from './config.js';
import { handleSubtitleMovie, handleSubtitleTv, fetchSubtitles, SUBTITLE_BASES } from './src/routes/subtitles.js';
import { handleDownloadMovie, handleDownloadTv } from './src/routes/downloads/main.js';
import { handleHealth } from './src/routes/health.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IS_HF = !!process.env.SPACE_ID;
const PORT = process.env.PORT || 7860;
const HF_FETCH_TIMEOUT = 25000;
const EARLY_CLOSE_MS = IS_HF ? 20000 : 14000;
const PROXY_CONCURRENCY = IS_HF ? 40 : 300;
const MAX_GLOBAL_TEST_CONCURRENCY = IS_HF ? 30 : 300;

const PROXY_BASES = process.env.PROXY_BASES
    ? process.env.PROXY_BASES.split(',').map(s => s.trim()).filter(Boolean)
    : ['https://boltunblocker.com/strapi'];

const FALLBACK_BASE = PROXY_BASES[0];

const LOGO_TEXT = (() => {
    try { return fs.readFileSync(path.join(__dirname, 'public/assets/title.txt'), 'utf8'); } catch { return ''; }
})();

const posthog = process.env.POSTHOG_API_KEY
    ? new PostHog(process.env.POSTHOG_API_KEY, { host: 'https://us.i.posthog.com', flushAt: 20, flushInterval: 10000 })
    : null;

process.on('exit', () => posthog?.shutdown());
process.on('SIGTERM', async () => { await posthog?.shutdown(); process.exit(0); });

const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

const NEED_PROXY_REGEX = /https?:\/\/(api2?\.videasy\.net|api\.dmvdriverseducation\.org|api\.tulnex\.com|strategicgrowthpartners\.site|cloudnestra\.com|(www\.)?lookmovie2?\.to|(www\.)?lookmovie\.foundation|.*\.theaky\.store|.*\.akamaihd\.net|.*\.vix-content\.net|vixsrc\.to|.*\.hakunaymatata\.com|vsembed\.ru|.*\.vodvidl\.site|.*\.vidldl\.site|.*\.vidldr\.site|typhoontigertribe\.net|skywardslothnetwork\.net)/i;
const M3U8_REGEX = /\.m3u8?(\?|$)|mpegurl|m3u8/i;
const TIKTOK_REGEX = /tiktokcdn\.com|ibyteimg\.com/i;
const STRIP_REGEX = /seg\.html|enproxy|letsgocdn\d+\.shop/i;
const STRIP_TEST_FAST = /seg\.html|enproxy|tiktokcdn|ibyteimg/i;
const URI_REPLACE = /URI="([^"]+)"/g;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin, Accept, Access-Control-Request-Method, Access-Control-Request-Headers',
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Max-Age': '86400',
};

const JSON_CORS = { 'Content-Type': 'application/json', ...CORS_HEADERS };

const ROUTE_PATTERNS = {
    subtitleMovie: /^\/(?:api\/)?subtitles?\/movie\/([^/]+)$/,
    subtitleTv: /^\/(?:api\/)?subtitles?\/tv\/([^/]+)\/([^/]+)\/([^/]+)$/,
    debug: /^\/(?:api\/)?debug\/([^/]+)$/,
    test: /^\/(?:api\/)?test\/([^/]+)$/,
    downloadMovie: /^\/(?:api\/)?downloads?\/movie\/([^/]+)$/,
    downloadTv: /^\/(?:api\/)?downloads?\/tv\/([^/]+)\/([^/]+)\/([^/]+)$/,
};

if (cluster.isPrimary) {
    const cpus = (await import('os')).default.cpus().length;
    const workerCount = IS_HF ? Math.min(cpus, 4) : 1;
    const sharedCache = new Map();

    const pruneCache = () => {
        const now = Date.now();
        for (const [k, v] of sharedCache) {
            if (now - v.ts > v.ttl) sharedCache.delete(k);
        }
    };

    const pruneTimer = setInterval(pruneCache, 30000);
    pruneTimer.unref();

    for (let i = 0; i < workerCount; i++) {
        const w = cluster.fork({ WORKER_ID: String(i) });
        w.on('online', () => w.send({ type: 'worker:id', id: i }));
    }

    cluster.on('message', (worker, msg) => {
        if (!msg?.type) return;

        if (msg.type === 'cache:get') {
            const entry = sharedCache.get(msg.key);
            const now = Date.now();
            if (entry && now - entry.ts <= entry.ttl) {
                worker.send({ type: 'cache:hit', id: msg.id, value: entry.value });
            } else {
                sharedCache.delete(msg.key);
                worker.send({ type: 'cache:miss', id: msg.id });
            }
            return;
        }

        if (msg.type === 'cache:set') {
            sharedCache.set(msg.key, { value: msg.value, ts: Date.now(), ttl: msg.ttl || CACHE_TTL });
            for (const id in cluster.workers) {
                if (cluster.workers[id] !== worker) {
                    try { cluster.workers[id]?.send({ type: 'cache:push', key: msg.key, value: msg.value, ttl: msg.ttl || CACHE_TTL }); } catch { }
                }
            }
        }
    });

    const watchPaths = [
        fileURLToPath(import.meta.url),
        './config.js',
        './src/routes/subtitles.js',
        './src/routes/downloads/main.js',
        './src/routes/health.js',
    ];

    let restarting = false;
    const scheduleRestart = () => {
        if (restarting) return;
        restarting = true;
        setTimeout(() => {
            for (const id in cluster.workers) cluster.workers[id]?.kill();
            restarting = false;
        }, 500);
    };

    fs.watch('./src/sources', { persistent: false }, scheduleRestart);
    watchPaths.forEach(f => { try { fs.watch(f, scheduleRestart); } catch { } });

    let pendingForks = 0;
    cluster.on('exit', (worker, code, signal) => {
        const isIntentional = signal === 'SIGKILL' || code === 0;
        const delay = isIntentional ? 0 : Math.min(++pendingForks * 1000, 5000);
        setTimeout(() => {
            pendingForks = Math.max(0, pendingForks - 1);
            cluster.fork();
        }, delay);
    });

    await new Promise(() => { });
}

const _nativeFetch = globalThis.fetch;

let fallbackRoundRobin = 0;
const nextProxyBase = () => {
    const base = PROXY_BASES[fallbackRoundRobin % PROXY_BASES.length];
    fallbackRoundRobin = (fallbackRoundRobin + 1) % PROXY_BASES.length;
    return base;
};

globalThis.fetch = (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url?.href ?? String(url);
    const signal = opts?.signal ?? AbortSignal.timeout(HF_FETCH_TIMEOUT);

    if (IS_HF && NEED_PROXY_REGEX.test(urlStr)) {
        let proxied = `${nextProxyBase()}/api?url=${encodeURIComponent(urlStr)}&vn=1`;
        if (opts?.headers) proxied += `&proxyHeaders=${encodeURIComponent(JSON.stringify(opts.headers))}`;
        return _nativeFetch(proxied, opts ? { ...opts, signal } : { signal });
    }

    return _nativeFetch(url, opts?.signal ? opts : { ...opts, signal });
};

class LRUCache {
    #max; #ttl; #map;

    constructor(max, ttl) {
        this.#max = max;
        this.#ttl = ttl;
        this.#map = new Map();
    }

    get(key) {
        const entry = this.#map.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > this.#ttl) { this.#map.delete(key); return undefined; }
        this.#map.delete(key);
        this.#map.set(key, entry);
        return entry.val;
    }

    set(key, val) {
        if (this.#map.has(key)) this.#map.delete(key);
        else if (this.#map.size >= this.#max) this.#map.delete(this.#map.keys().next().value);
        this.#map.set(key, { val, ts: Date.now() });
    }

    has(key) {
        const entry = this.#map.get(key);
        if (!entry) return false;
        if (Date.now() - entry.ts > this.#ttl) { this.#map.delete(key); return false; }
        return true;
    }

    get size() { return this.#map.size; }
}

const mainCache = new LRUCache(2000, CACHE_TTL);
const hlsVerifyCache = new LRUCache(1000, 180_000);
const testResultCache = new LRUCache(1000, 90_000);

const sharedInflight = new Map();
const inflightMap = new Map();

let ipcIdCounter = 0;
const ipcPending = new Map();

const ipcSend = (msg) => new Promise(resolve => {
    const id = ++ipcIdCounter;
    ipcPending.set(id, resolve);
    try {
        process.send({ ...msg, id });
    } catch {
        ipcPending.delete(id);
        resolve(null);
        return;
    }
    setTimeout(() => {
        if (ipcPending.has(id)) { ipcPending.delete(id); resolve(null); }
    }, 150);
});

process.on('message', (msg) => {
    if (!msg) return;
    if (msg.type === 'worker:id') return;

    if (msg.type === 'cache:hit' || msg.type === 'cache:miss') {
        const resolve = ipcPending.get(msg.id);
        if (resolve) { ipcPending.delete(msg.id); resolve(msg); }
        return;
    }

    if (msg.type === 'cache:push' && msg.key && msg.value !== undefined) {
        mainCache.set(msg.key, msg.value);
        testResultCache.set(msg.key, msg.value);
    }
});

async function sharedCacheGet(key) {
    const local = mainCache.get(key);
    if (local !== undefined) return local;
    if (!process.send) return undefined;
    const reply = await ipcSend({ type: 'cache:get', key });
    if (reply?.type === 'cache:hit') { mainCache.set(key, reply.value); return reply.value; }
    return undefined;
}

function sharedCacheSet(key, value, ttl) {
    mainCache.set(key, value);
    testResultCache.set(key, value);
    if (process.send) {
        try { process.send({ type: 'cache:set', key, value, ttl: ttl || CACHE_TTL }); } catch { }
    }
}

function getSharedCached(key, fn, ttl) {
    const local = mainCache.get(key);
    if (local !== undefined) return Promise.resolve(local);

    const inflight = sharedInflight.get(key);
    if (inflight) return inflight;

    const p = (async () => {
        const shared = await sharedCacheGet(key);
        if (shared !== undefined) return shared;
        const val = await fn();
        if (val != null) sharedCacheSet(key, val, ttl);
        return val;
    })().finally(() => sharedInflight.delete(key));

    sharedInflight.set(key, p);
    return p;
}

const getUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const jitter = ms => ms > 0 ? new Promise(r => setTimeout(r, Math.random() * ms)) : Promise.resolve();
const withTimeout = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(() => r(null), ms))]);

async function withRetry(fn, attempts = 2, delay = 300) {
    for (let i = 0; i < attempts; i++) {
        try {
            const result = await fn();
            if (result != null) return result;
        } catch (err) {
            if (i === attempts - 1) throw err;
            await new Promise(r => setTimeout(r, delay + Math.random() * delay * 0.5));
        }
    }
    return null;
}

const ALL_SOURCE_MODULES = Object.fromEntries(
    await Promise.all(SOURCES.map(async cfg => [cfg.key, await import(`./src/sources/${cfg.sourceFile}.js`)]))
);

const SOURCE_MODULES = Object.fromEntries(
    Object.entries(ALL_SOURCE_MODULES).filter(([key]) => !SOURCE_MAP[key]?.disabled)
);

const ACTIVE_SOURCES = SOURCES.filter(c => !c.disabled);
const PROXY_PARAM_MAP = new Map(ACTIVE_SOURCES.map(cfg => [cfg.proxyParam, cfg]));

const BLOCKED_IPS = new Set([]);
const rateLimitMap = new Map();

const rateLimitTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, rl] of rateLimitMap) {
        if (now - rl.ts > 60_000) rateLimitMap.delete(ip);
    }
}, 30_000);
rateLimitTimer.unref?.();

let proxyActiveCount = 0;
const proxyQueue = [];

let globalTestConcurrency = 0;
const testQueue = [];

function runTestQueue() {
    while (testQueue.length > 0 && globalTestConcurrency < MAX_GLOBAL_TEST_CONCURRENCY) {
        testQueue.shift().resolve();
        globalTestConcurrency++;
    }
}

async function acquireTestSlot() {
    if (globalTestConcurrency < MAX_GLOBAL_TEST_CONCURRENCY) { globalTestConcurrency++; return; }
    await new Promise(resolve => testQueue.push({ resolve }));
}

function releaseTestSlot() {
    globalTestConcurrency = Math.max(0, globalTestConcurrency - 1);
    runTestQueue();
}

const getAbsoluteBase = host =>
    (host.startsWith('localhost') || host.startsWith('127.0.0.1')) ? `http://${host}` : `https://${host}`;

const getEffectiveBase = abs => IS_HF ? nextProxyBase() : abs;

const isFallbackNeeded = host =>
    !host.startsWith('localhost') && !host.startsWith('127.0.0.1');

function unwrapProxyUrl(url) {
    try {
        const inner = new URL(url).searchParams.get('url');
        if (inner) return decodeURIComponent(inner);
    } catch { }
    return url;
}

function resolveUri(uri, dir, originBase) {
    const abs = uri.startsWith('http') ? uri : uri.startsWith('/') ? originBase + uri : dir + uri;
    const decoded = safeDecode(abs.startsWith('http://') ? 'https://' + abs.slice(7) : abs);
    return decoded.startsWith('http') ? decoded : abs.startsWith('http://') ? 'https://' + abs.slice(7) : abs;
}

function buildM3u8Rewriter(rewriteSegments) {
    return function rewrite(body, url, extraParam, absoluteBase) {
        const safeBase = absoluteBase.replace('https://localhost', 'http://localhost').replace('https://127.0.0.1', 'http://127.0.0.1');
        const qmark = url.indexOf('?');
        const base = qmark === -1 ? url : url.slice(0, qmark);
        const dir = base.slice(0, base.lastIndexOf('/') + 1);
        const schemeEnd = url.indexOf('//') + 2;
        const originBase = url.slice(0, url.indexOf('/', schemeEnd));
        const prefix = `${safeBase}/api?url=`;
        const lines = body.split('\n');
        const out = new Array(lines.length);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const t = line.trim();
            if (!t) { out[i] = line; continue; }

            if (t.charCodeAt(0) === 35) {
                out[i] = t.replace(URI_REPLACE, (_, uri) => {
                    const resolved = unwrapProxyUrl(resolveUri(uri, dir, originBase));
                    return `URI="${prefix}${encodeURIComponent(resolved)}${extraParam}"`;
                });
            } else {
                const resolved = unwrapProxyUrl(resolveUri(t, dir, originBase));
                out[i] = rewriteSegments
                    ? `${prefix}${encodeURIComponent(resolved)}${extraParam}${STRIP_TEST_FAST.test(resolved) ? '&tt=1' : ''}`
                    : resolved;
            }
        }

        return out.join('\n');
    };
}

const rewriteM3u8 = buildM3u8Rewriter(true);
const rewriteM3u8KeyOnly = buildM3u8Rewriter(false);

async function fetchUpstream(url, extraHeaders = {}, timeoutMs = 30_000) {
    let current = url.startsWith('http://') ? 'https://' + url.slice(7) : url;
    const headers = { 'User-Agent': getUA(), ...extraHeaders };
    const opts = { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };

    for (let i = 0; i <= 5; i++) {
        const res = await _nativeFetch(current, opts);
        if (res.status < 300 || res.status >= 400 || !res.headers.has('location')) return res;
        res.body?.cancel();
        const loc = res.headers.get('location');
        current = loc.startsWith('http')
            ? (loc.startsWith('http://') ? 'https://' + loc.slice(7) : loc)
            : new URL(loc, current).href;
    }

    throw new Error('redirect loop');
}

async function verifyStream(rawUrl, sourceKey) {
    const cfg = SOURCE_MAP[sourceKey];
    if (cfg?.skipVerify) return true;

    const cacheKey = `vstream-${rawUrl}`;
    const cached = hlsVerifyCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
        const res = await _nativeFetch(rawUrl, {
            method: 'HEAD',
            headers: { 'User-Agent': getUA(), ...(cfg?.verifyHeaders ?? {}) },
            redirect: 'follow',
            signal: AbortSignal.timeout(6_000),
        });
        res.body?.cancel();
        const ok = res.status < 400;
        hlsVerifyCache.set(cacheKey, ok);
        return ok;
    } catch {
        hlsVerifyCache.set(cacheKey, false);
        return false;
    }
}

async function verifyPlayable(proxiedUrl, extraHeaders = {}, skipProxyCheck = false) {
    if (IS_HF && proxiedUrl.includes('.hf.space/api?url=')) {
        try {
            const parsed = new URL(proxiedUrl);
            const rawUrl = decodeURIComponent(parsed.searchParams.get('url') || '');
            const ph = parsed.searchParams.get('proxyHeaders');
            if (ph) try { Object.assign(extraHeaders, JSON.parse(decodeURIComponent(ph))); } catch { }
            if (rawUrl) { proxiedUrl = rawUrl; skipProxyCheck = true; }
        } catch { }
    }

    const cached = hlsVerifyCache.get(proxiedUrl);
    if (cached !== undefined) return cached;

    const store = val => { hlsVerifyCache.set(proxiedUrl, val); return val; };
    const fail = error => ({ ok: false, error });

    try {
        const fetchHeaders = extraHeaders['User-Agent'] ? extraHeaders : { 'User-Agent': getUA(), ...extraHeaders };
        const m3u8Res = await _nativeFetch(proxiedUrl, { signal: AbortSignal.timeout(12_000), headers: fetchHeaders });

        if (!m3u8Res.ok) {
            const val = fail(`m3u8 failed: ${m3u8Res.status}`);
            if (m3u8Res.status !== 429) store(val);
            return val;
        }

        const text = await m3u8Res.text();
        if (!text.trim().startsWith('#EXTM3U')) return fail('invalid m3u8');
        if (/^429$|^429\s/m.test(text) || text.includes('Too Many Requests')) return fail('Proxy Blocked or Invalid Hash');
        if (!text.includes('#EXTINF') && !text.includes('#EXT-X-STREAM-INF')) return fail('empty playlist');

        if (!skipProxyCheck) {
            let nextUrl = null;
            for (const l of text.split('\n')) {
                const t = l.trim();
                if (t && t.charCodeAt(0) !== 35) { nextUrl = t; break; }
            }

            if (nextUrl) {
                if (!nextUrl.startsWith('http')) nextUrl = new URL(nextUrl, proxiedUrl).href;
                const variantRes = await _nativeFetch(nextUrl, {
                    method: 'GET',
                    headers: { 'User-Agent': getUA(), ...extraHeaders, 'Range': 'bytes=0-1024' },
                    signal: AbortSignal.timeout(10_000),
                });

                if (!variantRes.ok && variantRes.status !== 206) return fail(`Variant failed: ${variantRes.status}`);

                const ct = (variantRes.headers.get('content-type') || '').toLowerCase();
                if (ct.includes('mpegurl') || ct.includes('m3u8') || nextUrl.includes('.m3u8')) {
                    let segUrl = null;
                    for (const l of (await variantRes.text()).split('\n')) {
                        const t = l.trim();
                        if (t && t.charCodeAt(0) !== 35) { segUrl = t; break; }
                    }
                    if (segUrl) {
                        if (!segUrl.startsWith('http')) segUrl = new URL(segUrl, nextUrl).href;
                        const segRes = await _nativeFetch(segUrl, {
                            method: 'HEAD',
                            signal: AbortSignal.timeout(5_000),
                            headers: { 'User-Agent': getUA(), ...extraHeaders },
                        });
                        segRes.body?.cancel();
                        if (!segRes.ok && segRes.status !== 206) return fail(`Segment failed: ${segRes.status}`);
                    }
                } else if (!variantRes.ok && variantRes.status !== 206) {
                    return fail(`Variant fetch failed: ${variantRes.status}`);
                }
            }
        }

        return store({ ok: true, error: null });
    } catch (err) {
        return fail(err.message);
    }
}

async function getMetadata(id, s, e) {
    const key = process.env.TMDB_API_KEY;
    if (!key) return { error: 'TMDB API key not configured' };

    const cacheKey = `meta-${id}-${s ?? ''}-${e ?? ''}`;
    return getSharedCached(cacheKey, async () => {
        const url = s
            ? `https://api.themoviedb.org/3/tv/${id}/season/${s}/episode/${e || 1}?api_key=${key}`
            : `https://api.themoviedb.org/3/movie/${id}?api_key=${key}`;
        const res = await _nativeFetch(url, { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) { res.body?.cancel(); return { error: `TMDB API error: ${res.status}` }; }
        return res.json();
    }, 1_800_000);
}

function applyCdnHeaders(cleanUrl, extraHeaders, sourceKey) {
    const cfg = SOURCE_MAP[sourceKey];
    if (!cfg?.cdnHeaders) return;
    for (const rule of cfg.cdnHeaders) {
        if (rule.pattern.test(cleanUrl)) { Object.assign(extraHeaders, rule.headers); return; }
    }
}

function wrapUrl(rawUrl, sourceKey, absoluteBase = '') {
    if (!rawUrl) return null;
    const raw = typeof rawUrl === 'object' ? rawUrl.url : rawUrl;
    const cfg = SOURCE_MAP[sourceKey];
    if (!cfg || cfg.skipProxy || rawUrl?.skipProxy) return raw;

    const isLocal = absoluteBase.includes('localhost') || absoluteBase.includes('127.0.0.1');
    const safeBase = isLocal ? absoluteBase : absoluteBase.replace('http://', 'https://');
    const normalized = isLocal ? raw : raw.replace('http://', 'https://');
    let wrapped = `${safeBase}/api?url=${encodeURIComponent(normalized)}&${cfg.proxyParam}=1`;
    if (typeof rawUrl === 'object' && rawUrl.headers) {
        wrapped += `&proxyHeaders=${encodeURIComponent(JSON.stringify(rawUrl.headers))}`;
    }
    return wrapped;
}

function fetchSource(cfg, cacheKey, id, s, e, clientIP, absoluteBase, fallbackBase) {
    const mod = SOURCE_MODULES[cfg.key];
    const effectiveBase = getEffectiveBase(absoluteBase);
    const audio = /dub$/.test(cfg.key) ? 'dub' : 'sub';
    const streamArgs = extra => ({ id, s, e, clientIP, absoluteBase: extra || effectiveBase, audio, config: cfg });

    if (cfg.skipCache) {
        return withTimeout(
            jitter(cfg.jitter).then(() => withRetry(() => mod.getStream(streamArgs()), cfg.retries, 300)),
            cfg.timeout
        );
    }

    if (cfg.multiBase) {
        return withTimeout(jitter(cfg.jitter).then(async () => {
            for (const base of mod.BASES) {
                const res = await getSharedCached(
                    `${cfg.key}-${base}-${cacheKey}`,
                    () => withRetry(() => mod.getStream(streamArgs(base)), cfg.retries, 300)
                );
                if (res) return res;
            }
            return null;
        }), cfg.timeout);
    }

    const primaryTimeout = fallbackBase ? Math.floor(cfg.timeout * 0.6) : cfg.timeout;
    return withTimeout(jitter(cfg.jitter).then(async () => {
        const primary = await withTimeout(
            getSharedCached(`${cfg.key}-${cacheKey}`, () => withRetry(() => mod.getStream(streamArgs()), cfg.retries, 300)),
            primaryTimeout
        );
        if (primary) return primary;
        if (!fallbackBase) return null;
        return withTimeout(
            getSharedCached(`${cfg.key}-fallback-${cacheKey}`, () => withRetry(() => mod.getStream(streamArgs(fallbackBase)), cfg.retries, 300)),
            cfg.timeout - primaryTimeout
        );
    }), cfg.timeout);
}

function normalizeCandidates(rawResult) {
    if (rawResult?.allUrls?.length) {
        return rawResult.allUrls.map(u => typeof u === 'object' ? u : { url: u });
    }
    if (Array.isArray(rawResult)) {
        return rawResult.map(u => typeof u === 'object' ? u : { url: u });
    }
    if (rawResult) {
        return [{ url: typeof rawResult === 'object' ? rawResult.url : rawResult, headers: rawResult?.headers, skipProxy: rawResult?.skipProxy, skipHlsCheck: rawResult?.skipHlsCheck }];
    }
    return [];
}

async function handleTestSource(sourceKey, id, s, e, clientIP, host) {
    const start = Date.now();
    const cfg = SOURCE_MAP[sourceKey];
    const absoluteBase = getAbsoluteBase(host);
    const mod = SOURCE_MODULES[sourceKey];

    const respond = (ok, url, raw_url, error, debug) => ({
        status: 200,
        body: JSON.stringify({ source: sourceKey, id, s: s || null, e: e || null, ok, url: ok ? url : null, raw_url, elapsed_ms: Date.now() - start, error: ok ? null : error, debug }, null, 2),
        contentType: 'application/json',
    });

    if (cfg?.disabled) return respond(false, null, null, 'source disabled');

    const cacheKey = `test-${sourceKey}-${id}-${s ?? ''}-${e ?? ''}`;
    const localCached = testResultCache.get(cacheKey);
    if (localCached !== undefined) return respond(localCached.ok, localCached.url, localCached.raw_url, localCached.error);

    const shared = await sharedCacheGet(cacheKey);
    if (shared !== undefined) { testResultCache.set(cacheKey, shared); return respond(shared.ok, shared.url, shared.raw_url, shared.error); }

    const inflightKey = `inflight-${cacheKey}`;
    const existing = sharedInflight.get(inflightKey);
    if (existing) {
        try {
            const result = await existing;
            return respond(result?.ok ?? false, result?.url ?? null, result?.raw_url ?? null, result?.error ?? null);
        } catch {
            return respond(false, null, null, 'deduped request failed');
        }
    }

    await acquireTestSlot();

    const testPromise = (async () => {
        try {
            let rawResult = null, fetchError = null;
            const audio = /dub$/.test(cfg.key) ? 'dub' : 'sub';
            const fallbackBase = isFallbackNeeded(host) ? nextProxyBase() : '';

            try {
                rawResult = await fetchSource(cfg, `${id}-${s ?? ''}-${e ?? ''}`, id, s, e, clientIP, absoluteBase, fallbackBase);
                if (!rawResult) rawResult = await withTimeout(mod.getStream({ id, s, e, clientIP: null, absoluteBase: getEffectiveBase(absoluteBase), audio, config: cfg }), 20_000);
                if (!rawResult && isFallbackNeeded(host)) rawResult = await withTimeout(mod.getStream({ id, s, e, clientIP: null, absoluteBase: nextProxyBase(), audio, config: cfg }), 20_000);
            } catch (err) { fetchError = err.message; }

            const candidates = normalizeCandidates(rawResult);

            for (const candidate of candidates) {
                const wrappedUrl = wrapUrl(candidate, sourceKey, absoluteBase);
                if (!wrappedUrl) continue;

                if (candidate?.skipProxy) {
                    const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                    testResultCache.set(cacheKey, result);
                    sharedCacheSet(cacheKey, result, 90_000);
                    return result;
                }

                if (candidate?.skipHlsCheck) {
                    try {
                        const r = await _nativeFetch(candidate.url, { signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': getUA(), ...(candidate.headers ?? {}) } });
                        if (!r.ok) continue;
                        const ct = (r.headers.get('content-type') || '').toLowerCase();
                        const text = ct.includes('video') || ct.includes('octet-stream') ? null : await r.text();
                        if (text !== null && !text.trim().startsWith('#EXTM3U')) continue;
                        if (text !== null && /Too Many Requests/m.test(text)) continue;
                        if (text !== null && !text.includes('#EXTINF') && !text.includes('#EXT-X-STREAM-INF')) continue;
                        const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                        testResultCache.set(cacheKey, result);
                        sharedCacheSet(cacheKey, result, 90_000);
                        return result;
                    } catch { continue; }
                }

                if (cfg.skipVerify || cfg.multiUrl) {
                    const checkUrl = IS_HF ? candidate.url : wrappedUrl;
                    const checkHeaders = IS_HF ? (candidate.headers ?? {}) : {};
                    const check = await verifyPlayable(checkUrl, checkHeaders, false);

                    if (check.ok) {
                        const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                        if (!rawResult?.skipCache) { testResultCache.set(cacheKey, result); sharedCacheSet(cacheKey, result, cfg.testCacheTtl ?? 90_000); }
                        return result;
                    }

                    if (/timeout|aborted/i.test(check.error ?? '')) {
                        const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                        if (!rawResult?.skipCache) { testResultCache.set(cacheKey, result); sharedCacheSet(cacheKey, result, 15_000); }
                        return result;
                    }

                    try {
                        const headRes = await _nativeFetch(candidate.url, {
                            method: 'HEAD',
                            headers: { 'User-Agent': getUA(), ...(candidate.headers ?? {}) },
                            signal: AbortSignal.timeout(6_000),
                            redirect: 'follow',
                        });
                        headRes.body?.cancel();
                        const ct = (headRes.headers.get('content-type') || '').toLowerCase();
                        if (headRes.status < 400 && /video|octet-stream|mp4/.test(ct) && !ct.includes('mpegurl')) {
                            const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                            testResultCache.set(cacheKey, result);
                            sharedCacheSet(cacheKey, result, cfg.testCacheTtl ?? 90_000);
                            return result;
                        }
                    } catch { }
                    continue;
                }

                if (!(await verifyStream(candidate.url, sourceKey))) continue;

                const verifyUrl = IS_HF ? candidate.url : wrappedUrl;
                const verifyHeaders = IS_HF ? (candidate.headers ?? {}) : {};
                const check = await verifyPlayable(verifyUrl, verifyHeaders, IS_HF);

                if (!check.ok) {
                    const rawHeaders = candidate?.headers ?? {};
                    const [proxiedBody, rawCheck] = await Promise.all([
                        _nativeFetch(wrappedUrl, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': getUA() } })
                            .then(r => r.text()).then(t => t.slice(0, 200)).catch(e => e.message),
                        verifyPlayable(candidate.url, rawHeaders, true),
                    ]);
                    return {
                        ok: false, url: null, raw_url: candidate.url, error: check.error,
                        debug: { proxy_failed: true, proxy_error: check.error, proxy_body_preview: proxiedBody, raw_reachable: rawCheck.ok, raw_error: rawCheck.error, raw_headers_used: rawHeaders, proxied_url: wrappedUrl },
                    };
                }

                const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                testResultCache.set(cacheKey, result);
                sharedCacheSet(cacheKey, result, 90_000);
                return result;
            }

            return { ok: false, url: null, raw_url: candidates[0]?.url || null, error: fetchError };
        } finally {
            releaseTestSlot();
            sharedInflight.delete(inflightKey);
        }
    })();

    sharedInflight.set(inflightKey, testPromise);
    const result = await testPromise;
    return respond(result?.ok ?? false, result?.url ?? null, result?.raw_url ?? null, result?.error ?? null, result?.debug ?? null);
}

async function streamSources(sources, id, s, e, clientIP, absoluteBase, res) {
    const sent = new Set();
    const host = absoluteBase.replace(/https?:\/\//, '');
    const debugResults = [];
    let closed = false;

    const onClose = () => { closed = true; };
    res.on('close', onClose);
    res.on('error', onClose);

    const safeWrite = data => {
        if (closed || res.writableEnded || res.destroyed) return false;
        try { res.write(data); return true; } catch { closed = true; return false; }
    };

    const promises = sources.map(async cfg => {
        if (closed) return;
        try {
            const result = await handleTestSource(cfg.key, id, s, e, clientIP, host);
            if (closed) return;
            const parsed = JSON.parse(result.body);
            debugResults.push({ source: cfg.key, ok: parsed.ok, error: parsed.error || null, elapsed_ms: parsed.elapsed_ms });
            if (parsed.ok && parsed.url && !sent.has(parsed.url)) {
                sent.add(parsed.url);
                safeWrite(`data: ${JSON.stringify({ type: 'source', source: { source: cfg.key, label: cfg.label ?? cfg.key, url: parsed.url } })}\n\n`);
            }
        } catch (err) {
            debugResults.push({ source: cfg.key, ok: false, error: err.message });
        }
    });

    await Promise.race([
        Promise.all(promises),
        new Promise(r => setTimeout(r, EARLY_CLOSE_MS)),
    ]);

    safeWrite(`data: ${JSON.stringify({ type: 'debug', results: debugResults })}\n\n`);
    return sent.size;
}

const respondJson = (status, data, extraHeaders) => ({
    status,
    body: JSON.stringify(data),
    headers: extraHeaders ? { ...JSON_CORS, ...extraHeaders } : JSON_CORS,
});

async function handleRequest(req, res) {
    const baseUrl = `http://${req.headers.host || 'localhost'}`;
    const reqUrl = new URL(req.url, baseUrl);
    const { pathname, searchParams } = reqUrl;
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || null;

    if (BLOCKED_IPS.has(clientIP)) return respondJson(403, { error: 'forbidden' });

    const now = Date.now();
    const rl = rateLimitMap.get(clientIP) || { count: 0, ts: now };
    if (now - rl.ts > 10_000) { rl.count = 0; rl.ts = now; }
    rl.count++;
    rateLimitMap.set(clientIP, rl);
    if (rl.count > 10) return respondJson(429, { error: 'rate limited' });

    if (req.method === 'OPTIONS') return { status: 204, body: '', headers: CORS_HEADERS };

    if (pathname === '/' || pathname === '') {
        return {
            status: 200,
            body: `${LOGO_TEXT}\n\ndeveloped_by: @vyla-entertainment\ngithub: https://github.com/vyla-entertainment\ndocs: https://vyla.mintlify.app\ndmca: https://vyla.mintlify.app/misc/dmca`,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
        };
    }

    if (pathname === '/test' || pathname === '/api/test') {
        const tests = {};
        ACTIVE_SOURCES.forEach(s => {
            tests[s.key] = { movie: `/api/test/155?source=${s.key}`, tv: `/api/test/1396?season=1&episode=1&source=${s.key}` };
        });
        return respondJson(200, tests);
    }

    if (pathname === '/health' || pathname === '/api/health') {
        const result = await handleHealth(SOURCE_MODULES, mainCache);
        return { ...result, headers: { ...result.headers, ...CORS_HEADERS } };
    }

    const absoluteBase = getAbsoluteBase(reqUrl.host);
    const getRequestedSources = () => {
        const raw = searchParams.get('sources')?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
        return raw.length ? ACTIVE_SOURCES.filter(s => raw.includes(s.key)) : ACTIVE_SOURCES;
    };

    const getRequestMeta = () => ({
        ip: clientIP,
        referer: req.headers['referer'] || null,
        origin: req.headers['origin'] || null,
        user_agent: req.headers['user-agent'] || null,
        host: req.headers['host'] || null,
        country: req.headers['cf-ipcountry'] || null,
        path: pathname,
        query: reqUrl.search || null,
    });

    const posthogTrack = (event, extra = {}) => {
        if (!posthog) return;
        posthog.capture({ distinctId: clientIP || 'anonymous', event, properties: { ...getRequestMeta(), ...extra } });
    };

    if (pathname === '/movie' || pathname === '/api/movie') {
        const id = searchParams.get('id');
        if (!id) return respondJson(400, { error: 'missing id', route: '/movie?id=:tmdb_id', example: '/movie?id=155' });

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS_HEADERS });

        const [meta, subtitles] = await Promise.all([
            getMetadata(id, null, null),
            fetchSubtitles([
                { base: SUBTITLE_BASES[0], path: `/movie/${id}` },
                { base: SUBTITLE_BASES[1], path: `/movie/${id}` },
                { base: SUBTITLE_BASES[2], path: `/movie/tt${id}` }
            ])
        ]);

        if (!res.writableEnded && !res.destroyed) {
            try { res.write(`data: ${JSON.stringify({ type: 'meta', meta, subtitles })}\n\n`); } catch { return null; }
        }

        posthogTrack('stream-movie', { id });
        const total = await streamSources(getRequestedSources(), id, null, null, clientIP, absoluteBase, res);
        if (!res.writableEnded && !res.destroyed) {
            try { res.write(`data: ${JSON.stringify({ type: 'done', total })}\n\n`); res.end(); } catch { }
        }
        return null;
    }

    if (pathname === '/tv' || pathname === '/api/tv') {
        const id = searchParams.get('id'), s = searchParams.get('season'), e = searchParams.get('episode');
        if (!id || !s || !e) return respondJson(400, { error: 'missing parameters', route: '/tv?id=:id&season=:s&episode=:e', example: '/tv?id=1396&season=1&episode=1' });

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS_HEADERS });

        const [meta, subtitles] = await Promise.all([
            getMetadata(id, s, e),
            fetchSubtitles([
                { base: SUBTITLE_BASES[0], path: `/tv/${id}/${s}/${e}` },
                { base: SUBTITLE_BASES[1], path: `/tv/${id}/${s}/${e}` },
                { base: SUBTITLE_BASES[2], path: `/tv/tt${id}/${s}/${e}` }
            ])
        ]);

        if (!res.writableEnded && !res.destroyed) {
            try { res.write(`data: ${JSON.stringify({ type: 'meta', meta, subtitles })}\n\n`); } catch { return null; }
        }

        posthogTrack('stream-tv', { id, season: s, episode: e });
        const total = await streamSources(getRequestedSources(), id, s, e, clientIP, absoluteBase, res);
        if (!res.writableEnded && !res.destroyed) {
            try { res.write(`data: ${JSON.stringify({ type: 'done', total })}\n\n`); res.end(); } catch { }
        }
        return null;
    }

    if (pathname === '/subtitle' || pathname === '/subtitles' || pathname === '/api/subtitle' || pathname === '/api/subtitles') {
        return respondJson(200, { routes: { movie: '/subtitles/movie/:id', tv: '/subtitles/tv/:id/:s/:e' }, examples: { movie: '/subtitles/movie/155', tv: '/subtitles/tv/1396/1/1' } });
    }

    if (pathname === '/download' || pathname === '/downloads' || pathname === '/api/download' || pathname === '/api/downloads') {
        return respondJson(200, { routes: { movie: '/downloads/movie/:id', tv: '/downloads/tv/:id/:s/:e' }, examples: { movie: '/downloads/movie/155', tv: '/downloads/tv/1396/1/1' } });
    }

    let match;

    match = ROUTE_PATTERNS.subtitleMovie.exec(pathname);
    if (match) { posthogTrack('subtitles-movie', { id: match[1] }); return handleSubtitleMovie(match[1], CORS_HEADERS); }

    match = ROUTE_PATTERNS.subtitleTv.exec(pathname);
    if (match) { posthogTrack('subtitles-tv', { id: match[1], season: match[2], episode: match[3] }); return handleSubtitleTv(match[1], match[2], match[3], CORS_HEADERS); }

    match = ROUTE_PATTERNS.downloadMovie.exec(pathname);
    if (match) { posthogTrack('downloads-movie', { id: match[1] }); return handleDownloadMovie(match[1], CORS_HEADERS); }

    match = ROUTE_PATTERNS.downloadTv.exec(pathname);
    if (match) { posthogTrack('downloads-tv', { id: match[1], season: match[2], episode: match[3] }); return handleDownloadTv(match[1], match[2], match[3], CORS_HEADERS); }

    match = ROUTE_PATTERNS.test.exec(pathname);
    if (match) {
        const source = searchParams.get('source');
        if (!source || !SOURCE_MAP[source]) return respondJson(400, { error: 'invalid or missing source' });
        const result = await handleTestSource(source, match[1], searchParams.get('season') || searchParams.get('s') || null, searchParams.get('episode') || searchParams.get('e') || null, clientIP, reqUrl.host);
        posthogTrack('test', { source, id: match[1], ok: JSON.parse(result.body).ok });
        return { status: result.status, body: result.body, headers: JSON_CORS };
    }

    match = ROUTE_PATTERNS.debug.exec(pathname);
    if (match) {
        const id = match[1];
        const s = searchParams.get('season') || searchParams.get('s') || null;
        const e = searchParams.get('episode') || searchParams.get('e') || null;
        const sourceKey = searchParams.get('source');

        if (!sourceKey) return respondJson(400, { error: 'missing source' });

        const mod = SOURCE_MODULES[sourceKey];
        const cfg = SOURCE_MAP[sourceKey];
        if (!mod) return respondJson(400, { error: `unknown source: ${sourceKey}` });

        const t0 = Date.now();
        let streamResult = null, streamError = null;
        const fetchTrace = [];

        const tracingFetch = async (url, opts) => {
            const start = Date.now();
            try {
                const r = await _nativeFetch(url, opts);
                fetchTrace.push({ url: String(url).slice(0, 200), status: r.status, ok: r.ok, ms: Date.now() - start });
                return r;
            } catch (err) {
                fetchTrace.push({ url: String(url).slice(0, 200), error: err.message, ms: Date.now() - start });
                throw err;
            }
        };

        const prev = globalThis.fetch;
        globalThis.fetch = tracingFetch;
        try {
            const audio = /dub$/.test(sourceKey) ? 'dub' : 'sub';
            streamResult = (await mod.getStream({ id, s, e, clientIP: null, absoluteBase, audio, config: cfg }))
                ?? (await mod.getStream({ id, s, e, clientIP: null, absoluteBase: isFallbackNeeded(reqUrl.host) ? FALLBACK_BASE : '', audio, config: cfg }));
        } catch (err) {
            streamError = err.message;
        } finally {
            globalThis.fetch = prev;
        }

        const candidates = streamResult?.allUrls || (streamResult ? [streamResult] : []);

        const checks = await Promise.all(candidates.slice(0, 3).map(async (raw, i) => {
            const rawUrl = typeof raw === 'object' ? raw.url : raw;
            const rawHeaders = (typeof raw === 'object' && raw.headers) ? raw.headers : {};
            const wrappedUrl = wrapUrl(typeof raw === 'object' ? raw : { url: raw }, sourceKey, absoluteBase);

            let m3u8Preview = null, mp4Preview = null, playable_check = null;
            try {
                if (raw?.skipProxy) return { index: i, raw_url: rawUrl, proxy_url: rawUrl, playable_check: { ok: true, error: null }, m3u8_preview: 'skipped: direct client playback', mp4_preview: null };
                const fetchUrl = wrappedUrl || rawUrl;
                const fetchHeaders = wrappedUrl ? { 'User-Agent': getUA() } : { 'User-Agent': getUA(), ...rawHeaders };
                const r = await _nativeFetch(fetchUrl, { signal: AbortSignal.timeout(15_000), headers: { ...fetchHeaders, 'Range': 'bytes=0-511' } });
                const ct = (r.headers.get('content-type') || '').toLowerCase();
                const isMp4 = /\.mp4(\?|$)/i.test(fetchUrl) || ct.includes('video/mp4') || ct.includes('video/mp2t') || ct.includes('octet-stream');
                if (isMp4) {
                    const bytes = new Uint8Array(await r.arrayBuffer());
                    mp4Preview = Array.from(bytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    playable_check = { ok: r.ok || r.status === 206, error: (r.ok || r.status === 206) ? null : `mp4 fetch failed: ${r.status}` };
                } else {
                    m3u8Preview = (await r.text()).slice(0, 400);
                    playable_check = await verifyPlayable(fetchUrl, fetchHeaders, !wrappedUrl);
                }
            } catch (err) { playable_check = { ok: false, error: err.message }; }

            return { index: i, raw_url: rawUrl, proxy_url: wrappedUrl, playable_check, m3u8_preview: m3u8Preview, mp4_preview: mp4Preview };
        }));

        return respondJson(200, {
            source: sourceKey, id, candidates: candidates.length, checks,
            elapsed_ms: Date.now() - t0, stream_error: streamError, fetch_trace: fetchTrace,
            got_result: streamResult !== null, result_keys: streamResult ? Object.keys(streamResult) : null,
        });
    }

    if (pathname === '/api' || pathname === '/api/') {
        const url = searchParams.get('url') || searchParams.get('proxy');

        if (url) {
            if (IS_HF && searchParams.get('lm') === '1') {
                return { status: 302, body: '', headers: { 'Location': FALLBACK_BASE + req.url, ...CORS_HEADERS } };
            }

            try {
                new URL(url);

                const extraHeaders = {};
                const proxyHeaders = searchParams.get('proxyHeaders');
                if (proxyHeaders) try { Object.assign(extraHeaders, JSON.parse(safeDecode(proxyHeaders))); } catch { }
                if (!extraHeaders['User-Agent'] && !extraHeaders['user-agent']) extraHeaders['User-Agent'] = getUA();
                delete extraHeaders['Host'];

                let matchedSource = null;
                for (const [param, cfg] of PROXY_PARAM_MAP) {
                    if (searchParams.has(param)) { matchedSource = cfg; break; }
                }

                let cleanUrl = url;
                if (matchedSource) {
                    const isVodvidl = /vodvidl\.site|vidldl\.site|vidldr\.site/i.test(url);
                    if (!isVodvidl) {
                        try {
                            const qIndex = url.indexOf('?');
                            if (qIndex !== -1) {
                                const params = new URLSearchParams(url.slice(qIndex + 1));
                                params.delete('host');
                                cleanUrl = `${url.slice(0, qIndex)}${params.toString() ? '?' + params.toString() : ''}`;
                            }
                        } catch { }
                    }
                    applyCdnHeaders(isVodvidl ? url : cleanUrl, extraHeaders, matchedSource.key);
                }

                const upstream = await fetchUpstream(cleanUrl, extraHeaders, 30_000);
                const ct = (upstream.headers.get('content-type') || '').toLowerCase();
                const looksLikeM3u8 = M3U8_REGEX.test(cleanUrl) || cleanUrl.includes('/playlist/') || cleanUrl.includes('/streamsvr/') || ct.includes('mpegurl') || ct.includes('m3u8');

                if (looksLikeM3u8) {
                    const text = await upstream.text();
                    if (text.trim().startsWith('#EXT') || /megacloud\.animanga\.fun\/(ts-proxy|proxy)/i.test(text.slice(0, 200))) {
                        const isTesub = matchedSource?.proxyParam === 'tesub';
                        const extraParam = matchedSource ? `&${matchedSource.proxyParam}=1&proxyHeaders=${encodeURIComponent(JSON.stringify(extraHeaders))}` : '&vn=1';
                        const rewritten = isTesub
                            ? rewriteM3u8KeyOnly(text, cleanUrl, extraParam, absoluteBase)
                            : rewriteM3u8(text, matchedSource ? cleanUrl : url, extraParam, absoluteBase);
                        return { status: 200, body: rewritten, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...CORS_HEADERS } };
                    }
                    return { status: 502, body: `expected m3u8 but got: ${text.slice(0, 100)}`, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } };
                }

                if (matchedSource) {
                    const isTikTok = TIKTOK_REGEX.test(cleanUrl);
                    const isMkv = cleanUrl.includes('.mkv') || ct.includes('matroska');
                    const isPngMasked = ct === 'image/png' || ct === 'image/jpeg' || /\.png(\?|$)/i.test(cleanUrl) || /letsgocdn\d+\.shop/i.test(cleanUrl);
                    const needsStrip = searchParams.has('tt') || STRIP_REGEX.test(cleanUrl);

                    if (isTikTok || isPngMasked || needsStrip) {
                        if (!upstream.ok) return { status: upstream.status, body: `upstream ${upstream.status}`, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } };
                        const full = Buffer.from(await upstream.arrayBuffer());
                        const stripped = (full[0] === 0x89 || full[0] === 0xFF || full[0] === 0x00) ? full.subarray(120) : full;
                        return { status: 200, body: stripped, headers: { 'Content-Type': 'video/MP2T', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } };
                    }

                    if (!upstream.ok) return { status: upstream.status, body: `upstream ${upstream.status}`, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } };

                    const rangeHeader = req.headers['range'];
                    const streamUpstream = rangeHeader
                        ? await _nativeFetch(cleanUrl, { headers: { 'User-Agent': getUA(), ...extraHeaders, 'Range': rangeHeader }, redirect: 'follow' })
                        : upstream;

                    const responseHeaders = {
                        'Content-Type': isMkv || ct === 'application/octet-stream' ? 'video/mp4' : (ct || 'video/mp4'),
                        'Accept-Ranges': 'bytes',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-store',
                    };
                    if (streamUpstream.headers.has('content-length')) responseHeaders['Content-Length'] = streamUpstream.headers.get('content-length');
                    if (streamUpstream.headers.has('content-range')) responseHeaders['Content-Range'] = streamUpstream.headers.get('content-range');

                    return { status: rangeHeader && streamUpstream.status === 206 ? 206 : 200, stream: streamUpstream.body, headers: responseHeaders };
                }

                const full = Buffer.from(await upstream.arrayBuffer());
                const needsStrip = searchParams.has('tt') || TIKTOK_REGEX.test(url) || STRIP_REGEX.test(url);
                const stripped = (needsStrip && (full[0] === 0x89 || full[0] === 0xFF || full[0] === 0x00)) ? full.subarray(120) : full;
                return { status: 200, body: stripped, headers: { 'Content-Type': 'video/MP2T', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' } };
            } catch (e) {
                return respondJson(502, { error: e.message });
            }
        }

        if (searchParams.has('sources_meta')) {
            return respondJson(200, { sources: ACTIVE_SOURCES.map(c => ({ key: c.key, label: c.label, timeout: c.timeout })) });
        }

        if (searchParams.has('tmdb_movie') || searchParams.has('tmdb_tv') || searchParams.has('tmdb_show') || searchParams.has('tmdb_season')) {
            const k = process.env.TMDB_API_KEY;
            if (!k) return respondJson(500, { error: 'no key' });
            const tmdbId = searchParams.get('id'), tmdbSeason = searchParams.get('s');
            let tmdbUrl;
            if (searchParams.has('tmdb_season')) tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${tmdbSeason}?api_key=${k}`;
            else if (searchParams.has('tmdb_movie')) tmdbUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${k}${searchParams.has('append_to_response') ? `&append_to_response=${searchParams.get('append_to_response')}` : ''}`;
            else tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${k}`;
            try { const r = await _nativeFetch(tmdbUrl); return respondJson(200, await r.json()); }
            catch (err) { return respondJson(500, { error: err.message }); }
        }

        return respondJson(400, { error: 'missing parameters' });
    }

    return respondJson(404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
    req.socket.setTimeout(90_000);
    req.socket.setNoDelay(true);

    try {
        const result = await handleRequest(req, res);
        if (result === null || res.headersSent || res.writableEnded || res.destroyed) return;

        const headers = result.headers || {};
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        res.writeHead(result.status, headers);

        if (result.stream) {
            const readable = Readable.fromWeb(result.stream);
            readable.on('error', () => { try { res.destroy(); } catch { } });
            res.on('error', () => { try { readable.destroy(); } catch { } });
            readable.pipe(res);
        } else {
            res.end(result.body ?? '');
        }
    } catch {
        if (!res.headersSent) {
            try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal server error"}'); } catch { }
        }
    }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.maxHeadersCount = 100;
server.timeout = 90_000;

server.on('error', err => { if (err.code !== 'EADDRINUSE') console.error('server error', err.message); });
server.listen(PORT, '0.0.0.0', () => console.log(`http://localhost:${PORT}`));