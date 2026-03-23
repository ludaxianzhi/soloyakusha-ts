/**
 * 提供基于嵌入向量的文本对齐算法，用于把原文片段与译文片段进行匹配。
 *
 * 本模块实现多种文本对齐策略，通过计算文本片段的语义嵌入向量来度量相似度，
 * 进而将原文序列与译文序列进行最优匹配。对齐结果可用于翻译校对、语料构建等场景。
 *
 * 算法原理：
 * 1. 使用嵌入模型将文本转换为高维向量
 * 2. 计算原文-译文片段对的欧氏相似度矩阵
 * 3. 基于相似度矩阵应用不同策略（贪心/动态规划）求解最优对齐
 *
 * 提供的对齐器实现：
 * - {@link DefaultTextAligner}: 贪心启发式算法，优先处理高置信度匹配，适合快速处理
 * - {@link DynamicTextAligner}: 基于动态规划的全局优化，适合需要高质量对齐的场景
 * - {@link SimplifiedDynamicTextAligner}: 简化版动态规划，假设原文数量≥译文数量，适合常见翻译场景
 *
 * @module utils/text-align
 */

import ddot from "@stdlib/blas-base-ddot";
import type { EmbeddingClient } from "../llm/base.ts";

const PLACEHOLDER = "<Omission/>";

/**
 * 文本对齐器抽象基类，定义原文与译文序列对齐的统一接口。
 *
 * 所有文本对齐器都依赖嵌入客户端获取文本的语义向量表示，然后基于向量相似度进行匹配。
 * 子类需要实现 {@link alignTexts} 方法，提供具体的对齐策略。
 *
 * @example
 * ```typescript
 * const aligner = new DefaultTextAligner(embeddingClient);
 * const result = await aligner.alignTexts(
 *   ["Hello", "World"],
 *   ["你好", "世界"]
 * );
 * // => ["你好", "世界"]
 * ```
 */
export abstract class TextAligner {
  constructor(protected readonly embeddingClient: EmbeddingClient) {}

  abstract alignTexts(
    sourceTexts: string[],
    targetTexts: string[],
  ): Promise<string[]>;
}

/**
 * 文本对齐基础实现，封装嵌入计算与对齐算法共享的辅助逻辑。
 *
 * 提供 {@link prepareAlignment} 方法负责文本预处理、嵌入向量获取和相似度矩阵计算，
 * 以及 {@link markExactCopiesAsOmission} 方法用于将原文与译文完全相同的片段标记为省略。
 *
 * 子类继承此类后，只需关注核心对齐策略的实现。
 */
abstract class BaseTextAligner extends TextAligner {
  protected readonly placeholder = PLACEHOLDER;

  protected async prepareAlignment(
    sourceTexts: string[],
    targetTexts: string[],
  ): Promise<{
    sourceTexts: string[];
    targetTexts: string[];
    similarityMatrix: number[][];
  }> {
    const normalizedSourceTexts = sourceTexts
      .filter((text) => text.trim().length > 0)
      .map((text) => text.trim());
    const normalizedTargetTexts = targetTexts
      .filter((text) => text.trim().length > 0)
      .map((text) => text.trim());

    if (normalizedSourceTexts.length === 0 || normalizedTargetTexts.length === 0) {
      throw new Error("源文本或目标文本为空。");
    }

    if (normalizedSourceTexts.length === normalizedTargetTexts.length) {
      return {
        sourceTexts: normalizedSourceTexts,
        targetTexts: normalizedTargetTexts,
        similarityMatrix: [],
      };
    }

    const sourceEmbeddings = await this.embeddingClient.getEmbeddings(
      normalizedSourceTexts,
    );
    const targetEmbeddings = await this.embeddingClient.getEmbeddings(
      normalizedTargetTexts,
    );

    return {
      sourceTexts: normalizedSourceTexts,
      targetTexts: normalizedTargetTexts,
      similarityMatrix: computeEuclideanSimilarityMatrix(
        sourceEmbeddings,
        targetEmbeddings,
      ),
    };
  }

