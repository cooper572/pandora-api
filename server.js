import cluster from 'cluster';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PostHog } from 'posthog-node';
import dotenv from 'dotenv';
import http from 'http';
import { SOURCES, SOURCE_MAP, CACHE_TTL } from './config.js';
import { fetchSubtitles, handleSubtitleMovie, handleSubtitleTv, SUBTITLE_BASES } from './src/routes/subtitles.js';
import { handleDownloadMovie, handleDownloadTv } from './src/routes/downloads.js';
import { handleHealth } from './src/routes/health.js';
import { Readable } from 'stream';

dotenv.config();

const rateLimitMap = new Map();
const BLOCKED_IPS = new Set(['45.150.110.57']);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let LOGO_TEXT = '';
try { LOGO_TEXT = fs.readFileSync(path.join(__dirname, 'public/logo.txt'), 'utf8'); } catch { }

const posthog = process.env.POSTHOG_API_KEY
    ? new PostHog(process.env.POSTHOG_API_KEY, { host: 'https://us.i.posthog.com', flushAt: 20, flushInterval: 10000 })
    : null;

process.on('exit', () => posthog?.shutdown());
process.on('SIGTERM', async () => { await posthog?.shutdown(); process.exit(0); });

if (cluster.isPrimary) {
    const cpus = (await import('os')).default.cpus().length;
    const workerCount = process.env.SPACE_ID ? Math.min(cpus, 4) : 1;
    const sharedCache = new Map();
    const pruneCache = (map) => {
        const now = Date.now();
        for (const [k, v] of map) {
            if (now - v.ts > v.ttl) map.delete(k);
        }
    };
    const cacheSetInterval = setInterval(() => pruneCache(sharedCache), 30000);
    cacheSetInterval.unref();

    for (let i = 0; i < workerCount; i++) {
        const w = cluster.fork({ WORKER_ID: String(i) });
        w.on('online', () => w.send({ type: 'worker:id', id: i }));
    }

    cluster.on('message', (worker, msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === 'cache:get') {
            const entry = sharedCache.get(msg.key);
            const now = Date.now();
            if (entry && now - entry.ts <= entry.ttl) {
                worker.send({ type: 'cache:hit', id: msg.id, value: entry.value });
            } else {
                if (entry) sharedCache.delete(msg.key);
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
            return;
        }
    });

    const toWatch = [
        fileURLToPath(import.meta.url),
        './config.js',
        './src/routes/subtitles.js',
        './src/routes/downloads.js',
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
    toWatch.forEach(f => { try { fs.watch(f, scheduleRestart); } catch { } });

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

const _originalFetch = globalThis.fetch;
const IS_HF = !!process.env.SPACE_ID;

const FALLBACK_BASES = process.env.PROXY_BASES
    ? process.env.PROXY_BASES.split(',').map(s => s.trim()).filter(Boolean)
    : ['https://boltunblocker.com/strapi'];

let fallbackBaseIndex = 0;
const getNextFallbackBase = () => {
    const base = FALLBACK_BASES[fallbackBaseIndex % FALLBACK_BASES.length];
    fallbackBaseIndex = (fallbackBaseIndex + 1) % FALLBACK_BASES.length;
    return base;
};
const FALLBACK_BASE = FALLBACK_BASES[0];

const NEED_PROXY_REGEX = /https?:\/\/(api2?\.videasy\.net|api\.dmvdriverseducation\.org|api\.tulnex\.com|strategicgrowthpartners\.site|cloudnestra\.com|(www\.)?lookmovie2?\.to|(www\.)?lookmovie\.foundation|.*\.theaky\.store|.*\.akamaihd\.net|.*\.vix-content\.net|vixsrc\.to|.*\.hakunaymatata\.com|vsembed\.ru|.*\.vodvidl\.site|.*\.vidldl\.site|.*\.vidldr\.site|typhoontigertribe\.net|skywardslothnetwork\.net)/i;
const M3U8_REGEX = /\.m3u8?(\?|$)|mpegurl|m3u8/i;
const TIKTOK_REGEX = /tiktokcdn\.com|ibyteimg\.com/i;
const STRIP_REGEX = /seg\.html|enproxy|letsgocdn\d+\.shop/i;

const outboundInflight = new Map();

async function dedupedFetch(url, opts) {
    const urlStr = typeof url === 'string' ? url : String(url);
    const key = urlStr.slice(0, 200);
    const existing = outboundInflight.get(key);
    if (existing) return existing;
    const p = _originalFetch(url, opts).finally(() => outboundInflight.delete(key));
    outboundInflight.set(key, p);
    return p;
}

let proxyActiveCount = 0;
const PROXY_CONCURRENCY = IS_HF ? 40 : 300;
const proxyQueue = [];

function runProxyQueue() {
    while (proxyQueue.length > 0 && proxyActiveCount < PROXY_CONCURRENCY) {
        const { resolve } = proxyQueue.shift();
        proxyActiveCount++;
        resolve();
    }
}

async function throttledFetch(url, opts) {
    if (proxyActiveCount >= PROXY_CONCURRENCY) {
        await new Promise(resolve => proxyQueue.push({ resolve }));
    } else {
        proxyActiveCount++;
    }
    try {
        return await _originalFetch(url, opts);
    } finally {
        proxyActiveCount--;
        runProxyQueue();
    }
}

const HF_FETCH_TIMEOUT = 25000;

globalThis.fetch = (url, opts) => {
    const urlStr = typeof url === 'string' ? url : url?.href ?? String(url);
    if (IS_HF && NEED_PROXY_REGEX.test(urlStr)) {
        const base = getNextFallbackBase();
        let proxied = `${base}/api?url=${encodeURIComponent(urlStr)}&vn=1`;
        if (opts?.headers) proxied += `&proxyHeaders=${encodeURIComponent(JSON.stringify(opts.headers))}`;
        const mergedOpts = opts ? { ...opts } : {};
        if (!mergedOpts.signal) mergedOpts.signal = AbortSignal.timeout(HF_FETCH_TIMEOUT);
        return _originalFetch(proxied, mergedOpts);
    }
    if (!opts?.signal) return _originalFetch(url, { ...opts, signal: AbortSignal.timeout(HF_FETCH_TIMEOUT) });
    return _originalFetch(url, opts);
};

class LRUCache {
    constructor(max, ttl) { this.max = max; this.ttl = ttl; this.map = new Map(); }
    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > this.ttl) { this.map.delete(key); return undefined; }
        this.map.delete(key); this.map.set(key, entry);
        return entry.val;
    }
    set(key, val) {
        if (this.map.has(key)) this.map.delete(key);
        else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
        this.map.set(key, { val, ts: Date.now() });
    }
    has(key) {
        const entry = this.map.get(key);
        if (!entry) return false;
        if (Date.now() - entry.ts > this.ttl) { this.map.delete(key); return false; }
        return true;
    }
    get size() { return this.map.size; }
}

