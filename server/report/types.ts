/** 会员周报领域类型（server 侧解析产物，同比一律由 current/previous 重算） */
export type MetricKey =
  | 'memberSales'
  | 'memberBuyers'
  | 'memberNewCards'
  | 'totalSales'
  | 'newMemberBuyers'
  | 'newMemberRepeat'

export interface MetricValue {
  current: number
  previous: number
}

export interface ChannelRow {
  brand: string
  /** 运营模式：加盟 / 直营（归因必须带，双主体同名渠道会互相抵消） */
  mode: string
  /** 一级渠道（大区） */
  region: string
  /** 二级渠道（分公司 / 加盟主体） */
  channel: string
  metrics: Record<MetricKey, MetricValue>
}

export interface WeeklyReport {
  /** 期次（从文件名提取的 YYYY-MM-DD） */
  period: string
  rows: ChannelRow[]
}

/** 同比（%），由本期/同期重算——源表声明列不可信（走查实证 1/132 错误）。
 *  同期为 0（新渠道无基数）返回 null：同比无定义，叙述须写「同期无基数」而非除零。 */
export function yoy(metric: MetricValue): number | null {
  if (metric.previous === 0) return null
  return ((metric.current - metric.previous) / metric.previous) * 100
}