  protected markExactCopiesAsOmission(
    sourceTexts: string[],
    targetTexts: string[],
    alignedTranslations: string[],
    similarityMatrix: number[][],
  ): string[] {
    if (similarityMatrix.length === 0) {
      return alignedTranslations;
    }

    return alignedTranslations.map((alignedText, sourceIndex) => {
      const sourceText = sourceTexts[sourceIndex];
      if (alignedText === this.placeholder || alignedText !== sourceText) {
        return alignedText;
      }

      const targetIndex = targetTexts.indexOf(alignedText);
      if (targetIndex < 0) {
        return alignedText;
      }

      return similarityMatrix[sourceIndex]?.[targetIndex] !== undefined &&
        similarityMatrix[sourceIndex]![targetIndex]! >= 1.0 - 1e-6
        ? this.placeholder
        : alignedText;
    });
  }
}

/**
 * 默认文本对齐器，采用启发式策略匹配原文与译文片段。
 *
 * 算法流程：
 * 1. 计算原文-译文的相似度矩阵
 * 2. 为每个原文片段选择相似度最高的候选译文
 * 3. 处理重复匹配：当多个原文匹配同一译文时，保留置信度最高的配对
 * 4. 修正逆序对齐：当原文顺序与译文顺序不一致时，选择置信度较低的一方标记为省略
 * 5. 标记完全相同的原文-译文对为省略（表示未翻译）
 *
 * 该对齐器适合处理原文数量与译文数量相近、且翻译顺序基本一致的场景。
 * 当原文数量远大于译文数量时，建议使用 {@link DynamicTextAligner}。
 */
export class DefaultTextAligner extends BaseTextAligner {
  override async alignTexts(
    sourceTexts: string[],
    targetTexts: string[],
  ): Promise<string[]> {
    const prepared = await this.prepareAlignment(sourceTexts, targetTexts);
    if (prepared.similarityMatrix.length === 0) {
      return prepared.targetTexts;
    }

    const alignedTranslations = this.fixReversedAlignments(
      this.alignGreedy(
        prepared.sourceTexts,
        prepared.targetTexts,
        prepared.similarityMatrix,
      ),
      prepared.targetTexts,
      prepared.similarityMatrix,
    );

    return this.markExactCopiesAsOmission(
      prepared.sourceTexts,
      prepared.targetTexts,
      alignedTranslations,
      prepared.similarityMatrix,
    );
  }

