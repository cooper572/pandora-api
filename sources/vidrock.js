'use strict';

import { webcrypto } from 'crypto';
const crypto = webcrypto;

const PASSPHRASE = 'x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9';
const BASE_URL = 'https://vidrock.net/';
const SUB_BASE_URL = 'https://sub.vdrk.site';
const PROXY_PREFIX = 'https://proxy.vidrock.store/';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'Origin': BASE_URL,
};

async function encryptItemId(itemId) {
    const textEncoder = new TextEncoder();
    const keyData = textEncoder.encode(PASSPHRASE);
    const iv = textEncoder.encode(PASSPHRASE.substring(0, 16));
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-CBC' }, false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, textEncoder.encode(itemId));
    const base64 = Buffer.from(new Uint8Array(encrypted)).toString('base64');
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function fetchPage(url) {
    try {
        const response = await fetch(url, { headers: { ...HEADERS, Referer: BASE_URL }, referrer: BASE_URL });
        if (response.status !== 200) return null;
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) return await response.json();
        return await response.text();
    } catch {
        return null;
    }
}

function getStreamProxyHeaders(streamUrl) {
    if (streamUrl.includes('hls2.vdrk.site') || streamUrl.includes('lok-lok.cc')) {
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6884.98 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://lok-lok.cc/',
            'Origin': 'https://lok-lok.cc',
        };
    }
    if (streamUrl.includes('67streams')) {
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6884.98 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': BASE_URL,
            'Origin': BASE_URL.replace(/\/$/, ''),
        };
    }
    if (streamUrl.includes('hakunaymatata.com') || streamUrl.includes('storrrrrrm.site')) {
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6884.98 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': BASE_URL,
            'Origin': BASE_URL.replace(/\/$/, ''),
        };
    }
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6884.98 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': BASE_URL,
        'Origin': BASE_URL.replace(/\/$/, ''),
    };
}

async function resolveUrl(url) {
    if (url.includes('hls2.vdrk.site')) {
        try {
            const data = await fetchPage(url);
            if (!data || !Array.isArray(data)) return null;
            for (const obj of data) {
                if (!obj.url) continue;
                if (obj.url.startsWith(PROXY_PREFIX)) {
                    const encodedPath = obj.url.slice(PROXY_PREFIX.length);
                    return decodeURIComponent(encodedPath.replace(/^\//, ''));
                }
                return obj.url;
            }
            return null;
        } catch {
            return null;
        }
    }

    if (url.includes('.workers.dev/')) {
        try {
            const workerPath = url.slice(url.indexOf('.workers.dev/') + '.workers.dev/'.length);
            const decoded = decodeURIComponent(workerPath);
            if (decoded.startsWith('http')) return decoded;
        } catch {
            return null;
        }
    }

    return url;
}

async function getStream(id, s, e) {
    try {
        const type = s ? 'tv' : 'movie';
        const itemId = s ? `${id}_${s}_${e || 1}` : `${id}`;
        const encrypted = await encryptItemId(itemId);
        const pageUrl = `${BASE_URL}api/${type}/${encrypted}`;
        const data = await fetchPage(pageUrl);
        if (!data || typeof data !== 'object') return null;

        for (const stream of Object.values(data)) {
            if (!stream?.url) continue;
            const resolved = await resolveUrl(stream.url);
            if (!resolved) continue;
            return { url: resolved, headers: getStreamProxyHeaders(resolved) };
        }

        return null;
    } catch {
        return null;
    }
}

async function getSubtitles(id, s, e) {
    try {
        const type = s ? 'tv' : 'movie';
        const subUrl = type === 'tv'
            ? `${SUB_BASE_URL}/v2/tv/${id}/${s}/${e}`
            : `${SUB_BASE_URL}/v2/movie/${id}`;
        const response = await fetch(subUrl, { headers: { ...HEADERS, Referer: BASE_URL } });
        if (response.status !== 200) return [];
        const subsData = await response.json();
        return subsData.map(sub => ({ label: sub.label, url: sub.file, format: 'vtt' }));
    } catch {
        return [];
    }
}

async function proxyStream(url, res, { fetchUpstream, rewriteM3u8 }) {
    const proxyHeaders = getStreamProxyHeaders(url);
    const upstream = await fetchUpstream(url, 0, proxyHeaders);
    const ct = (upstream.headers['content-type'] || upstream.headers.get?.('content-type') || '').toLowerCase();
    const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url);
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (isM3u8) {
        const chunks = [];
        for await (const c of upstream) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url, '&vr=1'));
    }

    const isTikTok = /tiktokcdn\.com|ibyteimg\.com/i.test(url);
    if (isTikTok) {
        const chunks = [];
        for await (const c of upstream) chunks.push(c);
        const full = Buffer.concat(chunks);
        const stripped = full[0] === 0x89 ? full.slice(120) : full;
        res.setHeader('Content-Type', 'video/MP2T');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.end(stripped);
    }

    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    upstream.pipe(res);
}

export const PROXY_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6884.98 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': BASE_URL,
    'Origin': 'https://vidrock.net',
};

export const VERIFY_HEADERS = { ...PROXY_HEADERS };

export { getStream, getSubtitles, proxyStream, HEADERS, BASE_URL };