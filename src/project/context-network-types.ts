export const CONTEXT_NETWORK_SCHEMA_VERSION = 1;

export type ContextNetworkManifest = {
  schemaVersion: typeof CONTEXT_NETWORK_SCHEMA_VERSION;
  sourceRevision: number;
  fragmentCount: number;
  blockSize: number;
  edgeCount: number;
  maxOutgoingPerNode?: number;
  createdAt: string;
};

export type ContextNetworkData = {
  manifest: ContextNetworkManifest;
  offsets: Uint32Array;
  targets: Int32Array;
  strengths: Int32Array;
};