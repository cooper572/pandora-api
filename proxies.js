import { PROXY_LIST_URL } from './config.js';

const proxyPool = { list: [], fetchedAt: 0 };

export async function getProxies() {
    if (proxyPool.list.length && Date.now() - proxyPool.fetchedAt < 10 * 60 * 1000) return proxyPool.list;
    try {
        const res = await fetch(PROXY_LIST_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36' }
        });
        if (!res.ok) throw new Error(`proxy list fetch failed: ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const json = await res.json();
            proxyPool.list = (json.data || []).filter(p =>
                p.protocols?.some(pr => ['http', 'https', 'socks4', 'socks5'].includes(pr)) &&
                p.upTime >= 80 &&
                p.responseTime < 5000
            ).map(p => ({
                ip: p.ip,
                port: p.port,
                protocol: p.protocols.find(pr => ['http', 'https', 'socks4', 'socks5'].includes(pr))
            }));
        } else {
            const text = await res.text();
            proxyPool.list = text.split('\n')
                .map(l => l.trim())
                .filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l))
                .map(l => {
                    const [ip, port] = l.split(':');
                    return { ip, port, protocol: 'http' };
                });
        }
        proxyPool.fetchedAt = Date.now();
        proxyPool.lastError = null;
    } catch (err) {
        proxyPool.lastError = err.message;
    }
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
        const shuffled = proxies.sort(() => Math.random() - 0.5).slice(0, 5);
        for (const proxy of shuffled) {
            try {
                const r = await Promise.race([
                    fetchViaProxy(url, proxy, options),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
                ]);
                if (r && r.ok) return r;
            } catch { }
        }
        return null;
    }
}

export async function fetchViaProxy(url, proxy, options = {}) {
    try {
        if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
            const { SocksProxyAgent } = await import('socks-proxy-agent');
            const agent = new SocksProxyAgent(`${proxy.protocol}://${proxy.ip}:${proxy.port}`);
            const https = await import('https');
            const http = await import('http');
            const { URL } = await import('url');
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            return new Promise((resolve, reject) => {
                const reqLib = isHttps ? https : http;
                const req = reqLib.request({
                    host: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    agent,
                }, (res) => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks);
                        resolve({
                            ok: res.statusCode >= 200 && res.statusCode < 300,
                            status: res.statusCode,
                            headers: { get: (h) => res.headers[h.toLowerCase()] },
                            text: () => Promise.resolve(body.toString('utf8')),
                            json: () => Promise.resolve(JSON.parse(body.toString('utf8'))),
                            arrayBuffer: () => Promise.resolve(body.buffer),
                            body: null,
                        });
                    });
                    res.on('error', reject);
                });
                req.on('error', reject);
                req.end();
            });
        } else {
            const { ProxyAgent } = await import('undici');
            const dispatcher = new ProxyAgent(`http://${proxy.ip}:${proxy.port}`);
            return fetch(url, { ...options, dispatcher });
        }
    } catch {
        return null;
    }
}

export function getProxyPoolInfo() {
    return { count: proxyPool.list.length, lastError: proxyPool.lastError || null };
}