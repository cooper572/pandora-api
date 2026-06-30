import { SOURCES, SOURCE_MAP, CACHE_TTL } from '../../config.js';
import { fetchSubtitles, handleSubtitleMovie, handleSubtitleTv, SUBTITLE_BASES } from '../routes/subtitles.js';
import { handleDownloadMovie, handleDownloadTv } from '../routes/downloads/main.js';
import { WORKER_DISABLED_SOURCES, WORKER_SOURCE_MODULES } from './sources.js';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin, Accept, Access-Control-Request-Method, Access-Control-Request-Headers, Range',
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Max-Age': '86400',
};

const JSON_CORS = { 'Content-Type': 'application/json', ...CORS_HEADERS };
const ACTIVE_SOURCES = SOURCES.filter(c => !c.disabled && !WORKER_DISABLED_SOURCES.has(c.key) && WORKER_SOURCE_MODULES[c.key]);
const PROXY_PARAM_MAP = new Map(ACTIVE_SOURCES.map(cfg => [cfg.proxyParam, cfg]));
const ROUTE_PATTERNS = {
    subtitleMovie: /^\/(?:api\/)?subtitles?\/movie\/([^/]+)$/,
    subtitleTv: /^\/(?:api\/)?subtitles?\/tv\/([^/]+)\/([^/]+)\/([^/]+)$/,
    test: /^\/(?:api\/)?test\/([^/]+)$/,
    downloadMovie: /^\/(?:api\/)?downloads?\/movie\/([^/]+)$/,
    downloadTv: /^\/(?:api\/)?downloads?\/tv\/([^/]+)\/([^/]+)\/([^/]+)$/,
};

const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

const M3U8_REGEX = /\.m3u8?(\?|$)|mpegurl|m3u8/i;
const TIKTOK_REGEX = /tiktokcdn\.com|ibyteimg\.com/i;
const STRIP_REGEX = /seg\.html|enproxy|letsgocdn\d+\.shop/i;
const STRIP_TEST_FAST = /seg\.html|enproxy|tiktokcdn|ibyteimg/i;
const URI_REPLACE = /URI="([^"]+)"/g;

class LRUCache {
    #max; #ttl; #map;
    constructor(max, ttl) { this.#max = max; this.#ttl = ttl; this.#map = new Map(); }
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
    get size() { return this.#map.size; }
}

const mainCache = new LRUCache(2000, CACHE_TTL);
const hlsVerifyCache = new LRUCache(1000, 180_000);
const inflightMap = new Map();
const rateLimitMap = new Map();

const getUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const jitter = ms => ms > 0 ? new Promise(r => setTimeout(r, Math.random() * ms)) : Promise.resolve();
const withTimeout = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(() => r(null), ms))]);
const respondJson = (status, data, extraHeaders) => new Response(JSON.stringify(data), { status, headers: extraHeaders ? { ...JSON_CORS, ...extraHeaders } : JSON_CORS });

function setProcessEnv(env) {
    globalThis.process ??= {};
    globalThis.process.env = { ...(globalThis.process.env || {}), ...(env || {}) };
}

function getClientIP(request) {
    return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'anonymous';
}

function getAbsoluteBase(url) {
    return `${url.protocol}//${url.host}`;
}

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

function getCached(key, fn, ttl = CACHE_TTL) {
    const cached = mainCache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inflight = inflightMap.get(key);
    if (inflight) return inflight;
    const p = fn().then(val => {
        if (val != null) mainCache.set(key, val, ttl);
        return val;
    }).finally(() => inflightMap.delete(key));
    inflightMap.set(key, p);
    return p;
}

