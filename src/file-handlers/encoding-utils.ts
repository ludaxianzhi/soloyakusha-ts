import { readFile, writeFile } from 'node:fs/promises';
import iconv from 'iconv-lite';

export interface FileEncodingInfo {
  encoding: string;
  hasBom: boolean;
  bomLength: number;
}

export interface ReadTextFileResult {
  content: string;
  encoding: string;
  hasBom: boolean;
}

export function detectBom(buffer: Uint8Array): FileEncodingInfo | null {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { encoding: 'utf-8', hasBom: true, bomLength: 3 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { encoding: 'utf-16le', hasBom: true, bomLength: 2 };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return { encoding: 'utf-16be', hasBom: true, bomLength: 2 };
  }
  return null;
}

export function isValidUtf8(buffer: Uint8Array): boolean {
  let i = 0;
  while (i < buffer.length) {
    const byte = buffer[i]!;
    if (byte <= 0x7F) {
      i++;
    } else if (byte >= 0xC2 && byte <= 0xDF) {
      if (i + 1 >= buffer.length || !isUtf8ContinuationByte(buffer[i + 1]!)) return false;
      i += 2;
    } else if (byte === 0xE0) {
      if (
        i + 2 >= buffer.length ||
        buffer[i + 1]! < 0xA0 ||
        buffer[i + 1]! > 0xBF ||
        !isUtf8ContinuationByte(buffer[i + 2]!)
      ) {
        return false;
      }
      i += 3;
    } else if (byte >= 0xE1 && byte <= 0xEC) {
      if (
        i + 2 >= buffer.length ||
        !isUtf8ContinuationByte(buffer[i + 1]!) ||
        !isUtf8ContinuationByte(buffer[i + 2]!)
      ) {
        return false;
      }
      i += 3;
    } else if (byte === 0xED) {
      if (
        i + 2 >= buffer.length ||
        buffer[i + 1]! < 0x80 ||
        buffer[i + 1]! > 0x9F ||
        !isUtf8ContinuationByte(buffer[i + 2]!)
      ) {
        return false;
      }
      i += 3;
    } else if (byte >= 0xEE && byte <= 0xEF) {
      if (
        i + 2 >= buffer.length ||
        !isUtf8ContinuationByte(buffer[i + 1]!) ||
        !isUtf8ContinuationByte(buffer[i + 2]!)
      ) {
        return false;
      }
      i += 3;
    } else if (byte === 0xF0) {
      if (
        i + 3 >= buffer.length ||
        buffer[i + 1]! < 0x90 ||
        buffer[i + 1]! > 0xBF ||
        !isUtf8ContinuationByte(buffer[i + 2]!) ||
        !isUtf8ContinuationByte(buffer[i + 3]!)
      ) {
        return false;
      }
      i += 4;
    } else if (byte >= 0xF1 && byte <= 0xF3) {
      if (
        i + 3 >= buffer.length ||
        !isUtf8ContinuationByte(buffer[i + 1]!) ||
        !isUtf8ContinuationByte(buffer[i + 2]!) ||
        !isUtf8ContinuationByte(buffer[i + 3]!)
      ) {
        return false;
      }
      i += 4;
    } else if (byte === 0xF4) {
      if (
        i + 3 >= buffer.length ||
        buffer[i + 1]! < 0x80 ||
        buffer[i + 1]! > 0x8F ||
        !isUtf8ContinuationByte(buffer[i + 2]!) ||
        !isUtf8ContinuationByte(buffer[i + 3]!)
      ) {
        return false;
      }
      i += 4;
    } else {
      return false;
    }
  }
  return true;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xBF;
}

const CANDIDATE_ENCODINGS = ['shift-jis', 'euc-jp', 'utf-16le', 'utf-16be'] as const;

export function probeEncoding(buffer: Uint8Array): string {
  if (isValidUtf8(buffer)) {
    const sample = decodeTextSample(buffer, 'utf-8');
    if (containsJapaneseChars(sample) || isMostlyAscii(buffer)) {
      return 'utf-8';
    }
  }

  let bestEncoding = 'utf-8';
  let bestScore = -Infinity;

  for (const enc of CANDIDATE_ENCODINGS) {
    const score = scoreCandidateEncoding(buffer, enc);
    if (score > bestScore) {
      bestScore = score;
      bestEncoding = enc;
    }
  }

  return bestEncoding;
}

