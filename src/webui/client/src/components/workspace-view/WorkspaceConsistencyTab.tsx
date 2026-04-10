import { useState } from 'react';
import { Card, Tabs } from 'antd';
import type { RepetitionPatternAnalysisResult } from '../../app/types.ts';
import { WorkspaceRepetitionPatternsTab } from './WorkspaceRepetitionPatternsTab.tsx';

interface WorkspaceConsistencyTabProps {
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

export function WorkspaceConsistencyTab({
  active,
  repeatedPatterns,
  onRefreshRepeatedPatterns,
  onSaveRepeatedPatternTranslation,
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
                onRefreshRepeatedPatterns={onRefreshRepeatedPatterns}
                onSaveRepeatedPatternTranslation={onSaveRepeatedPatternTranslation}
              />
            ),
          },
        ]}
      />
    </Card>
  );
}
