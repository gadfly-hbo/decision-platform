/** 严重度：high = 今天要拍板 / medium = 本周关注 / low = 观察项 */
export type Severity = 'high' | 'medium' | 'low'

/** 行动状态：pending 待定 / accepted 采纳 / rejected 驳回 */
export type ActionStatus = 'pending' | 'accepted' | 'rejected'

/** 指标定义——定义一次、全局引用（指标层原则的最小落地） */
export interface MetricDef {
  id: string
  name: string
  unit: string
  /** 口径说明，看板可直接展示 */
  caliber: string
  format: 'percent' | 'currency' | 'number' | 'x'
}

export interface MetricPoint {
  /** 数据层预生成的日期标签（MM-DD） */
  date: string
  value: number
}

/** 基准/阈值线：threshold 止损线 / target 目标 / comparison 对比期 */
export interface MetricBaseline {
  kind: 'threshold' | 'target' | 'comparison'
  label: string
  value: number
}

export interface MetricSeries {
  metricId: string
  points: MetricPoint[]
  baselines: MetricBaseline[]
}

/** 推导步骤类型：detection 检测 → attribution 归因 → rule 规则匹配 → suggestion 建议 */
export type DerivationKind = 'detection' | 'attribution' | 'rule' | 'suggestion'

export interface DerivationStep {
  kind: DerivationKind
  text: string
}

/** 归因明细行：contribution 为对指标偏离的贡献，正 = 推高，负 = 拉低 */
export interface BreakdownRow {
  dimension: string
  contribution: number
  value: number
  /** 相对变化的展示说明，如 "-38%" */
  delta?: string
}

export interface SuggestedAction {
  id: string
  conclusionId: string
  /** 动作一句话 */
  text: string
  /** 预期影响 */
  impact: string
}

/** 结论（决策卡）：一句话说清什么指标、偏离多少、大概什么原因 */
export interface Conclusion {
  id: string
  severity: Severity
  title: string
  summary: string
  /** 数据窗口，如 '09-12 ~ 09-25' */
  window: string
  updatedAt: string
  metricIds: string[]
  derivation: DerivationStep[]
  breakdown: BreakdownRow[]
  actions: SuggestedAction[]
}

export interface DashboardData {
  title: string
  lede: string
  window: string
  updatedAt: string
  metrics: MetricDef[]
  series: MetricSeries[]
  conclusions: Conclusion[]
  /** true = 演示数据回退（无真实数据或解析失败时置位，前端据此标注） */
  isDemo?: boolean
  /** 数据期次（真实数据来自周报文件名，如 2026-09-26） */
  period?: string
}