  private alignGreedy(
    sourceTexts: string[],
    targetTexts: string[],
    similarityMatrix: number[][],
  ): string[] {
    const alignedTranslations: string[] = [];
    const sourceScores: Array<Array<{ score: number; targetIndex: number }>> = [];

    for (let sourceIndex = 0; sourceIndex < sourceTexts.length; sourceIndex += 1) {
      const similarities = similarityMatrix[sourceIndex] ?? [];
      const candidates = similarities
        .map((similarity, targetIndex) => {
          const sourceLow = Math.max(0, sourceIndex - 4);
          const sourceHigh = Math.min(sourceTexts.length, sourceIndex + 5);
          const targetLow = Math.max(0, targetIndex - 3);
          const targetHigh = Math.min(targetTexts.length, targetIndex + 4);
          const localSimilarity = sumOfLargestN(
            sliceMatrix(similarityMatrix, sourceLow, sourceHigh, targetLow, targetHigh),
            7,
          );
          return {
            score: similarity + localSimilarity * 0.03,
            targetIndex,
          };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);

      sourceScores.push(candidates);
      alignedTranslations.push(
        candidates[0] ? targetTexts[candidates[0].targetIndex]! : this.placeholder,
      );
    }

    const usedTexts = new Set<string>();
    for (let sourceIndex = 0; sourceIndex < alignedTranslations.length; sourceIndex += 1) {
      const currentText = alignedTranslations[sourceIndex]!;
      if (!usedTexts.has(currentText)) {
        usedTexts.add(currentText);
        continue;
      }

      const firstOccurrenceIndex = alignedTranslations.indexOf(currentText);
      if (firstOccurrenceIndex < 0) {
        continue;
      }

      const firstBestCandidate = sourceScores[firstOccurrenceIndex]?.[0];
      const currentBestCandidate = sourceScores[sourceIndex]?.[0];
      if (!firstBestCandidate || !currentBestCandidate) {
        continue;
      }

      if (firstBestCandidate.score > currentBestCandidate.score) {
        sourceScores[sourceIndex]?.shift();
        const replacement = sourceScores[sourceIndex]?.[0];
        alignedTranslations[sourceIndex] = replacement
          ? targetTexts[replacement.targetIndex]!
          : this.placeholder;
      } else {
        sourceScores[firstOccurrenceIndex]?.shift();
        const replacement = sourceScores[firstOccurrenceIndex]?.[0];
        alignedTranslations[firstOccurrenceIndex] = replacement
          ? targetTexts[replacement.targetIndex]!
          : this.placeholder;
      }
    }

    for (const duplicate of findDuplicates(alignedTranslations)) {
      if (duplicate.text === this.placeholder) {
        continue;
      }

      const targetIndex = targetTexts.indexOf(duplicate.text);
      if (targetIndex < 0) {
        continue;
      }

      const similaritiesAtDuplicates = duplicate.indices.map(
        (sourceIndex) => similarityMatrix[sourceIndex]?.[targetIndex] ?? 0,
      );
      const maxSimilarity = Math.max(...similaritiesAtDuplicates);

      duplicate.indices.forEach((sourceIndex, duplicateIndex) => {
        if (similaritiesAtDuplicates[duplicateIndex] !== maxSimilarity) {
          alignedTranslations[sourceIndex] = this.placeholder;
        }
      });
    }

    return alignedTranslations;
  }

  private fixReversedAlignments(
    alignedTranslations: string[],
    targetTexts: string[],
    similarityMatrix: number[][],
  ): string[] {
    const indexMap = getTargetIndexMap(alignedTranslations, targetTexts);
    const sourceIndices = [...indexMap.keys()].sort((left, right) => left - right);
    const reversedPairs: Array<[number, number]> = [];

    for (let index = 0; index < sourceIndices.length - 1; index += 1) {
      const leftSourceIndex = sourceIndices[index]!;
      const rightSourceIndex = sourceIndices[index + 1]!;
      if ((indexMap.get(rightSourceIndex) ?? 0) < (indexMap.get(leftSourceIndex) ?? 0)) {
        reversedPairs.push([leftSourceIndex, rightSourceIndex]);
      }
    }

    for (const [leftSourceIndex, rightSourceIndex] of reversedPairs) {
      const leftTargetIndex = indexMap.get(leftSourceIndex);
      const rightTargetIndex = indexMap.get(rightSourceIndex);
      if (leftTargetIndex === undefined || rightTargetIndex === undefined) {
        continue;
      }

      const leftSimilarity = similarityMatrix[leftSourceIndex]?.[leftTargetIndex] ?? 0;
      const rightSimilarity = similarityMatrix[rightSourceIndex]?.[rightTargetIndex] ?? 0;

      if (leftSimilarity < rightSimilarity) {
        alignedTranslations[leftSourceIndex] = this.placeholder;
        indexMap.delete(leftSourceIndex);
      } else {
        alignedTranslations[rightSourceIndex] = this.placeholder;
        indexMap.delete(rightSourceIndex);
      }
    }

    return alignedTranslations;
  }
}

/**
 * 动态规划文本对齐器，通过全局搜索求解更稳健的片段匹配路径。
 *
 * 算法基于序列对齐问题建模：
 * - 状态：原文位置 i 和译文位置 j
 * - 动作：匹配当前位置、跳过原文、跳过译文
 * - 奖励：匹配时获得相似度得分，跳过时付出惩罚
 *
 * 通过动态规划找到从起点到终点的最优路径，使得累积得分最大化。
 * 相比贪心算法，动态规划能更好地处理整体一致性，避免局部最优。
 *
 * 配置参数：
 * - MATCH_SCORE = 1.0：匹配得分系数
 * - SKIP_PENALTY = -0.5：跳过惩罚
 *
 * 该对齐器适合处理原文与译文数量差异较大、或有大量省略/插入的场景。
 */
export class DynamicTextAligner extends BaseTextAligner {
  private static readonly MATCH_SCORE = 1.0;
  private static readonly SKIP_PENALTY = -0.5;