async function getMetadata(id, s, e, env) {
    const key = env.TMDB_API_KEY || globalThis.process?.env?.TMDB_API_KEY;
    if (!key) return { error: 'TMDB API key not configured' };
    const cacheKey = `meta-${id}-${s ?? ''}-${e ?? ''}`;
    return getCached(cacheKey, async () => {
        const url = s
            ? `https://api.themoviedb.org/3/tv/${id}/season/${s}/episode/${e || 1}?api_key=${key}`
            : `https://api.themoviedb.org/3/movie/${id}?api_key=${key}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: `TMDB API error: ${res.status}` };
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
    const normalized = raw.replace('http://', 'https://');
    let wrapped = `${absoluteBase}/api?url=${encodeURIComponent(normalized)}&${cfg.proxyParam}=1`;
    if (typeof rawUrl === 'object' && rawUrl.headers) {
        wrapped += `&proxyHeaders=${encodeURIComponent(JSON.stringify(rawUrl.headers))}`;
    }
    return wrapped;
}

function normalizeCandidates(rawResult) {
    if (rawResult?.allUrls?.length) return rawResult.allUrls.map(u => typeof u === 'object' ? u : { url: u });
    if (Array.isArray(rawResult)) return rawResult.map(u => typeof u === 'object' ? u : { url: u });
    if (rawResult) return [{ url: typeof rawResult === 'object' ? rawResult.url : rawResult, headers: rawResult?.headers, skipProxy: rawResult?.skipProxy, skipHlsCheck: rawResult?.skipHlsCheck }];
    return [];
}

async function verifyPlayable(proxiedUrl, extraHeaders = {}, skipProxyCheck = false) {
    const cached = hlsVerifyCache.get(proxiedUrl);
    if (cached !== undefined) return cached;
    const fail = error => ({ ok: false, error });
    try {
        const fetchHeaders = extraHeaders['User-Agent'] ? extraHeaders : { 'User-Agent': getUA(), ...extraHeaders };
        const m3u8Res = await fetch(proxiedUrl, { signal: AbortSignal.timeout(12000), headers: fetchHeaders });
        if (!m3u8Res.ok) return fail(`m3u8 failed: ${m3u8Res.status}`);
        const text = await m3u8Res.text();
        if (!text.trim().startsWith('#EXTM3U')) return fail('invalid m3u8');
        if (!text.includes('#EXTINF') && !text.includes('#EXT-X-STREAM-INF')) return fail('empty playlist');
        if (!skipProxyCheck) {
            const first = text.split('\n').map(l => l.trim()).find(l => l && l.charCodeAt(0) !== 35);
            if (first) {
                const nextUrl = first.startsWith('http') ? first : new URL(first, proxiedUrl).href;
                const variantRes = await fetch(nextUrl, { headers: { 'User-Agent': getUA(), ...extraHeaders, Range: 'bytes=0-1024' }, signal: AbortSignal.timeout(10000) });
                if (!variantRes.ok && variantRes.status !== 206) return fail(`Variant failed: ${variantRes.status}`);
            }
        }
        const ok = { ok: true, error: null };
        hlsVerifyCache.set(proxiedUrl, ok);
        return ok;
    } catch (err) {
        return fail(err.message);
    }
}

async function handleTestSource(sourceKey, id, s, e, clientIP, absoluteBase) {
    const start = Date.now();
    const cfg = ACTIVE_SOURCES.find(source => source.key === sourceKey);
    const mod = WORKER_SOURCE_MODULES[sourceKey];
    const respond = (ok, url, raw_url, error, debug) => ({ source: sourceKey, id, s: s || null, e: e || null, ok, url: ok ? url : null, raw_url, elapsed_ms: Date.now() - start, error: ok ? null : error, debug });
    if (!cfg || !mod) return respond(false, null, null, `unsupported source: ${sourceKey}`);
    try {
        const audio = /dub$/.test(cfg.key) ? 'dub' : 'sub';
        const cacheKey = `${cfg.key}-${id}-${s || ''}-${e || ''}`;
        const result = await withTimeout(jitter(cfg.jitter).then(() => getCached(cacheKey, () => withRetry(() => mod.getStream({ id, s, e, clientIP, absoluteBase, audio, config: cfg }), cfg.retries, 300))), cfg.timeout);
        const candidates = normalizeCandidates(result);
        if (!candidates.length) return respond(false, null, null, 'no stream returned');
        for (const candidate of candidates) {
            const raw = candidate.url;
            if (!raw?.startsWith('http')) continue;
            const wrapped = wrapUrl(candidate, sourceKey, absoluteBase);
            const isHls = /\.m3u8?(\?|$)/i.test(raw) || /\.m3u8?(\?|$)/i.test(wrapped);
            if (cfg.skipVerify || candidate.skipHlsCheck || !isHls) return respond(true, wrapped, raw, null, { candidates: candidates.length });
            const check = await verifyPlayable(wrapped, candidate.headers || {}, !!candidate.skipProxy || cfg.skipProxy);
            if (check.ok) return respond(true, wrapped, raw, null, { candidates: candidates.length, check });
        }
        return respond(false, null, candidates[0]?.url || null, 'no playable stream candidate');
    } catch (err) {
        return respond(false, null, null, err.message);
    }
}

async function streamSources(request, sources, id, s, e, clientIP, absoluteBase, env) {
    const encoder = new TextEncoder();
    const subtitlesPromise = fetchSubtitles(s
        ? [{ base: SUBTITLE_BASES[0], path: `/tv/${id}/${s}/${e}` }, { base: SUBTITLE_BASES[1], path: `/tv/${id}/${s}/${e}` }, { base: SUBTITLE_BASES[2], path: `/tv/tt${id}/${s}/${e}` }]
        : [{ base: SUBTITLE_BASES[0], path: `/movie/${id}` }, { base: SUBTITLE_BASES[1], path: `/movie/${id}` }, { base: SUBTITLE_BASES[2], path: `/movie/tt${id}` }]);
    const metaPromise = getMetadata(id, s, e, env);
    const stream = new ReadableStream({
        async start(controller) {
            let total = 0;
            const sent = new Set();
            const debugResults = [];
            const [meta, subtitles] = await Promise.all([metaPromise, subtitlesPromise]);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'meta', meta, subtitles })}\n\n`));
            await Promise.all(sources.map(async cfg => {
                const parsed = await handleTestSource(cfg.key, id, s, e, clientIP, absoluteBase);
                debugResults.push({ source: cfg.key, ok: parsed.ok, error: parsed.error || null, elapsed_ms: parsed.elapsed_ms });
                if (parsed.ok && parsed.url && !sent.has(parsed.url)) {
                    sent.add(parsed.url);
                    total++;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'source', source: { source: cfg.key, label: cfg.label ?? cfg.key, url: parsed.url } })}\n\n`));
                }
            }));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'debug', results: debugResults })}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', total })}\n\n`));
            controller.close();
        },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS_HEADERS } });
}

