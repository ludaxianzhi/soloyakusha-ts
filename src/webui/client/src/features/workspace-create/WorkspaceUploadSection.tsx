import { Button, Card, Descriptions, Form, Space, Typography, Upload } from 'antd';
import type { UploadFile } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';

interface WorkspaceUploadSectionProps {
  uploadFiles: UploadFile[];
  disabled?: boolean;
  onUploadFilesChange: (files: UploadFile[]) => void;
  onClearUpload: () => void;
}

export function WorkspaceUploadSection({
  uploadFiles,
  disabled,
  onUploadFilesChange,
  onClearUpload,
}: WorkspaceUploadSectionProps) {
  const activeFile = uploadFiles[0];

  return (
    <Card
      size="small"
      title="上传压缩包"
      extra={
        activeFile ? (
          <Button size="small" onClick={onClearUpload} disabled={disabled}>
            清空文件
          </Button>
        ) : null
      }
    >
      <Form.Item
        label="项目压缩包"
        required
        validateStatus={activeFile ? undefined : 'warning'}
        help={activeFile ? 'ZIP 将被解压到新的托管工作区目录。' : '请先选择一个 ZIP 文件。'}
      >
        <Upload.Dragger
          accept=".zip"
          beforeUpload={() => false}
          maxCount={1}
          disabled={disabled}
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

      {activeFile ? (
        <Descriptions
          bordered
          size="small"
          column={1}
          className="workspace-create-file-summary"
        >
          <Descriptions.Item label="文件名">{activeFile.name}</Descriptions.Item>
          <Descriptions.Item label="大小">
            {formatFileSize(activeFile.size)}
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            <Space size={4}>
              <Typography.Text strong>已选择</Typography.Text>
              <Typography.Text type="secondary">再次上传会自动替换当前文件</Typography.Text>
            </Space>
          </Descriptions.Item>
        </Descriptions>
      ) : null}
    </Card>
  );
}

function formatFileSize(size?: number) {
  if (!size || size <= 0) {
    return '未知';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
