const PASSPHRASE = 'eDdrOW1QcVQycld2WTh6QTViQzNuRjZoSjJsSzRtTjk=';

export async function encryptItemId(itemId: string) {
    try {
        const textEncoder = new TextEncoder();

        // Key is the passphrase
        const keyData = textEncoder.encode(Buffer.from(PASSPHRASE, 'base64').toString());

        // IV is first 16 bytes of the key
        const iv = keyData.slice(0, 16);

        // Import the key for AES-CBC
        const key = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'AES-CBC' },
            false,
            ['encrypt']
        );

        // Pad the item ID to AES block size (16 bytes)
        // PKCS7 padding: add (16 - length % 16) bytes, each with value (16 - length % 16)
        const itemIdBytes = textEncoder.encode(itemId);
        const paddingLength = 16 - (itemIdBytes.length % 16);
        const paddedData = new Uint8Array(itemIdBytes.length + paddingLength);
        paddedData.set(itemIdBytes);
        paddedData.fill(paddingLength, itemIdBytes.length);

        // Encrypt using AES-CBC
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-CBC', iv: iv },
            key,
            paddedData
        );

        // Base64 encode and make URL-safe (similar to VidSrcCC approach)
        const encryptedArray = new Uint8Array(encrypted);
        const binaryString = String.fromCharCode(...encryptedArray);
        const base64 = Buffer.from(binaryString, 'binary').toString('base64');

        // Convert to URL-safe base64: + -> -, / -> _, remove padding =
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    } catch (error) {
        console.error('[encryptItemId] Encryption error:', error);
        throw error;
    }
}