import Editor from '@monaco-editor/react';

interface YamlCodeEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  height?: number;
  placeholder?: string;
}

export function YamlCodeEditor({
  value,
  onChange,
  height = 220,
  placeholder,
}: YamlCodeEditorProps) {
  return (
    <div className="yaml-editor-shell">
      <Editor
        height={height}
        defaultLanguage="yaml"
        language="yaml"
        theme="vs-dark"
        value={value ?? ''}
        options={{
          automaticLayout: true,
          fontFamily: 'Cascadia Code, JetBrains Mono, Consolas, monospace',
          fontSize: 13,
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          padding: { top: 12, bottom: 12 },
        }}
        onChange={(nextValue) => onChange?.(nextValue ?? '')}
      />
      {placeholder ? <div className="yaml-editor-hint">示例：{placeholder}</div> : null}
    </div>
  );
}
