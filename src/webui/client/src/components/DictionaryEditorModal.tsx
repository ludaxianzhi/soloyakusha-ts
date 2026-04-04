import { Form, Input, Modal, Select } from 'antd';
import type { FormInstance } from 'antd';
import type { GlossaryTerm } from '../app/types.ts';

const { TextArea } = Input;

interface DictionaryEditorModalProps {
  open: boolean;
  editingTerm: GlossaryTerm | null;
  form: FormInstance<Record<string, unknown>>;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
}

export function DictionaryEditorModal({
  open,
  editingTerm,
  form,
  onCancel,
  onSubmit,
}: DictionaryEditorModalProps) {
  return (
    <Modal
      title={editingTerm ? '编辑术语条目' : '新建术语条目'}
      open={open}
      onCancel={onCancel}
      onOk={() => void form.submit()}
    >
      <Form
        form={form}
        layout="vertical"
        className="compact-form"
        onFinish={(values) => void onSubmit(values)}
      >
        <Form.Item name="originalTerm" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="term" label="术语" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="translation" label="译文">
          <Input />
        </Form.Item>
        <Form.Item name="category" label="类别">
          <Select
            allowClear
            options={[
              { label: 'personName', value: 'personName' },
              { label: 'placeName', value: 'placeName' },
              { label: 'properNoun', value: 'properNoun' },
              { label: 'personTitle', value: 'personTitle' },
              { label: 'catchphrase', value: 'catchphrase' },
            ]}
          />
        </Form.Item>
        <Form.Item name="status" label="状态">
          <Select
            allowClear
            options={[
              { label: 'translated', value: 'translated' },
              { label: 'untranslated', value: 'untranslated' },
            ]}
          />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <TextArea rows={4} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
