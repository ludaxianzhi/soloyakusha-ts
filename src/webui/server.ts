import { createServer } from 'node:net';
import { createApp, type CreateAppOptions } from './app.ts';

export interface WebUiServerOptions extends CreateAppOptions {
  port?: number;
  hostname?: string;
}

export async function resolveWebUiPort(
  preferredPort = getDefaultWebUiPort(),
  hostname = getDefaultWebUiHost(),
): Promise<number> {
  for (let port = preferredPort; port < preferredPort + 50; port += 1) {
    if (await canBindPort(port, hostname)) {
      return port;
    }
  }

  throw new Error(
    `无法找到可用的 WebUI 端口：从 ${preferredPort} 开始连续尝试 50 个端口都被占用`,
  );
}

export function createWebUiServer(options: WebUiServerOptions = {}) {
  const port = options.port ?? getDefaultWebUiPort();
  const hostname = options.hostname ?? getDefaultWebUiHost();
  const runtime = createApp(options);

  return {
    ...runtime,
    port,
    hostname,
    fetch: runtime.app.fetch,
  };
}

export function logWebUiServerStart(port: number) {
  console.log(`\n  🌐 SoloYakusha WebUI 已启动`);
  console.log(`  → http://localhost:${port}\n`);
}

function getDefaultWebUiPort(): number {
  const parsedPort = Number(process.env.PORT);
  return Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8000;
}

function getDefaultWebUiHost(): string {
  return process.env.HOST || '0.0.0.0';
}

function canBindPort(port: number, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    const finalize = (result: boolean) => {
      try {
        probe.close();
      } catch {
        // Ignore close errors while probing availability.
      }
      resolve(result);
    };

    probe.once('error', () => finalize(false));
    probe.once('listening', () => finalize(true));
    probe.listen({ port, host: hostname, exclusive: true });
  });
}
