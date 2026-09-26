import type { MetricDef, Severity } from './types'

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

/** 按严重度排序（高→低），返回新数组，不修改入参 */
export function sortConclusions<T extends { severity: Severity }>(conclusions: T[]): T[] {
  return [...conclusions].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

export function formatMetricValue(def: MetricDef, value: number): string {
  switch (def.format) {
    case 'percent':
      return `${(value * 100).toFixed(1)}%`
    case 'currency':
      return `¥${new Intl.NumberFormat('zh-CN').format(value)}`
    case 'x':
      // 最多 2 位小数并去掉尾零：ROI 2.1 → '2.1'，0.72 → '0.72'（与叙述精度一致）
      return value.toFixed(2).replace(/\.?0+$/, '')
    case 'number':
      return new Intl.NumberFormat('zh-CN').format(value)
  }
}

/** 偏离量（万元，带符号）：+442 万 / -268 万 */
export function formatWanDelta(v: number): string {
  return `${v >= 0 ? '+' : '-'}${Math.round(Math.abs(v) / 10000).toLocaleString('zh-CN')} 万`
}

/** 存量水平值（万元，无符号——正负号只属于偏离语义）：1,169 万 */
export function formatWanLevel(v: number): string {
  return `${Math.round(Math.abs(v) / 10000).toLocaleString('zh-CN')} 万`
}

/** 带符号百分比（1 位小数）：+37.8% / -5.9% */
export function formatPctDelta(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}
