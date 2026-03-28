import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, useInput } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import type { PersistedLlmClientConfig } from '../../config/types.ts';
import { Form } from '../components/form.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import type { FormFieldDef, SelectItem } from '../types.ts';

type Mode =
  | { kind: 'loading' }
  | { kind: 'menu' }
  | { kind: 'edit-embedding' }
  | { kind: 'create-profile' }
  | { kind: 'profile-actions'; profileName: string }
  | { kind: 'edit-profile'; profileName: string };

type ProfileSummary = {
  name: string;
  config: PersistedLlmClientConfig;
};

const PROVIDER_OPTIONS = [
  { label: 'OpenAI (兼容)', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
] as const;

const EMBEDDING_PROVIDER_OPTIONS = [
  { label: 'OpenAI (兼容)', value: 'openai' },
] as const;

const NUMBER_OPTIONS = (values: number[]) =>
  values.map((value) => ({ label: String(value), value: String(value) }));

const OPTIONAL_NUMBER_OPTIONS = [
  { label: '(未设置)', value: '' },
  ...NUMBER_OPTIONS([1, 2, 3, 4, 5, 8, 10, 20]),
];

export function SettingsLlmScreen() {
  const { goBack } = useNavigation();
  const { addLog } = useLog();
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [defaultProfileName, setDefaultProfileName] = useState<string>('');
  const [embeddingConfig, setEmbeddingConfig] = useState<PersistedLlmClientConfig | null>(null);

  const reload = useCallback(async () => {
    const manager = new GlobalConfigManager();
    const profileNames = await manager.listLlmProfileNames();
    const loadedProfiles = await Promise.all(
      profileNames.map(async (name) => ({
        name,
        config: await manager.getRequiredLlmProfile(name),
      })),
    );
    const defaultName = await manager.getDefaultLlmProfileName();
    const embedding = await manager.getEmbeddingConfig();
    setProfiles(loadedProfiles);
    setDefaultProfileName(defaultName ?? '');
    setEmbeddingConfig(embedding ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await reload();
        setMode({ kind: 'menu' });
      } catch (error) {
        addLog('error', `读取 LLM 配置失败：${toErrorMessage(error)}`);
        setMode({ kind: 'menu' });
      }
    })();
  }, [addLog, reload]);

  useInput((_input, key) => {
    if (!key.escape) {
      return;
    }

    if (mode.kind === 'menu' || mode.kind === 'loading') {
      goBack();
      return;
    }

    if (mode.kind === 'profile-actions') {
      setMode({ kind: 'menu' });
      return;
    }

    if (mode.kind === 'edit-profile') {
      setMode({ kind: 'profile-actions', profileName: mode.profileName });
      return;
    }

    setMode({ kind: 'menu' });
  });

  const profileMenuItems = useMemo<SelectItem<string>[]>(() => {
    const items: SelectItem<string>[] = [
      {
        label: '🧩 嵌入配置',
        value: '__embedding__',
        meta: embeddingConfig?.modelName ? 'ready' : 'empty',
      },
      ...profiles.map((profile) => ({
        label: profile.name,
        value: `profile:${profile.name}`,
        meta: profile.name === defaultProfileName ? 'default' : profile.config.provider,
      })),
      {
        label: '➕ 新建配置',
        value: '__new__',
        meta: 'new',
      },
      {
        label: '↩️ 返回',
        value: '__back__',
        meta: 'esc',
      },
    ];

    return items;
  }, [defaultProfileName, embeddingConfig?.modelName, profiles]);

  if (mode.kind === 'loading') {
    return (
      <SafeBox flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">LLM 配置</Text>
        <Text dimColor>正在加载配置...</Text>
      </SafeBox>
    );
  }

  if (mode.kind === 'menu') {
    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">LLM 配置</Text>
          <Text>
            命名配置：<Text color="green">{profiles.length}</Text>
            {' · '}嵌入模型：{embeddingConfig?.modelName ? (
              <Text color="green">{embeddingConfig.modelName}</Text>
            ) : (
              <Text color="yellow">未配置</Text>
            )}
          </Text>
        </SafeBox>

        <Select
          title="配置列表"
          items={profileMenuItems}
          onSelect={(item) => {
            if (item.value === '__back__') {
              goBack();
              return;
            }
            if (item.value === '__embedding__') {
              setMode({ kind: 'edit-embedding' });
              return;
            }
            if (item.value === '__new__') {
              setMode({ kind: 'create-profile' });
              return;
            }

            setMode({ kind: 'profile-actions', profileName: item.value.slice('profile:'.length) });
          }}
        />
      </SafeBox>
    );
  }

  if (mode.kind === 'profile-actions') {
    const profile = profiles.find((item) => item.name === mode.profileName);
    const actionItems: SelectItem<string>[] = [
      { label: '✏️ 编辑配置', value: '__edit__', meta: 'edit' },
      { label: '🗑️ 删除配置', value: '__delete__', meta: 'del' },
      { label: '↩️ 返回', value: '__back__', meta: 'esc' },
    ];

    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">LLM 配置 · {mode.profileName}</Text>
          <Text>
            模型：{profile?.config.modelName ?? '(未知)'}
            {' · '}默认：{mode.profileName === defaultProfileName ? '是' : '否'}
          </Text>
        </SafeBox>

        <Select
          title="操作"
          items={actionItems}
          onSelect={(item) => {
            if (item.value === '__back__') {
              setMode({ kind: 'menu' });
              return;
            }

            if (item.value === '__edit__') {
              setMode({ kind: 'edit-profile', profileName: mode.profileName });
              return;
            }

            void (async () => {
              try {
                const manager = new GlobalConfigManager();
                await manager.removeLlmProfile(mode.profileName);
                await reload();
                addLog('success', `已删除 LLM 配置：${mode.profileName}`);
                setMode({ kind: 'menu' });
              } catch (error) {
                addLog('error', `删除 LLM 配置失败：${toErrorMessage(error)}`);
              }
            })();
          }}
        />
      </SafeBox>
    );
  }

  if (mode.kind === 'edit-embedding') {
    const fields = buildEmbeddingFields(embeddingConfig ?? undefined);
    return (
      <Form
        title="嵌入配置"
        fields={fields}
        submitLabel="保存嵌入配置"
        onSubmit={async (values) => {
          const nextConfig = buildLlmConfigFromValues(values, 'embedding');
          if (!nextConfig.ok) {
            addLog('warning', nextConfig.message);
            return;
          }

          try {
            const manager = new GlobalConfigManager();
            await manager.setEmbeddingConfig(nextConfig.config);
            await reload();
            addLog('success', `嵌入模型已更新：${nextConfig.config.modelName}`);
            setMode({ kind: 'menu' });
          } catch (error) {
            addLog('error', `保存嵌入配置失败：${toErrorMessage(error)}`);
          }
        }}
        onCancel={() => setMode({ kind: 'menu' })}
      />
    );
  }

  const originalProfile =
    mode.kind === 'edit-profile'
      ? profiles.find((item) => item.name === mode.profileName)
      : undefined;
  const fields = buildProfileFields({
    profileName: originalProfile?.name,
    config: originalProfile?.config,
    isDefault: originalProfile?.name === defaultProfileName,
  });

  return (
    <Form
      title={mode.kind === 'create-profile' ? '新建 LLM 配置' : `编辑 LLM 配置 · ${mode.profileName}`}
      fields={fields}
      submitLabel="保存配置"
      onSubmit={async (values) => {
        const profileName = values.profileName?.trim() ?? '';
        if (!profileName) {
          addLog('warning', '配置名称不能为空');
          return;
        }

        if (
          profiles.some((profile) => profile.name === profileName) &&
          profileName !== originalProfile?.name
        ) {
          addLog('warning', `已存在同名配置：${profileName}`);
          return;
        }

        const nextConfig = buildLlmConfigFromValues(values, 'chat');
        if (!nextConfig.ok) {
          addLog('warning', nextConfig.message);
          return;
        }

        const shouldBeDefault = values.isDefault === 'yes';
        try {
          const manager = new GlobalConfigManager();
          await manager.setLlmProfile(profileName, nextConfig.config);

          if (originalProfile && originalProfile.name !== profileName) {
            await manager.removeLlmProfile(originalProfile.name);
          }

          if (shouldBeDefault) {
            await manager.setDefaultLlmProfileName(profileName);
          } else if (originalProfile?.name === defaultProfileName) {
            await manager.setDefaultLlmProfileName(undefined);
          }

          await reload();
          addLog('success', `LLM 配置已保存：${profileName}`);
          setMode({ kind: 'menu' });
        } catch (error) {
          addLog('error', `保存 LLM 配置失败：${toErrorMessage(error)}`);
        }
      }}
      onCancel={() => {
        if (mode.kind === 'edit-profile') {
          setMode({ kind: 'profile-actions', profileName: mode.profileName });
          return;
        }
        setMode({ kind: 'menu' });
      }}
    />
  );
}