function resolveUri(uri, dir, originBase) {
    const abs = uri.startsWith('http') ? uri : uri.startsWith('/') ? originBase + uri : dir + uri;
    const decoded = safeDecode(abs.startsWith('http://') ? 'https://' + abs.slice(7) : abs);
    return decoded.startsWith('http') ? decoded : abs.startsWith('http://') ? 'https://' + abs.slice(7) : abs;
}

function buildM3u8Rewriter(rewriteSegments) {
    return function rewrite(body, url, extraParam, absoluteBase) {
        const qmark = url.indexOf('?');
        const base = qmark === -1 ? url : url.slice(0, qmark);
        const dir = base.slice(0, base.lastIndexOf('/') + 1);
        const schemeEnd = url.indexOf('//') + 2;
        const originBase = url.slice(0, url.indexOf('/', schemeEnd));
        const prefix = `${absoluteBase}/api?url=`;
        return body.split('\n').map(line => {
            const t = line.trim();
            if (!t) return line;
            if (t.charCodeAt(0) === 35) {
                return t.replace(URI_REPLACE, (_, uri) => `URI="${prefix}${encodeURIComponent(resolveUri(uri, dir, originBase))}${extraParam}"`);
            }
            const resolved = resolveUri(t, dir, originBase);
            return rewriteSegments ? `${prefix}${encodeURIComponent(resolved)}${extraParam}${STRIP_TEST_FAST.test(resolved) ? '&tt=1' : ''}` : resolved;
        }).join('\n');
    };
}

const rewriteM3u8 = buildM3u8Rewriter(true);
const rewriteM3u8KeyOnly = buildM3u8Rewriter(false);

