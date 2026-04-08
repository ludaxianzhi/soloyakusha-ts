import { Alert, Card, Col, Form, Input, InputNumber, Row, Select } from 'antd';
import {
  DEFAULT_ARCHIVE_IMPORT_PATTERN,
  IMPORT_FORMAT_OPTIONS,
} from '../../app/ui-helpers.ts';

export function WorkspaceImportOptionsSection() {
  return (
    <Card size="small" title="导入策略">
      <Alert
        showIcon
        type="info"
        style={{ marginBottom: 12 }}
        message="导入时会先扫描 ZIP 内文本，再决定如何切分章节与片段。"
        description="如果检测到已有译文，系统会先询问是否保留这些译文；如果 Pattern 没有匹配到文件，则创建会被中止。"
      />
      <Row gutter={12}>
        <Col xs={24} md={10}>
          <Form.Item label="默认导入格式" name="importFormat">
            <Select options={IMPORT_FORMAT_OPTIONS} />
          </Form.Item>
        </Col>
        <Col xs={24} md={14}>
          <Form.Item
            label="ZIP 内导入 Pattern"
            name="importPattern"
            rules={[{ required: true, message: '请输入 ZIP 内导入 Pattern' }]}
            extra="使用 glob 模式匹配 ZIP 解压后的章节文件，例如 scenario/**/*.txt。"
          >
            <Input placeholder={DEFAULT_ARCHIVE_IMPORT_PATTERN} />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item
        label="文本切分长度"
        name="textSplitMaxChars"
        rules={[{ required: true, message: '请输入文本切分长度' }]}
        extra="按原文字符数切分文本块，默认 2000。只有整块全部行都有译文时，才会按已翻译导入。"
      >
        <InputNumber min={1} precision={0} style={{ width: '100%' }} />
      </Form.Item>
    </Card>
  );
}
