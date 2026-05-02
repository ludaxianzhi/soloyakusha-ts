import type { SqliteMemoryWorkerRequest, SqliteMemoryWorkerResponse } from "./sqlite-memory-protocol.ts";
import { createSqliteMemoryWorkerRuntime } from "./sqlite-memory-runtime.ts";

const runtime = createSqliteMemoryWorkerRuntime((response, transfer = []) => {
  globalThis.postMessage(response, { transfer });
});

globalThis.addEventListener("message", (event: MessageEvent<SqliteMemoryWorkerRequest>) => {
  void runtime.handleRequest(event.data);
});