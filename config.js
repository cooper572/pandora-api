export const SOURCES = [
    {
        key: 'flixhq',
        label: 'FlixHQ',
        sourceFile: 'flixhq',
        proxyParam: 'fq',
        timeout: 20000,
        jitter: 600,
        retries: 2,
        skipProxy: true,
        skipVerify: true,
    },

    {
        key: 'meowtv',
        label: 'MeowTV',
        sourceFile: 'meowtv',
        proxyParam: 'mt',
        timeout: 15000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
        verifyHeaders: {
            Referer: 'https://meowtv.ru',
            Origin: 'https://meowtv.ru',
        },
    },

    {
        key: 'cinezo',
        label: 'Cinezo',
        sourceFile: 'cinezo',
        proxyParam: 'cz',
        timeout: 60000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
        verifyHeaders: {
            Origin: 'https://onionplay.io',
            Referer: 'https://onionplay.io/',
        },
    },

    {
        key: 'icefy',
        label: 'Icefy',
        sourceFile: 'icefy',
        proxyParam: 'iy',
        timeout: 20000,
        sourcesTimeout: 10000,
        jitter: 500,
        retries: 2,
        skipVerify: false,
        verifyHeaders: {
            Referer: 'https://streams.icefy.top/',
            Origin: 'https://streams.icefy.top',
        },
    },

    {
        key: 'vidrock',
        label: 'VidRock',
        sourceFile: 'vidrock',
        proxyParam: 'vr',
        timeout: 20000,
        jitter: 800,
        retries: 3,
        skipVerify: true,
        multiUrl: true,
        cdnHeaders: [
            {
                pattern: /./,
                headers: {
                    Accept: '/',
                    'Accept-Language': 'en-US,en;q=0.9',
                    Referer: 'https://vidrock.ru/',
                    Origin: 'https://vidrock.ru',
                },
            },
        ],
    },

    {
        key: 'vidlink',
        label: 'VidLink',
        sourceFile: 'vidlink',
        proxyParam: 'vl',
        timeout: 15000,
        jitter: 500,
        retries: 2,
        skipProxy: true,
        skipVerify: true,
        verifyHeaders: {
            Referer: 'https://vidlink.pro/',
            Origin: 'https://vidlink.pro',
        },
        cdnHeaders: [
            {
                pattern: /vodvidl.site|vidldl.site|vidldr.site/i,
                headers: {
                    Referer: 'https://vidlink.pro/',
                    Origin: 'https://vidlink.pro',
                    Accept: '/',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'sec-fetch-dest': 'video',
                    'sec-fetch-mode': 'no-cors',
                    'sec-fetch-site': 'cross-site',
                },
            },
        ],
    },

    {
        key: 'miruro-sub',
        label: 'Miruro (Sub)',
        sourceFile: 'miruro',
        proxyParam: 'mrsub',
        timeout: 25000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
        multiUrl: true,
    },

    {
        key: 'miruro-dub',
        label: 'Miruro (Dub)',
        sourceFile: 'miruro',
        proxyParam: 'mrdub',
        timeout: 25000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
        multiUrl: true,
    },

    {
        key: 'vidzee',
        label: 'VidZee',
        sourceFile: 'vidzee',
        proxyParam: 'vz',
        timeout: 20000,
        sourcesTimeout: 10000,
        jitter: 400,
        retries: 3,
        skipVerify: true,
        verifyHeaders: {
            Accept: '/',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://player.vidzee.wtf',
            Origin: 'https://player.vidzee.wtf',
        },
    },

    {
        key: 'vixsrc',
        label: 'VixSrc',
        sourceFile: 'vixsrc',
        proxyParam: 'vx',
        timeout: 35000,
        jitter: 0,
        retries: 2,
        skipVerify: false,
        multiUrl: false,
        verifyHeaders: {
            Accept: 'application/json, text/javascript, /; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://vixsrc.to/',
            Origin: 'https://vixsrc.to',
        },
    },

    {
        key: '02movie',
        label: '02Movie',
        sourceFile: '02movie',
        proxyParam: 'zm',
        timeout: 35000,
        jitter: 600,
        retries: 1,
        skipVerify: true,
    },

    {
        key: 'vidnest',
        label: 'VidNest',
        sourceFile: 'vidnest',
        proxyParam: 'vdn',
        timeout: 20000,
        jitter: 0,
        retries: 1,
        skipProxy: true,
        skipVerify: true,
        multiUrl: false,
        cdnHeaders: [
            {
                pattern: /letsgocdn\d+.shop/i,
                headers: {
                    Referer: 'https://vidnest.fun/',
                    Origin: 'https://vidnest.fun',
                },
            },
            {
                pattern: /cdn.mewstream.buzz/i,
                headers: {
                    Referer: 'https://vidnest.fun/',
                    Origin: 'https://vidnest.fun',
                },
            },
        ],
    },

    {
        key: 'vidnest-sub',
        label: 'VidNest (Sub)',
        sourceFile: 'vidnest',
        proxyParam: 'vdn',
        timeout: 20000,
        jitter: 0,
        retries: 1,
        skipProxy: true,
        skipVerify: true,
        multiUrl: false,
        cdnHeaders: [
            {
                pattern: /letsgocdn\d+.shop/i,
                headers: {
                    Referer: 'https://vidnest.fun/',
                    Origin: 'https://vidnest.fun',
                },
            },
            {
                pattern: /cdn.mewstream.buzz/i,
                headers: {
                    Referer: 'https://vidnest.fun/',
                    Origin: 'https://vidnest.fun',
                },
            },
        ],
    },

    {
        key: 'vidnest-dub',
        label: 'VidNest (Dub)',
        sourceFile: 'vidnest',
        proxyParam: 'vdn',
        timeout: 20000,
        jitter: 0,
        retries: 1,
        skipProxy: true,
        skipVerify: true,
        multiUrl: false,
        cdnHeaders: [
            {
                pattern: /letsgocdn\d+.shop/i,
                headers: {
                    Referer: 'https://vidnest.fun/',
                    Origin: 'https://vidnest.fun',
                },
            },
            {
                pattern: /cdn.mewstream.buzz/i,
                headers: {
                    Referer: 'https://vidnest.fun/',
                    Origin: 'https://vidnest.fun',
                },
            },
        ],
    },

    {
        key: 'vidfun',
        label: 'VidFun',
        sourceFile: 'vidfun',
        proxyParam: 'vf',
        timeout: 20000,
        jitter: 500,
        retries: 2,
        disabled: true,
        skipVerify: true,
    },

    {
        key: 'fsharetv',
        label: 'FShareTV',
        sourceFile: 'fsharetv',
        proxyParam: 'fs',
        timeout: 25000,
        jitter: 600,
        retries: 2,
        skipVerify: true,
        multiUrl: false,
        verifyHeaders: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,/;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://fsharetv.cc',
        },
    },

    {
        key: 'vidapi',
        label: 'VidApi',
        sourceFile: 'vidapi',
        proxyParam: 'va',
        timeout: 20000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
        multiUrl: true,
        verifyHeaders: {
            Referer: 'https://brightpathsignals.com/',
            Origin: 'https://brightpathsignals.com',
            Accept: '/',
        },
    },

    {
        key: 'fsonic',
        label: 'Fsonic',
        sourceFile: 'fsonic',
        proxyParam: 'fn',
        timeout: 35000,
        jitter: 600,
        retries: 1,
        skipVerify: true,
        multiUrl: true,
    },

    {
        key: 'lookmovie',
        label: 'LookMovie',
        sourceFile: 'lookmovie',
        proxyParam: 'lm',
        timeout: 20000,
        jitter: 500,
        retries: 2,
        skipProxy: true,
        skipVerify: true,
        multiUrl: true,
        verifyHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
        },
    },

    {
        key: 'tryembed-sub',
        label: 'TryEmbed (Sub)',
        sourceFile: 'tryembed',
        proxyParam: 'tesub',
        timeout: 25000,
        jitter: 500,
        retries: 2,
        skipCache: true,
        disabled: true,
        skipVerify: true,
        multiUrl: true,
    },

    {
        key: 'tryembed-dub',
        label: 'TryEmbed (Dub)',
        sourceFile: 'tryembed',
        proxyParam: 'tedub',
        timeout: 25000,
        jitter: 500,
        retries: 2,
        skipCache: true,
        disabled: true,
        skipVerify: true,
        multiUrl: true,
    },

    {
        key: 'movsrc',
        label: 'MovSrc',
        sourceFile: 'movsrc',
        proxyParam: 'ms',
        timeout: 20000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
    },

    {
        key: 'toustream',
        label: 'TouStream',
        sourceFile: 'toustream',
        proxyParam: 'ts',
        timeout: 20000,
        jitter: 400,
        retries: 1,
        skipVerify: true,
        cdnHeaders: [
            {
                pattern: /toustream.xyz/,
                headers: {
                    Referer: 'https://toustream.xyz/',
                    Origin: 'https://toustream.xyz',
                },
            },
        ],
    },

    {
        key: 'flaxmovies',
        label: 'FlaxMovies',
        sourceFile: 'flaxmovies',
        proxyParam: 'fx',
        timeout: 20000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
        multiUrl: true,
        cdnHeaders: [
            {
                pattern: /flix2watch.pro/i,
                headers: {
                    Referer: 'https://flaxmovies.xyz/',
                    Origin: 'https://flaxmovies.xyz',
                },
            },
        ],
    },

    {
        key: 'vapor',
        label: 'Vapor',
        sourceFile: 'vapor',
        proxyParam: 'vp',
        timeout: 20000,
        jitter: 500,
        retries: 2,
        skipVerify: false,
        skipProxy: true,
    },

    {
        key: 'vidsrc',
        label: 'VidSrc',
        sourceFile: 'vidsrc',
        proxyParam: 'vs',
        timeout: 20000,
        sourcesTimeout: 10000,
        jitter: 700,
        retries: 2,
        verifyHeaders: {
            Referer: 'https://cloudnestra.com/',
            Origin: 'https://cloudnestra.com',
            Accept: '/',
        },
    },

    {
        key: 'videasy',
        label: 'Videasy',
        sourceFile: 'videasy',
        proxyParam: 'vy',
        timeout: 40000,
        sourcesTimeout: 10000,
        jitter: 900,
        retries: 3,
        skipVerify: true,
        multiUrl: false,
        verifyHeaders: {
            Accept: 'application/json, /; q=0.01',
            Referer: 'https://player.videasy.net/',
            Origin: 'https://player.videasy.net',
        },
    },

    {
        key: 'peachify',
        label: 'Peachify',
        sourceFile: 'peachify',
        proxyParam: 'py',
        timeout: 30000,
        jitter: 500,
        retries: 2,
        skipVerify: true,
    },

    {
        key: 'vidify',
        label: 'Vidify',
        sourceFile: 'vidify',
        proxyParam: 'vdy',
        timeout: 20000,
        jitter: 700,
        retries: 2,
        disabled: true,
        verifyHeaders: {
            Referer: 'https://cloudnestra.com/',
            Origin: 'https://cloudnestra.com',
            Accept: '/',
        },
    },

    {
        key: 'moviebite',
        label: 'MovieBite',
        sourceFile: 'moviebite',
        proxyParam: 'mb',
        timeout: 25000,
        jitter: 500,
        retries: 2,
        skipProxy: true,
        skipVerify: true,
    },
];

export const SOURCE_MAP = Object.fromEntries(SOURCES.map(s => [s.key, s]));
export const ALLOWED_ORIGINS = [''];
export const HEALTH_PROBE_ID = '155';
export const CACHE_TTL = 5 * 60 * 1000;