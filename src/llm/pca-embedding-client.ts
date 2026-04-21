/**
 * PCA 降维嵌入层：包装任意 EmbeddingClient，透明地将原始高维嵌入向量降维至目标维度。
 *
 * 核心组件：
 * - {@link PcaProjection}：独立的 PCA 投影器，从 JSON 权重文件加载模型并执行降维
 * - {@link PcaEmbeddingClient}：包装任意 {@link EmbeddingClient}，在获取原始嵌入后自动应用 PCA 降维
 *
 * 权重格式：
 * - 支持 train_pca.py 输出的 JSON 格式（包含 base64 编码的 float32 矩阵）
 * - 关键字段：`pca.components`（形状 [target_dim, input_dim]）、`pca.mean`（形状 [input_dim]）
 *
 * 计算方式：
 * - 降维公式：y = (x - mean) @ components.T
 * - 使用 BLAS ddot 对每个输出维度进行加速点积计算
 *
 * @module llm/pca-embedding-client
 */

import { readFileSync } from "node:fs";
import ddot from "@stdlib/blas-base-ddot";
import { EmbeddingClient } from "./base.ts";

// ---- JSON 权重格式类型 -------------------------------------------------------

/**
 * train_pca.py 输出的 ndarray 序列化格式（float32 base64 编码）。
 */
export type PcaNdarrayBlob = {
  dtype: "float32";
  shape: number[];
  /** base64 编码的 float32 小端字节序列 */
  data: string;
};

/**
 * train_pca.py 输出的 PCA 权重 JSON 文件完整格式。
 * 文件中允许存在其他附加字段（source_file、embedding 配置等），会被忽略。
 */