  override async alignTexts(
    sourceTexts: string[],
    targetTexts: string[],
  ): Promise<string[]> {
    const prepared = await this.prepareAlignment(sourceTexts, targetTexts);
    if (prepared.similarityMatrix.length === 0) {
      return prepared.targetTexts;
    }

    const alignedTranslations = this.alignDynamic(
      prepared.sourceTexts,
      prepared.targetTexts,
      prepared.similarityMatrix,
    );

    return this.markExactCopiesAsOmission(
      prepared.sourceTexts,
      prepared.targetTexts,
      alignedTranslations,
      prepared.similarityMatrix,
    );
  }

  private alignDynamic(
    sourceTexts: string[],
    targetTexts: string[],
    similarityMatrix: number[][],
  ): string[] {
    const sourceLength = sourceTexts.length;
    const targetLength = targetTexts.length;
    const dp = Array.from({ length: sourceLength + 1 }, () =>
      Array<number>(targetLength + 1).fill(0),
    );
    const path = Array.from({ length: sourceLength + 1 }, () =>
      Array<
        | { action: "match" | "skip_source" | "skip_target"; previousI: number; previousJ: number }
        | undefined
      >(targetLength + 1).fill(undefined),
    );

    for (let sourceIndex = 1; sourceIndex <= sourceLength; sourceIndex += 1) {
      dp[sourceIndex]![0] =
        dp[sourceIndex - 1]![0]! + DynamicTextAligner.SKIP_PENALTY;
      path[sourceIndex]![0] = {
        action: "skip_source",
        previousI: sourceIndex - 1,
        previousJ: 0,
      };
    }

    for (let targetIndex = 1; targetIndex <= targetLength; targetIndex += 1) {
      dp[0]![targetIndex] =
        dp[0]![targetIndex - 1]! + DynamicTextAligner.SKIP_PENALTY;
      path[0]![targetIndex] = {
        action: "skip_target",
        previousI: 0,
        previousJ: targetIndex - 1,
      };
    }

    for (let sourceIndex = 1; sourceIndex <= sourceLength; sourceIndex += 1) {
      for (let targetIndex = 1; targetIndex <= targetLength; targetIndex += 1) {
        const matchScore =
          dp[sourceIndex - 1]![targetIndex - 1]! +
          (similarityMatrix[sourceIndex - 1]?.[targetIndex - 1] ?? 0) *
            DynamicTextAligner.MATCH_SCORE;
        const skipSourceScore =
          dp[sourceIndex - 1]![targetIndex]! + DynamicTextAligner.SKIP_PENALTY;
        const skipTargetScore =
          dp[sourceIndex]![targetIndex - 1]! + DynamicTextAligner.SKIP_PENALTY;

        if (matchScore >= skipSourceScore && matchScore >= skipTargetScore) {
          dp[sourceIndex]![targetIndex] = matchScore;
          path[sourceIndex]![targetIndex] = {
            action: "match",
            previousI: sourceIndex - 1,
            previousJ: targetIndex - 1,
          };
        } else if (skipSourceScore >= skipTargetScore) {
          dp[sourceIndex]![targetIndex] = skipSourceScore;
          path[sourceIndex]![targetIndex] = {
            action: "skip_source",
            previousI: sourceIndex - 1,
            previousJ: targetIndex,
          };
        } else {
          dp[sourceIndex]![targetIndex] = skipTargetScore;
          path[sourceIndex]![targetIndex] = {
            action: "skip_target",
            previousI: sourceIndex,
            previousJ: targetIndex - 1,
          };
        }
      }
    }

    const alignedTranslations = Array<string>(sourceLength).fill(this.placeholder);
    let sourceIndex = sourceLength;
    let targetIndex = targetLength;

    while (sourceIndex > 0 || targetIndex > 0) {
      const current = path[sourceIndex]?.[targetIndex];
      if (!current) {
        break;
      }

      if (current.action === "match") {
        alignedTranslations[current.previousI] = targetTexts[current.previousJ]!;
      }

      sourceIndex = current.previousI;
      targetIndex = current.previousJ;
    }

    return alignedTranslations;
  }
}

/**
 * 简化版动态规划对齐器，针对常见场景提供更轻量的匹配策略。
 *
 * 该对齐器假设原文片段数量 ≥ 译文片段数量（即原文中有一些内容被省略翻译），
 * 在此假设下简化算法：
 * 1. 按原文顺序遍历，决定每个位置是否跳过
 * 2. 基于当前相似度和后续对角线预评分做出跳过决策
 * 3. 将跳过位置的译文填充为占位符
 *
 * 相比完整动态规划，该算法计算量更小，适合处理大段原文被选择性翻译的场景。
 * 当原文数量 < 译文数量时，退化为简单截断处理。
 */
export class SimplifiedDynamicTextAligner extends BaseTextAligner {
  override async alignTexts(
    sourceTexts: string[],
    targetTexts: string[],
  ): Promise<string[]> {
    const prepared = await this.prepareAlignment(sourceTexts, targetTexts);
    if (prepared.similarityMatrix.length === 0) {
      return prepared.targetTexts;
    }

    const alignedTranslations = this.alignSimplified(
      prepared.sourceTexts,
      prepared.targetTexts,
      prepared.similarityMatrix,
    );

    return this.markExactCopiesAsOmission(
      prepared.sourceTexts,
      prepared.targetTexts,
      alignedTranslations,
      prepared.similarityMatrix,
    );
  }

