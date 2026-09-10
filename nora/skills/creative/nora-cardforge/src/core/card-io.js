const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { normalizeCard, exportCardV2, exportCardV3 } = require('./card-model');

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BYTES = 5 * 1024 * 1024;

function readCard(inputPath) {
  const abs = path.resolve(inputPath);
  const buffer = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') {
    const raw = JSON.parse(buffer.toString('utf8'));
    return {
      card: normalizeCard(raw),
      source: { path: abs, type: 'json' }
    };
  }
  if (ext === '.png') {
    const extracted = readPngCardData(buffer);
    return {
      card: normalizeCard(extracted.card),
      source: {
        path: abs,
        type: 'png',
        pngBuffer: buffer,
        chunkKeyword: extracted.keyword,
        availableKeywords: extracted.availableKeywords
      }
    };
  }
  throw new Error(`Unsupported input extension: ${ext}`);
}

function writeCardArtifact({ card, source, outputPath, coverPath }) {
  const abs = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const ext = path.extname(abs).toLowerCase();
  const exported = exportCardV2(card);
  if (ext === '.json') {
    fs.writeFileSync(abs, JSON.stringify(exported, null, 2) + '\n', 'utf8');
    return;
  }
  if (ext !== '.png') throw new Error(`Unsupported output extension: ${ext}`);
  let basePng;
  if (coverPath) {
    basePng = fs.readFileSync(path.resolve(coverPath));
  } else if (source && source.type === 'png' && source.pngBuffer) {
    basePng = source.pngBuffer;
  } else {
    throw new Error('PNG export needs --cover when input is not a PNG');
  }
  const output = writePngCardData(basePng, exported, exportCardV3(card));
  fs.writeFileSync(abs, output);
}

function readPngCardData(buffer) {
  assertPng(buffer);
  const chunks = extractChunks(buffer);
  for (const keyword of ['ccv3', 'chara']) {
    for (const chunk of chunks) {
      const text = decodeCardTextChunk(chunk);
      if (!text || text.keyword !== keyword) continue;
      const json = decodeCardPayload(text.value);
      return { card: JSON.parse(json), keyword, availableKeywords: cardKeywords(chunks) };
    }
  }
  throw new Error('PNG does not contain chara or ccv3 character card data');
}

function writePngCardData(buffer, v2Card, v3Card) {
  assertPng(buffer);
  const chunks = extractChunks(buffer).filter(chunk => {
    const text = decodeCardTextChunk(chunk);
    return !text || (text.keyword !== 'chara' && text.keyword !== 'ccv3');
  });
  const cards = v3Card
    ? [['chara', v2Card], ['ccv3', v3Card]]
    : [['chara', v2Card]];
  const textChunks = cards.map(([keyword, card]) => ({
    type: 'tEXt',
    data: encodeTextChunk(keyword, Buffer.from(JSON.stringify(card), 'utf8').toString('base64'))
  }));
  const iend = chunks.findIndex(chunk => chunk.type === 'IEND');
  if (iend === -1) throw new Error('Invalid PNG: missing IEND chunk');
  chunks.splice(iend, 0, ...textChunks);
  return encodeChunks(chunks);
}

function assertPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('File is not a valid PNG');
  }
  if (buffer.length > MAX_PNG_BYTES) throw new Error('PNG exceeds 20 MB safety limit');
}

function extractChunks(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error('Invalid PNG chunk table');
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error(`Invalid PNG chunk length for ${type}`);
    const data = buffer.subarray(dataStart, dataEnd);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]));
    if (expectedCrc !== actualCrc) throw new Error(`Invalid PNG CRC for ${type}`);
    chunks.push({ type, data: Buffer.from(data) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function encodeChunks(chunks) {
  const parts = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    const type = Buffer.from(chunk.type, 'latin1');
    const data = Buffer.from(chunk.data || []);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
    parts.push(len, type, data, crc);
  }
  return Buffer.concat(parts);
}

function decodeTextChunk(data) {
  const sep = data.indexOf(0);
  if (sep < 0) return null;
  return {
    keyword: data.subarray(0, sep).toString('latin1'),
    value: data.subarray(sep + 1).toString('latin1')
  };
}

function decodeCardTextChunk(chunk) {
  if (chunk.type === 'tEXt') return decodeTextChunk(chunk.data);
  if (chunk.type === 'zTXt') {
    const sep = chunk.data.indexOf(0);
    if (sep < 0 || chunk.data[sep + 1] !== 0) return null;
    const decoded = zlib.inflateSync(chunk.data.subarray(sep + 2), { maxOutputLength: MAX_METADATA_BYTES });
    return { keyword: chunk.data.subarray(0, sep).toString('latin1'), value: decoded.toString('latin1') };
  }
  if (chunk.type === 'iTXt') {
    const first = chunk.data.indexOf(0);
    if (first < 0 || first + 3 >= chunk.data.length) return null;
    const keyword = chunk.data.subarray(0, first).toString('latin1');
    const compressed = chunk.data[first + 1] === 1;
    let cursor = first + 3;
    for (let i = 0; i < 2; i++) {
      const next = chunk.data.indexOf(0, cursor);
      if (next < 0) return null;
      cursor = next + 1;
    }
    const raw = chunk.data.subarray(cursor);
    const decoded = compressed ? zlib.inflateSync(raw, { maxOutputLength: MAX_METADATA_BYTES }) : raw;
    return { keyword, value: decoded.toString('utf8') };
  }
  return null;
}

function decodeCardPayload(value) {
  const text = String(value || '').trim();
  if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) throw new Error('Card metadata exceeds safety limit');
  if (text.startsWith('{')) return text;
  const raw = Buffer.from(text, 'base64');
  if (raw.length > MAX_METADATA_BYTES) throw new Error('Decoded card metadata exceeds safety limit');
  const decoded = raw.toString('utf8');
  if (!decoded.trimStart().startsWith('{')) throw new Error('Card payload is neither JSON nor base64 JSON');
  return decoded;
}

function cardKeywords(chunks) {
  return [...new Set(chunks.map(decodeCardTextChunk).filter(Boolean).map(item => item.keyword)
    .filter(keyword => keyword === 'chara' || keyword === 'ccv3'))];
}

function encodeTextChunk(keyword, value) {
  return Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

module.exports = {
  readCard,
  writeCardArtifact,
  readPngCardData,
  writePngCardData,
  extractChunks,
  encodeChunks
};
