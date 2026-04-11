import { useEffect } from 'react';
import { DeleteOutlined, DownloadOutlined, ExportOutlined } from '@ant-design/icons';
import {
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
import { IMPORT_FORMAT_OPTIONS } from '../../app/ui-helpers.ts';
import { usePollingTask } from '../../app/usePollingTask.ts';

const { TextArea } = Input;

interface WorkspaceConfigTabProps {
  active: boolean;
  workspaceForm: FormInstance<Record<string, unknown>>;
  translatorOptions: Array<{ label: string; value: string }>;
  onRefreshWorkspaceConfig: () => void | Promise<void>;
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
  onRefreshWorkspaceConfig,
  onWorkspaceConfigSave,
  onDownloadExport,
  onResetProject,
}: WorkspaceConfigTabProps) {
  useEffect(() => {
    if (!active) {
      return;
    }
    void onRefreshWorkspaceConfig();
  }, [active, onRefreshWorkspaceConfig]);

  usePollingTask({
    enabled: active,
    intervalMs: 5_000,
    task: async () => {
      await onRefreshWorkspaceConfig();
    },
  });

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
                name="translatorName"
                label="翻译器"
                rules={[{ required: true, message: '请选择翻译器' }]}
              >
                <Select options={translatorOptions} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="glossaryPath" label="术语表路径">
                <Input placeholder="Data/glossary.json" />
              </Form.Item>
            </Col>
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
          </Row>
          <Form.Item name="customRequirements" label="自定义要求">
            <TextArea rows={6} placeholder="每行一条要求" />
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
