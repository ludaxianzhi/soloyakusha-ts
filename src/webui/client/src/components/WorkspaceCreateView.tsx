import { Button, Card, Collapse, Form, Input, Select, Upload } from 'antd';
import type { FormInstance, UploadFile } from 'antd';
import { CloudUploadOutlined, FileZipOutlined } from '@ant-design/icons';
import {
  DEFAULT_ARCHIVE_IMPORT_PATTERN,
  DEFAULT_LANGUAGE_PAIR,
  IMPORT_FORMAT_OPTIONS,
  LANGUAGE_PAIR_OPTIONS,
} from '../app/ui-helpers.ts';

const { TextArea } = Input;

interface WorkspaceCreateViewProps {
  uploadForm: FormInstance<Record<string, unknown>>;
  uploadFiles: UploadFile[];
  translatorOptions: Array<{ label: string; value: string }>;
  onUploadFilesChange: (files: UploadFile[]) => void;
  onUploadSubmit: (values: Record<string, unknown>) => void | Promise<void>;
}

export function WorkspaceCreateView({
  uploadForm,
  uploadFiles,
  translatorOptions,
  onUploadFilesChange,
  onUploadSubmit,
}: WorkspaceCreateViewProps) {
  return (
    <Card
      title={
        <>
          <FileZipOutlined style={{ marginRight: 8 }} />
          上传压缩包创建工作区
        </>
      }
      extra="ZIP 导入"
    >
      <Form
        form={uploadForm}
        layout="vertical"
        className="compact-form"
        initialValues={{
          projectName: '新建项目',
          importPattern: DEFAULT_ARCHIVE_IMPORT_PATTERN,
          languagePair: DEFAULT_LANGUAGE_PAIR,
        }}
        onFinish={(values) => void onUploadSubmit(values)}
      >
        <Form.Item
          label="项目名称"
          name="projectName"
          rules={[{ required: true, message: '请输入项目名称' }]}
        >
          <Input placeholder="例如：某轻小说项目" />
        </Form.Item>
        <Form.Item label="默认导入格式" name="importFormat">
          <Select options={IMPORT_FORMAT_OPTIONS} />
        </Form.Item>
        <Form.Item
          label="ZIP 内导入 Pattern"
          name="importPattern"
          rules={[{ required: true, message: '请输入 ZIP 内导入 Pattern' }]}
          extra="使用 glob 模式匹配 ZIP 解压后的章节文件，例如 scenario/**/*.txt。"
        >
          <Input placeholder={DEFAULT_ARCHIVE_IMPORT_PATTERN} />
        </Form.Item>
        <Form.Item label="默认翻译器" name="translatorName">
          <Select
            allowClear
            options={translatorOptions}
            placeholder="使用全局默认翻译器"
          />
        </Form.Item>
        <Form.Item
          label="语言对"
          name="languagePair"
          extra="当前前端按硬编码语言对限制为日语 -> 简体中文。"
        >
          <Select options={LANGUAGE_PAIR_OPTIONS} />
        </Form.Item>
        <Form.Item label="项目压缩包">
          <Upload.Dragger
            accept=".zip"
            beforeUpload={() => false}
            maxCount={1}
            fileList={uploadFiles}
            onChange={({ fileList }) => onUploadFilesChange(fileList.slice(-1))}
          >
            <p className="ant-upload-drag-icon">
              <CloudUploadOutlined />
            </p>
            <p>拖入或点击上传 ZIP</p>
            <span className="upload-hint">导入后工作区将由程序托管到独立目录中</span>
          </Upload.Dragger>
        </Form.Item>
        <Collapse
          items={[
            {
              key: 'manifest',
              label: '高级：导入 Manifest JSON',
              children: (
                <Form.Item
                  label="Manifest JSON"
                  name="manifestJson"
                  extra="可选，用于指定 chapterPaths / branches / glossaryPath 等高级导入配置。"
                >
                  <TextArea rows={8} placeholder='{"chapterPaths":["..."]}' />
                </Form.Item>
              ),
            },
          ]}
        />
        <Button type="primary" htmlType="submit" block>
          创建并打开工作区
        </Button>
      </Form>
    </Card>
  );
}