const mainCache = new LRUCache(2000, CACHE_TTL);
const hlsVerifyCache = new LRUCache(1000, 180000);
const metaCache = new LRUCache(500, 1800000);
const testResultCache = new LRUCache(1000, 90000);
const inflightMap = new Map();
const sharedInflight = new Map();

let msgIdCounter = 0;
const pendingMsgs = new Map();

function ipcSend(msg) {
    return new Promise((resolve) => {
        const id = ++msgIdCounter;
        pendingMsgs.set(id, resolve);
        try { process.send({ ...msg, id }); } catch { pendingMsgs.delete(id); resolve(null); return; }
        setTimeout(() => { if (pendingMsgs.has(id)) { pendingMsgs.delete(id); resolve(null); } }, 150);
    });
}

process.on('message', (msg) => {
    if (!msg) return;
    if (msg.type === 'worker:id') return;
    if (msg.type === 'cache:hit' || msg.type === 'cache:miss') {
        const resolve = pendingMsgs.get(msg.id);
        if (resolve) { pendingMsgs.delete(msg.id); resolve(msg); }
        return;
    }
    if (msg.type === 'cache:push') {
        if (msg.key && msg.value !== undefined) {
            mainCache.set(msg.key, msg.value);
            testResultCache.set(msg.key, msg.value);
        }
    }
});

async function sharedCacheGet(key) {
    const local = mainCache.get(key);
    if (local !== undefined) return local;
    if (!process.send) return undefined;
    const reply = await ipcSend({ type: 'cache:get', key });
    if (reply?.type === 'cache:hit') {
        mainCache.set(key, reply.value);
        return reply.value;
    }
    return undefined;
}

function sharedCacheSet(key, value, ttl) {
    mainCache.set(key, value);
    testResultCache.set(key, value);
    if (process.send) {
        try { process.send({ type: 'cache:set', key, value, ttl: ttl || CACHE_TTL }); } catch { }
    }
}

const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];
const getUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

function posthogTrack(event, data, distinctId) {
    if (!posthog) return;
    posthog.capture({ distinctId: distinctId || 'anonymous', event, properties: data });
}

const getRequestMeta = (req, reqUrl) => ({
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    referer: req.headers['referer'] || null,
    origin: req.headers['origin'] || null,
    user_agent: req.headers['user-agent'] || null,
    host: req.headers['host'] || null,
    country: req.headers['cf-ipcountry'] || null,
    path: reqUrl.pathname,
    query: reqUrl.search || null,
});

const ALL_SOURCE_MODULES = Object.fromEntries(
    await Promise.all(SOURCES.map(async cfg => [cfg.key, await import(`./src/sources/${cfg.sourceFile}.js`)]))
);

const SOURCE_MODULES = Object.fromEntries(Object.entries(ALL_SOURCE_MODULES).filter(([key]) => !SOURCE_MAP[key]?.disabled));
const ACTIVE_SOURCES = SOURCES.filter(c => !c.disabled);

const getAbsoluteBase = host => (host.startsWith('localhost') || host.startsWith('127.0.0.1')) ? `http://${host}` : `https://${host}`;
const getEffectiveBase = abs => IS_HF ? getNextFallbackBase() : abs;
const isFallbackNeeded = host => !host.startsWith('localhost') && !host.startsWith('127.0.0.1');

function getCached(key, fn, cache = mainCache) {
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const inflight = inflightMap.get(key);
    if (inflight) return inflight;
    const p = fn().then(val => { inflightMap.delete(key); if (val != null) cache.set(key, val); return val; }, err => { inflightMap.delete(key); throw err; });
    inflightMap.set(key, p);
    return p;
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
    })().then(val => { sharedInflight.delete(key); return val; }, err => { sharedInflight.delete(key); throw err; });
    sharedInflight.set(key, p);
    return p;
}

const jitter = ms => ms > 0 ? new Promise(r => setTimeout(r, Math.random() * ms)) : Promise.resolve();

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

const PROXY_PARAM_MAP = new Map(ACTIVE_SOURCES.map(cfg => [cfg.proxyParam, cfg]));
const withTimeout = (promise, ms) => {
    let t;
    return Promise.race([promise.then(v => { clearTimeout(t); return v; }), new Promise(r => { t = setTimeout(() => r(null), ms); })]);
};

async function fetchUpstream(url, extraHeaders = {}, timeoutMs = 30000) {
    let current = url.startsWith('http://') ? 'https://' + url.slice(7) : url;
    const headers = { 'User-Agent': getUA(), ...extraHeaders };
    const opts = { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };
    for (let i = 0; i <= 5; i++) {
        const res = await _originalFetch(current, opts);
        if (res.status < 300 || res.status >= 400 || !res.headers.has('location')) return res;
        res.body?.cancel();
        const loc = res.headers.get('location');
        current = loc.startsWith('http') ? (loc.startsWith('http://') ? 'https://' + loc.slice(7) : loc) : new URL(loc, current).href;
    }
    throw new Error('redirect loop');
}

const _processUri = (uri, dir, originBase) => {
    const abs = uri.startsWith('http') ? uri : uri.startsWith('/') ? originBase + uri : dir + uri;
    const decoded = safeDecode(abs.startsWith('http://') ? 'https://' + abs.slice(7) : abs);
    return decoded.startsWith('http') ? decoded : abs.startsWith('http://') ? 'https://' + abs.slice(7) : abs;
};

