/**
 * 将提示词模板定义编译为可渲染模板，并支持静态、插值与 Liquid 风格语法。
 *
 * @module prompts/templates
 */
import { Liquid } from "liquidjs";
import type {
  PromptMessageTemplateDefinition,
  PromptRenderVariables,
  PromptTemplateKind,
} from "./types.ts";

type PromptTemplate = {
  render(variables: PromptRenderVariables): string;
};

const liquidEngine = new Liquid({
  jsTruthy: true,
  ownPropertyOnly: true,
  outputEscape: stringifyTemplateValue,
  strictFilters: false,
  strictVariables: false,
});

/**
 * 将单条提示词模板定义编译为可渲染模板实例。
 *
 * 支持三种模板类型：
 * - static：直接返回原始文本
 * - interpolate：解析 ${variable} 形式的字符串插值
 * - liquid：解析简化版 Liquid 语法的条件与循环
 */
export function createPromptTemplate(
  definition: PromptMessageTemplateDefinition,
): PromptTemplate {
  switch (definition.type) {
    case "static":
      return createStaticPromptTemplate(definition.template);
    case "interpolate":
      return createInterpolatedPromptTemplate(definition.template);
    case "liquid":
      return createLiquidPromptTemplate(definition.template);
    default:
      return assertNever(definition.type);
  }
}

function createStaticPromptTemplate(template: string): PromptTemplate {
  return {
    render() {
      return template;
    },
  };
}

function createInterpolatedPromptTemplate(template: string): PromptTemplate {
  return {
    render(variables) {
      return template.replace(/\$\{([A-Za-z_][\w.]*)\}/g, (_, expression: string) => {
        const value = resolveExpression(expression, variables);
        if (value === undefined) {
          throw new Error(`插值模板变量未定义: ${expression}`);
        }
        return stringifyTemplateValue(value);
      });
    },
  };
}

function createLiquidPromptTemplate(template: string): PromptTemplate {
  let parsedTemplate: ReturnType<typeof liquidEngine.parse>;

  try {
    parsedTemplate = liquidEngine.parse(template);
  } catch (error) {
    throw new Error(`Liquid 模板编译失败: ${getErrorMessage(error)}`);
  }

  return {
    render(variables) {
      try {
        return liquidEngine.renderSync(parsedTemplate, variables);
      } catch (error) {
        throw new Error(`Liquid 模板渲染失败: ${getErrorMessage(error)}`);
      }
    },
  };
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function assertNever(value: never): never {
  throw new Error(`未支持的模板类型: ${String(value)}`);
}

export type { PromptTemplate, PromptTemplateKind };