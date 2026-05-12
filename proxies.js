import { PROXY_LIST_URL } from './config.js';

const proxyPool = { list: [], fetchedAt: 0 };

export async function getProxies() {
    if (proxyPool.list.length && Date.now() - proxyPool.fetchedAt < 10 * 60 * 1000) return proxyPool.list;
    try {
        const res = await fetch(PROXY_LIST_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36' }
        });
        if (!res.ok) throw new Error(`proxy list fetch failed: ${res.status}`);
        const json = await res.json();
        proxyPool.list = (json.data || []).filter(p =>
            p.protocols?.some(pr => pr === 'http' || pr === 'https') &&
            p.upTime >= 80 &&
            p.responseTime < 5000
        ).map(p => ({ ip: p.ip, port: p.port }));
        proxyPool.fetchedAt = Date.now();
    } catch { }
    return proxyPool.list;
}

export async function fetchWithProxyFallback(url, options = {}) {
    try {
        const res = await fetch(url, options);
        if (res.ok || (res.status !== 403 && res.status !== 429)) return res;
        res.body?.cancel();
        throw new Error(`status ${res.status}`);
    } catch {
        const proxies = await getProxies();
        if (!proxies.length) return null;
        const proxy = proxies[Math.floor(Math.random() * proxies.length)];
        try {
            const { ProxyAgent } = await import('undici');
            const dispatcher = new ProxyAgent(`http://${proxy.ip}:${proxy.port}`);
            return await fetch(url, { ...options, dispatcher });
        } catch {
            return null;
        }
    }
}