const _STRIP_TEST = /seg\.html|enproxy|tiktokcdn|ibyteimg/i;
const _URI_REPLACE = /URI="([^"]+)"/g;

function _unwrapProxyUrl(url) {
    try {
        const parsed = new URL(url);
        const inner = parsed.searchParams.get('url');
        if (inner) return decodeURIComponent(inner);
    } catch { }
    return url;
}

function rewriteM3u8KeyOnly(body, url, extraParam, absoluteBase) {
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
            out[i] = t.replace(_URI_REPLACE, (_, uri) => {
                const resolved = _processUri(uri, dir, originBase);
                const unwrapped = _unwrapProxyUrl(resolved);
                return `URI="${prefix}${encodeURIComponent(unwrapped)}${extraParam}"`;
            });
        } else {
            const normalized = _processUri(t, dir, originBase);
            out[i] = _unwrapProxyUrl(normalized);
        }
    }
    return out.join('\n');
}

function rewriteM3u8(body, url, extraParam, absoluteBase) {
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
            out[i] = t.replace(_URI_REPLACE, (_, uri) => {
                const resolved = _processUri(uri, dir, originBase);
                const unwrapped = _unwrapProxyUrl(resolved);
                return `URI="${prefix}${encodeURIComponent(unwrapped)}${extraParam}"`;
            });
        } else {
            const normalized = _processUri(t, dir, originBase);
            const unwrapped = _unwrapProxyUrl(normalized);
            out[i] = `${prefix}${encodeURIComponent(unwrapped)}${extraParam}${_STRIP_TEST.test(unwrapped) ? '&tt=1' : ''}`;
        }
    }
    return out.join('\n');
}

function fetchSource(cfg, cacheKey, id, s, e, clientIP, absoluteBase, fallbackBase) {
    const mod = SOURCE_MODULES[cfg.key];
    const effectiveBase = getEffectiveBase(absoluteBase);
    const audio = /dub$/.test(cfg.key) ? 'dub' : 'sub';

    if (cfg.skipCache) {
        return withTimeout(jitter(cfg.jitter).then(() =>
            withRetry(() => mod.getStream({ id, s, e, clientIP, absoluteBase: effectiveBase, audio, config: cfg }), cfg.retries, 300)
        ), cfg.timeout);
    }

    if (cfg.multiBase) {
        return withTimeout(jitter(cfg.jitter).then(async () => {
            for (const base of mod.BASES) {
                const res = await getSharedCached(`${cfg.key}-${base}-${cacheKey}`, () => withRetry(() => mod.getStream({ id, s, e, clientIP, absoluteBase: base, audio, config: cfg }), cfg.retries, 300));
                if (res) return res;
            }
            return null;
        }), cfg.timeout);
    }

    const primaryTimeout = fallbackBase ? Math.floor(cfg.timeout * 0.6) : cfg.timeout;
    return withTimeout(jitter(cfg.jitter).then(async () => {
        const primary = await withTimeout(
            getSharedCached(`${cfg.key}-${cacheKey}`, () => withRetry(() => mod.getStream({ id, s, e, clientIP, absoluteBase: effectiveBase, audio, config: cfg }), cfg.retries, 300)),
            primaryTimeout
        );
        if (primary) return primary;
        if (!fallbackBase) return null;
        return withTimeout(
            getSharedCached(`${cfg.key}-fallback-${cacheKey}`, () => withRetry(() => mod.getStream({ id, s, e, clientIP, absoluteBase: fallbackBase, audio, config: cfg }), cfg.retries, 300)),
            cfg.timeout - primaryTimeout
        );
    }), cfg.timeout);
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
    if (typeof rawUrl === 'object' && rawUrl.headers) wrapped += `&proxyHeaders=${encodeURIComponent(JSON.stringify(rawUrl.headers))}`;
    return wrapped;
}

function applyCdnHeaders(cleanUrl, extraHeaders, sourceKey) {
    const cfg = SOURCE_MAP[sourceKey];
    if (!cfg?.cdnHeaders) return;
    for (const rule of cfg.cdnHeaders) {
        if (rule.pattern.test(cleanUrl)) { Object.assign(extraHeaders, rule.headers); return; }
    }
}

async function verifyStream(rawUrl, sourceKey) {
    const cfg = SOURCE_MAP[sourceKey];
    if (cfg?.skipVerify) return true;
    const cacheKey = `vstream-${rawUrl}`;
    const cached = hlsVerifyCache.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
        const res = await _originalFetch(rawUrl, {
            method: 'HEAD',
            headers: { 'User-Agent': getUA(), ...(cfg?.verifyHeaders || {}) },
            redirect: 'follow',
            signal: AbortSignal.timeout(6000),
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
            const inner = new URL(proxiedUrl);
            const rawUrl = decodeURIComponent(inner.searchParams.get('url') || '');
            const ph = inner.searchParams.get('proxyHeaders');
            if (ph) try { Object.assign(extraHeaders, JSON.parse(decodeURIComponent(ph))); } catch { }
            if (rawUrl) proxiedUrl = rawUrl;
        } catch { }
        skipProxyCheck = true;
    }
    const cached = hlsVerifyCache.get(proxiedUrl);
    if (cached !== undefined) return cached;
    const store = val => { hlsVerifyCache.set(proxiedUrl, val); return val; };
    const fail = error => ({ ok: false, error });
    try {
        const m3u8Res = await _originalFetch(proxiedUrl, {
            signal: AbortSignal.timeout(12000),
            headers: extraHeaders['User-Agent'] ? extraHeaders : { 'User-Agent': getUA(), ...extraHeaders },
        });
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
                const fetchOpts = { method: 'GET', headers: { 'User-Agent': getUA(), ...extraHeaders, 'Range': 'bytes=0-1024' }, signal: AbortSignal.timeout(10000) };
                const nextRes = await _originalFetch(nextUrl, fetchOpts);
                if (!nextRes.ok && nextRes.status !== 206) return fail(`Variant failed: ${nextRes.status}`);
                const ct = (nextRes.headers.get('content-type') || '').toLowerCase();
                if (ct.includes('mpegurl') || ct.includes('m3u8') || nextUrl.includes('.m3u8')) {
                    let segUrl = null;
                    for (const l of (await nextRes.text()).split('\n')) {
                        const t = l.trim();
                        if (t && t.charCodeAt(0) !== 35) { segUrl = t; break; }
                    }
                    if (segUrl) {
                        if (!segUrl.startsWith('http')) segUrl = new URL(segUrl, nextUrl).href;
                        const segRes = await _originalFetch(segUrl, fetchOpts);
                        if (!segRes.ok && segRes.status !== 206 && segRes.status !== 403) return fail(`Segment failed: ${segRes.status}`);
                    }
                }
            }
        }
        return store({ ok: true, error: null });
    } catch (err) {
        return fail(err.message);
    }
}

