const getStaticProxies = () => {
    const u = process.env.WEBSHARE_USERNAME;
    const p = process.env.WEBSHARE_PASSWORD;
    return [
        { ip: '31.59.20.176', port: '6754', username: u, password: p, protocol: 'http' },
        { ip: '31.56.127.193', port: '7684', username: u, password: p, protocol: 'http' },
        { ip: '45.38.107.97', port: '6014', username: u, password: p, protocol: 'http' },
        { ip: '107.172.163.27', port: '6543', username: u, password: p, protocol: 'http' },
        { ip: '198.23.243.226', port: '6361', username: u, password: p, protocol: 'http' },
        { ip: '216.10.27.159', port: '6837', username: u, password: p, protocol: 'http' },
        { ip: '142.111.67.146', port: '5611', username: u, password: p, protocol: 'http' },
        { ip: '191.96.254.138', port: '6185', username: u, password: p, protocol: 'http' },
        { ip: '31.58.9.4', port: '6077', username: u, password: p, protocol: 'http' },
        { ip: '23.229.19.94', port: '8689', username: u, password: p, protocol: 'http' },
    ];
};

const proxyPool = { list: [], fetchedAt: 0 };

export async function getProxies() {
    if (proxyPool.list.length && Date.now() - proxyPool.fetchedAt < 10 * 60 * 1000) return proxyPool.list;
    const apiKey = process.env.WEBSHARE_API_KEY;
    if (apiKey) {
        try {
            const res = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=25', {
                headers: { 'Authorization': `Token ${apiKey}` }
            });
            if (!res.ok) throw new Error(`webshare API failed: ${res.status}`);
            const json = await res.json();
            const parsed = (json.results || []).map(p => ({
                ip: p.proxy_address,
                port: String(p.port),
                username: p.username,
                password: p.password,
                protocol: 'http',
            }));
            if (parsed.length) {
                proxyPool.list = parsed;
                proxyPool.fetchedAt = Date.now();
                proxyPool.lastError = null;
                return proxyPool.list;
            }
        } catch (err) {
            proxyPool.lastError = err.message;
        }
    }
    proxyPool.list = getStaticProxies();
    proxyPool.fetchedAt = Date.now();
    if (!apiKey) proxyPool.lastError = 'WEBSHARE_API_KEY not set, using static fallback';
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
        const shuffled = [...proxies].sort(() => Math.random() - 0.5).slice(0, 5);
        for (const proxy of shuffled) {
            try {
                const r = await Promise.race([
                    fetchViaProxy(url, proxy, options),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
                ]);
                if (!r) continue;
                if (r.status === 403 || r.status === 429) { r.body?.cancel?.(); continue; }
                return r;
            } catch { }
        }
        return null;
    }
}

export async function fetchViaProxy(url, proxy, options = {}) {
    try {
        const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
        if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
            const { SocksProxyAgent } = await import('socks-proxy-agent');
            const agent = new SocksProxyAgent(`${proxy.protocol}://${auth}${proxy.ip}:${proxy.port}`);
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
            const dispatcher = new ProxyAgent(`http://${auth}${proxy.ip}:${proxy.port}`);
            return fetch(url, { ...options, dispatcher });
        }
    } catch {
        return null;
    }
}

export function getProxyPoolInfo() {
    return { count: proxyPool.list.length, lastError: proxyPool.lastError || null };
}