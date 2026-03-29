import { describe, expect, test } from 'bun:test';
import {
  buildTranslatorEntryFields,
  buildTranslatorEntryFromValues,
} from './settings-translator.tsx';

describe('settings-translator helpers', () => {
  test('buildTranslatorEntryFields keeps existing request options visible during edit', () => {
    const fields = buildTranslatorEntryFields({
      translatorName: 'novel-translator',
      workflow: 'default',
      llmOptions: [{ label: 'writer', value: 'writer' }],
      entry: {
        modelName: 'writer',
        slidingWindow: { overlapChars: 96 },
        requestOptions: {
          requestConfig: {
            systemPrompt: 'translate carefully',
            temperature: 0.2,
            topP: 0.9,
            maxTokens: 4096,
            extraBody: {
              chat_template_kwargs: {
                enable_thinking: false,
              },
            },
          },
          outputValidationContext: {
            stageLabel: 'translator',
            sourceLineCount: 128,
            minLineRatio: 0.9,
            modelName: 'writer',
          },
        },
      },
    });

    const lookup = Object.fromEntries(fields.map((field) => [field.key, field]));
    expect(lookup.requestSystemPrompt?.defaultValue).toBe('translate carefully');
    expect(lookup.requestTemperature?.defaultValue).toBe('0.2');
    expect(lookup.requestTopP?.defaultValue).toBe('0.9');
    expect(lookup.requestMaxTokens?.defaultValue).toBe('4096');
    expect(lookup.requestExtraBody?.defaultValue).toContain('enable_thinking: false');
    expect(lookup.validationStageLabel?.defaultValue).toBe('translator');
    expect(lookup.validationSourceLineCount?.defaultValue).toBe('128');
    expect(lookup.validationMinLineRatio?.defaultValue).toBe('0.9');
    expect(lookup.validationModelName?.defaultValue).toBe('writer');
  });

  test('buildTranslatorEntryFromValues parses multi-stage models and request options', () => {
    const result = buildTranslatorEntryFromValues(
      {
        modelName: 'writer',
        overlapChars: '64',
        reviewIterations: '3',
        model_analyzer: 'analyst',
        model_translator: 'writer',
        model_polisher: 'polisher',
        model_editor: '',
        model_proofreader: '',
        model_reviser: 'writer',
        requestSystemPrompt: 'translate carefully',
        requestTemperature: '0.25',
        requestTopP: '0.85',
        requestMaxTokens: '2048',
        requestExtraBody: 'chat_template_kwargs:\n  enable_thinking: false\n',
        validationStageLabel: 'translator',
        validationSourceLineCount: '120',
        validationMinLineRatio: '0.92',
        validationModelName: 'writer',
      },
      'multi-stage',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.entry).toEqual({
      type: 'multi-stage',
      modelName: 'writer',
      slidingWindow: { overlapChars: 64 },
      requestOptions: {
        requestConfig: {
          systemPrompt: 'translate carefully',
          temperature: 0.25,
          topP: 0.85,
          maxTokens: 2048,
          extraBody: {
            chat_template_kwargs: {
              enable_thinking: false,
            },
          },
        },
        outputValidationContext: {
          stageLabel: 'translator',
          sourceLineCount: 120,
          minLineRatio: 0.92,
          modelName: 'writer',
        },
      },
      models: {
        analyzer: 'analyst',
        polisher: 'polisher',
      },
      reviewIterations: 3,
    });
  });

  test('buildTranslatorEntryFromValues rejects malformed request extra body', () => {
    const result = buildTranslatorEntryFromValues(
      {
        modelName: 'writer',
        overlapChars: '',
        requestSystemPrompt: '',
        requestTemperature: '',
        requestTopP: '',
        requestMaxTokens: '',
        requestExtraBody: '- invalid\n- yaml',
        validationStageLabel: '',
        validationSourceLineCount: '',
        validationMinLineRatio: '',
        validationModelName: '',
      },
      'default',
    );

    expect(result).toEqual({
      ok: false,
      message: '请求 Extra Body 必须是 YAML 对象',
    });
  });
});