export type PcaJsonWeights = {
  pca: {
    target_dim: number;
    input_dim: number;
    /** 主成分矩阵，形状 [target_dim, input_dim]，行主序 */
    components: PcaNdarrayBlob;
    /** 训练集均值向量，形状 [input_dim] */
    mean: PcaNdarrayBlob;
    explained_variance_ratio_sum?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

// ---- 内部工具函数 -------------------------------------------------------------

/**
 * 将 PcaNdarrayBlob（base64 float32）解码为 Float64Array，供 BLAS 使用。
 * 类型从 float32 提升到 float64 在加载时一次完成，推理期间无额外转换开销。
 */
function decodeBlobToF64(blob: PcaNdarrayBlob): Float64Array {
  const buf = Buffer.from(blob.data, "base64");
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const f64 = new Float64Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    f64[i] = f32[i] as number;
  }
  return f64;
}

function validateJsonWeights(raw: unknown, filePath?: string): PcaJsonWeights {
  const src = filePath ? ` (${filePath})` : "";
  if (typeof raw !== "object" || raw === null || !("pca" in raw)) {
    throw new Error(`PCA 权重文件格式错误${src}: 缺少顶层 "pca" 字段`);
  }
  const typed = raw as PcaJsonWeights;
  const { pca } = typed;
  if (typeof pca.target_dim !== "number" || typeof pca.input_dim !== "number") {
    throw new Error(`PCA 权重文件格式错误${src}: pca.target_dim / pca.input_dim 必须为数字`);
  }
  if (!pca.components || !pca.mean) {
    throw new Error(`PCA 权重文件格式错误${src}: 缺少 pca.components 或 pca.mean`);
  }
  return typed;
}

// ---- PcaProjection -----------------------------------------------------------

/**
 * 独立的 PCA 投影器，持有解码后的权重并执行降维计算。
 *
 * 降维算法：
 * 1. 中心化：x_centered = x - mean
 * 2. 投影：y[i] = dot(components[i], x_centered)（对每个主成分使用 BLAS ddot）
 *
 * 线程安全：实例为不可变对象，`project` / `projectBatch` 可安全并发调用。
 */
export class PcaProjection {
  /** 原始嵌入向量的维度 */
  readonly inputDim: number;
  /** PCA 降维后的目标维度 */
  readonly targetDim: number;
  /** 主成分矩阵，行主序扁平化存储，Float64Array，长度 targetDim × inputDim */
  private readonly components: Float64Array;
  /** 训练集均值向量，Float64Array，长度 inputDim */
  private readonly mean: Float64Array;

  private constructor(
    inputDim: number,
    targetDim: number,
    components: Float64Array,
    mean: Float64Array,
  ) {
    this.inputDim = inputDim;
    this.targetDim = targetDim;
    this.components = components;
    this.mean = mean;
  }

  /**
   * 从已解析的 {@link PcaJsonWeights} 对象创建 PcaProjection。
   */
  static fromJsonWeights(weights: PcaJsonWeights): PcaProjection {
    const { pca } = weights;
    const { target_dim, input_dim } = pca;

    const components = decodeBlobToF64(pca.components);
    const mean = decodeBlobToF64(pca.mean);

    const expectedCompLen = target_dim * input_dim;
    if (components.length !== expectedCompLen) {
      throw new Error(
        `PCA components 尺寸不匹配: 期望 ${expectedCompLen} (${target_dim}×${input_dim}), 实际 ${components.length}`,
      );
    }
    if (mean.length !== input_dim) {
      throw new Error(
        `PCA mean 尺寸不匹配: 期望 ${input_dim}, 实际 ${mean.length}`,
      );
    }

    return new PcaProjection(input_dim, target_dim, components, mean);
  }

  /**
   * 从 JSON 字符串解析并创建 PcaProjection。
   */
  static fromJsonString(jsonString: string): PcaProjection {
    const raw: unknown = JSON.parse(jsonString);
    return PcaProjection.fromJsonWeights(validateJsonWeights(raw));
  }

  /**
   * 从 JSON 文件路径同步加载并创建 PcaProjection。
   *
   * @param filePath - JSON 权重文件的绝对或相对路径
   */
  static fromJsonFile(filePath: string): PcaProjection {
    const content = readFileSync(filePath, "utf-8");
    const raw: unknown = JSON.parse(content);
    return PcaProjection.fromJsonWeights(validateJsonWeights(raw, filePath));
  }

  /**
   * 对单个嵌入向量执行 PCA 降维。
   *
   * 使用 BLAS ddot 加速每个输出维度的点积计算，时间复杂度 O(target_dim × input_dim)。
   *
   * @param vector - 原始嵌入向量，长度须等于 inputDim
   * @returns 降维后的向量，长度等于 targetDim
   */
  project(vector: readonly number[]): number[] {
    if (vector.length !== this.inputDim) {
      throw new Error(
        `输入向量维度不匹配: 期望 ${this.inputDim}, 实际 ${vector.length}`,
      );
    }

    // 步骤 1：计算中心化向量 x_centered = x - mean
    const xCentered = new Float64Array(this.inputDim);
    for (let j = 0; j < this.inputDim; j++) {
      xCentered[j] = (vector[j] as number) - (this.mean[j] as number);
    }

    // 步骤 2：对每个主成分行调用 BLAS ddot
    // y[i] = dot(components[i, :], x_centered)
    const result = new Array<number>(this.targetDim);
    for (let i = 0; i < this.targetDim; i++) {
      const rowStart = i * this.inputDim;
      const rowEnd = rowStart + this.inputDim;
      const row = this.components.subarray(rowStart, rowEnd);
      result[i] = ddot(this.inputDim, row, 1, xCentered, 1);
    }

    return result;
  }

  /**
   * 批量对多个嵌入向量执行 PCA 降维。
   * 共用同一份 mean 和 components，避免重复分配。
   *
   * @param vectors - 原始嵌入向量数组
   * @returns 降维后的向量数组，顺序与输入一致
   */
  projectBatch(vectors: readonly (readonly number[])[]): number[][] {
    return vectors.map((v) => this.project(v));
  }
}

// ---- PcaEmbeddingClient ------------------------------------------------------

/**
 * PCA 降维嵌入客户端，包装任意 {@link EmbeddingClient}，在获取原始嵌入后自动应用 PCA 降维。
 *
 * 使用方式：
 * ```typescript
 * const inner = new OpenAIEmbeddingClient(config);
 * const projection = PcaProjection.fromJsonFile("weights/pca.json");
 * const client = new PcaEmbeddingClient(inner, projection);
 *
 * // 获取降维后的嵌入（维度 = projection.targetDim）
 * const embedding = await client.getEmbedding("Hello world");
 * ```
 *
 * 兼容性：
 * - 完全实现 {@link EmbeddingClient} 接口，可直接替换任何使用原始嵌入客户端的场合
 * - 内部客户端的缓存、速率限制等机制保持不变
 * - `close()` 会同时关闭内部客户端
 *
 * 通过 {@link innerClient} 属性可访问原始客户端，获取未降维的原始嵌入。
 */
export class PcaEmbeddingClient extends EmbeddingClient {
  /** 底层原始嵌入客户端，可用于获取未降维的原始嵌入 */
  readonly innerClient: EmbeddingClient;
  /** 用于执行降维的 PCA 投影器 */
  readonly projection: PcaProjection;

  constructor(inner: EmbeddingClient, projection: PcaProjection) {
    super(inner.config, {});
    this.innerClient = inner;
    this.projection = projection;
  }

  /**
   * 获取单个文本的 PCA 降维嵌入向量。
   * 先由内部客户端获取原始嵌入，再通过 {@link PcaProjection.project} 降维。
   */
  override async getEmbedding(text: string): Promise<number[]> {
    const raw = await this.innerClient.getEmbedding(text);
    return this.projection.project(raw);
  }

  /**
   * 批量获取 PCA 降维嵌入向量。
   * 先由内部客户端批量获取原始嵌入，再批量降维（共用 Float64Array 缓冲区）。
   */
  override async getEmbeddings(texts: string[]): Promise<number[][]> {
    const raws = await this.innerClient.getEmbeddings(texts);
    return this.projection.projectBatch(raws);
  }

  /**
   * 关闭客户端，同时关闭内部嵌入客户端以释放资源。
   */
  override async close(): Promise<void> {
    await this.innerClient.close();
  }
}
