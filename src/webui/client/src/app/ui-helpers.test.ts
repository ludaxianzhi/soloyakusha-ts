import { describe, expect, test } from 'bun:test';
import {
  buildTranslatorPayload,
  formatLlmRequestConfigYaml,
  formatModelChain,
  parseLlmRequestConfigYaml,
  parseYamlObject,
  translatorFieldName,
  translatorToForm,
} from './ui-helpers.ts';

describe('WebUI LLM request config helpers', () => {
  test('maps unknown top-level YAML keys into extraBody when saving', () => {
    expect(
      parseLlmRequestConfigYaml(
        'temperature: 0.2\nchat_template_kwargs:\n  enable_thinking: false\n',
      ),
    ).toEqual({
      temperature: 0.2,
      extraBody: {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });
  });

  test('accepts snake_case aliases for basic request config keys', () => {
    expect(
      parseLlmRequestConfigYaml(
        'system_prompt: keep style\ntop_p: 0.9\nmax_tokens: 2048\nextra_body:\n  response_format:\n    type: json_schema\nchat_template_kwargs:\n  enable_thinking: false\n',
      ),
    ).toEqual({
      systemPrompt: 'keep style',
      topP: 0.9,
      maxTokens: 2048,
      extraBody: {
        response_format: {
          type: 'json_schema',
        },
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });
  });

  test('echoes persisted extraBody as extra_body in the form', () => {
    const yaml = formatLlmRequestConfigYaml({
      temperature: 0.2,
      extraBody: {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });

    expect(parseYamlObject(yaml)).toEqual({
      temperature: 0.2,
      extra_body: {
        chat_template_kwargs: {
          enable_thinking: false,
        },
      },
    });
  });

  test('keeps extraBody nested when echoing in the form', () => {
    const yaml = formatLlmRequestConfigYaml({
      temperature: 0.2,
      extraBody: {
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
        },
      },
    });

    expect(parseYamlObject(yaml)).toEqual({
      temperature: 0.2,
      extra_body: {
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
        },
      },
    });
  });

  test('serializes and parses ordered fallback model chains for translator fields', () => {
    const workflow = {
      workflow: 'default',
      title: 'Default',
      fields: [
        {
          key: 'modelNames',
          label: '默认模型链',
          input: 'llm-profile' as const,
          required: true,
        },
      ],
    };

    const formValues = translatorToForm(
      {
        modelNames: ['primary', 'fallback-a', 'fallback-b'],
      },
      'demo',
      workflow,
    );

    expect(formValues[translatorFieldName('modelNames')]).toEqual([
      'primary',
      'fallback-a',
      'fallback-b',
    ]);
    expect(
      buildTranslatorPayload(
        {
          [translatorFieldName('modelNames')]: [
            'primary',
            'fallback-a',
            'fallback-b',
          ],
        },
        workflow,
      ),
    ).toEqual({
      modelNames: ['primary', 'fallback-a', 'fallback-b'],
      type: undefined,
    });
    expect(formatModelChain(['primary', 'fallback-a', 'fallback-b'])).toBe(
      'primary -> fallback-a -> fallback-b',
    );
  });
});
