import { useCallback, useState } from 'react';
import { App as AntdApp, Form } from 'antd';
import type { UploadFile } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from '../../app/api.ts';
import { toErrorMessage } from '../../app/ui-helpers.ts';
import {
  getWorkspaceTranslationChoiceError,
  type WorkspaceCreateFormValues,
  type WorkspaceTranslationChoiceError,
  type WorkspaceTranslationImportMode,
} from './workspace-create-helpers.ts';

interface UseWorkspaceCreateControllerOptions {
  onRefreshBootData: () => Promise<void>;
  onRefreshProjectData: () => Promise<void>;
}

export function useWorkspaceCreateController({
  onRefreshBootData,
  onRefreshProjectData,
}: UseWorkspaceCreateControllerOptions) {
  const { message, modal } = AntdApp.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<WorkspaceCreateFormValues>();
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const handleUploadFilesChange = useCallback((files: UploadFile[]) => {
    setUploadFiles(files.slice(-1));
  }, []);

  const handleClearUpload = useCallback(() => {
    setUploadFiles([]);
  }, []);

  const requestTranslationImportMode = useCallback(
    async (
      choiceError: WorkspaceTranslationChoiceError,
    ): Promise<WorkspaceTranslationImportMode> =>
      new Promise((resolve) => {
        const translatedFileCount = choiceError.translatedFileCount ?? 0;
        const translatedUnitCount = choiceError.translatedUnitCount ?? 0;
        modal.confirm({
          title: '检测到已翻译内容',
          content: `检测到 ${translatedFileCount} 个文件中存在 ${translatedUnitCount} 行译文。请选择导入译文，或只导入原文并清空未完整翻译文本块里的这些译文。`,
          okText: '导入译文',
          cancelText: '只导入原文',
          closable: false,
          maskClosable: false,
          onOk: () => resolve('with-translation'),
          onCancel: () => resolve('source-only'),
        });
      }),
    [modal],
  );

  const handleSubmit = useCallback(
    async (values: WorkspaceCreateFormValues) => {
      const file = uploadFiles[0]?.originFileObj;
      if (!file) {
        message.error('请先选择 ZIP 文件');
        return;
      }

      setSubmitting(true);
      try {
        const submitWorkspaceCreate = async (
          translationImportMode?: WorkspaceTranslationImportMode,
        ) => {
          const formData = new FormData();
          formData.set('file', file);
          formData.set('projectName', String(values.projectName ?? ''));
          if (values.importFormat) {
            formData.set('importFormat', String(values.importFormat));
          }
          if (values.importPattern) {
            formData.set('importPattern', String(values.importPattern));
          }
          if (values.translatorName) {
            formData.set('translatorName', String(values.translatorName));
          }
          if (values.textSplitMaxChars !== undefined && values.textSplitMaxChars !== null) {
            formData.set('textSplitMaxChars', String(values.textSplitMaxChars));
          }
          if (values.manifestJson) {
            formData.set('manifestJson', String(values.manifestJson));
          }
          if (translationImportMode) {
            formData.set('translationImportMode', translationImportMode);
          }
          await api.createWorkspace(formData);
        };

        try {
          await submitWorkspaceCreate();
        } catch (error) {
          const choiceError = getWorkspaceTranslationChoiceError(error);
          if (!choiceError) {
            throw error;
          }
          const translationImportMode = await requestTranslationImportMode(choiceError);
          await submitWorkspaceCreate(translationImportMode);
        }

        setUploadFiles([]);
        form.resetFields(['manifestJson']);
        await onRefreshBootData();
        await onRefreshProjectData();
        navigate('/workspace/current');
        message.success('工作区已创建并打开');
      } catch (error) {
        message.error(toErrorMessage(error));
      } finally {
        setSubmitting(false);
      }
    },
    [
      form,
      message,
      navigate,
      onRefreshBootData,
      onRefreshProjectData,
      requestTranslationImportMode,
      uploadFiles,
    ],
  );

  return {
    form,
    uploadFiles,
    submitting,
    onUploadFilesChange: handleUploadFilesChange,
    onClearUpload: handleClearUpload,
    onSubmit: handleSubmit,
  };
}