function decodeTextSample(buffer: Uint8Array, encoding: string): string {
  const decoder = new TextDecoder(encoding, { fatal: false });
  const sample = buffer.slice(0, Math.min(buffer.length, 4096));
  return decoder.decode(sample);
}

function containsJapaneseChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0x3040 && code <= 0x309F) ||
      (code >= 0x30A0 && code <= 0x30FF) ||
      (code >= 0x4E00 && code <= 0x9FFF)
    ) {
      return true;
    }
  }
  return false;
}

function isMostlyAscii(buffer: Uint8Array): boolean {
  let asciiCount = 0;
  const checkLen = Math.min(buffer.length, 4096);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i]! >= 0x20 && buffer[i]! <= 0x7E) asciiCount++;
  }
  return asciiCount / checkLen > 0.95;
}

function countLookalikeAsciiInCjk(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      const high = (code >> 8) & 0xFF;
      const low = code & 0xFF;
      if (
        (high >= 0x20 && high <= 0x7E) ||
        (low >= 0x20 && low <= 0x7E)
      ) {
        count++;
      }
    }
  }
  return count;
}

function scoreCandidateEncoding(buffer: Uint8Array, encoding: string): number {
  const text = decodeTextSample(buffer, encoding);

  let score = 0;
  let total = 0;
  let replacementCount = 0;
  let cjkFromAsciiCount = 0;

  for (const char of text) {
    total++;
    const code = char.charCodeAt(0);

    if (code === 0xFFFD) {
      replacementCount++;
    } else if ((code >= 0x20 && code <= 0x7E) || code === 0x0A || code === 0x0D || code === 0x09) {
      score += 1;
    } else if (code >= 0x3040 && code <= 0x309F) {
      score += 4;
    } else if (code >= 0x30A0 && code <= 0x30FF) {
      score += 4;
    } else if (code >= 0x3000 && code <= 0x303F) {
      score += 2;
    } else if (code >= 0x4E00 && code <= 0x9FFF) {
      const high = (code >> 8) & 0xFF;
      const low = code & 0xFF;
      if ((high >= 0x20 && high <= 0x7E) || (low >= 0x20 && low <= 0x7E)) {
        cjkFromAsciiCount++;
        score -= 2;
      } else {
        score += 1;
      }
    } else if (code >= 0xFF00 && code <= 0xFFEF) {
      score += 2;
    } else if (code > 0x7F) {
      score += 0.5;
    }
  }

  if (replacementCount > 0) {
    score -= replacementCount * 5;
  }

  if (cjkFromAsciiCount > total * 0.3) {
    score -= cjkFromAsciiCount * 3;
  }

  return total > 0 ? score / total : -Infinity;
}

export const EXPORT_ENCODINGS: Array<{ label: string; value: string }> = [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'UTF-16 LE', value: 'utf-16le' },
  { label: 'GBK', value: 'gbk' },
  { label: 'GB18030', value: 'gb18030' },
];

export const DEFAULT_EXPORT_ENCODING = 'utf-8';

export async function writeEncodedFile(
  filePath: string,
  content: string,
  encoding: string,
): Promise<void> {
  if (encoding === 'utf-8') {
    await writeFile(filePath, content, 'utf-8');
    return;
  }

  const encoded = iconv.encode(content, encoding);

  if (encoding === 'utf-16le') {
    const bom = new Uint8Array([0xFF, 0xFE]);
    const withBom = new Uint8Array(bom.length + encoded.length);
    withBom.set(bom);
    withBom.set(encoded, bom.length);
    await writeFile(filePath, withBom);
    return;
  }

  await writeFile(filePath, encoded);
}

export async function readTextFile(filePath: string): Promise<ReadTextFileResult> {
  const buffer = await readFile(filePath);

  const bom = detectBom(buffer);
  if (bom) {
    const decoder = new TextDecoder(bom.encoding, { fatal: false });
    const content = decoder.decode(buffer.slice(bom.bomLength));
    return { content, encoding: bom.encoding, hasBom: true };
  }

  const encoding = probeEncoding(buffer);
  const decoder = new TextDecoder(encoding, { fatal: false });
  const content = decoder.decode(buffer);
  return { content, encoding, hasBom: false };
}
