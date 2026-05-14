import { useCallback, useEffect, useState } from 'react';
import { Checkbox, Form, Input, InputNumber, Select, Space, Typography } from 'antd';
import { api } from '../../app/api.ts';

export interface ParamDef {
  key: string;
  label: string;
  type: string;
  defaultValue?: unknown;
  options?: { label: string; value: string }[];
  description?: string;
  required?: boolean;
}

export function useFormatParams(formatName: string, mode: 'import' | 'export') {
  const [paramDefs, setParamDefs] = useState<ParamDef[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!formatName) {
      setParamDefs([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.getFormatParams(formatName, mode)
      .then((result) => {
        if (!cancelled) {
          setParamDefs(result.params);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setParamDefs([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [formatName, mode]);

  const buildParams = useCallback(
    (values: Record<string, unknown>): Record<string, unknown> => {
      const params: Record<string, unknown> = {};
      for (const def of paramDefs) {
        const val = values[def.key] ?? def.defaultValue;
        if (val !== undefined && val !== null) {
          params[def.key] = val;
        }
      }
      return params;
    },
    [paramDefs],
  );

  return { paramDefs, loading, buildParams };
}

export function FormatParamFields({
  paramDefs,
  values,
  onChange,
}: {
  paramDefs: ParamDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {paramDefs.map((def) => (
        <div key={def.key}>
          {def.type === 'boolean' ? (
            <Checkbox
              checked={Boolean(values[def.key] ?? def.defaultValue ?? false)}
              onChange={(e) => onChange(def.key, e.target.checked)}
            >
              <Space size={4}>
                <span>{def.label}</span>
                {def.description ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {def.description}
                  </Typography.Text>
                ) : null}
              </Space>
            </Checkbox>
          ) : def.type === 'select' ? (
            <Form.Item label={def.label}>
              <Select
                value={String(values[def.key] ?? def.defaultValue ?? '')}
                onChange={(val) => onChange(def.key, val)}
                options={def.options ?? []}
              />
            </Form.Item>
          ) : def.type === 'number' ? (
            <Form.Item label={def.label}>
              <InputNumber
                value={Number(values[def.key] ?? def.defaultValue ?? 0)}
                onChange={(val) => onChange(def.key, val)}
                style={{ width: '100%' }}
              />
            </Form.Item>
          ) : (
            <Form.Item label={def.label}>
              <Input
                value={String(values[def.key] ?? def.defaultValue ?? '')}
                onChange={(e) => onChange(def.key, e.target.value)}
              />
            </Form.Item>
          )}
        </div>
      ))}
    </Space>
  );
}
