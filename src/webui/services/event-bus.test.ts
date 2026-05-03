import { expect, test } from 'bun:test';
import { EventBus } from './event-bus.ts';

test('EventBus paginates logs from newest to oldest', () => {
  const eventBus = new EventBus();
  for (let index = 1; index <= 5; index += 1) {
    eventBus.addLog('info', `message ${index}`);
  }

  const digest = eventBus.getLogDigest();
  expect(digest).toEqual({
    total: 5,
    latestId: 5,
  });

  const firstPage = eventBus.getLogPage({ limit: 2 });
  expect(firstPage.items.map((entry) => entry.id)).toEqual([5, 4]);
  expect(firstPage.nextBeforeId).toBe(4);

  const secondPage = eventBus.getLogPage({
    limit: 2,
    beforeId: firstPage.nextBeforeId,
  });
  expect(secondPage.items.map((entry) => entry.id)).toEqual([3, 2]);
});

test('EventBus clears log digest and pages together', () => {
  const eventBus = new EventBus();
  eventBus.addLog('warning', 'one');
  eventBus.clearLogs();

  expect(eventBus.getLogDigest()).toEqual({
    total: 0,
    latestId: 0,
  });
  expect(eventBus.getLogPage({ limit: 10 }).items).toEqual([]);
});

test('EventBus exposes runtime log session metadata and formatted exports', () => {
  const eventBus = new EventBus();
  eventBus.addLog('info', 'hello');

  const session = eventBus.getLogSession();
  expect(session.runId).toContain('webui-');
  expect(session.startedAt).toContain('T');

  const textExport = eventBus.formatLogExport();
  expect(textExport.fileName).toEndWith('.txt');
  expect(textExport.content).toContain('hello');
  expect(textExport.content).toContain(session.runId);

  const jsonExport = eventBus.formatLogExport('json');
  expect(jsonExport.fileName).toEndWith('.json');
  expect(jsonExport.content).toContain('"items"');
  expect(jsonExport.content).toContain('"runId"');
});

test('EventBus filters logs by workspace and emits workspace metadata', () => {
  const eventBus = new EventBus();
  const received: Array<{ type: string; workspaceId: string | null }> = [];

  const unsubscribe = eventBus.subscribe((event) => {
    received.push({
      type: event.type,
      workspaceId: event.workspaceId,
    });
  });

  eventBus.addLog('info', 'shared');
  eventBus.addLog('warning', 'workspace-a', 'workspace-a');
  eventBus.addLog('warning', 'workspace-b', 'workspace-b');
  unsubscribe();

  expect(received).toEqual([
    { type: 'log', workspaceId: null },
    { type: 'log', workspaceId: 'workspace-a' },
    { type: 'log', workspaceId: 'workspace-b' },
  ]);

  expect(eventBus.getLogDigest()).toEqual({
    total: 3,
    latestId: 3,
  });
  expect(eventBus.getLogDigest('workspace-a')).toEqual({
    total: 1,
    latestId: 2,
  });
  expect(eventBus.getLogPage({ workspaceId: 'workspace-a' }).items).toHaveLength(1);

  const exportText = eventBus.formatLogExport('text', 'workspace-a');
  expect(exportText.content).toContain('Workspace: workspace-a');
  expect(exportText.content).toContain('workspace-a');
  expect(exportText.content).not.toContain('workspace-b');
});
