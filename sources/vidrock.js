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

export const SKIP_VERIFY = true;
export const MULTI_URL = true;

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
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6884.98 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': BASE_URL,
        'Origin': BASE_URL.replace(/\/$/, ''),
    };
}

export async function getStream(id, s, e) {
    try {
        const type = s ? 'tv' : 'movie';
        const itemId = s ? `${id}_${s}_${e || 1}` : `${id}`;
        const encrypted = await encryptItemId(itemId);
        const pageUrl = `${BASE_URL}api/${type}/${encrypted}`;
        const data = await fetchPage(pageUrl);
        if (!data || typeof data !== 'object') return null;

        const allUrls = [];

        for (const stream of Object.values(data)) {
            if (!stream?.url) continue;

            if (stream.url.includes('hls2.vdrk.site')) {
                const cdnData = await fetchPage(stream.url);
                if (!Array.isArray(cdnData)) continue;
                for (const obj of cdnData) {
                    if (!obj?.url) continue;
                    let finalUrl;
                    if (obj.url.startsWith(PROXY_PREFIX)) {
                        const encodedPath = obj.url.slice(PROXY_PREFIX.length);
                        finalUrl = decodeURIComponent(encodedPath.replace(/^\//, ''));
                    } else {
                        finalUrl = obj.url;
                    }
                    allUrls.push({ url: finalUrl, headers: getStreamProxyHeaders(finalUrl) });
                }
                continue;
            }

            allUrls.push({ url: stream.url, headers: getStreamProxyHeaders(stream.url) });
        }

        if (!allUrls.length) return null;
        return { allUrls };
    } catch {
        return null;
    }
}

export const VERIFY_HEADERS = { ...HEADERS };
export { HEADERS, BASE_URL };