import { Alert, Card, Col, Form, Row, Select } from 'antd';
import { Input } from 'antd';
import { FileZipOutlined } from '@ant-design/icons';
import { LANGUAGE_PAIR_OPTIONS } from '../../app/ui-helpers.ts';

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
          description="你仍然可以创建工作区，后续再到“设置”中补充翻译器配置。"
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
          <Form.Item label="默认翻译器" name="translatorName">
            <Select
              allowClear
              options={translatorOptions}
              placeholder={
                translatorOptions.length > 0 ? '使用全局默认翻译器' : '暂无可选翻译器'
              }
            />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item
        label="语言对"
        name="languagePair"
        extra="当前前端按硬编码语言对限制为日语 -> 简体中文。"
      >
        <Select options={LANGUAGE_PAIR_OPTIONS} />
      </Form.Item>
    </Card>
  );
}
