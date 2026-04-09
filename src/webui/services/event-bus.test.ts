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