async function getMetadata(id, s, e) {
    const cacheKey = `meta-${id}-${s || ''}-${e || ''}`;
    return getSharedCached(cacheKey, async () => {
        const k = process.env.TMDB_API_KEY;
        if (!k) return { error: 'TMDB API key not configured' };
        const url = s ? `https://api.themoviedb.org/3/tv/${id}/season/${s}/episode/${e || 1}?api_key=${k}` : `https://api.themoviedb.org/3/movie/${id}?api_key=${k}`;
        const res = await _originalFetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) { res.body?.cancel(); return { error: `TMDB API error: ${res.status}` }; }
        return res.json();
    }, 1800000);
}

let globalTestConcurrency = 0;
const MAX_GLOBAL_TEST_CONCURRENCY = IS_HF ? 30 : 300;
const testQueue = [];

function runTestQueue() {
    while (testQueue.length > 0 && globalTestConcurrency < MAX_GLOBAL_TEST_CONCURRENCY) {
        const { resolve } = testQueue.shift();
        globalTestConcurrency++;
        resolve();
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

    const cacheKey = `test-${sourceKey}-${id}-${s || ''}-${e || ''}`;
    const localCached = testResultCache.get(cacheKey);
    if (localCached !== undefined) return respond(localCached.ok, localCached.url, localCached.raw_url, localCached.error);
    const shared = await sharedCacheGet(cacheKey);
    if (shared !== undefined) { testResultCache.set(cacheKey, shared); return respond(shared.ok, shared.url, shared.raw_url, shared.error); }

    const inflightKey = `inflight-${cacheKey}`;
    const existingInflight = sharedInflight.get(inflightKey);
    if (existingInflight) {
        try { const result = await existingInflight; return respond(result?.ok ?? false, result?.url ?? null, result?.raw_url ?? null, result?.error ?? null); }
        catch { return respond(false, null, null, 'deduped request failed'); }
    }

    await acquireTestSlot();
    const testPromise = (async () => {
        try {
            let rawResult = null, fetchError = null;
            try {
                rawResult = await fetchSource(cfg, `${id}-${s || ''}-${e || ''}`, id, s, e, clientIP, absoluteBase, isFallbackNeeded(host) ? getNextFallbackBase() : '');
                if (!rawResult) {
                    const audio = /dub$/.test(cfg.key) ? 'dub' : 'sub';
                    rawResult = await withTimeout(mod.getStream({ id, s, e, clientIP: null, absoluteBase: getEffectiveBase(absoluteBase), audio, config: cfg }), 20000);
                }
                if (!rawResult && isFallbackNeeded(host)) {
                    const audio = /dub$/.test(cfg.key) ? 'dub' : 'sub';
                    rawResult = await withTimeout(mod.getStream({ id, s, e, clientIP: null, absoluteBase: getNextFallbackBase(), audio, config: cfg }), 20000);
                }
            } catch (err) { fetchError = err.message; }

            const candidates = rawResult?.allUrls?.length
                ? rawResult.allUrls.map(u => typeof u === 'object' ? u : { url: u })
                : (Array.isArray(rawResult) ? rawResult.map(u => typeof u === 'object' ? u : { url: u })
                    : (rawResult ? [{ url: typeof rawResult === 'object' ? rawResult.url : rawResult, headers: rawResult?.headers, skipProxy: rawResult?.skipProxy, skipHlsCheck: rawResult?.skipHlsCheck }] : []));

            for (const candidate of candidates) {
                const wrappedUrl = wrapUrl(candidate, sourceKey, absoluteBase);
                if (!wrappedUrl) continue;
                if (candidate?.skipProxy) {
                    const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                    testResultCache.set(cacheKey, result); sharedCacheSet(cacheKey, result, 90000); return result;
                }
                if (candidate?.skipHlsCheck) {
                    try {
                        const r = await _originalFetch(candidate.url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': getUA(), ...(candidate.headers || {}) } });
                        if (!r.ok) continue;
                        const ct = (r.headers.get('content-type') || '').toLowerCase();
                        const text = ct.includes('video') || ct.includes('octet-stream') ? null : await r.text();
                        if (text !== null && !text.trim().startsWith('#EXTM3U')) continue;
                        if (text !== null && /Too Many Requests/m.test(text)) continue;
                        if (text !== null && !text.includes('#EXTINF') && !text.includes('#EXT-X-STREAM-INF')) continue;
                        const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                        testResultCache.set(cacheKey, result); sharedCacheSet(cacheKey, result, 90000); return result;
                    } catch { continue; }
                }
                if (cfg.skipVerify || cfg.multiUrl) {
                    const checkUrl = IS_HF ? candidate.url : wrappedUrl;
                    const checkHeaders = IS_HF ? (candidate.headers || {}) : {};
                    const playableCheck = await verifyPlayable(checkUrl, checkHeaders, true);
                    if (playableCheck.ok || /timeout|aborted/.test(playableCheck.error)) {
                        const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                        if (!rawResult?.skipCache) { testResultCache.set(cacheKey, result); sharedCacheSet(cacheKey, result, 90000); }
                        return result;
                    }
                    try {
                        const headRes = await _originalFetch(candidate.url, { method: 'HEAD', headers: { 'User-Agent': getUA(), ...(candidate.headers || {}) }, signal: AbortSignal.timeout(6000), redirect: 'follow' });
                        headRes.body?.cancel();
                        const ct = (headRes.headers.get('content-type') || '').toLowerCase();
                        if (headRes.status < 400 && /video|octet-stream|mp4/.test(ct)) {
                            const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                            testResultCache.set(cacheKey, result); sharedCacheSet(cacheKey, result, 90000); return result;
                        }
                    } catch { }
                } else {
                    if (!(await verifyStream(candidate.url, sourceKey))) continue;
                    const verifyUrl = IS_HF ? candidate.url : wrappedUrl;
                    const verifyHeaders = IS_HF ? (candidate.headers || {}) : {};
                    const playableCheck = await verifyPlayable(verifyUrl, verifyHeaders, IS_HF);
                    if (!playableCheck.ok) {
                        const rawHeaders = candidate?.headers || {};
                        const [proxiedBody, rawCheck] = await Promise.all([
                            _originalFetch(wrappedUrl, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': getUA() } }).then(r => r.text()).then(t => t.slice(0, 200)).catch(e => e.message),
                            verifyPlayable(candidate.url, rawHeaders, true),
                        ]);
                        return { ok: false, url: null, raw_url: candidate.url, error: playableCheck.error, debug: { proxy_failed: true, proxy_error: playableCheck.error, proxy_body_preview: proxiedBody, raw_reachable: rawCheck.ok, raw_error: rawCheck.error, raw_headers_used: rawHeaders, proxied_url: wrappedUrl } };
                    }
                    const result = { ok: true, url: wrappedUrl, raw_url: candidate.url };
                    testResultCache.set(cacheKey, result); sharedCacheSet(cacheKey, result, 90000); return result;
                }
            }
            return { ok: false, url: null, raw_url: candidates[0]?.url || null, error: fetchError };
        } finally { releaseTestSlot(); sharedInflight.delete(inflightKey); }
    })();
    sharedInflight.set(inflightKey, testPromise);
    const result = await testPromise;
    return respond(result?.ok ?? false, result?.url ?? null, result?.raw_url ?? null, result?.error ?? null, result?.debug ?? null);
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin, Accept, Access-Control-Request-Method, Access-Control-Request-Headers',
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Max-Age': '86400',
};

const JSON_CORS = { 'Content-Type': 'application/json', ...CORS_HEADERS };
const respondJson = (status, data, extraHeaders) => ({ status, body: JSON.stringify(data), headers: extraHeaders ? { ...JSON_CORS, ...extraHeaders } : JSON_CORS });

const ROUTE_TESTS = {
    subtitle_movie: /^\/(?:api\/)?subtitles?\/movie\/([^/]+)$/, subtitle_tv: /^\/(?:api\/)?subtitles?\/tv\/([^/]+)\/([^/]+)\/([^/]+)$/,
    debug: /^\/(?:api\/)?debug\/([^/]+)$/, test: /^\/(?:api\/)?test\/([^/]+)$/,
    download_movie: /^\/(?:api\/)?downloads?\/movie\/([^/]+)$/, download_tv: /^\/(?:api\/)?downloads?\/tv\/([^/]+)\/([^/]+)\/([^/]+)$/,
};

const EARLY_CLOSE_MS = IS_HF ? 20000 : 14000;

async function streamSources(sources, id, s, e, clientIP, absoluteBase, res) {
    const sent = new Set();
    const host = absoluteBase.replace('http://', '').replace('https://', '');
    const debugResults = [];
    let closed = false;
    const onClose = () => { closed = true; };
    res.on('close', onClose); res.on('error', onClose);
    const safeWrite = (data) => { if (closed || res.writableEnded || res.destroyed) return false; try { res.write(data); return true; } catch { closed = true; return false; } };
    const promises = sources.map(async (cfg) => {
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
        } catch (err) { debugResults.push({ source: cfg.key, ok: false, error: err.message }); }
    });
    await Promise.race([Promise.all(promises), new Promise(r => setTimeout(r, EARLY_CLOSE_MS))]);
    safeWrite(`data: ${JSON.stringify({ type: 'debug', results: debugResults })}\n\n`);
    return sent.size;
}

const rateLimitCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, rl] of rateLimitMap) { if (now - rl.ts > 60000) rateLimitMap.delete(ip); }
}, 30000);
rateLimitCleanupInterval.unref?.();