function buildProfileFields(input: {
  profileName?: string;
  config?: PersistedLlmClientConfig;
  isDefault?: boolean;
}): FormFieldDef[] {
  return [
    {
      key: 'profileName',
      label: '配置名称',
      type: 'text',
      placeholder: '例如: writer',
      defaultValue: input.profileName ?? '',
    },
    {
      key: 'provider',
      label: '提供商',
      type: 'select',
      options: [...PROVIDER_OPTIONS],
      defaultValue: input.config?.provider ?? 'openai',
    },
    {
      key: 'endpoint',
      label: 'API 地址',
      type: 'text',
      placeholder: 'https://api.openai.com/v1',
      defaultValue: input.config?.endpoint ?? '',
    },
    {
      key: 'apiKey',
      label: 'API 密钥',
      type: 'text',
      placeholder: 'sk-...',
      defaultValue: input.config?.apiKey ?? '',
    },
    {
      key: 'apiKeyEnv',
      label: '密钥环境变量',
      type: 'text',
      placeholder: 'OPENAI_API_KEY',
      defaultValue: input.config?.apiKeyEnv ?? '',
    },
    {
      key: 'modelName',
      label: '模型名称',
      type: 'text',
      placeholder: 'gpt-4.1',
      defaultValue: input.config?.modelName ?? '',
    },
    {
      key: 'retries',
      label: '重试次数',
      type: 'select',
      options: NUMBER_OPTIONS([1, 2, 3, 5, 8]),
      defaultValue: String(input.config?.retries ?? 3),
    },
    {
      key: 'qps',
      label: 'QPS',
      type: 'select',
      options: OPTIONAL_NUMBER_OPTIONS,
      defaultValue: input.config?.qps ? String(input.config.qps) : '',
    },
    {
      key: 'maxParallelRequests',
      label: '并发数',
      type: 'select',
      options: OPTIONAL_NUMBER_OPTIONS,
      defaultValue: input.config?.maxParallelRequests ? String(input.config.maxParallelRequests) : '',
    },
    {
      key: 'isDefault',
      label: '设为默认',
      type: 'select',
      options: [
        { label: '否', value: 'no' },
        { label: '是', value: 'yes' },
      ],
      defaultValue: input.isDefault ? 'yes' : 'no',
    },
  ];
}

