export type ScreenName =
  | 'main-menu'
  | 'workspace-menu'
  | 'workspace-create'
  | 'workspace-import'
  | 'workspace-config'
  | 'workspace-sort'
  | 'settings-menu'
  | 'settings-llm'
  | 'settings-translator';

export interface LogEntry {
  id: number;
  level: 'error' | 'warning';
  message: string;
  timestamp: Date;
}

export interface SelectItem<T extends string = string> {
  label: string;
  value: T;
}

export interface FormFieldDef {
  key: string;
  label: string;
  type: 'text' | 'select';
  placeholder?: string;
  options?: SelectItem[];
  defaultValue?: string;
}

/** 翻译器类型注册表条目 */
export interface TranslatorTypeDef {
  name: string;
  label: string;
  fields: FormFieldDef[];
}
