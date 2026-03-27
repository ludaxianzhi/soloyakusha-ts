import { useEffect, useMemo, useState } from 'react';
import { Text } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import { Form } from '../components/form.tsx';
import { Panel } from '../components/panel.tsx';
import { ReorderList, type ReorderItem } from '../components/reorder-list.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { FormFieldDef, SelectItem } from '../types.ts';

type WizardStep = 'basics' | 'order' | 'translator' | 'confirm';

type TranslatorOption = {
  label: string;
  value: string;
};

type DraftState = {
  projectName: string;
  projectDir: string;
  importPattern: string;
  importFormat: string;
  glossaryPath: string;
  srcLang: string;
  tgtLang: string;
  chapterPaths: string[];
  translatorModelName: string;
  translatorWorkflow: string;
};

const DEFAULT_IMPORT_FORMAT = 'plain_text';

export function WorkspaceCreateScreen() {
  const { goBack, navigate } = useNavigation();
  const { addLog } = useLog();
  const { initializeProject, isBusy } = useProject();
  const [step, setStep] = useState<WizardStep>('basics');
  const [translatorOptions, setTranslatorOptions] = useState<TranslatorOption[]>([]);
  const [draft, setDraft] = useState<DraftState>({
    projectName: '',
    projectDir: '',
    importPattern: 'sources/**/*.txt',
    importFormat: DEFAULT_IMPORT_FORMAT,
    glossaryPath: '',
    srcLang: 'ja',
    tgtLang: 'zh-CN',
    chapterPaths: [],
    translatorModelName: '',
    translatorWorkflow: 'default',
  });

  useEffect(() => {
    void (async () => {
      try {
        const manager = new GlobalConfigManager();
        const profileNames = await manager.listLlmProfileNames();
        const defaultProfile = await manager.getDefaultLlmProfileName();
        const defaultTranslationProcessor = await manager
          .getTranslationProcessorConfig()
          .catch(() => undefined);

        const nextOptions = profileNames.map((name) => ({
          label: name === defaultProfile ? `${name} (默认)` : name,
          value: name,
        }));
        setTranslatorOptions(nextOptions);
        setDraft((prev) => ({
          ...prev,
          translatorModelName:
            prev.translatorModelName ||
            defaultTranslationProcessor?.modelName ||
            defaultProfile ||
            nextOptions[0]?.value ||
            '',
          translatorWorkflow:
            prev.translatorWorkflow ||
            defaultTranslationProcessor?.workflow ||
            'default',
        }));
      } catch (error) {
        addLog('warning', `读取翻译器配置失败：${toErrorMessage(error)}`);
      }
    })();
  }, [addLog]);

  const basicsFields = useMemo<FormFieldDef[]>(
    () => [
      {
        key: 'name',
        label: '项目名称',
        type: 'text',
        placeholder: '输入项目名称...',
        description: '必填。用于工作区显示和项目快照标识。',
        defaultValue: draft.projectName,
      },
      {
        key: 'dir',
        label: '项目目录',
        type: 'text',
        placeholder: '输入项目目录...',
        description: '项目根目录。Pattern 匹配会基于此目录查找文件。',
        defaultValue: draft.projectDir,
      },
      {
        key: 'importPattern',
        label: '导入 Pattern',
        type: 'text',
        placeholder: 'sources/**/*.txt',
        description: '使用 glob 模式匹配需要导入的章节文件。',
        defaultValue: draft.importPattern,
      },
      {
        key: 'importFormat',
        label: '导入格式',
        type: 'select',
        description: '选择章节文件的解析格式。',
        defaultValue: draft.importFormat,
        options: [
          { label: '纯文本 plain_text', value: 'plain_text' },
          { label: 'Nature Dialog', value: 'naturedialog' },
          { label: 'Nature Dialog (Keep Name)', value: 'naturedialog_keepname' },
          { label: 'M3T', value: 'm3t' },
          { label: 'Galtransl JSON', value: 'galtransl_json' },
        ],
      },
      {
        key: 'glossaryPath',
        label: '字典路径（可选）',
        type: 'text',
        placeholder: 'glossary.csv',
        description: '如果提供，项目会尝试按此路径加载已有字典。',
        defaultValue: draft.glossaryPath,
      },
      {
        key: 'srcLang',
        label: '源语言',
        type: 'select',
        description: '用于初始化工作区语言信息。',
        defaultValue: draft.srcLang,
        options: [
          { label: '日语 (ja)', value: 'ja' },
          { label: '英语 (en)', value: 'en' },
          { label: '韩语 (ko)', value: 'ko' },
        ],
      },
      {
        key: 'tgtLang',
        label: '目标语言',
        type: 'select',
        description: '用于初始化工作区语言信息。',
        defaultValue: draft.tgtLang,
        options: [
          { label: '简体中文 (zh-CN)', value: 'zh-CN' },
          { label: '英语 (en)', value: 'en' },
          { label: '繁体中文 (zh-TW)', value: 'zh-TW' },
        ],
      },
    ],
    [draft],
  );

  const translatorFields = useMemo<FormFieldDef[]>(
    () => [
      {
        key: 'translatorModelName',
        label: '翻译器 Profile',
        type: 'select',
        description: '来自全局配置中的 LLM Profile。',
        defaultValue: draft.translatorModelName || translatorOptions[0]?.value || '__none__',
        options:
          translatorOptions.length > 0
            ? translatorOptions
            : [{ label: '未找到可用 Profile', value: '__none__' }],
      },
      {
        key: 'translatorWorkflow',
        label: '翻译流程',
        type: 'select',
        description: '当前仓库提供的翻译处理工作流。',
        defaultValue: draft.translatorWorkflow,
        options: [{ label: 'default', value: 'default' }],
      },
    ],
    [draft.translatorModelName, draft.translatorWorkflow, translatorOptions],
  );

  if (step === 'basics') {
    return (
      <Form
        title="初始化项目 · Step 1 / 4"
        fields={basicsFields}
        submitLabel="扫描导入文件"
        onSubmit={async (values) => {
          if (!values.name?.trim()) {
            addLog('warning', '项目名称不能为空');
            return;
          }
          if (!values.dir?.trim()) {
            addLog('warning', '项目目录不能为空');
            return;
          }
          if (!values.importPattern?.trim()) {
            addLog('warning', '导入 Pattern 不能为空');
            return;
          }

          const matchedFiles = await findMatchedFiles(values.dir.trim(), values.importPattern.trim());
          if (matchedFiles.length === 0) {
            addLog('warning', '未匹配到任何章节文件，请调整目录或 Pattern');
            return;
          }

          setDraft({
            projectName: values.name.trim(),
            projectDir: values.dir.trim(),
            importPattern: values.importPattern.trim(),
            importFormat: values.importFormat || DEFAULT_IMPORT_FORMAT,
            glossaryPath: values.glossaryPath?.trim() ?? '',
            srcLang: values.srcLang || 'ja',
            tgtLang: values.tgtLang || 'zh-CN',
            chapterPaths: matchedFiles,
            translatorModelName: draft.translatorModelName,
            translatorWorkflow: draft.translatorWorkflow,
          });
          addLog('success', `已匹配 ${matchedFiles.length} 个章节文件，进入排序步骤`);
          setStep('order');
        }}
        onCancel={goBack}
      />
    );
  }

  if (step === 'order') {
    return (
      <ReorderList
        title="初始化项目 · Step 2 / 4"
        description="像老式 BIOS 调整启动顺序一样，先用 ↑↓ 选择，再用 ←→ 调整章节顺序。"
        items={draft.chapterPaths.map((chapterPath, index) => ({
          id: `${index}:${chapterPath}`,
          label: chapterPath,
          meta: `CH${index + 1}`,
          description: `导入格式：${draft.importFormat}`,
        }))}
        onChange={(items) => {
          setDraft((prev) => ({
            ...prev,
            chapterPaths: items.map((item) => item.label),
          }));
        }}
        onConfirm={() => {
          addLog('info', '章节顺序已确认，进入翻译器选择');
          setStep('translator');
        }}
        onCancel={() => setStep('basics')}
        isActive={!isBusy}
      />
    );
  }

  if (step === 'translator') {
    return (
      <Form
        title="初始化项目 · Step 3 / 4"
        fields={translatorFields}
        submitLabel="确认翻译器"
        onSubmit={async (values) => {
          const translatorModelName = values.translatorModelName;
          if (!translatorModelName || translatorModelName === '__none__') {
            addLog('warning', '当前没有可用的翻译器 Profile，请先配置全局 LLM Profile');
            return;
          }

          setDraft((prev) => ({
            ...prev,
            translatorModelName,
            translatorWorkflow: values.translatorWorkflow || 'default',
          }));
          addLog('success', `已选择翻译器 ${translatorModelName}`);
          setStep('confirm');
        }}
        onCancel={() => setStep('order')}
      />
    );
  }

  const confirmItems: SelectItem<'create' | 'back' | 'cancel'>[] = [
    {
      label: '✅ 创建并进入项目',
      value: 'create',
      description: '按当前配置初始化项目并跳转到项目主页。',
      meta: 'enter',
    },
    {
      label: '↩️ 返回上一步',
      value: 'back',
      description: '回到翻译器选择步骤。',
      meta: 'back',
    },
    {
      label: '❌ 取消初始化',
      value: 'cancel',
      description: '退出初始化向导。',
      meta: 'esc',
    },
  ];

  return (
    <SafeBox flexDirection="column" gap={1}>
      <Panel
        title="初始化项目 · Step 4 / 4"
        subtitle="确认项目初始化摘要后即可进入项目主页。"
        tone="green"
      >
        <SafeBox flexDirection="column">
          <Text>
            项目：<Text color="cyan">{draft.projectName}</Text>
          </Text>
          <Text>目录：{draft.projectDir}</Text>
          <Text>Pattern：{draft.importPattern}</Text>
          <Text>导入格式：{draft.importFormat}</Text>
          <Text>翻译器：{draft.translatorModelName || '未选择'}</Text>
          <Text>Workflow：{draft.translatorWorkflow}</Text>
          <Text>章节数：{draft.chapterPaths.length}</Text>
          {draft.glossaryPath ? <Text>字典路径：{draft.glossaryPath}</Text> : null}
          <Text dimColor>章节预览：</Text>
          {draft.chapterPaths.slice(0, 8).map((chapterPath, index) => (
            <Text key={`${index}:${chapterPath}`} dimColor>
              {index + 1}. {chapterPath}
            </Text>
          ))}
          {draft.chapterPaths.length > 8 ? (
            <Text dimColor>... 还有 {draft.chapterPaths.length - 8} 个章节</Text>
          ) : null}
        </SafeBox>
      </Panel>

      <Select
        title="确认动作"
        description="创建后会直接打开项目主页，并显示实时项目进度。"
        items={confirmItems}
        isActive={!isBusy}
        onSelect={(item) => {
          if (item.value === 'back') {
            setStep('translator');
            return;
          }
          if (item.value === 'cancel') {
            goBack();
            return;
          }

          void (async () => {
            const opened = await initializeProject({
              projectName: draft.projectName,
              projectDir: draft.projectDir,
              chapterPaths: draft.chapterPaths,
              glossaryPath: draft.glossaryPath,
              srcLang: draft.srcLang,
              tgtLang: draft.tgtLang,
              importFormat: draft.importFormat,
              translatorModelName: draft.translatorModelName,
              translatorWorkflow: draft.translatorWorkflow,
            });

            if (opened) {
              addLog('success', '初始化工作流完成，已进入项目主页');
              navigate('workspace-progress');
            }
          })();
        }}
      />
    </SafeBox>
  );
}

async function findMatchedFiles(projectDir: string, pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const results: string[] = [];

  for await (const match of glob.scan({
    cwd: projectDir,
    onlyFiles: true,
    absolute: false,
  })) {
    results.push(match);
  }

  return results.sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
