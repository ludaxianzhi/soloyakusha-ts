import { useEffect } from 'react';
import { DeleteOutlined, DownloadOutlined, ExportOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Select,
  Space,
} from 'antd';
import type { FormInstance } from 'antd';
import type { TranslationProcessorWorkflowMetadata } from '../../app/types.ts';
import {
  getWorkspaceWorkflowFields,
  IMPORT_FORMAT_OPTIONS,
  WORKSPACE_PIPELINE_STRATEGY_OPTIONS,
  workspaceFieldName,
} from '../../app/ui-helpers.ts';
import { WorkflowFieldSections } from '../WorkflowFieldSections.tsx';
import { usePollingTask } from '../../app/usePollingTask.ts';

const { TextArea } = Input;

const DEFAULT_EDITOR_REQUIREMENTS_PLACEHOLDER = [
  '作为翻译而来的非本土作品，应该尽量避免过于“书面化”和“古风化”的表达。比如“若是”（应改为“如果是”），“本无此意”（太过于书面化），“虽说”，“倘若”，“吾”，“妾身”等等（除非另有说明）。',
  '修辞和成语方面，避免使用生僻或过于高雅的词汇，尽量贴近现实。适当地采用口语化的表达风格，避免阅读的割裂感。',
].join('\n');

interface WorkspaceConfigTabProps {
  active: boolean;
  workspaceForm: FormInstance<Record<string, unknown>>;
  translatorOptions: Array<{ label: string; value: string }>;
  styleLibraryOptions: Array<{ label: string; value: string; description?: string }>;
  selectedTranslatorWorkflow?: TranslationProcessorWorkflowMetadata;
  onRefreshWorkspaceConfig: () => void | Promise<void>;
  onRefreshStyleLibraryOptions?: () => void | Promise<void>;
  onWorkspaceConfigSave: (values: Record<string, unknown>) => void | Promise<void>;
  onDownloadExport: (format: string) => void | Promise<void>;
  onResetProject: (
    payload: Record<string, unknown>,
    successText: string,
  ) => void | Promise<void>;
}

export function WorkspaceConfigTab({
  active,
  workspaceForm,
  translatorOptions,
  styleLibraryOptions,
  selectedTranslatorWorkflow,
  onRefreshWorkspaceConfig,
  onRefreshStyleLibraryOptions,
  onWorkspaceConfigSave,
  onDownloadExport,
  onResetProject,
}: WorkspaceConfigTabProps) {
  const formValues = Form.useWatch([], workspaceForm) as Record<string, unknown> | undefined;

  useEffect(() => {
    if (!active) {
      return;
    }
    void onRefreshWorkspaceConfig();
    void onRefreshStyleLibraryOptions?.();
  }, [active, onRefreshStyleLibraryOptions, onRefreshWorkspaceConfig]);

  usePollingTask({
    enabled: active,
    intervalMs: 5_000,
    task: async () => {
      await onRefreshWorkspaceConfig();
    },
  });

  const workspaceFields = getWorkspaceWorkflowFields(selectedTranslatorWorkflow);

  return (
    <div className="section-stack">
      <Card title="项目配置">
        <Form
          form={workspaceForm}
          layout="vertical"
          className="compact-form"
          onFinish={(values) => void onWorkspaceConfigSave(values)}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="projectName" label="项目名称" rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="pipelineStrategy"
                label="翻译工作流"
                rules={[{ required: true, message: '请选择翻译工作流' }]}
              >
                <Select options={WORKSPACE_PIPELINE_STRATEGY_OPTIONS} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="translatorName"
                label="翻译器"
                rules={[{ required: true, message: '请选择翻译器' }]}
              >
                <Select options={translatorOptions} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="glossaryPath" label="术语表路径">
                <Input placeholder="Data/glossary.json" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="defaultImportFormat" label="默认导入格式">
                <Select options={IMPORT_FORMAT_OPTIONS} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="defaultExportFormat" label="默认导出格式">
                <Select options={IMPORT_FORMAT_OPTIONS} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Alert
                type="info"
                showIcon
                message="切换工作流会清除相关支持数据"
                description="例如上下文网络与依赖图会被清空，切换后需要重新构建所需支持数据。"
              />
            </Col>
          </Row>
          <Form.Item name="customRequirements" label="自定义要求">
            <TextArea rows={6} placeholder="每行一条要求" />
          </Form.Item>
          {workspaceFields.length > 0 ? (
            <Card size="small" className="settings-meta-card" title="翻译器专属参数">
              <WorkflowFieldSections
                formValues={formValues}
                fields={workspaceFields}
                llmProfileOptions={[]}
                fieldOptionsBySource={{
                  'style-libraries': styleLibraryOptions,
                }}
                fieldNameForKey={workspaceFieldName}
              />
            </Card>
          ) : null}
          <Form.Item name="editorRequirementsText" label="校对-编辑要求">
            <TextArea rows={5} placeholder={DEFAULT_EDITOR_REQUIREMENTS_PLACEHOLDER} />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            保存配置
          </Button>
        </Form>
      </Card>

      <Row gutter={16}>
        <Col span={12}>
          <Card title="导出项目" extra={<ExportOutlined />}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button
                icon={<DownloadOutlined />}
                type="primary"
                onClick={() => void onDownloadExport('plain_text')}
              >
                下载纯文本导出 ZIP
              </Button>
              <Button onClick={() => void onDownloadExport('naturedialog')}>
                下载 Nature Dialog 导出 ZIP
              </Button>
              <Button onClick={() => void onDownloadExport('m3t')}>
                下载 M3T 导出 ZIP
              </Button>
              <Button onClick={() => void onDownloadExport('galtransl_json')}>
                下载 GalTransl JSON 导出 ZIP
              </Button>
            </Space>
          </Card>
        </Col>
        <Col span={12}>
          <Card title="重置项目" extra={<DeleteOutlined />}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button
                danger
                onClick={() =>
                  void onResetProject({ clearAllTranslations: true }, '已清空所有译文')
                }
              >
                清空全部译文
              </Button>
              <Button
                danger
                onClick={() => void onResetProject({ clearGlossary: true }, '已清空术语表')}
              >
                清空术语表
              </Button>
              <Button
                danger
                onClick={() =>
                  void onResetProject(
                    { clearGlossaryTranslations: true },
                    '已清空术语表译文',
                  )
                }
              >
                清空术语表译文
              </Button>
              <Button
                danger
                onClick={() =>
                  void onResetProject({ clearPlotSummaries: true }, '已清空情节大纲')
                }
              >
                清空情节大纲
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
