import { expect, test } from 'bun:test';
import { LogService } from './log-service.ts';

test('LogService paginates logs from newest to oldest', () => {
  const svc = new LogService();
  for (let index = 1; index <= 5; index += 1) {
    svc.addLog('info', `message ${index}`);
  }

  const digest = svc.getLogDigest();
  expect(digest).toEqual({
    total: 5,
    latestId: 5,
  });

  const firstPage = svc.getLogPage({ limit: 2 });
  expect(firstPage.items.map((entry) => entry.id)).toEqual([5, 4]);
  expect(firstPage.nextBeforeId).toBe(4);

  const secondPage = svc.getLogPage({
    limit: 2,
    beforeId: firstPage.nextBeforeId,
  });
  expect(secondPage.items.map((entry) => entry.id)).toEqual([3, 2]);
});

test('LogService clears log digest and pages together', () => {
  const svc = new LogService();
  svc.addLog('warning', 'one');
  svc.clearLogs();

  expect(svc.getLogDigest()).toEqual({
    total: 0,
    latestId: 0,
  });
  expect(svc.getLogPage({ limit: 10 }).items).toEqual([]);
});

test('LogService exposes runtime log session metadata and formatted exports', () => {
  const svc = new LogService();
  svc.addLog('info', 'hello');

  const session = svc.getLogSession();
  expect(session.runId).toContain('webui-');
  expect(session.startedAt).toContain('T');

  const textExport = svc.formatLogExport();
  expect(textExport.fileName).toEndWith('.txt');
  expect(textExport.content).toContain('hello');
  expect(textExport.content).toContain(session.runId);

  const jsonExport = svc.formatLogExport('json');
  expect(jsonExport.fileName).toEndWith('.json');
  expect(jsonExport.content).toContain('"items"');
  expect(jsonExport.content).toContain('"runId"');
});

test('LogService filters logs by workspace and emits workspace metadata', () => {
  const svc = new LogService();

  svc.addLog('info', 'shared');
  svc.addLog('warning', 'workspace-a', 'workspace-a');
  svc.addLog('warning', 'workspace-b', 'workspace-b');

  expect(svc.getLogDigest()).toEqual({
    total: 3,
    latestId: 3,
  });
  expect(svc.getLogDigest('workspace-a')).toEqual({
    total: 1,
    latestId: 2,
  });
  expect(svc.getLogPage({ workspaceId: 'workspace-a' }).items).toHaveLength(1);

  const exportText = svc.formatLogExport('text', 'workspace-a');
  expect(exportText.content).toContain('Workspace: workspace-a');
  expect(exportText.content).toContain('workspace-a');
  expect(exportText.content).not.toContain('workspace-b');
});
