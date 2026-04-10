import { Alert, Button, Card, Descriptions, Form, Space, Tag, Typography } from 'antd';
import type { FormInstance, UploadFile } from 'antd';
import type {
  WorkspaceCreateFormValues,
  WorkspaceCreateManifestState,
} from './workspace-create-helpers.ts';

interface WorkspaceCreateSummaryPanelProps {
  form: FormInstance<WorkspaceCreateFormValues>;
  uploadFiles: UploadFile[];
  manifestState: WorkspaceCreateManifestState;
  submitting: boolean;
}

export function WorkspaceCreateSummaryPanel({
  form,
  uploadFiles,
  manifestState,
  submitting,
}: WorkspaceCreateSummaryPanelProps) {
  return (
    <Form.Item shouldUpdate noStyle>
      {() => {
        const values = form.getFieldsValue();
        const selectedFile = uploadFiles[0];
        const canSubmit = Boolean(selectedFile) && manifestState.isValid && !submitting;

        return (
          <Card
            size="small"
            title="创建摘要"
            className="workspace-create-summary-card"
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {!selectedFile ? (
                <Alert
                  showIcon
                  type="warning"
                  message="还没有选择 ZIP 文件"
                  description="上传文件后才能开始创建工作区。"
                />
              ) : null}
              {!manifestState.isValid ? (
                <Alert
                  showIcon
                  type="error"
                  message="Manifest JSON 无法通过校验"
                  description="修复 JSON 后再提交，避免后端在创建时直接失败。"
                />
              ) : null}
              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label="项目名称">
                  {String(values.projectName ?? '').trim() || '未填写'}
                </Descriptions.Item>
                <Descriptions.Item label="导入文件">
                  {selectedFile?.name ?? '未选择'}
                </Descriptions.Item>
                <Descriptions.Item label="导入 Pattern">
                  {String(values.importPattern ?? '').trim() || '未填写'}
                </Descriptions.Item>
                <Descriptions.Item label="翻译器">
                  {String(values.translatorName ?? '').trim() || '未选择'}
                </Descriptions.Item>
                <Descriptions.Item label="文本切分长度">
                  {values.textSplitMaxChars ?? 2000}
                </Descriptions.Item>
                <Descriptions.Item label="Manifest">
                  {manifestState.hasValue ? (
                    <Space wrap size={[6, 6]}>
                      <Tag color={manifestState.isValid ? 'blue' : 'error'}>
                        {manifestState.isValid ? '已启用' : '无效'}
                      </Tag>
                      {manifestState.overrideKeys.length > 0 ? (
                        <Typography.Text type="secondary">
                          覆盖 {manifestState.overrideKeys.length} 项设置
                        </Typography.Text>
                      ) : (
                        <Typography.Text type="secondary">
                          无覆盖字段
                        </Typography.Text>
                      )}
                    </Space>
                  ) : (
                    '未提供'
                  )}
                </Descriptions.Item>
              </Descriptions>
              <Typography.Text type="secondary">
                创建后将自动打开新工作区，并刷新当前项目视图与最近工作区列表。
              </Typography.Text>
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={submitting}
                disabled={!canSubmit}
              >
                创建并打开工作区
              </Button>
            </Space>
          </Card>
        );
      }}
    </Form.Item>
  );
}
