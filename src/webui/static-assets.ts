import { join } from 'node:path';

export interface StaticAsset {
  content: BodyInit;
  contentType?: string;
}

export type StaticAssetMap = ReadonlyMap<string, StaticAsset>;

export function normalizeStaticAssetPath(requestPath: string): string {
  if (requestPath === '/' || requestPath === '') {
    return 'index.html';
  }

  return requestPath.replace(/^\/+/, '').replace(/\\/g, '/');
}

export async function resolveStaticAssetResponse(
  requestPath: string,
  staticAssets?: StaticAssetMap,
  clientDistDir?: string,
): Promise<Response | null> {
  const normalizedPath = normalizeStaticAssetPath(requestPath);
  const embeddedAsset = staticAssets?.get(normalizedPath);
  if (embeddedAsset) {
    return createStaticAssetResponse(embeddedAsset);
  }

  if (clientDistDir) {
    const diskAsset = await resolveDiskAssetResponse(normalizedPath, clientDistDir);
    if (diskAsset) {
      return diskAsset;
    }
  }

  if (normalizedPath.includes('.')) {
    return null;
  }

  const embeddedIndexAsset = staticAssets?.get('index.html');
  if (embeddedIndexAsset) {
    return createStaticAssetResponse(embeddedIndexAsset, 'text/html; charset=utf-8');
  }

  if (!clientDistDir) {
    return null;
  }

  return resolveDiskAssetResponse('index.html', clientDistDir, 'text/html; charset=utf-8');
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
