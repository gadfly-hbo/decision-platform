import type { ChannelRow, MetricKey, WeeklyReport } from './types'

export { yoy } from './types'

export class ReportParseError extends Error {}

/** CSV 列 → 指标键（每指标取 本期值/同期值 两列，声明同比列不读——一律重算） */
const METRIC_COLUMNS: Array<{ key: MetricKey; prefix: string }> = [
  { key: 'memberSales', prefix: '会员零售额' },
  { key: 'memberBuyers', prefix: '会员购买人数' },
  { key: 'memberNewCards', prefix: '会员开卡人数' },
  { key: 'totalSales', prefix: '零售额' },
  { key: 'newMemberBuyers', prefix: '新会员购买人数' },
  { key: 'newMemberRepeat', prefix: '新会员复购人数' },
]

const DIMENSION_COLUMNS = ['渠道品牌', '运营模式', '一级渠道', '二级渠道'] as const

/** 从文件名提取期次并归一化为 YYYY-MM-DD；兼容 2026-09-26 与 20260926 两种格式；无日期返回 ''（由上层按解析失败处理） */
export function extractPeriod(sourceName: string): string {
  const dashed = sourceName.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (dashed) return dashed.slice(1).join('-')
  const compact = sourceName.match(/\d{8}/)
  if (compact) {
    const raw = compact[0]
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  }
  return ''
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map((cell) => cell.trim())
}

function parseNumber(cell: string, lineNo: number): number {
  if (cell === '') {
    throw new ReportParseError(`第 ${lineNo} 行存在空数值单元格（缺数据须显式处理，不静默置 0）`)
  }
  const value = Number(cell)
  if (!Number.isFinite(value)) {
    throw new ReportParseError(`第 ${lineNo} 行数值单元格无法解析："${cell}"`)
  }
  return value
}

/**
 * 解析会员周报 CSV。容错前导标题行（自动定位以「渠道品牌」开头的表头行）；
 * 缺列/坏数字/空单元格抛 ReportParseError（含 1 起算的文件行号），绝不静默丢数据。
 * period 从 sourceName 文件名日期提取；无日期返回 ''。
 */
export function parseMemberWeeklyCsv(csvText: string, sourceName: string): WeeklyReport {
  // 不预过滤空行：行号必须对应物理行（REVIEW cycle 2），空行在行循环中跳过
  const lines = csvText.split(/\r?\n/)
  if (lines[0]?.startsWith('\uFEFF')) lines[0] = lines[0].slice(1) // Excel 导出常带 BOM
  const headerIdx = lines.findIndex((l) => l.startsWith('渠道品牌'))
  if (headerIdx < 0) {
    throw new ReportParseError('未找到表头行（应以「渠道品牌」开头）')
  }
  const header = splitCsvLine(lines[headerIdx])
  const indexOf = (name: string) => header.indexOf(name)

  const dimIdx = DIMENSION_COLUMNS.map((name) => {
    const i = indexOf(name)
    if (i < 0) throw new ReportParseError(`表头缺少列：${name}`)
    return i
  })
  const metricIdx = METRIC_COLUMNS.map(({ key, prefix }) => {
    const cur = indexOf(`${prefix}本期值`)
    const prev = indexOf(`${prefix}同期值`)
    if (cur < 0 || prev < 0) {
      throw new ReportParseError(`表头缺少指标列：${prefix}本期值/同期值`)
    }
    return { key, cur, prev }
  })

  const rows: ChannelRow[] = []
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    // 多于表头的单元格容忍（导出工具常见尾随逗号）；少于表头才视为坏行
    const cells = splitCsvLine(lines[i])
    const lineNo = i + 1
    if (cells.length < header.length) {
      throw new ReportParseError(`第 ${lineNo} 行列数不足（${cells.length}/${header.length}）`)
    }
    const metrics = {} as ChannelRow['metrics']
    for (const { key, cur, prev } of metricIdx) {
      metrics[key] = {
        current: parseNumber(cells[cur], lineNo),
        previous: parseNumber(cells[prev], lineNo),
      }
    }
    rows.push({
      brand: cells[dimIdx[0]],
      mode: cells[dimIdx[1]],
      region: cells[dimIdx[2]],
      channel: cells[dimIdx[3]],
      metrics,
    })
  }

  if (rows.length === 0) {
    throw new ReportParseError('表头后无数据行（空报告按解析失败处理，不产出 0 结论）')
  }

  return { period: extractPeriod(sourceName), rows }
}
