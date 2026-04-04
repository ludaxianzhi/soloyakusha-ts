import { join } from 'node:path';

export interface StaticAsset {
  content: BodyInit;
  contentType?: string;
}

export type StaticAssetMap = ReadonlyMap<string, StaticAsset>;

export interface StaticAssetLookupOptions {
  staticAssets?: StaticAssetMap;
  clientDistDir: string;
}

export function normalizeStaticAssetPath(requestPath: string): string {
  if (requestPath === '/' || requestPath === '') {
    return 'index.html';
  }

  return requestPath.replace(/^\/+/, '').replace(/\\/g, '/');
}

export async function resolveStaticAssetResponse(
  requestPath: string,
  options: StaticAssetLookupOptions,
): Promise<Response | null> {
  const normalizedPath = normalizeStaticAssetPath(requestPath);
  const embeddedAsset = options.staticAssets?.get(normalizedPath);
  if (embeddedAsset) {
    return createStaticAssetResponse(embeddedAsset);
  }

  const diskAsset = await resolveDiskAssetResponse(normalizedPath, options.clientDistDir);
  if (diskAsset) {
    return diskAsset;
  }

  if (normalizedPath.includes('.')) {
    return null;
  }

  const embeddedIndexAsset = options.staticAssets?.get('index.html');
  if (embeddedIndexAsset) {
    return createStaticAssetResponse(embeddedIndexAsset, 'text/html; charset=utf-8');
  }

  return resolveDiskAssetResponse('index.html', options.clientDistDir, 'text/html; charset=utf-8');
}

function createStaticAssetResponse(
  asset: StaticAsset,
  fallbackContentType?: string,
): Response {
  const headers = new Headers();
  const contentType = asset.contentType ?? fallbackContentType;
  if (contentType) {
    headers.set('Content-Type', contentType);
  }

  return new Response(asset.content, {
    headers,
  });
}

async function resolveDiskAssetResponse(
  relativeAssetPath: string,
  clientDistDir: string,
  fallbackContentType?: string,
): Promise<Response | null> {
  const assetFile = Bun.file(join(clientDistDir, ...relativeAssetPath.split('/')));
  if (!(await assetFile.exists())) {
    return null;
  }

  const headers = new Headers();
  const contentType = assetFile.type || fallbackContentType;
  if (contentType) {
    headers.set('Content-Type', contentType);
  }

  return new Response(assetFile, {
    headers,
  });
}
