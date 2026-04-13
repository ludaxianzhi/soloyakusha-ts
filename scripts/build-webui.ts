import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';

interface GeneratedAsset {
  path: string;
  contentType: string;
  contentBase64: string;
}

const projectRoot = process.cwd();
const distDir = resolve(projectRoot, 'dist');
const buildWorkspaceDir = resolve(distDir, '.webui-build');
const clientBuildDir = resolve(buildWorkspaceDir, 'client');
const embeddedAssetsModulePath = resolve(buildWorkspaceDir, 'embedded-assets.ts');
const standaloneEntryModulePath = resolve(buildWorkspaceDir, 'standalone-entry.ts');
const defaultPromptCatalogPath = resolve(
  projectRoot,
  'src',
  'prompts',
  'resources',
  'default-prompts.yaml',
);
const consistencyPromptCatalogPath = resolve(
  projectRoot,
  'src',
  'prompts',
  'resources',
  'consistency-prompts.yaml',
);
const executableFileName =
  process.platform === 'win32' ? 'soloyakusha-webui.exe' : 'soloyakusha-webui';
const executableOutputPath = resolve(distDir, executableFileName);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await rm(buildWorkspaceDir, { recursive: true, force: true });
  await mkdir(buildWorkspaceDir, { recursive: true });
  await mkdir(distDir, { recursive: true });

  await runCommand(['bun', 'x', 'vite', 'build', '--config', 'vite.webui.config.ts'], {
    WEBUI_CLIENT_OUTDIR: clientBuildDir,
  });

  const assets = await collectGeneratedAssets(clientBuildDir);
  if (assets.length === 0) {
    throw new Error('WebUI client build produced no files.');
  }

  const [defaultPromptCatalogText, consistencyPromptCatalogText] = await Promise.all([
    readFile(defaultPromptCatalogPath, 'utf8'),
    readFile(consistencyPromptCatalogPath, 'utf8'),
  ]);

  await writeFile(
    embeddedAssetsModulePath,
    buildEmbeddedAssetsModule(embeddedAssetsModulePath, assets),
    'utf8',
  );
  await writeFile(
    standaloneEntryModulePath,
    buildStandaloneEntryModule(
      standaloneEntryModulePath,
      embeddedAssetsModulePath,
      defaultPromptCatalogText,
      consistencyPromptCatalogText,
    ),
    'utf8',
  );

  await runCommand(
    [
      'bun',
      'build',
      '--compile',
      '--minify',
      '--outfile',
      executableOutputPath,
      standaloneEntryModulePath,
    ],
  );

  await rm(buildWorkspaceDir, { recursive: true, force: true });

  console.log(`\nStandalone WebUI executable built: ${executableOutputPath}`);
}

async function runCommand(command: string[], extraEnv?: Record<string, string>) {
  const subprocess = Bun.spawn(command, {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await subprocess.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(' ')}`);
  }
}

async function collectGeneratedAssets(rootDir: string): Promise<GeneratedAsset[]> {
  const filePaths = await walkFiles(rootDir);
  const assets = await Promise.all(
    filePaths.map(async (filePath) => {
      const content = await readFile(filePath);
      const relativePath = relative(rootDir, filePath).replace(/\\/g, '/');

      return {
        path: relativePath,
        contentType: inferContentType(filePath),
        contentBase64: content.toString('base64'),
      } satisfies GeneratedAsset;
    }),
  );

  return assets.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...(await walkFiles(entryPath)));
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

function buildEmbeddedAssetsModule(
  modulePath: string,
  assets: GeneratedAsset[],
): string {
  const staticAssetsImport = toImportSpecifier(
    modulePath,
    resolve(projectRoot, 'src', 'webui', 'static-assets.ts'),
  );
  const serializedAssets = assets
    .map(
      (asset) =>
        `  [${JSON.stringify(asset.path)}, { contentType: ${JSON.stringify(asset.contentType)}, contentBase64: ${JSON.stringify(asset.contentBase64)} }],`,
    )
    .join('\n');

  return `import type { StaticAssetMap } from ${JSON.stringify(staticAssetsImport)};

const assetEntries = [
${serializedAssets}
] as const;

export const embeddedStaticAssets: StaticAssetMap = new Map(
  assetEntries.map(([path, asset]) => [
    path,
    {
      content: Buffer.from(asset.contentBase64, 'base64'),
      contentType: asset.contentType,
    },
  ]),
);
`;
}

function buildStandaloneEntryModule(
  modulePath: string,
  assetsModulePath: string,
  defaultPromptCatalogText: string,
  consistencyPromptCatalogText: string,
): string {
  const serverImport = toImportSpecifier(
    modulePath,
    resolve(projectRoot, 'src', 'webui', 'server.ts'),
  );
  const assetsImport = toImportSpecifier(modulePath, assetsModulePath);
  const promptManagerImport = toImportSpecifier(
    modulePath,
    resolve(projectRoot, 'src', 'prompts', 'manager.ts'),
  );
  const consistencyPromptManagerImport = toImportSpecifier(
    modulePath,
    resolve(projectRoot, 'src', 'consistency', 'prompt-manager.ts'),
  );

  return `import { createWebUiServer, logWebUiServerStart } from ${JSON.stringify(serverImport)};
import { embeddedStaticAssets } from ${JSON.stringify(assetsImport)};
import { getDefaultPromptFilePath, registerEmbeddedPromptCatalog } from ${JSON.stringify(promptManagerImport)};
import { getConsistencyPromptFilePath } from ${JSON.stringify(consistencyPromptManagerImport)};

registerEmbeddedPromptCatalog(
  getDefaultPromptFilePath(),
  ${JSON.stringify(defaultPromptCatalogText)},
);
registerEmbeddedPromptCatalog(
  getConsistencyPromptFilePath(),
  ${JSON.stringify(consistencyPromptCatalogText)},
);

const server = createWebUiServer({
  staticAssets: embeddedStaticAssets,
});

logWebUiServerStart(server.port);

export default server;
`;
}

function toImportSpecifier(fromFile: string, toFile: string): string {
  const relativePath = relative(dirname(fromFile), toFile).replace(/\\/g, '/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function inferContentType(filePath: string): string {
  const bunInferredType = Bun.file(filePath).type;
  if (bunInferredType) {
    return bunInferredType;
  }

  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}
