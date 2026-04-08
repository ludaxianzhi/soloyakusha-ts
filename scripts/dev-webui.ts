const projectRoot = process.cwd();

interface ManagedProcess {
  name: string;
  command: string[];
  subprocess: Bun.Subprocess<'inherit', 'inherit', 'inherit'>;
}

const managedProcesses: ManagedProcess[] = [
  spawnProcess('backend', ['bun', '--hot', 'src/webui/index.ts']),
  spawnProcess('frontend', ['bun', 'x', 'vite', '--config', 'vite.webui.config.ts']),
];

let shuttingDown = false;
const shutdownSignals = ['SIGINT', 'SIGTERM'] as const;

for (const signal of shutdownSignals) {
  process.once(signal, () => {
    void shutdown(0, `Received ${signal}, shutting down WebUI dev processes...`);
  });
}

console.log('\nStarting SoloYakusha WebUI dev environment...');
console.log('  Frontend: http://localhost:5173');
console.log('  Backend:  http://localhost:8000\n');

const firstExit = await Promise.race(
  managedProcesses.map(async (processInfo) => ({
    name: processInfo.name,
    exitCode: await processInfo.subprocess.exited,
  })),
);

if (!shuttingDown) {
  const exitCode = firstExit.exitCode === 0 ? 0 : firstExit.exitCode;
  const detail =
    firstExit.exitCode === 0
      ? `${firstExit.name} exited, stopping remaining dev processes...`
      : `${firstExit.name} exited with code ${firstExit.exitCode}, stopping remaining dev processes...`;
  await shutdown(exitCode, detail);
}

function spawnProcess(name: string, command: string[]): ManagedProcess {
  return {
    name,
    command,
    subprocess: Bun.spawn(command, {
      cwd: projectRoot,
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  };
}

async function shutdown(exitCode: number, detail: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`\n${detail}\n`);

  for (const processInfo of managedProcesses) {
    stopProcess(processInfo);
  }

  await Promise.allSettled(
    managedProcesses.map((processInfo) => processInfo.subprocess.exited),
  );

  process.exitCode = exitCode;
}

function stopProcess(processInfo: ManagedProcess) {
  try {
    processInfo.subprocess.kill();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Failed to stop ${processInfo.name} (${processInfo.command.join(' ')}): ${message}`,
    );
  }
}
