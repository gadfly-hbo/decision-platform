import type { WeeklyReport, ChannelRow, MetricKey } from '../report/types'
import { yoy } from '../report/types'
import type { BreakdownRow, Conclusion, DerivationStep } from '../../src/data/types'
import { formatWanDelta, formatWanLevel, formatPctDelta } from '../../src/data/format'
import { sortConclusions } from '../../src/data'

/**
 * 规则参数（初值经真实样本校准：整体异动阈值 5→10，
 * 避免"会员购买人数 +8.8%"这类与背离/结构结论重复叙述的低价值条目——KA2 校准记录）。
 * REVIEW cycle 1：R5 补基数门槛（开卡同期 ≥100 人），过滤小基数交叉噪声。
 */
export const RULES = {
  divergenceGapPt: 10, // R1：会员 vs 大盘 同比差（pt）
  growthGatePct: 5, // R2：会员零售额整体增速门槛
  overallThresholdPct: 10, // R3：非主题指标整体异动阈值
  channelYoyPct: 30, // R4：渠道同比阈值（高增速路径）
  channelBaseShare: 0.01, // R4：基数占比门槛（同期值/大盘同期）
  channelDeviationAbs: 500000, // R4：偏离额绝对门槛（元）
  channelDeviationShare: 0.05, // R4：偏离额占整体偏离比例门槛
  crossCardUpPct: 5, // R5：开卡同比上界
  crossBuyerDownPct: -20, // R5：购买同比下界
  crossMinCardBase: 100, // R5：开卡同期基数门槛（人）
  maxChannelConclusions: 4,
  maxBreakdownRows: 8,
  maxConclusions: 8,
} as const

const fmtNum = (v: number): string => Math.round(v).toLocaleString('zh-CN')
/** 同比可空（同期无基数 → null → 「同期无基数」） */
const fmtYoy = (pct: number | null): string => (pct === null ? '同期无基数' : formatPctDelta(pct))
const dimensionOf = (row: ChannelRow): string => `${row.mode}·${row.channel}`
/** 稳定 slug：mode+channel 规范化（去空白/斜杠），跨期一致（同名分公司因运营模式不同而不同） */
const slugOf = (row: ChannelRow): string => `${row.mode}-${row.channel}`.replace(/[\s/\\]/g, '')

interface Contribution extends BreakdownRow {
  row: ChannelRow
}

function totalOf(report: WeeklyReport, key: MetricKey): { current: number; previous: number } {
  return report.rows.reduce(
    (acc, r) => ({
      current: acc.current + r.metrics[key].current,
      previous: acc.previous + r.metrics[key].previous,
    }),
    { current: 0, previous: 0 },
  )
}

function contributionsOf(report: WeeklyReport, key: MetricKey): Contribution[] {
  return report.rows
    .map((row) => {
      const metric = row.metrics[key]
      return {
        dimension: dimensionOf(row),
        contribution: metric.current - metric.previous,
        value: metric.current,
        delta: fmtYoy(yoy(metric)),
        row,
      }
    })
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
}

const breakdownOf = (report: WeeklyReport, key: MetricKey): BreakdownRow[] =>
  contributionsOf(report, key)
    .slice(0, RULES.maxBreakdownRows)
    .map(({ dimension, contribution, value, delta }) => ({ dimension, contribution, value, delta }))

const steps = (
  detection: string,
  attribution: string,
  rule: string,
  suggestion: string,
): DerivationStep[] => [
  { kind: 'detection', text: detection },
  { kind: 'attribution', text: attribution },
  { kind: 'rule', text: rule },
  { kind: 'suggestion', text: suggestion },
]

const OVERALL_METRIC_NAMES: Partial<Record<MetricKey, string>> = {
  memberBuyers: '会员购买人数',
  memberNewCards: '会员开卡人数',
}