function buildEmbeddingFields(config?: PersistedLlmClientConfig): FormFieldDef[] {
  return [
    {
      key: 'provider',
      label: '提供商',
      type: 'select',
      options: [...EMBEDDING_PROVIDER_OPTIONS],
      defaultValue: config?.provider ?? 'openai',
    },
    {
      key: 'endpoint',
      label: 'API 地址',
      type: 'text',
      placeholder: 'https://api.openai.com/v1',
      defaultValue: config?.endpoint ?? '',
    },
    {
      key: 'apiKey',
      label: 'API 密钥',
      type: 'text',
      placeholder: 'sk-...',
      defaultValue: config?.apiKey ?? '',
    },
    {
      key: 'apiKeyEnv',
      label: '密钥环境变量',
      type: 'text',
      placeholder: 'OPENAI_API_KEY',
      defaultValue: config?.apiKeyEnv ?? '',
    },
    {
      key: 'modelName',
      label: '模型名称',
      type: 'text',
      placeholder: 'text-embedding-3-small',
      defaultValue: config?.modelName ?? '',
    },
    {
      key: 'retries',
      label: '重试次数',
      type: 'select',
      options: NUMBER_OPTIONS([1, 2, 3, 5, 8]),
      defaultValue: String(config?.retries ?? 3),
    },
    {
      key: 'qps',
      label: 'QPS',
      type: 'select',
      options: OPTIONAL_NUMBER_OPTIONS,
      defaultValue: config?.qps ? String(config.qps) : '',
    },
    {
      key: 'maxParallelRequests',
      label: '并发数',
      type: 'select',
      options: OPTIONAL_NUMBER_OPTIONS,
      defaultValue: config?.maxParallelRequests ? String(config.maxParallelRequests) : '',
    },
  ];
}

function buildLlmConfigFromValues(
  values: Record<string, string>,
  modelType: 'chat' | 'embedding',
):
  | { ok: true; config: PersistedLlmClientConfig }
  | { ok: false; message: string } {
  const endpoint = values.endpoint?.trim() ?? '';
  const modelName = values.modelName?.trim() ?? '';
  const apiKey = values.apiKey?.trim() ?? '';
  const apiKeyEnv = values.apiKeyEnv?.trim() ?? '';

  if (!endpoint) {
    return { ok: false, message: 'API 地址不能为空' };
  }
  if (!modelName) {
    return { ok: false, message: '模型名称不能为空' };
  }
  if (!apiKey && !apiKeyEnv) {
    return { ok: false, message: 'API 密钥和密钥环境变量至少填写一个' };
  }
  if (apiKey && apiKeyEnv) {
    return { ok: false, message: 'API 密钥和密钥环境变量只能填写一个' };
  }

  return {
    ok: true,
    config: {
      provider: (values.provider as PersistedLlmClientConfig['provider']) || 'openai',
      modelType,
      modelName,
      endpoint,
      retries: parseInteger(values.retries, 3),
      qps: parseOptionalInteger(values.qps),
      maxParallelRequests: parseOptionalInteger(values.maxParallelRequests),
      ...(apiKey ? { apiKey } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    },
  };
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
