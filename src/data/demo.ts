import type { ActionItemView, BoardView } from './types'

/**
 * 演示数据（G7）：无报告（data/raw/ 为空）时前端回退，固定 3 条样例，
 * 各覆盖一种证据等级（数据支撑 / 逻辑推断 / 经验假设），呈现「报告原文支撑 → 推导 → 无数据降级」叙事链。
 * 演示操作仅本地临态、不落库（说明条已声明）。
 */

const NOW = '2026-10-12T09:00:00.000Z'

const DEMO_ITEMS: ActionItemView[] = [
  {
    id: 'demo-1',
    reportId: null,
    sourceKind: 'extracted',
    title: '对 90 天未复购会员发放阶梯券召回',
    rationale: '复购率连续下滑，报告建议以阶梯券激活沉睡会员。',
    scene: '日常',
    lifecycle: 'R复购',
    expectedImpact: '30 日内复购率回升约 2pp，券成本可控在毛利内。',
    metricRef: null,
    priority: 'high',
    effort: 'medium',
    confidence: 0.92,
    evidence: {
      facts: [
        {
          text: '复购会员贡献了近半数销售额，但复购率连续四周下滑。',
          quote: '会员复购率由 12% 降至 9%，复购会员贡献销售额占比 48%。',
        },
      ],
      level: '数据支撑',
      reasoning: '报告数据直接给出复购率降幅与复购贡献占比，召回投入的边际收益可由同屏数字复算。',
    },
    evidenceLevel: '数据支撑',
    status: 'suggested',
    dismissedReason: null,
    decidedBy: null,
    decidedAt: null,
    decidedVia: null,
    createdAt: NOW,
    updatedAt: NOW,
    tasks: [],
  },
  {
    id: 'demo-2',
    reportId: null,
    sourceKind: 'extracted',
    title: '将自播开播时间从 20:00 调整至 19:00 错峰',
    rationale: '黄金时段竞价拥挤，报告推断提前一小时开播可降低投流成本。',
    scene: '日常',
    lifecycle: 'A获取',
    expectedImpact: '单场投流成本下降，同预算下直播时长增加约 1 小时。',
    metricRef: null,
    priority: 'medium',
    effort: 'low',
    confidence: 0.55,
    evidence: {
      facts: [
        { text: '同类目头部直播间集中在 20:00 后开播，流量竞价达到全天峰值。' },
      ],
      level: '逻辑推断',
      reasoning: '报告未提供分时段竞价数据，仅依据类目开播分布推断错峰可降低成本，需小流量验证。',
    },
    evidenceLevel: '逻辑推断',
    status: 'suggested',
    dismissedReason: null,
    decidedBy: null,
    decidedAt: null,
    decidedVia: null,
    createdAt: NOW,
    updatedAt: NOW,
    tasks: [],
  },
  {
    id: 'demo-3',
    reportId: null,
    sourceKind: 'extracted',
    title: '大促前 3 天启动社群预热种草',
    rationale: '行业惯例认为大促前社群预热可提前锁定意向，报告据此提出建议。',
    scene: '大促',
    lifecycle: 'A激活',
    expectedImpact: '大促首日 Opening 峰值前移，社群渠道进店占比提升。',
    metricRef: null,
    priority: 'low',
    effort: 'medium',
    confidence: 0.3,
    evidence: {
      facts: [{ text: '报告引用行业观察，无本店历史大促对照数据。' }],
      level: '经验假设',
      reasoning: '无本店数据支撑，依赖行业经验假设；建议以单次大促 A/B 验证后再固化节奏。',
    },
    evidenceLevel: '经验假设',
    status: 'suggested',
    dismissedReason: null,
    decidedBy: null,
    decidedAt: null,
    decidedVia: null,
    createdAt: NOW,
    updatedAt: NOW,
    tasks: [],
  },
]

export const demoBoardView: BoardView = {
  title: '决策看板',
  lede: '报告驱动的行动闭环：从分析报告提取决策建议，确认后拆解任务、执行后回录反馈，证据可展开核查。',
  reports: [],
  actionItems: DEMO_ITEMS,
  stats: { suggested: 3, adopted: 0, dismissed: 0, manual: 0 },
  notify: { configured: false },
  modelChain: { available: true, providers: [] },
  isDemo: true,
}
