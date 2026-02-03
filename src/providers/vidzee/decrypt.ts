import type { StreamUrl } from './vidzee.types.js';

export default async function decrypt(urls: StreamUrl[]): Promise<string[]> {
    const results: string[] = [];

    try {
        for (const streamurl of urls) {
            const decoded = Buffer
                .from(streamurl.link.toString(), 'base64')
                .toString();

            const [ivBase64, cipherBase64] = decoded.split(':');

            if (!ivBase64 || !cipherBase64) {
                continue;
            }

            const iv = await base64ToArrayBuffer(ivBase64);
            const keyBytes = await base64ToArrayBuffer(
                'aWZ5b3VzY3JhcGV5b3VhcmVnYXkAAAAAAAAAAAAAAAA='
            );
            const ciphertext = await base64ToArrayBuffer(cipherBase64);

            const cryptoKey = await crypto.subtle.importKey(
                'raw',
                keyBytes,
                { name: 'AES-CBC' },
                false,
                ['decrypt']
            );

            const plaintextBuffer = await crypto.subtle.decrypt(
                { 
                    name: 'AES-CBC', 
                    iv: iv as ArrayBuffer // Explicit cast
                },
                cryptoKey,
                ciphertext
            );

            const decrypted = new TextDecoder().decode(plaintextBuffer);
            
            if (decrypted && decrypted.trim()) {
                results.push(decrypted.trim());
            }
        }

        return results;
    } catch (error) {
        console.error('Vidzee decrypt failed:', error);
        throw new Error('Vidzee Decrypt failed: ' + (error as Error).message);
    }
}

/**
 * Convert base64 to ArrayBuffer (Web Crypto compatible)
 */
async function base64ToArrayBuffer(b64: string): Promise<ArrayBuffer> {
    const binaryString = atob(b64);
    const bytes = new Uint8Array(binaryString.length);
    
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    return bytes.buffer;
}
