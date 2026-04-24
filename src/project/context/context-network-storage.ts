import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONTEXT_NETWORK_SCHEMA_VERSION,
  type ContextNetworkData,
  type ContextNetworkManifest,
} from "./context-network-types.ts";

const CONTEXT_NETWORK_DIR = join("Data", "context-network");
const MANIFEST_FILE_NAME = "manifest.json";
const OFFSETS_FILE_NAME = "offsets.u32";
const TARGETS_FILE_NAME = "targets.i32";
const STRENGTHS_FILE_NAME = "strengths.f32";

export async function loadContextNetwork(
  projectDir: string,
): Promise<ContextNetworkData | undefined> {
  const manifestPath = getContextNetworkManifestPath(projectDir);
  let manifestContent: string;
  try {
    manifestContent = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  const manifest = parseManifest(manifestContent, manifestPath);
  const [offsetsBuffer, targetsBuffer, strengthsBuffer] = await Promise.all([
    readFile(getContextNetworkOffsetsPath(projectDir)),
    readFile(getContextNetworkTargetsPath(projectDir)),
    readFile(getContextNetworkStrengthsPath(projectDir)),
  ]);

  const offsets = toUint32Array(offsetsBuffer, "offsets.u32");
  const targets = toInt32Array(targetsBuffer, "targets.i32");
  const strengths = toFloat32Array(strengthsBuffer, "strengths.f32");
  validateContextNetworkData({ manifest, offsets, targets, strengths });

  return {
    manifest,
    offsets,
    targets,
    strengths,
  };
}

export async function saveContextNetwork(
  projectDir: string,
  data: ContextNetworkData,
): Promise<void> {
  validateContextNetworkData(data);
  const directoryPath = getContextNetworkDirectoryPath(projectDir);
  await mkdir(directoryPath, { recursive: true });

  await Promise.all([
    writeAtomicTextFile(
      getContextNetworkManifestPath(projectDir),
      `${JSON.stringify(data.manifest, null, 2)}\n`,
    ),
    writeAtomicBinaryFile(getContextNetworkOffsetsPath(projectDir), data.offsets),
    writeAtomicBinaryFile(getContextNetworkTargetsPath(projectDir), data.targets),
    writeAtomicBinaryFile(getContextNetworkStrengthsPath(projectDir), data.strengths),
  ]);
}

export async function clearContextNetwork(projectDir: string): Promise<void> {
  await rm(getContextNetworkDirectoryPath(projectDir), { recursive: true, force: true });
}

export function getContextNetworkDirectoryPath(projectDir: string): string {
  return resolve(projectDir, CONTEXT_NETWORK_DIR);
}

export function getContextNetworkManifestPath(projectDir: string): string {
  return join(getContextNetworkDirectoryPath(projectDir), MANIFEST_FILE_NAME);
}

export function getContextNetworkOffsetsPath(projectDir: string): string {
  return join(getContextNetworkDirectoryPath(projectDir), OFFSETS_FILE_NAME);
}

export function getContextNetworkTargetsPath(projectDir: string): string {
  return join(getContextNetworkDirectoryPath(projectDir), TARGETS_FILE_NAME);
}

export function getContextNetworkStrengthsPath(projectDir: string): string {
  return join(getContextNetworkDirectoryPath(projectDir), STRENGTHS_FILE_NAME);
}

function parseManifest(content: string, path: string): ContextNetworkManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `上下文网络清单不是合法 JSON: ${path}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`上下文网络清单格式无效: ${path}`);
  }

  const {
    schemaVersion,
    sourceRevision,
    fragmentCount,
    blockSize,
    edgeCount,
    maxOutgoingPerNode,
    createdAt,
  } = parsed;

  if (schemaVersion !== CONTEXT_NETWORK_SCHEMA_VERSION) {
    throw new Error(`上下文网络 schemaVersion 不受支持: ${String(schemaVersion)}`);
  }
  if (!isNonNegativeInteger(sourceRevision)) {
    throw new Error("上下文网络 sourceRevision 必须是非负整数");
  }
  if (!isNonNegativeInteger(fragmentCount)) {
    throw new Error("上下文网络 fragmentCount 必须是非负整数");
  }
  if (!isPositiveInteger(blockSize)) {
    throw new Error("上下文网络 blockSize 必须是正整数");
  }
  if (!isNonNegativeInteger(edgeCount)) {
    throw new Error("上下文网络 edgeCount 必须是非负整数");
  }
  if (
    maxOutgoingPerNode !== undefined &&
    !isNonNegativeInteger(maxOutgoingPerNode)
  ) {
    throw new Error("上下文网络 maxOutgoingPerNode 必须是非负整数");
  }
  if (typeof createdAt !== "string" || createdAt.trim().length === 0) {
    throw new Error("上下文网络 createdAt 必须是非空字符串");
  }

  return {
    schemaVersion: CONTEXT_NETWORK_SCHEMA_VERSION,
    sourceRevision,
    fragmentCount,
    blockSize,
    edgeCount,
    maxOutgoingPerNode,
    createdAt,
  };
}

function validateContextNetworkData(data: ContextNetworkData): void {
  const { manifest, offsets, targets, strengths } = data;
  if (offsets.length !== manifest.fragmentCount + 1) {
    throw new Error(
      `上下文网络 offsets 长度无效: expected=${manifest.fragmentCount + 1}, actual=${offsets.length}`,
    );
  }
  if (targets.length !== manifest.edgeCount) {
    throw new Error(
      `上下文网络 targets 长度无效: expected=${manifest.edgeCount}, actual=${targets.length}`,
    );
  }
  if (strengths.length !== manifest.edgeCount) {
    throw new Error(
      `上下文网络 strengths 长度无效: expected=${manifest.edgeCount}, actual=${strengths.length}`,
    );
  }
  if (offsets[0] !== 0) {
    throw new Error("上下文网络 offsets 必须以 0 开始");
  }
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index - 1]! > offsets[index]!) {
      throw new Error(`上下文网络 offsets 必须单调不减: index=${index}`);
    }
  }
  if (offsets[offsets.length - 1] !== manifest.edgeCount) {
    throw new Error(
      `上下文网络 offsets 终值无效: expected=${manifest.edgeCount}, actual=${offsets[offsets.length - 1]}`,
    );
  }
}

function toUint32Array(buffer: Buffer, label: string): Uint32Array {
  if (buffer.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`上下文网络 ${label} 字节长度无效`);
  }
  return new Uint32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
}

function toInt32Array(buffer: Buffer, label: string): Int32Array {
  if (buffer.byteLength % Int32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`上下文网络 ${label} 字节长度无效`);
  }
  return new Int32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
}

function toFloat32Array(buffer: Buffer, label: string): Float32Array {
  if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`上下文网络 ${label} 字节长度无效`);
  }
  return new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
}

async function writeAtomicTextFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

async function writeAtomicBinaryFile(
  path: string,
  array: Uint32Array | Int32Array | Float32Array,
): Promise<void> {
  const tempPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  await rename(tempPath, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}