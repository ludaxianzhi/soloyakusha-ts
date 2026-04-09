import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { extractArchiveToDirectory } from './archive-extractor.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('extractArchiveToDirectory strips single archive root folder by default', async () => {
  const targetDir = await mkdtemp(join(tmpdir(), 'soloyakusha-archive-extractor-'));
  tempDirs.push(targetDir);

  const zip = new JSZip();
  zip.file('root/chapter-1.txt', 'line-1');
  zip.file('root/sub/chapter-2.txt', 'line-2');
  const archive = await zip.generateAsync({ type: 'uint8array' });

  const extractedFiles = await extractArchiveToDirectory(targetDir, copyArrayBuffer(archive.buffer), {
    archiveFileName: 'append.zip',
    stripSingleRoot: true,
  });

  expect(extractedFiles).toEqual(['chapter-1.txt', 'sub/chapter-2.txt']);
  expect(await readFile(join(targetDir, 'chapter-1.txt'), 'utf8')).toBe('line-1');
  expect(await readFile(join(targetDir, 'sub', 'chapter-2.txt'), 'utf8')).toBe('line-2');
});

test('extractArchiveToDirectory keeps archive root when stripSingleRoot is disabled', async () => {
  const targetDir = await mkdtemp(join(tmpdir(), 'soloyakusha-archive-extractor-'));
  tempDirs.push(targetDir);

  const zip = new JSZip();
  zip.file('root/chapter-1.txt', 'line-1');
  const archive = await zip.generateAsync({ type: 'uint8array' });

  const extractedFiles = await extractArchiveToDirectory(targetDir, copyArrayBuffer(archive.buffer), {
    archiveFileName: 'append.zip',
    stripSingleRoot: false,
  });

  expect(extractedFiles).toEqual(['root/chapter-1.txt']);
  expect(await readFile(join(targetDir, 'root', 'chapter-1.txt'), 'utf8')).toBe('line-1');
});

function copyArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  return Uint8Array.from(new Uint8Array(buffer)).buffer;
}
