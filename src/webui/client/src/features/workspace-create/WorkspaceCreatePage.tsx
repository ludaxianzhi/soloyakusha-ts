import { useMemo } from 'react';
import { Alert, Form, Row, Col } from 'antd';
import { FormOutlined } from '@ant-design/icons';
import { WorkspaceCreateBasicsSection } from './WorkspaceCreateBasicsSection.tsx';
import { WorkspaceImportOptionsSection } from './WorkspaceImportOptionsSection.tsx';
import { WorkspaceUploadSection } from './WorkspaceUploadSection.tsx';
import { WorkspaceManifestSection } from './WorkspaceManifestSection.tsx';
import { WorkspaceCreateSummaryPanel } from './WorkspaceCreateSummaryPanel.tsx';
import { useWorkspaceCreateController } from './useWorkspaceCreateController.ts';
import {
  analyzeManifestJson,
  WORKSPACE_CREATE_INITIAL_VALUES,
} from './workspace-create-helpers.ts';

interface WorkspaceCreatePageProps {
  hasActiveWorkspace: boolean;
  translatorOptions: Array<{ label: string; value: string }>;
  onRefreshBootData: () => Promise<void>;
  onRefreshProjectData: () => Promise<void>;
}

export function WorkspaceCreatePage({
  hasActiveWorkspace,
  translatorOptions,
  onRefreshBootData,
  onRefreshProjectData,
}: WorkspaceCreatePageProps) {
  const {
    form,
    uploadFiles,
    submitting,
    onUploadFilesChange,
    onClearUpload,
    onSubmit,
  } = useWorkspaceCreateController({
    onRefreshBootData,
    onRefreshProjectData,
  });
  const manifestJson = Form.useWatch('manifestJson', form);
  const manifestState = useMemo(
    () => analyzeManifestJson(manifestJson),
    [manifestJson],
  );

  return (
    <div className="section-stack">
      <Alert
        showIcon
        type="info"
        icon={<FormOutlined />}
        message="推荐先确认导入格式、Pattern 和切分长度，再上传 ZIP。"
        description="创建流程会优先读取 ZIP 内容；如果 Manifest 中存在同名字段，则会以 Manifest 为准。"
      />
      {hasActiveWorkspace ? (
        <Alert
          showIcon
          type="warning"
          message="当前已有工作区处于打开状态"
          description="创建成功后会自动切换到新工作区，但不会删除当前工作区。"
        />
      ) : null}
      <Form
        form={form}
        layout="vertical"
        className="compact-form"
        initialValues={WORKSPACE_CREATE_INITIAL_VALUES}
        onFinish={(values) => void onSubmit(values)}
      >
        <Row gutter={[12, 12]} align="top">
          <Col xs={24} xl={16}>
            <div className="section-stack">
              <WorkspaceCreateBasicsSection translatorOptions={translatorOptions} />
              <WorkspaceImportOptionsSection />
              <WorkspaceUploadSection
                uploadFiles={uploadFiles}
                disabled={submitting}
                onUploadFilesChange={onUploadFilesChange}
                onClearUpload={onClearUpload}
              />
              <WorkspaceManifestSection form={form} manifestState={manifestState} />
            </div>
          </Col>
          <Col xs={24} xl={8}>
            <WorkspaceCreateSummaryPanel
              form={form}
              uploadFiles={uploadFiles}
              manifestState={manifestState}
              submitting={submitting}
            />
          </Col>
        </Row>
      </Form>
    </div>
  );
}
