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
