import { describe, expect, test } from 'bun:test';
import {
  buildTranslatorPayload,
  formatLlmRequestConfigYaml,
  formatModelChain,
  formatTranslatorModelSummary,
  parseLlmRequestConfigYaml,
  parseYamlObject,
  translatorFieldName,
  translatorToForm,
} from './ui-helpers.ts';
import type {
  TranslatorEntry,
  TranslationProcessorWorkflowMetadata,
} from './types.ts';

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
        sourceLanguage: 'ja',
        targetLanguage: 'zh-CN',
        promptSet: 'ja-zhCN',
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
          sourceLanguage: 'ja',
          targetLanguage: 'zh-CN',
          promptSet: 'ja-zhCN',
          [translatorFieldName('modelNames')]: [
            'primary',
            'fallback-a',
            'fallback-b',
          ],
        },
        workflow,
      ),
    ).toEqual({
      sourceLanguage: 'ja',
      targetLanguage: 'zh-CN',
      promptSet: 'ja-zhCN',
      modelNames: ['primary', 'fallback-a', 'fallback-b'],
      type: undefined,
    });
    expect(formatModelChain(['primary', 'fallback-a', 'fallback-b'])).toBe(
      'primary -> fallback-a -> fallback-b',
    );
  });

  test('binds translator language and prompt defaults to workflow metadata', () => {
    const workflow = {
      workflow: 'default',
      title: 'Custom',
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      promptSet: 'en-fr',
      fields: [
        {
          key: 'modelNames',
          label: '默认模型链',
          input: 'llm-profile' as const,
          required: true,
        },
      ],
    } satisfies TranslationProcessorWorkflowMetadata;

    const formValues = translatorToForm(null, 'demo', workflow);
    expect(formValues.sourceLanguage).toBe('en');
    expect(formValues.targetLanguage).toBe('fr');
    expect(formValues.promptSet).toBe('en-fr');

    const payload = buildTranslatorPayload(
      {
        sourceLanguage: 'ignored',
        targetLanguage: 'ignored',
        promptSet: 'ignored',
        modelNames: ['primary'],
      },
      workflow,
    );

    expect(payload.sourceLanguage).toBe('en');
    expect(payload.targetLanguage).toBe('fr');
    expect(payload.promptSet).toBe('en-fr');
  });

  test('serializes multi-stage step model chains and request options', () => {
    const workflow = {
      workflow: 'multi-stage',
      title: 'Multi-stage',
      fields: [
        {
          key: 'steps.analyzer.modelNames',
          label: '分析器模型链',
          input: 'llm-profile' as const,
          required: true,
        },
        {
          key: 'steps.analyzer.requestOptions',
          label: '分析器请求选项',
          input: 'yaml' as const,
          yamlShape: 'object' as const,
        },
        {
          key: 'steps.translator.modelNames',
          label: '翻译器模型链',
          input: 'llm-profile' as const,
          required: true,
        },
        {
          key: 'steps.translator.requestOptions',
          label: '翻译器请求选项',
          input: 'yaml' as const,
          yamlShape: 'object' as const,
        },
      ],
    } satisfies TranslationProcessorWorkflowMetadata;
    const translator = {
      sourceLanguage: 'ja',
      targetLanguage: 'zh-CN',
      promptSet: 'ja-zhCN',
      type: 'multi-stage',
      modelNames: ['analyzer-primary'],
      steps: {
        analyzer: {
          modelNames: ['analyzer-primary', 'analyzer-fallback'],
          requestOptions: {
            requestConfig: {
              temperature: 0.2,
            },
          },
        },
        translator: {
          modelNames: ['translator-primary'],
          requestOptions: {
            requestConfig: {
              maxTokens: 2048,
            },
          },
        },
      },
    } satisfies TranslatorEntry;

    const formValues = translatorToForm(translator, 'demo', workflow);
    expect(formValues[translatorFieldName('steps.analyzer.modelNames')]).toEqual([
      'analyzer-primary',
      'analyzer-fallback',
    ]);
    expect(formValues[translatorFieldName('steps.translator.modelNames')]).toEqual([
      'translator-primary',
    ]);

    const payload = buildTranslatorPayload(formValues as Record<string, unknown>, workflow);
    expect(payload.modelNames).toEqual(['analyzer-primary', 'analyzer-fallback']);
    expect(payload.steps?.analyzer?.modelNames).toEqual([
      'analyzer-primary',
      'analyzer-fallback',
    ]);
    expect(payload.steps?.analyzer?.requestOptions).toEqual({
      requestConfig: {
        temperature: 0.2,
      },
    });
    expect(payload.steps?.translator?.requestOptions).toEqual({
      requestConfig: {
        maxTokens: 2048,
      },
    });
    expect(formatTranslatorModelSummary(payload, workflow)).toContain(
      '分析器模型链: analyzer-primary -> analyzer-fallback',
    );
  });
});
