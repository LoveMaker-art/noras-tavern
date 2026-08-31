import { imageSize as decodeDimensions } from 'image-size';

/**
 * Decode only the raster formats supported by Tavern's image library.
 * Check bytes, not the uploaded filename: unsupported ICNS/JXL/HEIF decoders
 * can loop synchronously on malformed input (GHSA-w3rx-r6r6-pgpr,
 * GHSA-5p2g-fcmc-qvqq). No untrusted bytes reach those decoders.
 * @param {Uint8Array} input Image bytes
 * @returns {ReturnType<typeof decodeDimensions>} Dimensions
 */
export function imageSize(input) {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const prefix = bytes.subarray(0, 12);
    const ascii = prefix.toString('latin1');
    const supported = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff)
        || /^GIF8[79]a/.test(ascii)
        || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')
        || ascii.startsWith('BM')
        || ascii.startsWith('II\x2a\x00')
        || ascii.startsWith('MM\x00\x2a');
    if (!supported) throw new TypeError('Unsupported image format for Tavern metadata.');
    return decodeDimensions(bytes);
}
