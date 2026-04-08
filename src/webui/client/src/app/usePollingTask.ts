import { useEffect, useRef } from 'react';

interface UsePollingTaskOptions {
  enabled: boolean;
  intervalMs: number;
  task: () => Promise<void>;
}

export function usePollingTask({
  enabled,
  intervalMs,
  task,
}: UsePollingTaskOptions) {
  const taskRef = useRef(task);
  const runningRef = useRef(false);

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let disposed = false;

    const run = async () => {
      if (disposed || document.visibilityState === 'hidden' || runningRef.current) {
        return;
      }

      runningRef.current = true;
      try {
        await taskRef.current();
      } catch (error) {
        console.error('Polling task failed.', error);
      } finally {
        runningRef.current = false;
      }
    };

    void run();
    const intervalId = window.setInterval(() => {
      void run();
    }, intervalMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void run();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, intervalMs]);
}
