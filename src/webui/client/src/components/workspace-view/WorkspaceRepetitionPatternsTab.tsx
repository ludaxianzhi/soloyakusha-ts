import { useMemo, useState } from 'react';
import { BranchesOutlined } from '@ant-design/icons';
import {
  App as AntdApp,
  Button,
  Input,
  Empty,
  InputNumber,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { RepetitionPatternAnalysisResult, RepetitionPatternLocation } from '../../app/types.ts';

const { TextArea } = Input;

interface WorkspaceRepetitionPatternsTabProps {
  active: boolean;
  repeatedPatterns: RepetitionPatternAnalysisResult | null;
  onRefreshRepeatedPatterns: (options?: {
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  }) => Promise<RepetitionPatternAnalysisResult | null>;
  onSaveRepeatedPatternTranslation: (input: {
    chapterId: number;
    fragmentIndex: number;
    lineIndex: number;
    translation: string;
  }) => Promise<void>;
}

export function WorkspaceRepetitionPatternsTab({
  repeatedPatterns,
  onRefreshRepeatedPatterns,
  onSaveRepeatedPatternTranslation,
}: WorkspaceRepetitionPatternsTabProps) {
  const { message } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);
  const [savingLineKey, setSavingLineKey] = useState<string | null>(null);
  const [draftTranslations, setDraftTranslations] = useState<Record<string, string>>({});
  const [minOccurrences, setMinOccurrences] = useState(3);
  const [minLength, setMinLength] = useState(8);
  const [maxResults, setMaxResults] = useState(20);

  const refresh = async () => {
    setLoading(true);
    try {
      await onRefreshRepeatedPatterns({
        minOccurrences,
        minLength,
        maxResults,
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const translationsByLineKey = useMemo(() => {
    const mapping: Record<string, string> = {};
    for (const pattern of repeatedPatterns?.patterns ?? []) {
      for (const location of pattern.locations) {
        mapping[buildEditableLineKey(location)] = location.translatedSentence;
      }
    }
    return mapping;
  }, [repeatedPatterns]);

  const readDraftTranslation = (location: RepetitionPatternLocation) =>
    draftTranslations[buildEditableLineKey(location)] ??
    translationsByLineKey[buildEditableLineKey(location)] ??
    '';

  const handleSave = async (location: RepetitionPatternLocation) => {
    const lineKey = buildEditableLineKey(location);
    const translation = readDraftTranslation(location);
    setSavingLineKey(lineKey);
    try {
      await onSaveRepeatedPatternTranslation({
        chapterId: location.chapterId,
        fragmentIndex: location.fragmentIndex,
        lineIndex: location.lineIndex,
        translation,
      });
      setDraftTranslations((prev) => {
        const next = { ...prev };
        delete next[lineKey];
        return next;
      });
      await refresh();
      message.success('译文已保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingLineKey(null);
    }
  };

  return (
    <div className="section-stack">
      <Space wrap>
        <Space>
          <BranchesOutlined />
          <Typography.Text strong>重复 Pattern 发现</Typography.Text>
        </Space>
        <span>最少出现</span>
        <InputNumber
          min={2}
          value={minOccurrences}
          onChange={(value) => setMinOccurrences(Number(value ?? 3))}
        />
        <span>最短长度</span>
        <InputNumber min={2} value={minLength} onChange={(value) => setMinLength(Number(value ?? 8))} />
        <span>结果上限</span>
        <InputNumber min={1} value={maxResults} onChange={(value) => setMaxResults(Number(value ?? 20))} />
        <Button type="primary" loading={loading} onClick={() => void refresh()}>
          {repeatedPatterns ? '重新分析' : '开始分析'}
        </Button>
      </Space>
      {repeatedPatterns?.patterns.length ? (
        <div className="section-stack">
          <Typography.Text type="secondary">
            共扫描 {repeatedPatterns.totalSentenceCount} 句，发现 {repeatedPatterns.patterns.length} 个重复
            Pattern。
          </Typography.Text>
          <Table
            rowKey="text"
            dataSource={repeatedPatterns.patterns}
            pagination={{ pageSize: 10 }}
            expandable={{
              expandedRowRender: (record) => (
                <div className="section-stack">
                  <div>
                    <Typography.Text strong>译文分布</Typography.Text>
                    <div style={{ marginTop: 8 }}>
                      <Space wrap>
                        {record.translations.map((variant) => (
                          <Tag key={`${record.text}-${variant.normalizedText || '(empty)'}`}>
                            {variant.text || '(未翻译)'} x {variant.count}
                          </Tag>
                        ))}
                      </Space>
                    </div>
                  </div>
                  <div>
                    <Typography.Text strong>命中位置</Typography.Text>
                    <Table
                      size="small"
                      scroll={{ x: 980 }}
                      rowKey={(location) =>
                        `${record.text}-${location.chapterId}-${location.unitIndex}-${location.globalStartIndex}`
                      }
                      pagination={false}
                      dataSource={record.locations}
                      columns={[
                        {
                          title: '位置',
                          width: 120,
                          render: (_, location) =>
                            `章节 ${location.chapterId} / 句 ${location.unitIndex + 1}`,
                        },
                        {
                          title: '原文整句',
                          dataIndex: 'sourceSentence',
                          width: 260,
                        },
                        {
                          title: '译文',
                          width: 420,
                          render: (_, location) => {
                            const lineKey = buildEditableLineKey(location);
                            return (
                              <TextArea
                                autoSize={{ minRows: 1, maxRows: 4 }}
                                value={readDraftTranslation(location)}
                                placeholder="输入或修改译文"
                                onChange={(event) =>
                                  setDraftTranslations((prev) => ({
                                    ...prev,
                                    [lineKey]: event.target.value,
                                  }))
                                }
                              />
                            );
                          },
                        },
                        {
                          title: '句内区间',
                          width: 140,
                          render: (_, location) =>
                            `${location.matchStartInSentence}-${location.matchEndInSentence}`,
                        },
                        {
                          title: '操作',
                          width: 100,
                          render: (_, location) => {
                            const lineKey = buildEditableLineKey(location);
                            return (
                              <Button
                                type="link"
                                loading={savingLineKey === lineKey}
                                disabled={readDraftTranslation(location) === location.translatedSentence}
                                onClick={() => void handleSave(location)}
                              >
                                保存
                              </Button>
                            );
                          },
                        },
                      ]}
                    />
                  </div>
                </div>
              ),
            }}
            columns={[
              { title: 'Pattern', dataIndex: 'text' },
              { title: '长度', dataIndex: 'length', width: 90 },
              { title: '出现次数', dataIndex: 'occurrenceCount', width: 100 },
              {
                title: '译文状态',
                width: 120,
                render: (_, record) => (
                  <Tag color={record.isTranslationConsistent ? 'green' : 'gold'}>
                    {record.isTranslationConsistent ? '统一' : '不统一'}
                  </Tag>
                ),
              },
              {
              title: '译法数量',
              width: 100,
              render: (_, record) => record.translations.length,
            },
          ]}
          />
        </div>
      ) : (
        <Empty
          description={
            repeatedPatterns
              ? '当前阈值下没有发现可用的重复 Pattern'
              : '点击“开始分析”后查看重复 Pattern、命中位置和译文一致性'
          }
        />
      )}
    </div>
  );
}

function buildEditableLineKey(location: RepetitionPatternLocation): string {
  return `${location.chapterId}-${location.fragmentIndex}-${location.lineIndex}`;
}