  private alignSimplified(
    sourceTexts: string[],
    targetTexts: string[],
    similarityMatrix: number[][],
  ): string[] {
    const sourceLength = sourceTexts.length;
    const targetLength = targetTexts.length;
    const maxSkips = sourceLength - targetLength;

    if (maxSkips <= 0) {
      return targetTexts.slice(0, sourceLength);
    }

    const alignedTranslations = [...targetTexts];
    const skipPositions: number[] = [];
    let skipCount = 0;
    let targetIndex = 0;

    while (targetIndex < targetLength && skipCount < maxSkips) {
      const sourceIndex = targetIndex + skipCount;
      const currentScore =
        (similarityMatrix[sourceIndex]?.[targetIndex] ?? 0) +
        calculateDiagonalScore(similarityMatrix, sourceIndex, targetIndex) * 0.25;

      if (sourceIndex + 1 < sourceLength) {
        const nextScore =
          (similarityMatrix[sourceIndex + 1]?.[targetIndex] ?? 0) +
          calculateDiagonalScore(similarityMatrix, sourceIndex + 1, targetIndex) *
            0.25;
        if (nextScore > currentScore) {
          skipPositions.push(sourceIndex);
          skipCount += 1;
        }
      }

      targetIndex += 1;
    }

    for (const skipPosition of skipPositions) {
      alignedTranslations.splice(skipPosition, 0, this.placeholder);
    }

    while (alignedTranslations.length < sourceLength) {
      alignedTranslations.push(this.placeholder);
    }

    return alignedTranslations.slice(0, sourceLength);
  }
}

function computeEuclideanSimilarityMatrix(
  sourceEmbeddings: number[][],
  targetEmbeddings: number[][],
): number[][] {
  const sourceVectors = sourceEmbeddings.map((embedding) =>
    Float64Array.from(embedding),
  );
  const targetVectors = targetEmbeddings.map((embedding) =>
    Float64Array.from(embedding),
  );

  const sourceNormSquares = sourceVectors.map((vector) =>
    ddot(vector.length, vector, 1, vector, 1),
  );
  const targetNormSquares = targetVectors.map((vector) =>
    ddot(vector.length, vector, 1, vector, 1),
  );

  const similarityMatrix = Array.from({ length: sourceVectors.length }, () =>
    Array<number>(targetVectors.length).fill(0),
  );
  const maxIndexDistance = Math.max(
    (sourceVectors.length + targetVectors.length) / 10,
    10,
  );

  for (let sourceIndex = 0; sourceIndex < sourceVectors.length; sourceIndex += 1) {
    for (let targetIndex = 0; targetIndex < targetVectors.length; targetIndex += 1) {
      if (Math.abs(sourceIndex - targetIndex) > maxIndexDistance) {
        continue;
      }

      const sourceVector = sourceVectors[sourceIndex]!;
      const targetVector = targetVectors[targetIndex]!;
      const dimension = Math.min(sourceVector.length, targetVector.length);
      const dot = ddot(dimension, sourceVector, 1, targetVector, 1);
      const squaredDistance = Math.max(
        0,
        sourceNormSquares[sourceIndex]! + targetNormSquares[targetIndex]! - 2 * dot,
      );
      similarityMatrix[sourceIndex]![targetIndex] = Math.exp(
        -Math.sqrt(squaredDistance),
      );
    }
  }

  return similarityMatrix;
}

function sumOfLargestN(matrix: number[][], count: number): number {
  const flattened = matrix.flat();
  if (flattened.length === 0 || count <= 0) {
    return 0;
  }

  return flattened
    .sort((left, right) => right - left)
    .slice(0, Math.min(count, flattened.length))
    .reduce((sum, value) => sum + value, 0);
}

function findDuplicates(
  texts: string[],
): Array<{ text: string; indices: number[] }> {
  const indexMap = new Map<string, number[]>();
  texts.forEach((text, index) => {
    const indices = indexMap.get(text) ?? [];
    indices.push(index);
    indexMap.set(text, indices);
  });

  return [...indexMap.entries()]
    .filter(([, indices]) => indices.length > 1)
    .map(([text, indices]) => ({ text, indices }));
}

function getTargetIndexMap(
  alignedTranslations: string[],
  targetTexts: string[],
): Map<number, number> {
  const result = new Map<number, number>();
  alignedTranslations.forEach((alignedText, sourceIndex) => {
    if (alignedText === PLACEHOLDER) {
      return;
    }
    const targetIndex = targetTexts.indexOf(alignedText);
    if (targetIndex >= 0) {
      result.set(sourceIndex, targetIndex);
    }
  });
  return result;
}

function calculateDiagonalScore(
  similarityMatrix: number[][],
  startRow: number,
  startColumn: number,
  length = 5,
): number {
  let total = 0;
  let count = 0;

  for (let offset = 0; offset < length; offset += 1) {
    const row = startRow + offset;
    const column = startColumn + offset;
    const value = similarityMatrix[row]?.[column];
    if (value === undefined) {
      break;
    }
    total += value;
    count += 1;
  }

  return count > 0 ? total / count : 0;
}

function sliceMatrix(
  matrix: number[][],
  rowStart: number,
  rowEnd: number,
  columnStart: number,
  columnEnd: number,
): number[][] {
  return matrix
    .slice(rowStart, rowEnd)
    .map((row) => row.slice(columnStart, columnEnd));
}

export { PLACEHOLDER as TEXT_ALIGN_PLACEHOLDER };
