import { unwrapTulnexProxy } from '../utils/helpers.js';

const PLAYER_BASE = 'https://player.cinezo.live';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let _sourcesCache = null;
let _sourcesCacheTime = 0;

function safeAbortSignal(ms) {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
}

function nodeAtob(b64) {
    if (typeof atob === 'function') return atob(b64);
    return Buffer.from(b64, 'base64').toString('binary');
}
function base64ToBuffer(b64) {
    const bin = nodeAtob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
}
function binaryDecode(encoded) {
    return nodeAtob(encoded).split(' ').map(s => String.fromCharCode(parseInt(s, 2))).join('');
}
function bufferToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function strToBuffer(str) { return new TextEncoder().encode(str).buffer; }
function bufferToStr(buf) { return new TextDecoder().decode(buf); }
function hexToUint8(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) arr[i / 2] = parseInt(hex.substr(i, 2), 16);
    return arr;
}

async function scrapeSources() {
    const now = Date.now();
    if (_sourcesCache && now - _sourcesCacheTime < CACHE_TTL_MS) {
        return _sourcesCache;
    }

    try {
        const htmlRes = await fetch(`${PLAYER_BASE}/embed/movie/550`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': PLAYER_BASE + '/',
            },
            signal: safeAbortSignal(10000),
        });
        if (!htmlRes.ok) throw new Error(`HTML fetch ${htmlRes.status}`);
        const html = await htmlRes.text();

        const scriptRe = /src="([^"]*\/assets\/[^"]+\.js[^"]*)"/g;
        const chunkUrls = [];
        let m;
        while ((m = scriptRe.exec(html)) !== null) {
            const src = m[1];
            chunkUrls.push(src.startsWith('http') ? src : `${PLAYER_BASE}${src}`);
        }

        if (chunkUrls.length === 0) throw new Error('No JS chunks found in HTML');

        const chunkTexts = await Promise.all(
            chunkUrls.map(url =>
                fetch(url, {
                    headers: { 'Referer': PLAYER_BASE + '/' },
                    signal: safeAbortSignal(8000),
                })
                    .then(r => r.ok ? r.text() : '')
                    .catch(() => '')
            )
        );

        const allParsed = [];
        for (const text of chunkTexts) {
            allParsed.push(...parseSourcesFromChunk(text));
        }

        if (allParsed.length === 0) throw new Error('No sources parsed from JS chunks');

        const seen = new Set();
        const sources = [];
        for (const src of allParsed) {
            const key = `${src.movieApi}||${src.tvApi}`;
            if (!seen.has(key)) {
                seen.add(key);
                sources.push(src);
            }
        }

        console.log(`[cinezo] Scraped ${sources.length} unique sources from live player JS`);
        _sourcesCache = sources;
        _sourcesCacheTime = now;
        return sources;

    } catch (err) {
        console.warn(`[cinezo] Source scrape failed (${err.message}), using stale cache or empty`);
        return _sourcesCache ?? [];
    }
}

