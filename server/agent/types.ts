/** 行动项草稿域类型（对齐 pi-xanthil Actions）；证据/枚举类型自 src/data/types 共享 */

import type {
  ActionEvidence,
  ActionLifecycle,
  ActionLevel,
  ActionScene,
} from '../../src/data/types'

export type {
  ActionEvidence,
  ActionEvidenceFact,
  ActionEvidenceLevel,
  ActionScene,
  ActionLifecycle,
  ActionLevel,
} from '../../src/data/types'

export interface ActionItemDraft {
  title: string
  rationale: string
  scene?: ActionScene
  lifecycle?: ActionLifecycle
  expectedImpact: string
  metricRef?: string
  priority: ActionLevel
  effort: ActionLevel
  /** 由证据确定性派生（公式见 normalize.deriveActionConfidence），忽略 LLM 自评 */
  confidence: number
  evidence?: ActionEvidence
}

/** G12 抽取校准上下文：近期驳回理由 + 人工补充方向 */
export interface ExtractionCalibration {
  dismissalReasons: string[]
  manualAdditions: Array<{ title: string; rationale: string }>
}
