import { getTmdbInfo, tmdbToAnilist } from '../utils/helpers.js';

const PIPE_OBF_KEY = Uint8Array.from('71951034f8fbcf53d89db52ceb3dc22c'.match(/../g), x => parseInt(x, 16));
const PROTOCOL_VERSION = '0.2.0';
const DEFAULT_PROVIDER = 'kiwi';
const BASE_URL = 'https://www.miruro.tv';
const MIRURO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36', 'Referer': `${BASE_URL}/`, 'Origin': BASE_URL };

function b64Encode(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function decodeObfuscated(text) {
    const e = text.replace(/-/g, '+').replace(/_/g, '/');
    const padded = e + '='.repeat((4 - e.length % 4) % 4);
    const bytes = Buffer.from(padded, 'base64');
    const xored = Buffer.allocUnsafe(bytes.length);
    for (let i = 0; i < bytes.length; i++) xored[i] = bytes[i] ^ PIPE_OBF_KEY[i % PIPE_OBF_KEY.length];
    const { createGunzip } = await import('zlib');
    return new Promise((resolve, reject) => {
        const gz = createGunzip();
        const chunks = [];
        gz.on('data', c => chunks.push(c));
        gz.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); } });
        gz.on('error', reject); gz.end(xored);
    });
}

async function pipeGet(path, query = {}) {
    const payload = { path, method: 'GET', query, body: null, version: PROTOCOL_VERSION };
    const res = await fetch(`${BASE_URL}/api/secure/pipe?e=${b64Encode(payload)}`, { headers: MIRURO_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { res.body?.cancel(); throw new Error(`pipe ${path} → ${res.status}`); }
    const text = await res.text();
    if (res.headers.get('x-obfuscated') === '2') return decodeObfuscated(text);
    return JSON.parse(text);
}

async function getEpisodeId(anilistId, episodeNumber, category = 'sub') {
    const data = await pipeGet('episodes', { anilistId: String(anilistId) });
    const providerData = data?.providers?.[DEFAULT_PROVIDER];
    if (!providerData) throw new Error(`provider ${DEFAULT_PROVIDER} not found`);
    const list = providerData.episodes?.[category] || providerData.episodes?.sub || [];
    const ep = list.find(e => e.number === episodeNumber);
    if (!ep) throw new Error(`episode ${episodeNumber} not found in ${category}`);
    return ep.id;
}

async function getSources(episodeId, anilistId, category = 'sub') {
    return pipeGet('sources', { episodeId, provider: DEFAULT_PROVIDER, category, anilistId: String(anilistId) });
}

export async function getStream({ id, s, e, audio = 'sub' }) {
    if (!s || !e || s === 'null' || e === 'null') return null;
    const info = await getTmdbInfo(id, 'tv', s);
    if (!info.isAnime) return null;
    const anilistId = await tmdbToAnilist(id, 'tv', s, info.titles, info.year);
    if (!anilistId) return null;
    const category = audio === 'dub' ? 'dub' : 'sub';
    const episodeNum = parseInt(e, 10);
    const episodeId = await getEpisodeId(anilistId, episodeNum, category).catch(() => null);
    if (!episodeId) return null;
    const sourcesData = await getSources(episodeId, anilistId, category).catch(() => null);
    if (!sourcesData?.streams?.length) return null;
    const hlsStreams = sourcesData.streams.filter(st => st.type === 'hls' && st.url && st.isActive !== false);
    if (!hlsStreams.length) return null;
    const refHeaders = { 'Referer': 'https://kwik.cx/', 'Origin': 'https://kwik.cx', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' };
    const allUrls = hlsStreams.map(st => ({ url: st.url, headers: refHeaders, skipProxy: false, quality: st.quality }));
    return { allUrls, skipProxy: false };
}