/** 从会员周报生成决策结论（M1 类型），按严重度排序、全局上限 8 条 */
export function buildConclusions(report: WeeklyReport): Conclusion[] {
  const period = report.period
  const windowText = `${period}（本期 vs 去年同期）`
  const updatedAt = `${period} 周报`

  const memberTotal = totalOf(report, 'memberSales')
  const totalSalesTotal = totalOf(report, 'totalSales')
  const newBuyerTotal = totalOf(report, 'newMemberBuyers')
  const repeatTotal = totalOf(report, 'newMemberRepeat')
  const memberYoy = yoy(memberTotal)
  const totalYoy = yoy(totalSalesTotal)
  const newBuyerYoy = yoy(newBuyerTotal)
  const repeatYoy = yoy(repeatTotal)

  const memberContribs = contributionsOf(report, 'memberSales')
  const memberDev = memberTotal.current - memberTotal.previous
  // REVIEW cycle 2：拉动/拖累按符号取——|贡献| 序里首个正贡献为最大拉动、首个负贡献为最大拖累
  const topPull = memberContribs.find((c) => c.contribution > 0)
  const topDrag = memberContribs.find((c) => c.contribution < 0)
  const shareOf = (c: number) => (memberDev === 0 ? 0 : (c / memberDev) * 100)

  const out: Conclusion[] = []

  // R1 整体背离（同比无定义时整体规则不参与）
  if (
    memberYoy !== null &&
    totalYoy !== null &&
    memberYoy * totalYoy < 0 &&
    Math.abs(memberYoy - totalYoy) >= RULES.divergenceGapPt
  ) {
    out.push({
      id: 'c-divergence',
      severity: 'high',
      title: `会员零售额同比 ${formatPctDelta(memberYoy)}，与大盘零售额 ${formatPctDelta(totalYoy)} 背离`,
      summary: '会员盘子逆势增长，是本周最值得关注的结构性事实；结合新客/复购判断增长质量。',
      window: windowText,
      updatedAt,
      metricIds: ['memberSales', 'totalSales'],
      derivation: steps(
        `会员零售额整体同比 ${formatPctDelta(memberYoy)}（本期 ${formatWanLevel(memberTotal.current)} vs 同期 ${formatWanLevel(memberTotal.previous)}），大盘零售额整体同比 ${formatPctDelta(totalYoy)}（本期 ${formatWanLevel(totalSalesTotal.current)} vs 同期 ${formatWanLevel(totalSalesTotal.previous)}），方向相反、差 ${Math.abs(memberYoy - totalYoy).toFixed(1)}pt。`,
        `会员零售额整体偏离 ${formatWanDelta(memberDev)}：${[
          topPull ? `${topPull.dimension} ${formatWanDelta(topPull.contribution)}（占 ${formatPctDelta(shareOf(topPull.contribution))}）为最大拉动` : '',
          topDrag ? `${topDrag.dimension} ${formatWanDelta(topDrag.contribution)}（占 ${formatPctDelta(shareOf(topDrag.contribution))}）为最大拖累` : '',
        ]
          .filter(Boolean)
          .join('，') || '各渠道无净偏离'}。`,
        `命中「会员与大盘零售额同比方向相反且差 ≥${RULES.divergenceGapPt}pt」。`,
        '优先核查拖累渠道与新客/复购结构，再决定资源加减（建议人工确认）。',
      ),
      breakdown: breakdownOf(report, 'memberSales'),
      actions: [
        {
          id: 'a-divergence-1',
          conclusionId: 'c-divergence',
          text: '核查会员逆势增长的结构质量（新客/复购），决定拉新预算方向',
          impact: '明确本周会员运营的资源加减方向',
        },
      ],
    })
  }

  // R2 整体结构：增长依赖存量（新客与复购双萎缩 high；单萎缩 medium；同比无定义不计入萎缩）
  const buyerWithered = newBuyerYoy !== null && newBuyerYoy <= 0
  const repeatWithered = repeatYoy !== null && repeatYoy <= 0
  if (memberYoy !== null && memberYoy >= RULES.growthGatePct && (buyerWithered || repeatWithered)) {
    const newBuyerContribs = contributionsOf(report, 'newMemberBuyers')
    const nbDrag = newBuyerContribs.find((c) => c.contribution < 0)
    const nbPull = newBuyerContribs[0]
    out.push({
      id: 'c-structure',
      severity: buyerWithered && repeatWithered ? 'high' : 'medium',
      title: `会员增长依赖存量：零售额 ${formatPctDelta(memberYoy)}，新客购买 ${fmtYoy(newBuyerYoy)}、复购 ${fmtYoy(repeatYoy)}`,
      summary: '增长由存量会员购买驱动，拉新与复购在萎缩，存在结构性风险。',
      window: windowText,
      updatedAt,
      metricIds: ['newMemberBuyers', 'newMemberRepeat', 'memberSales'],
      derivation: steps(
        `会员零售额整体同比 ${formatPctDelta(memberYoy)} 的同时，新会员购买人数同比 ${fmtYoy(newBuyerYoy)}（本期 ${fmtNum(newBuyerTotal.current)} vs 同期 ${fmtNum(newBuyerTotal.previous)}）、新会员复购人数同比 ${fmtYoy(repeatYoy)}（本期 ${fmtNum(repeatTotal.current)} vs 同期 ${fmtNum(repeatTotal.previous)}）。`,
        `新会员购买人数整体偏离 ${fmtNum(newBuyerTotal.current - newBuyerTotal.previous)} 人${nbDrag ? `：最大拖累 ${nbDrag.dimension} ${fmtNum(nbDrag.contribution)} 人` : ''}${nbPull && nbPull.contribution > 0 ? `，最大拉动 ${nbPull.dimension} +${fmtNum(nbPull.contribution)} 人` : ''}。`,
        `命中「会员零售额 ≥+${RULES.growthGatePct}% 且 新客购买或复购 ≤0」（增长依赖存量）。`,
        '评估拉新与复购激励的预算加码（建议人工确认）。',
      ),
      breakdown: breakdownOf(report, 'newMemberBuyers'),
      actions: [
        {
          id: 'a-structure-1',
          conclusionId: 'c-structure',
          text: '评估新客获取与复购激励的预算加码',
          impact: '对冲增长的结构性风险',
        },
      ],
    })
  }

  // R3 整体异动（购买/开卡两个流量指标；标题按指标名命名）
  for (const key of ['memberBuyers', 'memberNewCards'] as MetricKey[]) {
    const total = totalOf(report, key)
    const pct = yoy(total)
    if (pct === null || Math.abs(pct) < RULES.overallThresholdPct) continue
    const name = OVERALL_METRIC_NAMES[key]!
    out.push({
      id: `c-overall-${key}`,
      severity: 'medium',
      title: `${name}整体同比 ${formatPctDelta(pct)}`,
      summary: '整体量级异动，检查是否与结构结论同因。',
      window: windowText,
      updatedAt,
      metricIds: [key],
      derivation: steps(
        `${name}整体同比 ${formatPctDelta(pct)}（本期 ${fmtNum(total.current)} vs 同期 ${fmtNum(total.previous)}）。`,
        `整体偏离 ${fmtNum(total.current - total.previous)} 人。`,
        `命中「流量指标 |整体同比| ≥${RULES.overallThresholdPct}%」。`,
        '与结构结论对照后决定是否单独立项（建议人工确认）。',
      ),
      breakdown: breakdownOf(report, key),
      actions: [
        {
          id: `a-overall-${key}-1`,
          conclusionId: `c-overall-${key}`,
          text: '确认该指标异动是否与结构性结论同因',
          impact: '避免重复投入',
        },
      ],
    })
  }

  // R4 渠道异动（memberSales，两条触发路径 + 规模门槛；同期无基数走大额偏离路径）
  const candidates = report.rows
    .map((row) => {
      const metric = row.metrics.memberSales
      const pct = yoy(metric)
      const dev = metric.current - metric.previous
      const baseShare = memberTotal.previous === 0 ? 0 : metric.previous / memberTotal.previous
      const devShare = memberDev === 0 ? 0 : dev / memberDev
      const fastPath =
        pct !== null && Math.abs(pct) >= RULES.channelYoyPct && baseShare >= RULES.channelBaseShare
      const bigPath =
        Math.abs(dev) >= RULES.channelDeviationAbs && Math.abs(devShare) >= RULES.channelDeviationShare
      return { row, metric, pct, dev, baseShare, devShare, fires: fastPath || bigPath }
    })
    .filter((c) => c.fires)
    .sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev))
    .slice(0, RULES.maxChannelConclusions)

  const usedChannelIds = new Set<string>()
  candidates.forEach((cand) => {
    const { row, metric, pct, dev, baseShare, devShare } = cand
    const growing = pct === null ? dev > 0 : pct > 0
    // REVIEW cycle 3：大额偏离路径（含双路径命中）= medium；仅高增速路径（偏离额未过门槛的低体量高波动）= low
    const bigPath =
      Math.abs(dev) >= RULES.channelDeviationAbs && Math.abs(devShare) >= RULES.channelDeviationShare
    // M3：id 用维度 slug（跨期稳定，支撑行动跨周对照）；理论冲突加序号兜底
    const baseId = `c-ch-${slugOf(row)}`
    let conclusionId = baseId
    for (let n = 2; usedChannelIds.has(conclusionId); n++) conclusionId = `${baseId}-${n}`
    usedChannelIds.add(conclusionId)
    out.push({
      id: conclusionId,
      dimension: dimensionOf(row),
      severity: bigPath ? 'medium' : 'low',
      title: `${dimensionOf(row)} 会员零售额${pct === null ? '同期无基数' : `同比 ${formatPctDelta(pct)}`}，占整体偏离 ${formatPctDelta(devShare * 100)}`,
      summary: `同期基数 ${formatWanLevel(metric.previous)}（占大盘同期 ${(baseShare * 100).toFixed(1)}%），本期 ${formatWanLevel(metric.current)}。`,
      window: windowText,
      updatedAt,
      metricIds: ['memberSales'],
      derivation: steps(
        `${row.channel}（${row.mode}）会员零售额${pct === null ? '同期无基数（新渠道/新主体）' : `同比 ${formatPctDelta(pct)}`}，同期基数 ${formatWanLevel(metric.previous)}，占大盘同期 ${(baseShare * 100).toFixed(1)}%。`,
        `整体偏离 ${formatWanDelta(memberDev)} 中该渠道 ${formatWanDelta(dev)}（占 ${formatPctDelta(devShare * 100)}）${growing ? `；最大反向对照：${topDrag ? `${topDrag.dimension} ${formatWanDelta(topDrag.contribution)}` : '无'}。` : `；最大拉动对照：${topPull ? `${topPull.dimension} ${formatWanDelta(topPull.contribution)}` : '无'}。`}`,
        '命中「|同比|≥30% 且基数占比≥1%，或 |偏离额|≥50万 且占整体偏离≥5%」规模门槛。',
        growing
          ? '核查增长可持续性（促销/门店/口径），评估是否追加资源（建议人工确认）。'
          : '核查下滑原因（门店/活动/供给），评估止损或扶持（建议人工确认）。',
      ),
      breakdown: breakdownOf(report, 'memberSales'),
      actions: [
        {
          id: `a-${conclusionId}-1`,
          conclusionId,
          text: growing
            ? `核查${row.channel}的增长驱动，评估资源追加`
            : `核查${row.channel}的下滑原因，决定扶持或收缩`,
          impact: growing ? '扩大验证过的增长来源' : '止住确定性拖累',
        },
      ],
    })
  })

  // R5 交叉信号：开卡涨、购买跌（REVIEW cycle 1 补基数门槛）
  const usedCrossIds = new Set<string>()
  for (const row of report.rows) {
    const cardPct = yoy(row.metrics.memberNewCards)
    const buyerPct = yoy(row.metrics.memberBuyers)
    if (
      row.metrics.memberNewCards.previous < RULES.crossMinCardBase ||
      cardPct === null ||
      buyerPct === null ||
      cardPct < RULES.crossCardUpPct ||
      buyerPct > RULES.crossBuyerDownPct
    ) {
      continue
    }
    const baseCrossId = `c-cross-${slugOf(row)}`
    let crossId = baseCrossId
    for (let n = 2; usedCrossIds.has(crossId); n++) crossId = `${baseCrossId}-${n}`
    usedCrossIds.add(crossId)
    const buyerDev = row.metrics.memberBuyers.current - row.metrics.memberBuyers.previous
    out.push({
      id: crossId,
      dimension: dimensionOf(row),
      severity: 'medium',
      title: `${dimensionOf(row)} 开卡同比 ${formatPctDelta(cardPct)} 但会员购买 ${formatPctDelta(buyerPct)}`,
      summary: '拉新在涨、转化在跌，渠道质量或口径疑点，建议人工核查。',
      window: windowText,
      updatedAt,
      metricIds: ['memberBuyers', 'memberNewCards'],
      derivation: steps(
        `${row.channel}（${row.mode}）开卡人数同比 ${formatPctDelta(cardPct)}（本期 ${fmtNum(row.metrics.memberNewCards.current)} vs 同期 ${fmtNum(row.metrics.memberNewCards.previous)}），会员购买人数同比 ${formatPctDelta(buyerPct)}。`,
        `该渠道会员购买人数偏离 ${fmtNum(buyerDev)} 人，与大盘购买人数走势相反。`,
        `命中「开卡 ≥+${RULES.crossCardUpPct}% 且 购买 ≤${RULES.crossBuyerDownPct}% 且开卡同期基数 ≥${RULES.crossMinCardBase} 人」（渠道质量/口径疑点）。`,
        '人工核查该渠道的投放与转化链路。',
      ),
      breakdown: breakdownOf(report, 'memberBuyers'),
      actions: [
        {
          id: `a-${crossId}-1`,
          conclusionId: crossId,
          text: `核查${row.channel}的流量质量与转化链路`,
          impact: '确认渠道问题还是口径问题',
        },
      ],
    })
  }

  return sortConclusions(out).slice(0, RULES.maxConclusions)
}