const FALLBACK_SUB_BASES = ['https://subs.vidsrc.cc', 'https://vidsrc.cc', 'https://api.vidsrc.cc'];
async function getFastSubs(id, s, e) {
    const bases = [...new Set([...(SUBTITLE_BASES || []), ...FALLBACK_SUB_BASES])].filter(Boolean);
    const paths = s ? [`/tv/${id}/${s}/${e}`, `/tv/tt${id}/${s}/${e}`] : [`/movie/${id}`, `/movie/tt${id}`];
    const urls = [];
    for (const b of bases) for (const p of paths) urls.push(`${b}${p}`);
    try {
        return await Promise.any(urls.map(async u => {
            const r = await _originalFetch(u, { signal: AbortSignal.timeout(4000) });
            if (!r.ok) throw new Error();
            const data = await r.json();
            if (Array.isArray(data) && data.length > 0) return data;
            throw new Error();
        }));
    } catch { return []; }
}

async function handleRequest(req, res) {
    const baseUrl = `http://${req.headers.host || 'localhost'}`;
    const reqUrl = new URL(req.url, baseUrl);
    const { pathname, searchParams } = reqUrl;
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || null;

    if (BLOCKED_IPS.has(clientIP)) return respondJson(403, { error: 'forbidden' });

    const now = Date.now();
    const rl = rateLimitMap.get(clientIP) || { count: 0, ts: now };
    if (now - rl.ts > 10000) { rl.count = 0; rl.ts = now; }
    rl.count++;
    rateLimitMap.set(clientIP, rl);
    if (rl.count > 10) return respondJson(429, { error: 'rate limited' });

    if (req.method === 'OPTIONS') return { status: 204, body: '', headers: CORS_HEADERS };

    if (pathname === '/' || pathname === '') return { status: 200, body: `${LOGO_TEXT}\n\ndeveloped_by: @vyla-entertainment\ngithub: https://github.com/vyla-entertainment\ndocs: https://vyla.mintlify.app\ndmca: https://vyla.mintlify.app/misc/dmca`, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS } };

    if (pathname === '/test' || pathname === '/api/test') {
        const tests = {};
        ACTIVE_SOURCES.forEach(s => { tests[s.key] = { movie: `/api/test/155?source=${s.key}`, tv: `/api/test/1396?season=1&episode=1&source=${s.key}` }; });
        return respondJson(200, tests);
    }

    if (pathname === '/health' || pathname === '/api/health') {
        const result = await handleHealth(SOURCE_MODULES, mainCache);
        return { ...result, headers: { ...result.headers, ...CORS_HEADERS } };
    }

    if (pathname === '/movie' || pathname === '/api/movie') {
        const id = searchParams.get('id');
        if (!id) return respondJson(400, { error: 'missing id', route: '/movie?id=:tmdb_id', example: '/movie?id=155' });
        const absoluteBase = getAbsoluteBase(reqUrl.host);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS_HEADERS });
        const [meta, subtitles] = await Promise.all([getMetadata(id, null, null), getFastSubs(id, null, null)]);
        if (!res.writableEnded && !res.destroyed) { try { res.write(`data: ${JSON.stringify({ type: 'meta', meta, subtitles: subtitles || [] })}\n\n`); } catch { return null; } }
        const requestedSources = searchParams.get('sources')?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
        const sourcesToUse = requestedSources.length ? ACTIVE_SOURCES.filter(s => requestedSources.includes(s.key)) : ACTIVE_SOURCES;
        posthogTrack('stream-movie', { id, ...getRequestMeta(req, reqUrl) }, clientIP);
        const total = await streamSources(sourcesToUse, id, null, null, clientIP, absoluteBase, res);
        if (!res.writableEnded && !res.destroyed) { try { res.write(`data: ${JSON.stringify({ type: 'done', total })}\n\n`); res.end(); } catch { } }
        return null;
    }

    if (pathname === '/tv' || pathname === '/api/tv') {
        const id = searchParams.get('id'), s = searchParams.get('season'), e = searchParams.get('episode');
        if (!id || !s || !e) return respondJson(400, { error: 'missing parameters', route: '/tv?id=:id&season=:s&episode=:e', example: '/tv?id=1396&season=1&episode=1' });
        const absoluteBase = getAbsoluteBase(reqUrl.host);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS_HEADERS });
        const [meta, subtitles] = await Promise.all([getMetadata(id, s, e), getFastSubs(id, s, e)]);
        if (!res.writableEnded && !res.destroyed) { try { res.write(`data: ${JSON.stringify({ type: 'meta', meta, subtitles: subtitles || [] })}\n\n`); } catch { return null; } }
        const requestedSources = searchParams.get('sources')?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
        const sourcesToUse = requestedSources.length ? ACTIVE_SOURCES.filter(src => requestedSources.includes(src.key)) : ACTIVE_SOURCES;
        posthogTrack('stream-tv', { id, season: s, episode: e, ...getRequestMeta(req, reqUrl) }, clientIP);
        const total = await streamSources(sourcesToUse, id, s, e, clientIP, absoluteBase, res);
        if (!res.writableEnded && !res.destroyed) { try { res.write(`data: ${JSON.stringify({ type: 'done', total })}\n\n`); res.end(); } catch { } }
        return null;
    }

    if (pathname === '/subtitle' || pathname === '/subtitles' || pathname === '/api/subtitle' || pathname === '/api/subtitles') return respondJson(200, { routes: { movie: '/subtitles/movie/:id', tv: '/subtitles/tv/:id/:s/:e' }, examples: { movie: '/subtitles/movie/155', tv: '/subtitles/tv/1396/1/1' } });
    if (pathname === '/download' || pathname === '/downloads' || pathname === '/api/download' || pathname === '/api/downloads') return respondJson(200, { routes: { movie: '/downloads/movie/:id', tv: '/downloads/tv/:id/:s/:e' }, examples: { movie: '/downloads/movie/155', tv: '/downloads/tv/1396/1/1' } });

    let match = ROUTE_TESTS.subtitle_movie.exec(pathname);
    if (match) { posthogTrack('subtitles-movie', { id: match[1], ...getRequestMeta(req, reqUrl) }); const fastSubs = await getFastSubs(match[1], null, null); if (fastSubs.length > 0) return respondJson(200, fastSubs); return handleSubtitleMovie(match[1], CORS_HEADERS); }
    match = ROUTE_TESTS.subtitle_tv.exec(pathname);
    if (match) { posthogTrack('subtitles-tv', { id: match[1], season: match[2], episode: match[3], ...getRequestMeta(req, reqUrl) }); const fastSubs = await getFastSubs(match[1], match[2], match[3]); if (fastSubs.length > 0) return respondJson(200, fastSubs); return handleSubtitleTv(match[1], match[2], match[3], CORS_HEADERS); }
    match = ROUTE_TESTS.download_movie.exec(pathname);
    if (match) { posthogTrack('downloads-movie', { id: match[1], ...getRequestMeta(req, reqUrl) }, clientIP); return handleDownloadMovie(match[1], CORS_HEADERS); }
    match = ROUTE_TESTS.download_tv.exec(pathname);
    if (match) { posthogTrack('downloads-tv', { id: match[1], season: match[2], episode: match[3], ...getRequestMeta(req, reqUrl) }); return handleDownloadTv(match[1], match[2], match[3], CORS_HEADERS); }

    match = ROUTE_TESTS.test.exec(pathname);
    if (match) {
        const source = searchParams.get('source');
        if (!source || !SOURCE_MAP[source]) return respondJson(400, { error: 'invalid or missing source' });
        const result = await handleTestSource(source, match[1], searchParams.get('season') || searchParams.get('s') || null, searchParams.get('episode') || searchParams.get('e') || null, clientIP, reqUrl.host);
        posthogTrack('test', { source, id: match[1], ok: JSON.parse(result.body).ok, ...getRequestMeta(req, reqUrl) }, clientIP);
        return { status: result.status, body: result.body, headers: JSON_CORS };
    }

    match = ROUTE_TESTS.debug.exec(pathname);
    if (match) {
        const id = match[1], s = searchParams.get('season') || searchParams.get('s') || null, e = searchParams.get('episode') || searchParams.get('e') || null, sourceKey = searchParams.get('source');
        if (!sourceKey) return respondJson(400, { error: 'missing source' });
        const mod = SOURCE_MODULES[sourceKey], cfg = SOURCE_MAP[sourceKey];
        if (!mod) return respondJson(400, { error: `unknown source: ${sourceKey}` });
        const absoluteBase = getAbsoluteBase(reqUrl.host);
        const t0 = Date.now();
        let streamResult = null, streamError = null;
        const fetchTrace = [];
        const tracingFetch = async (url, opts) => { const start = Date.now(); try { const res = await _originalFetch(url, opts); fetchTrace.push({ url: String(url).slice(0, 200), status: res.status, ok: res.ok, ms: Date.now() - start }); return res; } catch (err) { fetchTrace.push({ url: String(url).slice(0, 200), error: err.message, ms: Date.now() - start }); throw err; } };
        const debugLock = new Map();
        try {
            const audio = /dub$/.test(sourceKey) ? 'dub' : 'sub';
            const lockKey = `${sourceKey}-${id}-${s}-${e}`;
            while (debugLock.has(lockKey)) await debugLock.get(lockKey);
            const prev = globalThis.fetch;
            globalThis.fetch = tracingFetch;
            const release = new Promise(async resolve => {
                try { streamResult = (await mod.getStream({ id, s, e, clientIP: null, absoluteBase, audio, config: cfg })) ?? (await mod.getStream({ id, s, e, clientIP: null, absoluteBase: isFallbackNeeded(reqUrl.host) ? FALLBACK_BASE : '', audio, config: cfg })); } catch (err) { streamError = err.message; }
                globalThis.fetch = prev; resolve();
            });
            debugLock.set(lockKey, release); await release; debugLock.delete(lockKey);
        } catch (err) { streamError = err.message; }
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
                const r = await _originalFetch(fetchUrl, { signal: AbortSignal.timeout(15000), headers: { ...fetchHeaders, 'Range': 'bytes=0-511' } });
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
        return respondJson(200, { source: sourceKey, id, candidates: candidates.length, checks, elapsed_ms: Date.now() - t0, stream_error: streamError, fetch_trace: fetchTrace, got_result: streamResult !== null, result_keys: streamResult ? Object.keys(streamResult) : null });
    }

    if (pathname === '/api' || pathname === '/api/') {
        const url = searchParams.get('url') || searchParams.get('proxy');
        if (url) {
            if (IS_HF && searchParams.get('lm') === '1') return { status: 302, body: '', headers: { 'Location': FALLBACK_BASE + req.url, ...CORS_HEADERS } };
            try {
                new URL(url);
                const extraHeaders = {};
                const proxyHeaders = searchParams.get('proxyHeaders');
                if (proxyHeaders) try { Object.assign(extraHeaders, JSON.parse(safeDecode(proxyHeaders))); } catch { }
                if (!extraHeaders['User-Agent'] && !extraHeaders['user-agent']) extraHeaders['User-Agent'] = getUA();
                delete extraHeaders['Host'];
                let matchedSource = null;
                for (const [param, cfg] of PROXY_PARAM_MAP) { if (searchParams.has(param)) { matchedSource = cfg; break; } }
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
                const upstream = await fetchUpstream(cleanUrl, extraHeaders, 30000);
                const ct = (upstream.headers.get('content-type') || '').toLowerCase();
                const looksLikeM3u8 = M3U8_REGEX.test(cleanUrl) || cleanUrl.includes('/playlist/') || cleanUrl.includes('/streamsvr/') || ct.includes('mpegurl') || ct.includes('m3u8');
                if (looksLikeM3u8) {
                    const text = await upstream.text();
                    if (text.trim().startsWith('#EXT') || /megacloud\.animanga\.fun\/(ts-proxy|proxy)/i.test(text.slice(0, 200))) {
                        const absoluteBase = getAbsoluteBase(reqUrl.host);
                        const isTesub = matchedSource?.proxyParam === 'tesub';
                        const rewritten = isTesub ? rewriteM3u8KeyOnly(text, cleanUrl, `&${matchedSource.proxyParam}=1&proxyHeaders=${encodeURIComponent(JSON.stringify(extraHeaders))}`, absoluteBase) : matchedSource ? rewriteM3u8(text, cleanUrl, `&${matchedSource.proxyParam}=1&proxyHeaders=${encodeURIComponent(JSON.stringify(extraHeaders))}`, absoluteBase) : rewriteM3u8(text, url, '&vn=1', absoluteBase);
                        return { status: 200, body: rewritten, headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...CORS_HEADERS } };
                    }
                    return { status: 502, body: `expected m3u8 but got: ${text.slice(0, 100)}`, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } };
                }
                if (matchedSource) {
                    const isTikTok = TIKTOK_REGEX.test(cleanUrl), isMkv = cleanUrl.includes('.mkv') || ct.includes('matroska'), isPngMasked = ct === 'image/png' || ct === 'image/jpeg' || /\.png(\?|$)/i.test(cleanUrl) || /letsgocdn\d+\.shop/i.test(cleanUrl), needsStrip = searchParams.has('tt') || STRIP_REGEX.test(cleanUrl);
                    if (isTikTok || isPngMasked || needsStrip) {
                        if (!upstream.ok) return { status: upstream.status, body: `upstream ${upstream.status}`, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } };
                        const full = Buffer.from(await upstream.arrayBuffer());
                        const stripped = (full[0] === 0x89 || full[0] === 0xFF || full[0] === 0x00) ? full.subarray(120) : full;
                        return { status: 200, body: stripped, headers: { 'Content-Type': 'video/MP2T', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' } };
                    }
                    if (!upstream.ok) return { status: upstream.status, body: `upstream ${upstream.status}`, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } };
                    const rangeHeader = req.headers['range'];
                    const streamUpstream = rangeHeader ? await _originalFetch(cleanUrl, { headers: { 'User-Agent': getUA(), ...extraHeaders, 'Range': rangeHeader }, redirect: 'follow' }) : upstream;
                    const responseHeaders = { 'Content-Type': isMkv || ct === 'application/octet-stream' ? 'video/mp4' : (ct || 'video/mp4'), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
                    if (streamUpstream.headers.has('content-length')) responseHeaders['Content-Length'] = streamUpstream.headers.get('content-length');
                    if (streamUpstream.headers.has('content-range')) responseHeaders['Content-Range'] = streamUpstream.headers.get('content-range');
                    return { status: rangeHeader && streamUpstream.status === 206 ? 206 : 200, stream: streamUpstream.body, headers: responseHeaders };
                }
                const full = Buffer.from(await upstream.arrayBuffer());
                const needsStrip = searchParams.has('tt') || TIKTOK_REGEX.test(url) || STRIP_REGEX.test(url);
                const stripped = (needsStrip && (full[0] === 0x89 || full[0] === 0xFF || full[0] === 0x00)) ? full.subarray(120) : full;
                return { status: 200, body: stripped, headers: { 'Content-Type': 'video/MP2T', ...CORS_HEADERS, 'Cache-Control': 'public, max-age=3600' } };
            } catch (e) { return respondJson(502, { error: e.message }); }
        }
        if (searchParams.has('sources_meta')) return respondJson(200, { sources: ACTIVE_SOURCES.map(c => ({ key: c.key, label: c.label, timeout: c.timeout })) });
        if (searchParams.has('tmdb_movie') || searchParams.has('tmdb_tv') || searchParams.has('tmdb_show') || searchParams.has('tmdb_season')) {
            const k = process.env.TMDB_API_KEY;
            if (!k) return respondJson(500, { error: 'no key' });
            const id = searchParams.get('id'), s = searchParams.get('s');
            const tmdbUrl = searchParams.has('tmdb_season') ? `https://api.themoviedb.org/3/tv/${id}/season/${s}?api_key=${k}` : searchParams.has('tmdb_movie') ? `https://api.themoviedb.org/3/movie/${id}?api_key=${k}${searchParams.has('append_to_response') ? `&append_to_response=${searchParams.get('append_to_response')}` : ''}` : `https://api.themoviedb.org/3/tv/${id}?api_key=${k}`;
            try { const r = await _originalFetch(tmdbUrl); return respondJson(200, await r.json()); } catch (err) { return respondJson(500, { error: err.message }); }
        }
        return respondJson(400, { error: 'missing parameters' });
    }

    if (pathname === '/api/proxydebug') {
        const url = searchParams.get('url');
        if (!url) return { status: 400, body: 'missing url', headers: CORS_HEADERS };
        const extraHeaders = searchParams.has('proxyHeaders') ? JSON.parse(safeDecode(searchParams.get('proxyHeaders'))) : {};
        try {
            const r1 = await fetchUpstream(url, extraHeaders);
            const body1 = await r1.text();
            let segResult = null;
            for (const l of body1.split('\n')) {
                const t = l.trim();
                if (!t || t.startsWith('#')) continue;
                const segUrl = t.startsWith('http') ? t : new URL(t, url).href;
                try {
                    const r2 = await _originalFetch(segUrl, { method: 'HEAD', headers: extraHeaders, signal: AbortSignal.timeout(5000) });
                    r2.body?.cancel();
                    segResult = { url: segUrl, status: r2.status, headers: Object.fromEntries(r2.headers.entries()) };
                } catch (err) { segResult = { url: segUrl, error: err.message }; }
                break;
            }
            return respondJson(200, { status: r1.status, content_type: r1.headers.get('content-type'), body_preview: body1.slice(0, 800), first_segment: segResult });
        } catch (err) { return respondJson(200, { error: err.message }); }
    }

    if (pathname === '/api/segdebug') {
        const url = searchParams.get('url');
        if (!url) return { status: 400, body: 'missing url', headers: CORS_HEADERS };
        const extraHeaders = {};
        const ph = searchParams.get('proxyHeaders');
        if (ph) try { Object.assign(extraHeaders, JSON.parse(safeDecode(ph))); } catch { }
        delete extraHeaders['Host']; delete extraHeaders['host'];
        try {
            const res = await _originalFetch(url, { headers: { 'User-Agent': getUA(), ...extraHeaders }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
            const bytes = new Uint8Array(await res.arrayBuffer());
            return respondJson(200, { upstream_status: res.status, upstream_ct: res.headers.get('content-type'), redirect_location: res.headers.get('location'), body_length: bytes.length, first_32_bytes_hex: Array.from(bytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '), first_byte: bytes[0], request_headers_sent: extraHeaders });
        } catch (err) { return respondJson(200, { error: err.message, request_headers_sent: extraHeaders }); }
    }
    return respondJson(404, { error: 'not found' });
}

const PORT = process.env.PORT || 7860;

const server = http.createServer(async (req, res) => {
    req.socket.setTimeout(90000);
    req.socket.setNoDelay(true);
    try {
        const result = await handleRequest(req, res);
        if (result === null) return;
        if (res.headersSent || res.writableEnded || res.destroyed) return;
        const headers = result.headers || {};
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        res.writeHead(result.status, headers);
        if (result.stream) {
            const readable = Readable.fromWeb(result.stream);
            readable.on('error', () => { try { res.destroy(); } catch { } });
            res.on('error', () => { try { readable.destroy(); } catch { } });
            readable.pipe(res);
        } else res.end(result.body ?? '');
    } catch (err) {
        if (!res.headersSent) {
            try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal server error"}'); } catch { }
        }
    }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.maxHeadersCount = 100;
server.timeout = 90000;

server.on('error', (err) => { if (err.code !== 'EADDRINUSE') console.error('server error', err.message); });
server.listen(PORT, '0.0.0.0', () => console.log(`http://localhost:${PORT}`));