import type {
  PromptMessageTemplateDefinition,
  PromptRenderVariables,
  PromptTemplateKind,
} from "./types.ts";

type PromptTemplate = {
  render(variables: PromptRenderVariables): string;
};

type TemplateToken =
  | { type: "text"; value: string }
  | { type: "output"; value: string }
  | { type: "tag"; value: string };

type TemplateNode =
  | { type: "text"; value: string }
  | { type: "output"; expression: string }
  | {
      type: "if";
      expression: string;
      truthy: TemplateNode[];
      falsy: TemplateNode[];
      negated: boolean;
    }
  | {
      type: "for";
      variableName: string;
      expression: string;
      body: TemplateNode[];
    };

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
  const tokens = tokenizeLiquidTemplate(template);
  const parser = new LiquidTemplateParser(tokens);
  const nodes = parser.parse();

  return {
    render(variables) {
      return renderLiquidNodes(nodes, variables);
    },
  };
}

function tokenizeLiquidTemplate(template: string): TemplateToken[] {
  const pattern = /(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/g;
  const tokens: TemplateToken[] = [];
  let cursor = 0;

  for (const match of template.matchAll(pattern)) {
    const matchedText = match[0];
    const startIndex = match.index ?? 0;
    if (startIndex > cursor) {
      tokens.push({
        type: "text",
        value: template.slice(cursor, startIndex),
      });
    }

    if (matchedText.startsWith("{{")) {
      tokens.push({
        type: "output",
        value: matchedText.slice(2, -2).trim(),
      });
    } else {
      tokens.push({
        type: "tag",
        value: matchedText.slice(2, -2).trim(),
      });
    }

    cursor = startIndex + matchedText.length;
  }

  if (cursor < template.length) {
    tokens.push({
      type: "text",
      value: template.slice(cursor),
    });
  }

  return tokens;
}

class LiquidTemplateParser {
  private index = 0;

  constructor(private readonly tokens: ReadonlyArray<TemplateToken>) {}

  parse(): TemplateNode[] {
    const { nodes, stopTag } = this.parseNodes();
    if (stopTag) {
      throw new Error(`Liquid 模板存在未匹配的结束标签: ${stopTag}`);
    }
    return nodes;
  }

  private parseNodes(stopTags: ReadonlySet<string> = new Set()): {
    nodes: TemplateNode[];
    stopTag?: string;
  } {
    const nodes: TemplateNode[] = [];

    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      if (!token) {
        break;
      }

      if (token.type === "text") {
        this.index += 1;
        nodes.push({ type: "text", value: token.value });
        continue;
      }

      if (token.type === "output") {
        this.index += 1;
        nodes.push({ type: "output", expression: token.value });
        continue;
      }

      const tagName = getLiquidTagName(token.value);
      if (stopTags.has(tagName)) {
        return {
          nodes,
          stopTag: token.value,
        };
      }

      if (token.value.startsWith("if ")) {
        nodes.push(this.parseIfNode(false));
        continue;
      }

      if (token.value.startsWith("unless ")) {
        nodes.push(this.parseIfNode(true));
        continue;
      }

      if (token.value.startsWith("for ")) {
        nodes.push(this.parseForNode());
        continue;
      }

      throw new Error(`不支持的 Liquid 标签: ${token.value}`);
    }

    return { nodes };
  }

  private parseIfNode(negated: boolean): TemplateNode {
    const token = this.tokens[this.index];
    if (!token || token.type !== "tag") {
      throw new Error("Liquid if 标签解析失败");
    }

    const prefix = negated ? "unless " : "if ";
    const expression = token.value.slice(prefix.length).trim();
    if (!expression) {
      throw new Error(`${negated ? "unless" : "if"} 标签缺少条件表达式`);
    }

    this.index += 1;
    const endTag = negated ? "endunless" : "endif";
    const { nodes: truthy, stopTag } = this.parseNodes(new Set(["else", endTag]));

    if (!stopTag) {
      throw new Error(`${negated ? "unless" : "if"} 标签缺少 ${endTag}`);
    }

    let falsy: TemplateNode[] = [];
    const stoppedAtTagName = getLiquidTagName(stopTag);
    if (stoppedAtTagName === "else") {
      this.index += 1;
      const parsedElse = this.parseNodes(new Set([endTag]));
      falsy = parsedElse.nodes;
      if (!parsedElse.stopTag || getLiquidTagName(parsedElse.stopTag) !== endTag) {
        throw new Error(`${negated ? "unless" : "if"} 标签缺少 ${endTag}`);
      }
      this.index += 1;
    } else {
      this.index += 1;
    }

    return {
      type: "if",
      expression,
      truthy,
      falsy,
      negated,
    };
  }

  private parseForNode(): TemplateNode {
    const token = this.tokens[this.index];
    if (!token || token.type !== "tag") {
      throw new Error("Liquid for 标签解析失败");
    }

    const match = token.value.match(/^for\s+([A-Za-z_][\w]*)\s+in\s+([A-Za-z_][\w.]*)$/);
    if (!match) {
      throw new Error(`for 标签格式不正确: ${token.value}`);
    }

    const [, variableName, expression] = match;
    this.index += 1;
    const parsedBody = this.parseNodes(new Set(["endfor"]));
    if (!parsedBody.stopTag || getLiquidTagName(parsedBody.stopTag) !== "endfor") {
      throw new Error("for 标签缺少 endfor");
    }

    this.index += 1;
    return {
      type: "for",
      variableName,
      expression,
      body: parsedBody.nodes,
    };
  }
}

