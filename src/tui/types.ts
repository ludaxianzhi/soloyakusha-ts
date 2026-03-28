export type ScreenName =
  | 'main-menu'
  | 'workspace-menu'
  | 'workspace-ops'
  | 'workspace-create'
  | 'workspace-progress'
  | 'workspace-dictionary'
  | 'workspace-history'
  | 'workspace-import'
  | 'workspace-export'
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

export interface AutocompleteItem {
  label: string;
  value: string;
  meta?: string;
}

export interface FormAutocompleteDef {
  maxItems?: number;
  showWhenEmpty?: boolean;
  getSuggestions: (
    input: string,
    values: Record<string, string>,
  ) => Promise<AutocompleteItem[]> | AutocompleteItem[];
}

export interface FormFieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'autocomplete';
  placeholder?: string;
  options?: SelectItem[];
  defaultValue?: string;
  description?: string;
  autocomplete?: FormAutocompleteDef;
}

/** 翻译器类型注册表条目 */
export interface TranslatorTypeDef {
  name: string;
  label: string;
  fields: FormFieldDef[];
}
