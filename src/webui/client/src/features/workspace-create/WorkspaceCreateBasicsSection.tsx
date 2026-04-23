import { Alert, Card, Col, Form, Row, Select } from 'antd';
import { Input } from 'antd';
import { FileZipOutlined } from '@ant-design/icons';
import { WORKSPACE_PIPELINE_STRATEGY_OPTIONS } from '../../app/ui-helpers.ts';

interface WorkspaceCreateBasicsSectionProps {
  translatorOptions: Array<{ label: string; value: string }>;
}

export function WorkspaceCreateBasicsSection({
  translatorOptions,
}: WorkspaceCreateBasicsSectionProps) {
  return (
    <Card
      size="small"
      title={
        <>
          <FileZipOutlined style={{ marginRight: 8 }} />
          创建工作区
        </>
      }
      extra="ZIP 导入"
    >
      {translatorOptions.length === 0 ? (
        <Alert
          showIcon
          type="warning"
          style={{ marginBottom: 12 }}
          message="当前没有可选翻译器"
          description="请先到“设置”中创建至少一个翻译器，然后再创建工作区。"
        />
      ) : null}
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Form.Item
            label="项目名称"
            name="projectName"
            rules={[{ required: true, message: '请输入项目名称' }]}
          >
            <Input placeholder="例如：某轻小说项目" />
          </Form.Item>
        </Col>
        <Col xs={24} md={12}>
          <Form.Item
            label="翻译工作流"
            name="pipelineStrategy"
            rules={[{ required: true, message: '请选择翻译工作流' }]}
          >
            <Select options={WORKSPACE_PIPELINE_STRATEGY_OPTIONS} />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={12}>
        <Col xs={24} md={12}>
          <Form.Item
            label="翻译器"
            name="translatorName"
            rules={[{ required: true, message: '请选择翻译器' }]}
          >
            <Select
              options={translatorOptions}
              placeholder={
                translatorOptions.length > 0 ? '请选择翻译器' : '暂无可选翻译器'
              }
            />
          </Form.Item>
        </Col>
      </Row>
    </Card>
  );
}
