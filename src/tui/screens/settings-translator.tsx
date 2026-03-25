import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from '../components/select.tsx';
import { Form } from '../components/form.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { TranslatorTypeDef, SelectItem } from '../types.ts';

/**
 * 翻译器类型注册表 —— 新增翻译器只需在此数组追加条目
 */
const translatorRegistry: TranslatorTypeDef[] = [
  {
    name: 'default',
    label: '默认翻译器 (DefaultTranslationProcessor)',
    fields: [
      {
        key: 'contextWindow',
        label: '上下文窗口大小',
        type: 'select',
        options: [
          { label: '3', value: '3' },
          { label: '5', value: '5' },
          { label: '10', value: '10' },
        ],
        defaultValue: '5',
      },
      {
        key: 'maxRetries',
        label: '最大重试次数',
        type: 'select',
        options: [
          { label: '1', value: '1' },
          { label: '3', value: '3' },
          { label: '5', value: '5' },
        ],
        defaultValue: '3',
      },
      {
        key: 'batchSize',
        label: '批次大小',
        type: 'select',
        options: [
          { label: '5', value: '5' },
          { label: '10', value: '10' },
          { label: '20', value: '20' },
        ],
        defaultValue: '10',
      },
    ],
  },
  // 后续扩展示例:
  // {
  //   name: 'galtransl',
  //   label: 'GalTransl 翻译器',
  //   fields: [ ... ],
  // },
];

const typeSelectItems: SelectItem[] = translatorRegistry.map(t => ({
  label: t.label,
  value: t.name,
}));

export function SettingsTranslatorScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const [selectedType, setSelectedType] = useState<TranslatorTypeDef | null>(null);

  useInput((_input, key) => {
    if (key.escape) {
      if (selectedType) setSelectedType(null);
      else goBack();
    }
  }, { isActive: !selectedType });

  // Step 1: 选择翻译器类型
  if (!selectedType) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">翻译器配置</Text>
        <Text dimColor>{'─'.repeat(36)}</Text>
        <Text>选择翻译器类型：</Text>
        <Text> </Text>
        <Select
          items={typeSelectItems}
          onSelect={item => {
            const found = translatorRegistry.find(t => t.name === item.value);
            if (found) setSelectedType(found);
          }}
        />
      </Box>
    );
  }

  // Step 2: 配置选中的翻译器
  return (
    <Form
      title={`翻译器配置 - ${selectedType.label}`}
      fields={selectedType.fields}
      submitLabel="保存"
      onSubmit={values => {
        // TODO: 调用 GlobalConfigManager 保存翻译器配置
        addLog('warning', `翻译器配置保存功能尚未接入 (${selectedType.name})`);
        goBack();
      }}
      onCancel={() => setSelectedType(null)}
    />
  );
}
