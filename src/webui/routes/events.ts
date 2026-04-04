/**
 * SSE 事件推送路由：向前端实时推送项目快照与日志事件。
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from '../services/event-bus.ts';

export function createEventsRoute(eventBus: EventBus): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return streamSSE(c, async (stream) => {
      let eventId = 0;

      const unsubscribe = eventBus.subscribe((event) => {
        void stream.writeSSE({
          id: String(++eventId),
          event: event.type,
          data: JSON.stringify(event.data),
        });
      });

      // 保持连接直到客户端断开
      try {
        while (true) {
          await stream.sleep(30_000);
          // 心跳
          void stream.writeSSE({
            id: String(++eventId),
            event: 'ping',
            data: '{}',
          });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  /** 获取当前所有日志 */
  app.get('/logs', (c) => {
    return c.json({ logs: eventBus.getLogs() });
  });

  /** 清空日志 */
  app.post('/logs/clear', (c) => {
    eventBus.clearLogs();
    return c.json({ ok: true });
  });

  return app;
}
