import { expect, test } from 'bun:test';
import { EventBus } from './event-bus.ts';
import { LogService } from './log-service.ts';

test('EventBus emits and subscribes to events', () => {
  const eventBus = new EventBus();
  const received: Array<{ type: string; workspaceId: string | null; data: unknown }> = [];

  const unsubscribe = eventBus.subscribe((event) => {
    received.push({ type: event.type, workspaceId: event.workspaceId, data: event.data });
  });

  eventBus.emit({ type: 'snapshot', workspaceId: null, data: { status: 'ok' } });
  eventBus.emit({ type: 'log', workspaceId: 'ws-1', data: { level: 'info', message: 'test' } });
  unsubscribe();

  eventBus.emit({ type: 'log', workspaceId: null, data: {} });

  expect(received).toHaveLength(2);
  expect(received[0]).toEqual({
    type: 'snapshot',
    workspaceId: null,
    data: { status: 'ok' },
  });
  expect(received[1]).toEqual({
    type: 'log',
    workspaceId: 'ws-1',
    data: { level: 'info', message: 'test' },
  });
});

test('EventBus addLog delegates to LogService and emits log event', () => {
  const logService = new LogService();
  const eventBus = new EventBus();
  eventBus.setLogService(logService);

  const received: Array<{ type: string; workspaceId: string | null }> = [];
  const unsubscribe = eventBus.subscribe((event) => {
    received.push({ type: event.type, workspaceId: event.workspaceId });
  });

  eventBus.addLog('info', 'hello');
  eventBus.addLog('warning', 'workspace-a', 'workspace-a');
  unsubscribe();

  expect(received).toEqual([
    { type: 'log', workspaceId: null },
    { type: 'log', workspaceId: 'workspace-a' },
  ]);

  const allLogs = logService.getLogs();
  expect(allLogs).toHaveLength(2);
  expect(allLogs[0]!.level).toBe('info');
  expect(allLogs[0]!.message).toBe('hello');
  expect(allLogs[1]!.workspaceId).toBe('workspace-a');
});

test('EventBus addLog works without LogService (no crash)', () => {
  const eventBus = new EventBus();
  let emitted = false;
  const unsub = eventBus.subscribe(() => { emitted = true; });

  eventBus.addLog('info', 'no-service');
  expect(emitted).toBe(true);
  unsub();
});

test('EventBus addLog passes metadata to LogService and SSE data', () => {
  const logService = new LogService();
  const eventBus = new EventBus();
  eventBus.setLogService(logService);

  const received: Array<{ type: string; data: unknown }> = [];
  const unsubscribe = eventBus.subscribe((event) => {
    received.push({ type: event.type, data: event.data });
  });

  const meta = { key: 'value', count: 42 };
  eventBus.addLog('error', 'something failed', null, meta);
  unsubscribe();

  const sseData = received[0]!.data as Record<string, unknown>;
  expect(sseData.level).toBe('error');
  expect(sseData.message).toBe('something failed');
  expect(sseData.metadata).toEqual(meta);

  const allLogs = logService.getLogs();
  expect(allLogs).toHaveLength(1);
  expect(allLogs[0]!.metadata).toEqual(meta);
});