async function handleProxy(request, reqUrl, absoluteBase) {
    const searchParams = reqUrl.searchParams;
    const url = searchParams.get('url') || searchParams.get('proxy');
    if (!url) return null;
    try { new URL(url); } catch { return respondJson(400, { error: 'invalid url' }); }
    const extraHeaders = {};
    const proxyHeaders = searchParams.get('proxyHeaders');
    if (proxyHeaders) try { Object.assign(extraHeaders, JSON.parse(safeDecode(proxyHeaders))); } catch { }
    if (!extraHeaders['User-Agent'] && !extraHeaders['user-agent']) extraHeaders['User-Agent'] = getUA();
    delete extraHeaders.Host;
    let matchedSource = null;
    for (const [param, cfg] of PROXY_PARAM_MAP) if (searchParams.has(param)) { matchedSource = cfg; break; }
    let cleanUrl = url;
    if (matchedSource) {
        try {
            const qIndex = url.indexOf('?');
            if (qIndex !== -1 && !/vodvidl\.site|vidldl\.site|vidldr\.site/i.test(url)) {
                const params = new URLSearchParams(url.slice(qIndex + 1));
                params.delete('host');
                cleanUrl = `${url.slice(0, qIndex)}${params.toString() ? '?' + params.toString() : ''}`;
            }
        } catch { }
        applyCdnHeaders(cleanUrl, extraHeaders, matchedSource.key);
    }
    const upstream = await fetch(cleanUrl, { headers: extraHeaders, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const looksLikeM3u8 = M3U8_REGEX.test(cleanUrl) || ct.includes('mpegurl') || ct.includes('m3u8');
    if (looksLikeM3u8) {
        const text = await upstream.text();
        if (text.trim().startsWith('#EXT')) {
            const isTesub = matchedSource?.proxyParam === 'tesub';
            const extraParam = matchedSource ? `&${matchedSource.proxyParam}=1&proxyHeaders=${encodeURIComponent(JSON.stringify(extraHeaders))}` : '&vn=1';
            const rewritten = isTesub ? rewriteM3u8KeyOnly(text, cleanUrl, extraParam, absoluteBase) : rewriteM3u8(text, cleanUrl, extraParam, absoluteBase);
            return new Response(rewritten, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...CORS_HEADERS } });
        }
        return new Response(`expected m3u8 but got: ${text.slice(0, 100)}`, { status: 502, headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS } });
    }
    const responseHeaders = new Headers(CORS_HEADERS);
    responseHeaders.set('Content-Type', ct || (matchedSource ? 'video/mp4' : 'video/MP2T'));
    responseHeaders.set('Cache-Control', matchedSource ? 'no-store' : 'public, max-age=3600');
    responseHeaders.set('Accept-Ranges', 'bytes');
    if (upstream.headers.has('content-length')) responseHeaders.set('Content-Length', upstream.headers.get('content-length'));
    if (upstream.headers.has('content-range')) responseHeaders.set('Content-Range', upstream.headers.get('content-range'));
    if (TIKTOK_REGEX.test(cleanUrl) || STRIP_REGEX.test(cleanUrl) || searchParams.has('tt')) {
        const bytes = new Uint8Array(await upstream.arrayBuffer());
        const stripped = (bytes[0] === 0x89 || bytes[0] === 0xFF || bytes[0] === 0x00) ? bytes.subarray(120) : bytes;
        return new Response(stripped, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function nodeRouteResultToResponse(result) {
    return new Response(result.body ?? '', { status: result.status, headers: { ...(result.headers || {}), ...CORS_HEADERS } });
}

async function handleRequest(request, env) {
    setProcessEnv(env);
    if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS_HEADERS });
    const reqUrl = new URL(request.url);
    const { pathname, searchParams } = reqUrl;
    const clientIP = getClientIP(request);
    const now = Date.now();
    const rl = rateLimitMap.get(clientIP) || { count: 0, ts: now };
    if (now - rl.ts > 10000) { rl.count = 0; rl.ts = now; }
    rl.count++;
    rateLimitMap.set(clientIP, rl);
    if (rl.count > 20) return respondJson(429, { error: 'rate limited' });

    const absoluteBase = getAbsoluteBase(reqUrl);
    if (pathname === '/' || pathname === '') {
        return new Response('Pandora API\n\ngithub: https://github.com/teethatkamsai/pandora-api', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS } });
    }
    if (pathname === '/health' || pathname === '/api/health') {
        return respondJson(200, { status: 'ok', runtime: 'cloudflare-workers', tmdb: !!env.TMDB_API_KEY, cache: mainCache.size, disabled_worker_sources: Array.from(WORKER_DISABLED_SOURCES), sources: ACTIVE_SOURCES.map(s => s.key) });
    }
    if (pathname === '/test' || pathname === '/api/test') {
        return respondJson(200, Object.fromEntries(ACTIVE_SOURCES.map(s => [s.key, { movie: `/api/test/155?source=${s.key}`, tv: `/api/test/1396?season=1&episode=1&source=${s.key}` }])));
    }
    if (pathname === '/api' || pathname === '/api/') {
        const proxied = await handleProxy(request, reqUrl, absoluteBase);
        if (proxied) return proxied;
        if (searchParams.has('sources_meta')) return respondJson(200, { sources: ACTIVE_SOURCES.map(c => ({ key: c.key, label: c.label, timeout: c.timeout })) });
        if (searchParams.has('tmdb_movie') || searchParams.has('tmdb_tv') || searchParams.has('tmdb_show') || searchParams.has('tmdb_season')) {
            const k = env.TMDB_API_KEY;
            if (!k) return respondJson(500, { error: 'no key' });
            const tmdbId = searchParams.get('id'), tmdbSeason = searchParams.get('s');
            let tmdbUrl;
            if (searchParams.has('tmdb_season')) tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${tmdbSeason}?api_key=${k}`;
            else if (searchParams.has('tmdb_movie')) tmdbUrl = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${k}${searchParams.has('append_to_response') ? `&append_to_response=${searchParams.get('append_to_response')}` : ''}`;
            else tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${k}`;
            const r = await fetch(tmdbUrl);
            return respondJson(r.ok ? 200 : r.status, await r.json());
        }
        return respondJson(400, { error: 'missing parameters' });
    }

    if (pathname === '/movie' || pathname === '/api/movie') {
        const id = searchParams.get('id');
        if (!id) return respondJson(400, { error: 'missing id', route: '/movie?id=:tmdb_id', example: '/movie?id=155' });
        const raw = searchParams.get('sources')?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
        const sources = raw.length ? ACTIVE_SOURCES.filter(s => raw.includes(s.key)) : ACTIVE_SOURCES;
        return streamSources(request, sources, id, null, null, clientIP, absoluteBase, env);
    }
    if (pathname === '/tv' || pathname === '/api/tv') {
        const id = searchParams.get('id'), s = searchParams.get('season'), e = searchParams.get('episode');
        if (!id || !s || !e) return respondJson(400, { error: 'missing parameters', route: '/tv?id=:id&season=:s&episode=:e', example: '/tv?id=1396&season=1&episode=1' });
        const raw = searchParams.get('sources')?.split(',').map(v => v.trim()).filter(Boolean) ?? [];
        const sources = raw.length ? ACTIVE_SOURCES.filter(source => raw.includes(source.key)) : ACTIVE_SOURCES;
        return streamSources(request, sources, id, s, e, clientIP, absoluteBase, env);
    }

    let match = ROUTE_PATTERNS.subtitleMovie.exec(pathname);
    if (match) return nodeRouteResultToResponse(await handleSubtitleMovie(match[1], CORS_HEADERS));
    match = ROUTE_PATTERNS.subtitleTv.exec(pathname);
    if (match) return nodeRouteResultToResponse(await handleSubtitleTv(match[1], match[2], match[3], CORS_HEADERS));
    match = ROUTE_PATTERNS.downloadMovie.exec(pathname);
    if (match) return nodeRouteResultToResponse(await handleDownloadMovie(match[1], CORS_HEADERS));
    match = ROUTE_PATTERNS.downloadTv.exec(pathname);
    if (match) return nodeRouteResultToResponse(await handleDownloadTv(match[1], match[2], match[3], CORS_HEADERS));
    match = ROUTE_PATTERNS.test.exec(pathname);
    if (match) {
        const source = searchParams.get('source');
        const result = await handleTestSource(source, match[1], searchParams.get('season') || searchParams.get('s') || null, searchParams.get('episode') || searchParams.get('e') || null, clientIP, absoluteBase);
        return respondJson(200, result);
    }
    return respondJson(404, { error: 'not found' });
}

export default {
    async fetch(request, env) {
        try {
            return await handleRequest(request, env || {});
        } catch (err) {
            return respondJson(500, { error: err.message || 'internal server error' });
        }
    },
};
