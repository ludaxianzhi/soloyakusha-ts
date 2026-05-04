import { Alert, Button, Card, Form, Input, Space, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import type {
  WorkspaceCreateFormValues,
  WorkspaceCreateManifestState,
} from './workspace-create-helpers.ts';
import {
  WORKSPACE_MANIFEST_EXAMPLE,
  validateManifestJson,
} from './workspace-create-helpers.ts';

const { TextArea } = Input;

interface WorkspaceManifestSectionProps {
  form: FormInstance<WorkspaceCreateFormValues>;
  manifestState: WorkspaceCreateManifestState;
}

export function WorkspaceManifestSection({
  form,
  manifestState,
}: WorkspaceManifestSectionProps) {
  return (
    <Card
      size="small"
      title="高级配置 / Manifest"
      extra={
        <Button
          size="small"
          onClick={() => form.setFieldValue('manifestJson', WORKSPACE_MANIFEST_EXAMPLE)}
        >
          填入示例
        </Button>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          showIcon
          type={manifestState.isValid ? 'info' : 'error'}
          message={
            manifestState.isValid
              ? 'Manifest 中的同名字段会覆盖表单中的默认值。'
              : 'Manifest JSON 解析失败'
          }
          description={
            manifestState.isValid
              ? '可选字段包括 chapterPaths / branches / glossaryPath / textSplitMaxChars / batchFragmentCount / translationImportMode 等。'
              : manifestState.error
          }
        />
        <Form.Item
          label="Manifest JSON"
          name="manifestJson"
          rules={[{ validator: (_, value) => validateManifestJson(value) }]}
          extra="适合放置 chapterPaths、branches、glossaryPath 等高级导入配置。"
        >
          <TextArea rows={10} placeholder={WORKSPACE_MANIFEST_EXAMPLE} />
        </Form.Item>
        {manifestState.overrideKeys.length > 0 ? (
          <div>
            <Typography.Text type="secondary">将覆盖表单设置的字段：</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Space wrap size={[6, 6]}>
                {manifestState.overrideKeys.map((key) => (
                  <Tag key={key}>{key}</Tag>
                ))}
              </Space>
            </div>
          </div>
        ) : null}
      </Space>
    </Card>
  );
}