function parseSourcesFromChunk(js) {
    const results = [];

    const apiOccurrences = [...js.matchAll(/\bapi\s*:\s*["'`]/g)];

    for (const match of apiOccurrences) {
        const objStart = findObjectStart(js, match.index);
        if (objStart === -1) continue;
        const objEnd = findObjectEnd(js, objStart);
        if (objEnd === -1) continue;

        const objStr = js.slice(objStart, objEnd + 1);
        const parsed = parseSourceObject(objStr);
        if (parsed) results.push(parsed);
    }

    return results;
}

function findObjectStart(js, fromIndex) {
    let depth = 0;
    for (let i = fromIndex; i >= 0; i--) {
        if (js[i] === '}') depth++;
        else if (js[i] === '{') {
            if (depth === 0) return i;
            depth--;
        }
    }
    return -1;
}

function findObjectEnd(js, startIndex) {
    let depth = 0;
    for (let i = startIndex; i < js.length; i++) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function parseSourceObject(objStr) {
    const get = (key) => {
        const re = new RegExp(`\\b${key}\\s*:\\s*(["\`'])([\\s\\S]*?)\\1`);
        const m = objStr.match(re);
        return m ? m[2] : null;
    };

    const api = get('api');
    if (!api || !api.includes('http')) return null;

    const tvApi = get('tvApi') ?? '';
    const name = get('name') ?? '';

    const normMovieApi = api
        .replace(/\$\{id\}/g, '${id}');

    const normTvApi = tvApi
        .replace(/\$\{season\}/g, '${s}')
        .replace(/\$\{episode\}/g, '${e}')
        .replace(/\$\{id\}/g, '${id}');

    return { name, movieApi: normMovieApi, tvApi: normTvApi };
}

const L1_KEY = 'Sn00pD0g#L1_X0R_M4st3rK3y!2026sex';
const L1_SALT = 'xK9!mR2@pL5#nQ8sex';
const L3_KEY = 'Sn00pD0g#L3_AES_S3cur3K3y@2026$sex';
const L4_KEYS = [
    'Sn00pD0g#L4_HMAC_F1n4lW4ll#2026!sex',
    'Sn00pD0g#L4_HMAC_F1n4lW4ll#2026',
    'Sn00pD0g#L4HMAC_S3xur3W4ll#2026!',
];

let _pbkdf2L1Cache = null;
async function getPbkdf2L1() {
    if (_pbkdf2L1Cache) return _pbkdf2L1Cache;
    _pbkdf2L1Cache = pbkdf2(L1_KEY, L1_SALT, 50000, 32, 'SHA-256');
    return _pbkdf2L1Cache;
}
async function pbkdf2(pass, salt, iterations, keyLen, hash) {
    const keyMat = await crypto.subtle.importKey('raw', strToBuffer(pass), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: strToBuffer(salt), iterations, hash }, keyMat, keyLen * 8);
    return new Uint8Array(bits);
}
function xorDecrypt(hexStr, keyBytes) {
    const src = hexToUint8(hexStr);
    const out = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i] ^ keyBytes[i % 32];
    return bufferToStr(out.buffer);
}
async function decodeL3(data) {
    const parts = data.split('.');
    if (parts.length !== 3) throw new Error('L3 invalid');
    const [ivB64, saltB64, ctB64] = parts;
    const salt = nodeAtob(saltB64);
    const keyBytes = await pbkdf2(L3_KEY, salt, 100000, 32, 'SHA-512');
    const aesKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(base64ToBuffer(ivB64)) }, aesKey, base64ToBuffer(ctB64));
    return bufferToStr(decrypted);
}
async function decodeL4(data, key) {
    const sep = data.indexOf('|');
    if (sep === -1) throw new Error('L4 no separator');
    const receivedHmac = data.slice(0, sep);
    const payload = data.slice(sep + 1);
    const payloadStr = bufferToStr(base64ToBuffer(payload));
    const hmacKey = await crypto.subtle.importKey('raw', strToBuffer(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payloadStr));
    if (receivedHmac !== bufferToHex(sig)) throw new Error('L4 HMAC mismatch');
    return payloadStr;
}
async function decryptPayload(payload) {
    const xorKey = await getPbkdf2L1();
    if (/^[0-9a-fA-F]+$/.test(payload) && payload.length % 2 === 0) return JSON.parse(xorDecrypt(payload, xorKey));
    const sep = payload.indexOf('|');
    if (sep === -1) throw new Error('L4 no separator and not hex');
    let l4out = null;
    for (const key of L4_KEYS) { try { l4out = await decodeL4(payload, key); break; } catch { } }
    if (!l4out) { try { l4out = bufferToStr(base64ToBuffer(payload.slice(sep + 1))); } catch { l4out = payload.slice(sep + 1); } }
    if (/^[0-9a-fA-F]+$/.test(l4out) && l4out.length % 2 === 0) return JSON.parse(xorDecrypt(l4out, xorKey));
    const l3out = await decodeL3(l4out);
    const l2out = binaryDecode(l3out);
    return JSON.parse(xorDecrypt(l2out, xorKey));
}
async function fetchAndDecrypt(url) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
                'Accept': 'application/json, */*',
                'Origin': 'https://player.cinezo.live',
                'Referer': 'https://player.cinezo.live/',
            },
            signal: safeAbortSignal(8000),
        });
        if (!res.ok) { res.body?.cancel(); return null; }
        const data = await res.json();
        if (data?.v === 4 && data?.payload) { try { return await decryptPayload(data.payload); } catch { return null; } }
        if (data?.success === false) return null;
        if (data && typeof data === 'object' && Object.keys(data).length > 0) return data;
        return null;
    } catch { return null; }
}

async function probeUrl(url, headers) {
    try {
        const probe = await fetch(url, { headers, signal: safeAbortSignal(5000), redirect: 'follow' });
        if (!probe.ok) return false;
        const text = await probe.text();
        if (!text.trim().startsWith('#EXTM3U')) return false;
        let variantUrl = null;
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (t && !t.startsWith('#')) { variantUrl = t.startsWith('http') ? t : new URL(t, url).href; break; }
        }
        if (!variantUrl) return true;
        const variantRes = await fetch(variantUrl, { headers, signal: safeAbortSignal(4000), redirect: 'follow' });
        if (!variantRes.ok) return false;
        const variantText = await variantRes.text();
        if (!variantText.trim().startsWith('#EXTM3U')) return false;
        let segUrl = null;
        for (const line of variantText.split('\n')) {
            const t = line.trim();
            if (t && !t.startsWith('#')) { segUrl = t.startsWith('http') ? t : new URL(t, variantUrl).href; break; }
        }
        if (segUrl) {
            try {
                const segRes = await fetch(segUrl, { method: 'GET', headers, signal: safeAbortSignal(3000), redirect: 'follow' });
                if (!segRes.ok && segRes.status !== 206 && segRes.status !== 403) return false;
                segRes.body?.cancel();
            } catch { return false; }
        }
        return true;
    } catch { return false; }
}

