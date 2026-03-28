export type ScreenName =
  | 'main-menu'
  | 'workspace-menu'
  | 'workspace-create'
  | 'workspace-progress'
  | 'workspace-dictionary'
  | 'workspace-history'
  | 'workspace-import'
  | 'workspace-config'
  | 'workspace-sort'
  | 'workspace-plot-summary'
  | 'settings-menu'
  | 'settings-llm'
  | 'settings-translator';

export interface LogEntry {
  id: number;
  level: 'error' | 'warning' | 'info' | 'success';
  message: string;
  timestamp: Date;
}

export interface SelectItem<T extends string = string> {
  label: string;
  value: T;
  description?: string;
  meta?: string;
}

export interface FormFieldDef {
  key: string;
  label: string;
  type: 'text' | 'select';
  placeholder?: string;
  options?: SelectItem[];
  defaultValue?: string;
  description?: string;
}

/** 翻译器类型注册表条目 */
export interface TranslatorTypeDef {
  name: string;
  label: string;
  fields: FormFieldDef[];
}
