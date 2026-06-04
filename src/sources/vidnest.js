import { getTmdbInfo, tmdbToAnilist } from '../utils/helpers.js';
const BASE_URL = 'https://vidnest.fun';
const API_BASE_URL = 'https://new.vidnest.fun';
const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36', 'Accept': 'application/json, text/javascript, */*; q=0.01', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': `${BASE_URL}/`, 'Origin': BASE_URL };
const CDN_PROXY_HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0', 'accept': '*/*', 'accept-language': 'en-US,en;q=0.5', 'origin': 'https://megaplay.buzz', 'referer': 'https://megaplay.buzz/' };
const VIDNEST_ALPHABET = 'RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=';
const VIDNEST_REVERSE_MAP = (() => { const map = {}; for (let i = 0; i < VIDNEST_ALPHABET.length; i++) map[VIDNEST_ALPHABET[i]] = i; return map; })();
function decodeVidnestBase64(input) {
    let padded = input;
    const mod = padded.length % 4;
    if (mod !== 0) padded += '='.repeat(4 - mod);
    const bytes = [];
    for (let i = 0; i < padded.length; i += 4) {
        const chunk = padded.slice(i, i + 4);
        const c0 = VIDNEST_REVERSE_MAP[chunk[0]] ?? 64, c1 = VIDNEST_REVERSE_MAP[chunk[1]] ?? 64, c2 = chunk[2] === '=' ? 64 : (VIDNEST_REVERSE_MAP[chunk[2]] ?? 64), c3 = chunk[3] === '=' ? 64 : (VIDNEST_REVERSE_MAP[chunk[3]] ?? 64);
        bytes.push(((c0 << 2) | (c1 >> 4)) & 0xff);
        if (c2 !== 64) bytes.push((((c1 & 0x0f) << 4) | (c2 >> 2)) & 0xff);
        if (c3 !== 64) bytes.push((((c2 & 0x03) << 6) | c3) & 0xff);
    }
    return Buffer.from(bytes).toString('utf8');
}
function decrypt(payload) { return JSON.parse(decodeVidnestBase64(payload)); }

const SERVERS = [{ server: 'vidlink', type: 'hexa' }, { server: 'klikxxi', type: 'ophim' }, { server: 'purstream', type: 'beta' }, { server: 'moviesapi', type: 'alfa' }, { server: 'allmovies', type: 'lamda' }];

export async function getStream({ id, s, e, audio = 'sub' }) {
    const ep = e ? parseInt(e, 10) : 1;
    const audioParam = audio === 'dub' ? 'dub' : 'sub';
    if (s) {
        const info = await getTmdbInfo(id, 'tv', s);
        if (info.isAnime) {
            const anilistId = await tmdbToAnilist(id, 'tv', s, info.titles, info.year);
            if (anilistId) {
                try {
                    const apiUrl = `${API_BASE_URL}/hianime/anime/${anilistId}/${ep}/${audioParam}`;
                    const res = await fetch(apiUrl, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(15000) });
                    if (res.ok) {
                        const json = await res.json();
                        const data = json.encrypted ? decrypt(json.data) : json.data;
                        const file = data?.sources?.[0]?.file;
                        if (file) {
                            const proxiedUrl = `https://megacloud.animanga.fun/proxy?url=${encodeURIComponent(file)}&headers=${encodeURIComponent(JSON.stringify(CDN_PROXY_HEADERS))}`;
                            return { url: proxiedUrl, headers: REQUEST_HEADERS };
                        }
                    } else res.body?.cancel();
                } catch { }
            }
        }
    }
    if (audio === 'dub') return null;
    const segment = s ? `tv/${id}/${s}/${ep}` : `movie/${id}`;
    const results = await Promise.allSettled(
        SERVERS.map(async ({ server }) => {
            const url = `${API_BASE_URL}/${server}/${segment}`;
            const res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(10000) });
            if (!res.ok) { res.body?.cancel(); throw new Error(`${server}: ${res.status}`); }
            const json = await res.json();
            if (!json.data) throw new Error(`${server}: no data`);
            const data = json.encrypted ? decrypt(json.data) : json.data;
            const file = data?.sources?.[0]?.file ?? data?.streams?.[0]?.url ?? data?.url?.[0]?.link ?? data?.data?.stream?.playlist;
            if (!file) throw new Error(`${server}: no file`);
            return file;
        })
    );
    const file = results.find(r => r.status === 'fulfilled')?.value;
    if (!file) return null;
    return { url: file, headers: REQUEST_HEADERS, skipProxy: false };
}