export async function getStream({ id, s, e }) {
    const sources = await scrapeSources();

    const applicableSources = sources.filter(src => !(s && e && !src.tvApi));

    const results = await Promise.allSettled(
        applicableSources.map(async (src) => {
            const url = s && e
                ? src.tvApi.replace('${id}', id).replace('${s}', s).replace('${e}', e)
                : src.movieApi.replace('${id}', id);
            if (!url) return null;
            const data = await fetchAndDecrypt(url);
            if (!data) return null;
            const extracted = extractUrl(data);
            if (!extracted?.url) return null;
            const headersToSend = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...(extracted.headers || {}),
            };
            const ok = await probeUrl(extracted.url, headersToSend);
            if (!ok) return null;
            return extracted;
        })
    );

    for (const r of results) {
        if (r.status === 'fulfilled' && r.value) return r.value;
    }
    return null;
}

function extractUrl(data) {
    if (!data) return null;
    if (data.success === false) return null;
    const wrap = (url, headers = null) => {
        if (!url || typeof url !== 'string' || !url.includes('http')) return null;
        const { unwrapped, headers: extractedHeaders } = unwrapTulnexProxy(url);
        const mergedHeaders = { ...(extractedHeaders || {}), ...(headers || {}) };
        const finalHeaders = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : null;
        return { url: unwrapped, headers: finalHeaders };
    };
    if (typeof data === 'string' && data.includes('http')) return wrap(data);
    const headers = data.headers || null;
    if (data.url && typeof data.url === 'string' && data.url.includes('http')) return wrap(data.url, headers);
    if (data.stream && typeof data.stream === 'string' && data.stream.includes('http')) return wrap(data.stream, headers);
    if (data.playlist && typeof data.playlist === 'string' && data.playlist.includes('http')) return wrap(data.playlist, headers);
    if (data.streamUrl && typeof data.streamUrl === 'string' && data.streamUrl.includes('http')) return wrap(data.streamUrl, headers);
    if (data.stream_url && typeof data.stream_url === 'string' && data.stream_url.includes('http')) return wrap(data.stream_url, headers);
    if (data.streaming_url && typeof data.streaming_url === 'string' && data.streaming_url.includes('http')) return wrap(data.streaming_url, headers);
    if (data.video_url && typeof data.video_url === 'string' && data.video_url.includes('http')) return wrap(data.video_url, headers);
    if (data.m3u8 && typeof data.m3u8 === 'string' && data.m3u8.includes('http')) return wrap(data.m3u8, headers);
    if (data.sources?.primary?.url) return wrap(data.sources.primary.url, data.sources.primary.headers || headers);
    if (data.sources && Array.isArray(data.sources) && data.sources.length > 0) {
        const sorted = data.sources
            .filter(s => s.url && s.url.includes('http'))
            .sort((a, b) => parseInt((b.quality || '').replace('p', '') || '0') - parseInt((a.quality || '').replace('p', '') || '0'));
        if (sorted.length > 0) return wrap(sorted[0].url, sorted[0].headers || headers);
    }
    if (data.languages && Array.isArray(data.languages)) {
        const orig = data.languages.find(l => l.original === true && l.sources?.length > 0);
        if (orig) {
            const sorted = [...orig.sources].sort((a, b) => parseInt((b.quality || '').replace('p', '') || '0') - parseInt((a.quality || '').replace('p', '') || '0'));
            return wrap(sorted[0].url || sorted[0].file, sorted[0].headers || orig.headers || headers);
        }
    }
    if (data.links && Array.isArray(data.links) && data.links.length > 0) {
        const link = data.links.find(l => l.url && l.url.includes('http'));
        if (link) return wrap(link.url, headers);
    }
    if (data.data?.data?.stream?.playlist) return wrap(data.data.data.stream.playlist, headers);
    if (data.data?.stream?.playlist) return wrap(data.data.stream.playlist, headers);
    if (data.data?.url && typeof data.data.url === 'string' && data.data.url.includes('http')) return wrap(data.data.url, data.data.headers || headers);
    if (data.data?.sources && Array.isArray(data.data.sources)) {
        const src = data.data.sources.find(s => s.url && s.url.includes('http'));
        if (src) return wrap(src.url, src.headers || headers);
    }
    if (data.streams && Array.isArray(data.streams)) {
        const src = data.streams.find(s => (s.url || s.link) && (s.url || s.link).includes('http'));
        if (src) return wrap(src.url || src.link, src.headers || headers);
    }
    return null;
}