function renderLiquidNodes(
  nodes: ReadonlyArray<TemplateNode>,
  variables: PromptRenderVariables,
): string {
  return nodes.map((node) => renderLiquidNode(node, variables)).join("");
}

function renderLiquidNode(node: TemplateNode, variables: PromptRenderVariables): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "output": {
      const value = resolveExpression(node.expression, variables);
      return value === undefined ? "" : stringifyTemplateValue(value);
    }
    case "if": {
      const condition = isTemplateTruthy(resolveExpression(node.expression, variables));
      const shouldRenderTruthy = node.negated ? !condition : condition;
      return renderLiquidNodes(shouldRenderTruthy ? node.truthy : node.falsy, variables);
    }
    case "for": {
      const value = resolveExpression(node.expression, variables);
      if (!Array.isArray(value) || value.length === 0) {
        return "";
      }

      return value
        .map((entry, index) =>
          renderLiquidNodes(node.body, {
            ...variables,
            [node.variableName]: entry,
            forloop: {
              index,
              index1: index + 1,
              first: index === 0,
              last: index === value.length - 1,
              length: value.length,
            },
          }),
        )
        .join("");
    }
    default:
      return assertNever(node);
  }
}

function resolveExpression(
  expression: string,
  variables: PromptRenderVariables,
): unknown {
  const normalized = expression.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  if (normalized === "null" || normalized === "nil") {
    return null;
  }
  if (/^".*"$/.test(normalized) || /^'.*'$/.test(normalized)) {
    return normalized.slice(1, -1);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return Number(normalized);
  }

  const segments = normalized.split(".");
  let currentValue: unknown = variables;
  for (const segment of segments) {
    if (!isRecord(currentValue) && !Array.isArray(currentValue)) {
      return undefined;
    }

    currentValue = currentValue[segment as keyof typeof currentValue];
  }

  return currentValue;
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

function isTemplateTruthy(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return Boolean(value);
}

function getLiquidTagName(tagStatement: string): string {
  const [tagName = ""] = tagStatement.split(/\s+/, 1);
  return tagName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertNever(value: never): never {
  throw new Error(`未支持的模板类型: ${String(value)}`);
}

export type { PromptTemplate, PromptTemplateKind };