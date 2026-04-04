import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { useEffect, useMemo, useState } from 'react';
import { Text } from 'ink';
import { GlobalConfigManager } from '../../config/manager.ts';
import { WorkspaceRegistry } from '../../config/workspace-registry.ts';
import { Form } from '../components/form.tsx';
import { ReorderList, type ReorderItem } from '../components/reorder-list.tsx';
import { Select } from '../components/select.tsx';
import { SafeBox } from '../components/safe-box.tsx';
import { useNavigation } from '../context/navigation.tsx';
import { useLog } from '../context/log.tsx';
import { useProject } from '../context/project.tsx';
import type { BranchImportInput } from '../context/project.tsx';
import type { AutocompleteItem, FormFieldDef, SelectItem } from '../types.ts';

type WizardStep = 'basics' | 'order' | 'translator' | 'branch-ask' | 'branch-setup' | 'branch-order' | 'confirm';

type TranslatorOption = {
  label: string;
  value: string;
};

type BranchDraft = {
  routeId: string;
  routeName: string;
  forkAfterChapterId: number;
  importPattern: string;
  chapterPaths: string[];
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
  translatorName: string;
  branches: BranchDraft[];
};

const DEFAULT_IMPORT_FORMAT = 'plain_text';

export function WorkspaceCreateScreen() {
  const { goBack, navigate } = useNavigation();
  const { addLog } = useLog();
  const { initializeProject, isBusy } = useProject();
  const [step, setStep] = useState<WizardStep>('basics');
  const [translatorOptions, setTranslatorOptions] = useState<TranslatorOption[]>([]);
  const [pendingBranch, setPendingBranch] = useState<BranchDraft | null>(null);
  const [draft, setDraft] = useState<DraftState>({
    projectName: '',
    projectDir: '',
    importPattern: 'sources/**/*.txt',
    importFormat: DEFAULT_IMPORT_FORMAT,
    glossaryPath: '',
    srcLang: 'ja',
    tgtLang: 'zh-CN',
    chapterPaths: [],
    translatorName: '',
    branches: [],
  });

  useEffect(() => {
    void (async () => {
      try {
        const manager = new GlobalConfigManager();
        const translatorNames = await manager.listTranslatorNames();
        const nextOptions = translatorNames.map((name) => ({
          label: name,
          value: name,
        }));
        setTranslatorOptions(nextOptions);
        setDraft((prev) => ({
          ...prev,
          translatorName: prev.translatorName || nextOptions[0]?.value || '',
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
        type: 'autocomplete',
        placeholder: '输入项目目录...',
        description: '项目根目录。Pattern 匹配会基于此目录查找文件。',
        defaultValue: draft.projectDir,
        autocomplete: {
          maxItems: 5,
          getSuggestions: (input) => getShallowPathSuggestions(input, { directoriesOnly: true }),
        },
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
        type: 'autocomplete',
        placeholder: 'glossary.csv',
        description: '如果提供，项目会尝试按此路径加载已有字典。',
        defaultValue: draft.glossaryPath,
        autocomplete: {
          maxItems: 5,
          getSuggestions: (input, values) =>
            getShallowPathSuggestions(input, {
              baseDir: values.dir?.trim() || undefined,
            }),
        },
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
        key: 'translatorName',
        label: '翻译器',
        type: 'autocomplete',
        description: '选择全局翻译器目录中已配置的翻译器。如未配置，请先前往「设置 → 翻译器目录」创建。',
        defaultValue: draft.translatorName || translatorOptions[0]?.value || '__none__',
        autocomplete: {
          maxItems: 5,
          showWhenEmpty: true,
          getSuggestions: (input) =>
            getTranslatorSuggestions(
              input,
              translatorOptions.length > 0
                ? translatorOptions
                : [{ label: '未找到可用翻译器', value: '__none__' }],
            ),
        },
      },
    ],
    [draft.translatorName, translatorOptions],
  );

  if (step === 'basics') {
    return (
      <Form
        title="初始化项目 · 导入主线"
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
            translatorName: draft.translatorName,
            branches: draft.branches,
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
        title="初始化项目 · 主线章节排序"
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
        title="初始化项目 · 翻译器选择"
        fields={translatorFields}
        submitLabel="确认翻译器"
        onSubmit={async (values) => {
          const translatorName = values.translatorName;
          if (!translatorName || translatorName === '__none__') {
            addLog('warning', '请先在「设置 → 翻译器目录」中创建翻译器，再初始化项目');
            return;
          }

          setDraft((prev) => ({
            ...prev,
            translatorName,
          }));
          addLog('success', `已选择翻译器「${translatorName}」`);
          setStep('branch-ask');
        }}
        onCancel={() => setStep('order')}
      />
    );
  }

  if (step === 'branch-ask') {
    const branchAskItems: SelectItem<'add' | 'skip'>[] = [
      {
        label: '📌 添加支线',
        value: 'add',
        description: '选择一个主线章节作为分支点，导入另一组文件作为支线。',
        meta: 'branch',
      },
      {
        label: '⏭️ 跳过，直接创建',
        value: 'skip',
        description: draft.branches.length > 0
          ? `已添加 ${draft.branches.length} 条支线，进入最终确认。`
          : '不添加支线，直接进入确认步骤。',
        meta: 'skip',
      },
    ];

    return (
      <SafeBox flexDirection="column" gap={1}>
        <SafeBox flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
          <Text bold color="blue">初始化项目 · 是否导入支线？</Text>
          <SafeBox flexDirection="column">
            <Text>
              主线章节数：<Text color="cyan">{draft.chapterPaths.length}</Text>
            </Text>
            {draft.branches.length > 0 ? (
              <Text>
                已添加支线：<Text color="yellow">{draft.branches.length}</Text> 条
                {draft.branches.map((branch, index) => (
                  <Text key={branch.routeId} dimColor>
                    {`\n  ${index + 1}. ${branch.routeName}（${branch.chapterPaths.length} 章节，从章节 ${branch.forkAfterChapterId} 分叉）`}
                  </Text>
                ))}
              </Text>
            ) : null}
          </SafeBox>
        </SafeBox>

        <Select
          title="选择操作"
          items={branchAskItems}
          isActive={!isBusy}
          onSelect={(item) => {
            if (item.value === 'skip') {
              setStep('confirm');
            } else {
              setStep('branch-setup');
            }
          }}
        />
      </SafeBox>
    );
  }

  if (step === 'branch-setup') {
    const forkPointOptions = draft.chapterPaths.map((chapterPath, index) => ({
      label: `CH${index + 1}: ${chapterPath}`,
      value: String(index + 1),
    }));

    const branchFields: FormFieldDef[] = [
      {
        key: 'routeName',
        label: '支线名称',
        type: 'text',
        placeholder: '例如：Heroine A Route',
        description: '用于标识这条分支路线的名称。',
        defaultValue: '',
      },
      {
        key: 'forkAfterChapterId',
        label: '分叉点（主线章节）',
        type: 'select',
        description: '选择主线中的一个章节作为分叉点，支线从该章节之后开始。',
        defaultValue: forkPointOptions[0]?.value ?? '',
        options: forkPointOptions,
      },
      {
        key: 'importPattern',
        label: '支线导入 Pattern',
        type: 'text',
        placeholder: 'sources/branch-a/**/*.txt',
        description: '使用 glob 模式匹配支线的章节文件。基于项目目录。',
        defaultValue: '',
      },
    ];

    return (
      <Form
        title="初始化项目 · 支线配置"
        fields={branchFields}
        submitLabel="扫描支线文件"
        onSubmit={async (values) => {
          if (!values.routeName?.trim()) {
            addLog('warning', '支线名称不能为空');
            return;
          }
          if (!values.importPattern?.trim()) {
            addLog('warning', '支线导入 Pattern 不能为空');
            return;
          }

          const forkChapterId = parseInt(values.forkAfterChapterId || '1', 10);
          const matchedFiles = await findMatchedFiles(draft.projectDir, values.importPattern.trim());
          if (matchedFiles.length === 0) {
            addLog('warning', '未匹配到任何支线文件，请调整 Pattern');
            return;
          }

          const routeId = `branch-${draft.branches.length + 1}`;
          setPendingBranch({
            routeId,
            routeName: values.routeName.trim(),
            forkAfterChapterId: forkChapterId,
            importPattern: values.importPattern.trim(),
            chapterPaths: matchedFiles,
          });
          addLog('success', `已匹配 ${matchedFiles.length} 个支线文件，进入支线排序`);
          setStep('branch-order');
        }}
        onCancel={() => {
          setPendingBranch(null);
          setStep('branch-ask');
        }}
      />
    );
  }

  if (step === 'branch-order' && pendingBranch) {
    return (
      <ReorderList
        title={`初始化项目 · 支线「${pendingBranch.routeName}」章节排序`}
        description="调整支线章节顺序后确认。"
        items={pendingBranch.chapterPaths.map((chapterPath, index) => ({
          id: `${index}:${chapterPath}`,
          label: chapterPath,
          meta: `B${draft.branches.length + 1}-CH${index + 1}`,
          description: `支线 · 导入格式：${draft.importFormat}`,
        }))}
        onChange={(items) => {
          setPendingBranch((prev) =>
            prev ? { ...prev, chapterPaths: items.map((item) => item.label) } : prev,
          );
        }}
        onConfirm={() => {
          setDraft((prev) => ({
            ...prev,
            branches: [...prev.branches, pendingBranch],
          }));
          addLog('success', `支线「${pendingBranch.routeName}」已添加（${pendingBranch.chapterPaths.length} 章节）`);
          setPendingBranch(null);
          setStep('branch-ask');
        }}
        onCancel={() => {
          setPendingBranch(null);
          setStep('branch-setup');
        }}
        isActive={!isBusy}
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
      <SafeBox flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
        <Text bold color="green">初始化项目 · 确认</Text>
        <SafeBox flexDirection="column">
          <Text>
            项目：<Text color="cyan">{draft.projectName}</Text>
          </Text>
          <Text>目录：{draft.projectDir}</Text>
          <Text>Pattern：{draft.importPattern}</Text>
          <Text>导入格式：{draft.importFormat}</Text>
          <Text>翻译器：{draft.translatorName || '未选择'}</Text>
          <Text>主线章节数：{draft.chapterPaths.length}</Text>
          {draft.branches.length > 0 ? (
            <Text>
              支线：<Text color="yellow">{draft.branches.length}</Text> 条
              （共 {draft.branches.reduce((sum, b) => sum + b.chapterPaths.length, 0)} 章节）
            </Text>
          ) : null}
          {draft.glossaryPath ? <Text>字典路径：{draft.glossaryPath}</Text> : null}
          <Text dimColor>主线章节预览：</Text>
          {draft.chapterPaths.slice(0, 6).map((chapterPath, index) => (
            <Text key={`main-${index}:${chapterPath}`} dimColor>
              {index + 1}. {chapterPath}
            </Text>
          ))}
          {draft.chapterPaths.length > 6 ? (
            <Text dimColor>... 还有 {draft.chapterPaths.length - 6} 个主线章节</Text>
          ) : null}
          {draft.branches.map((branch) => (
            <Text key={branch.routeId} dimColor>
              支线「{branch.routeName}」：{branch.chapterPaths.length} 章节，从 CH{branch.forkAfterChapterId} 分叉
            </Text>
          ))}
        </SafeBox>
      </SafeBox>

      <Select
        title="确认动作"
        items={confirmItems}
        isActive={!isBusy}
        onSelect={(item) => {
          if (item.value === 'back') {
            setStep('branch-ask');
            return;
          }
          if (item.value === 'cancel') {
            goBack();
            return;
          }

          void (async () => {
            const branches: BranchImportInput[] = draft.branches.map((branch) => ({
              routeId: branch.routeId,
              routeName: branch.routeName,
              forkAfterChapterId: branch.forkAfterChapterId,
              chapterPaths: branch.chapterPaths,
            }));

            const opened = await initializeProject({
              projectName: draft.projectName,
              projectDir: draft.projectDir,
              chapterPaths: draft.chapterPaths,
              glossaryPath: draft.glossaryPath,
              srcLang: draft.srcLang,
              tgtLang: draft.tgtLang,
              importFormat: draft.importFormat,
              translatorName: draft.translatorName,
              branches: branches.length > 0 ? branches : undefined,
            });

            if (opened) {
              try {
                const registry = new WorkspaceRegistry();
                await registry.touchWorkspace({
                  name: draft.projectName,
                  dir: draft.projectDir,
                });
              } catch {
                // 注册表写入失败不阻断流程
              }
              addLog('success', '初始化工作流完成，已进入工作区操作面板');
              navigate('workspace-ops');
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

async function getShallowPathSuggestions(
  input: string,
  options: {
    baseDir?: string;
    directoriesOnly?: boolean;
    maxItems?: number;
  } = {},
): Promise<AutocompleteItem[]> {
  const trimmedInput = input.trim().replace(/\//g, '\\');
  if (!trimmedInput) {
    return [];
  }

  const hasTrailingSlash = /[\\/]$/.test(trimmedInput);
  const baseDir = options.baseDir?.trim();
  const resolvedInput = resolvePathForAutocomplete(trimmedInput, baseDir);
  const searchDir = hasTrailingSlash ? resolvedInput : dirname(resolvedInput);
  const partialName = hasTrailingSlash ? '' : basename(trimmedInput);
  const displayPrefix = hasTrailingSlash
    ? trimmedInput
    : trimmedInput.slice(0, Math.max(0, trimmedInput.length - partialName.length));
  const maxItems = Math.max(1, options.maxItems ?? 5);

  try {
    const entries = await readdir(searchDir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (options.directoriesOnly && !entry.isDirectory()) {
          return false;
        }
        return entry.name.toLowerCase().startsWith(partialName.toLowerCase());
      })
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1;
        }
        return left.name.localeCompare(right.name, 'zh-CN');
      })
      .slice(0, maxItems)
      .map((entry) => ({
        label: `${displayPrefix}${entry.name}${entry.isDirectory() ? '\\' : ''}`,
        value: `${displayPrefix}${entry.name}${entry.isDirectory() ? '\\' : ''}`,
        meta: entry.isDirectory() ? 'dir' : 'file',
      }));
  } catch {
    return [];
  }
}

function resolvePathForAutocomplete(input: string, baseDir?: string): string {
  if (isAbsolute(input)) {
    return resolve(input);
  }

  if (baseDir) {
    return resolve(baseDir, input);
  }

  return resolve(input);
}

function getTranslatorSuggestions(
  input: string,
  options: ReadonlyArray<TranslatorOption>,
): AutocompleteItem[] {
  const query = input.trim().toLowerCase();
  return options
    .filter((option) => {
      if (!query) {
        return true;
      }
      return (
        option.value.toLowerCase().includes(query) ||
        option.label.toLowerCase().includes(query)
      );
    })
    .slice(0, 5)
    .map((option) => ({
      label: option.value,
      value: option.value,
      meta: option.label === option.value ? undefined : option.label,
    }));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
