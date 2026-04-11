import { useState } from 'react';
import { Card, Tabs } from 'antd';
import type {
  RepetitionPatternAnalysisResult,
  RepetitionPatternConsistencyFixProgress,
  RepetitionPatternContextResult,
} from '../../app/types.ts';
import { WorkspaceRepetitionPatternsTab } from './WorkspaceRepetitionPatternsTab.tsx';

interface WorkspaceConsistencyTabProps {
  active: boolean;
  repeatedPatterns: RepetitionPatternAnalysisResult | null;
  llmProfileOptions: Array<{ label: string; value: string }>;
  defaultLlmProfileName?: string;
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
  onLoadRepeatedPatternContext: (input: {
    chapterId: number;
    unitIndex: number;
  }) => Promise<RepetitionPatternContextResult>;
  onRefreshProjectStatus: () => void | Promise<void>;
  onStartRepeatedPatternConsistencyFix: (input: {
    llmProfileName: string;
    minOccurrences?: number;
    minLength?: number;
    maxResults?: number;
  }) => Promise<RepetitionPatternConsistencyFixProgress>;
  onGetRepeatedPatternConsistencyFixStatus: () => Promise<RepetitionPatternConsistencyFixProgress | null>;
  onClearRepeatedPatternConsistencyFixStatus: () => Promise<void>;
}

export function WorkspaceConsistencyTab({
  active,
  repeatedPatterns,
  llmProfileOptions,
  defaultLlmProfileName,
  onRefreshRepeatedPatterns,
  onSaveRepeatedPatternTranslation,
  onLoadRepeatedPatternContext,
  onRefreshProjectStatus,
  onStartRepeatedPatternConsistencyFix,
  onGetRepeatedPatternConsistencyFixStatus,
  onClearRepeatedPatternConsistencyFixStatus,
}: WorkspaceConsistencyTabProps) {
  const [activeSubTabKey, setActiveSubTabKey] = useState('repetition-patterns');

  return (
    <Card title="一致性分析">
      <Tabs
        size="small"
        activeKey={activeSubTabKey}
        onChange={setActiveSubTabKey}
        items={[
          {
            key: 'repetition-patterns',
            label: '重复 Pattern 分析',
            children: (
              <WorkspaceRepetitionPatternsTab
                active={active && activeSubTabKey === 'repetition-patterns'}
                repeatedPatterns={repeatedPatterns}
                llmProfileOptions={llmProfileOptions}
                defaultLlmProfileName={defaultLlmProfileName}
                onRefreshRepeatedPatterns={onRefreshRepeatedPatterns}
                onSaveRepeatedPatternTranslation={onSaveRepeatedPatternTranslation}
                onLoadRepeatedPatternContext={onLoadRepeatedPatternContext}
                onRefreshProjectStatus={onRefreshProjectStatus}
                onStartRepeatedPatternConsistencyFix={onStartRepeatedPatternConsistencyFix}
                onGetRepeatedPatternConsistencyFixStatus={onGetRepeatedPatternConsistencyFixStatus}
                onClearRepeatedPatternConsistencyFixStatus={onClearRepeatedPatternConsistencyFixStatus}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}
