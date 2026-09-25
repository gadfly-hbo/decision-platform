import type { DashboardData } from './types'

/**
 * 演示数据：线上经营 · 渠道投放域（ROI 预算决策）。
 * 数字自洽约束（REVIEW cycle 1/2/3 确立的口径）：所有叙述数字——均值基线、连续天数、
 * 归因占比、行动预期影响——必须能由同屏展示的 series / breakdown / 行动文本复算：
 * 「前 N 日均值」= 窗口前 N 个点的均值（四舍五入 2 位）；contribution 之和 = 标题偏离量
 * （不要求按权重分解到各维度值）；行动影响的所有操作数须出现在屏上文本中。
 */
export const demoData: DashboardData = {
  title: '决策看板',
  lede: '打开就知道今天要拍板什么：按紧急度排序的结论，展开可查推导过程与核心指标，直接采纳建议行动。',
  window: '09-12 ~ 09-25',
  updatedAt: '2026-09-25 09:00',
  metrics: [
    {
      id: 'roi-search-a',
      name: 'ROI（渠道A·搜索计划）',
      unit: '倍',
      caliber: 'GMV / 消耗，渠道A搜索计划口径',
      format: 'x',
    },
    {
      id: 'roi-feed-b',
      name: 'ROI（渠道B·信息流）',
      unit: '倍',
      caliber: 'GMV / 消耗，渠道B信息流口径',
      format: 'x',
    },
    {
      id: 'cvr-overall',
      name: '转化率（全站）',
      unit: '%',
      caliber: '下单用户数 / 访问用户数',
      format: 'percent',
    },
    {
      id: 'ctr-display-c',
      name: 'CTR（渠道C·展示广告）',
      unit: '%',
      caliber: '点击量 / 展示量',
      format: 'percent',
    },
  ],
  series: [
    {
      metricId: 'roi-search-a',
      points: [
        { date: '09-12', value: 1.25 },
        { date: '09-13', value: 1.31 },
        { date: '09-14', value: 1.22 },
        { date: '09-15', value: 1.28 },
        { date: '09-16', value: 1.18 },
        { date: '09-17', value: 1.24 },
        { date: '09-18', value: 1.3 },
        { date: '09-19', value: 1.21 },
        { date: '09-20', value: 1.15 },
        { date: '09-21', value: 1.08 },
        { date: '09-22', value: 1.04 },
        { date: '09-23', value: 0.95 },
        { date: '09-24', value: 0.81 },
        { date: '09-25', value: 0.72 },
      ],
      baselines: [{ kind: 'threshold', label: '止损线 1.0', value: 1.0 }],
    },
    {
      metricId: 'roi-feed-b',
      points: [
        { date: '09-12', value: 1.42 },
        { date: '09-13', value: 1.48 },
        { date: '09-14', value: 1.45 },
        { date: '09-15', value: 1.51 },
        { date: '09-16', value: 1.44 },
        { date: '09-17', value: 1.49 },
        { date: '09-18', value: 1.55 },
        { date: '09-19', value: 1.6 },
        { date: '09-20', value: 1.58 },
        { date: '09-21', value: 1.65 },
        { date: '09-22', value: 1.72 },
        { date: '09-23', value: 1.85 },
        { date: '09-24', value: 1.98 },
        { date: '09-25', value: 2.1 },
      ],
      baselines: [{ kind: 'comparison', label: '前 7 日均值 1.48', value: 1.48 }],
    },
    {
      metricId: 'cvr-overall',
      points: [
        { date: '09-12', value: 0.032 },
        { date: '09-13', value: 0.033 },
        { date: '09-14', value: 0.032 },
        { date: '09-15', value: 0.031 },
        { date: '09-16', value: 0.033 },
        { date: '09-17', value: 0.032 },
        { date: '09-18', value: 0.032 },
        { date: '09-19', value: 0.031 },
        { date: '09-20', value: 0.03 },
        { date: '09-21', value: 0.03 },
        { date: '09-22', value: 0.029 },
        { date: '09-23', value: 0.029 },
        { date: '09-24', value: 0.028 },
        { date: '09-25', value: 0.028 },
      ],
      baselines: [{ kind: 'comparison', label: '前 7 日均值 3.2%', value: 0.032 }],
    },
    {
      metricId: 'ctr-display-c',
      points: [
        { date: '09-12', value: 0.019 },
        { date: '09-13', value: 0.019 },
        { date: '09-14', value: 0.018 },
        { date: '09-15', value: 0.018 },
        { date: '09-16', value: 0.018 },
        { date: '09-17', value: 0.017 },
        { date: '09-18', value: 0.017 },
        { date: '09-19', value: 0.016 },
        { date: '09-20', value: 0.016 },
        { date: '09-21', value: 0.016 },
        { date: '09-22', value: 0.015 },
        { date: '09-23', value: 0.015 },
        { date: '09-24', value: 0.014 },
        { date: '09-25', value: 0.014 },
      ],
      baselines: [{ kind: 'target', label: '目标线 1.8%', value: 0.018 }],
    },
  ],
  conclusions: [
    {
      id: 'c1',
      severity: 'high',
      title: '渠道A·搜索计划 ROI 0.72，连续 3 日低于止损线 1.0',
      summary: '品牌专享词组竞价上涨推高 CPA，按当前节奏日损失约 ¥1,400。',
      window: '09-12 ~ 09-25',
      updatedAt: '2026-09-25 09:00',
      metricIds: ['roi-search-a'],
      derivation: [
        {
          kind: 'detection',
          text: 'ROI 自 09-23 起连续 3 日低于止损线 1.0，09-25 收于 0.72（前 7 日均值 1.25）。',
        },
        {
          kind: 'attribution',
          text: '归因到计划内广告组：品牌专享词组贡献偏离 -0.42（占 75%），通用词组 +0.08、竞品词组 +0.06，合计 -0.28。',
        },
        {
          kind: 'rule',
          text: '命中规则「ROI < 1.0 持续 3 日 → 暂停计划并释放预算」（第 3 日）。',
        },
        {
          kind: 'suggestion',
          text: '今日 18:00 前暂停该计划，释放约 ¥5,000/日预算，可移至渠道B。',
        },
      ],
      breakdown: [
        { dimension: '品牌专享词组', contribution: -0.42, value: 0.61, delta: '-52%' },
        { dimension: '通用词组', contribution: 0.08, value: 1.35, delta: '+3%' },
        { dimension: '竞品词组', contribution: 0.06, value: 1.18, delta: '+2%' },
      ],
      actions: [
        {
          id: 'a1',
          conclusionId: 'c1',
          text: '暂停渠道A·搜索计划，释放预算移至渠道B',
          impact: '止损约 ¥1,400/日',
        },
      ],
    },
    {
      id: 'c2',
      severity: 'medium',
      title: '渠道B·信息流 ROI 2.1，环比 +42%，预算利用率 92%',
      summary: '新素材组 CTR 提升带动转化，预算临近触顶，存在放量空间。',
      window: '09-12 ~ 09-25',
      updatedAt: '2026-09-25 09:00',
      metricIds: ['roi-feed-b'],
      derivation: [
        {
          kind: 'detection',
          text: 'ROI 09-25 收于 2.1，环比前 7 日均值 1.48 上升 42%，为全渠道最高。',
        },
        {
          kind: 'attribution',
          text: '归因到素材组：新版短视频素材组贡献偏离 +0.46（占 74%），其余素材组合计 +0.16。',
        },
        {
          kind: 'rule',
          text: '命中规则「ROI > 1.8 且预算利用率 > 85% → 建议追加预算」（当前利用率 92%）。',
        },
        {
          kind: 'suggestion',
          text: '追加渠道B日预算 20%（¥3,000 → ¥3,600），观察 3 日 ROI 衰减再定后续。',
        },
      ],
      breakdown: [
        { dimension: '短视频素材组', contribution: 0.46, value: 2.6, delta: '+61%' },
        { dimension: '图文素材组', contribution: 0.1, value: 1.8, delta: '+12%' },
        { dimension: '旧素材组', contribution: 0.06, value: 1.5, delta: '+4%' },
      ],
      actions: [
        {
          id: 'a2',
          conclusionId: 'c2',
          text: '追加渠道B日预算 20%（¥3,000 → ¥3,600）',
          impact: '预计增量 GMV 约 ¥1,300/日（增量 ¥600 × ROI 2.1）',
        },
      ],
    },
    {
      id: 'c3',
      severity: 'medium',
      title: '全站转化率 2.8%，环比 -12.5%，连续 7 日低于对比基线',
      summary: '落地页 B 实验组跳出率上升为主因，该实验覆盖全站 45% 流量。',
      window: '09-12 ~ 09-25',
      updatedAt: '2026-09-25 09:00',
      metricIds: ['cvr-overall'],
      derivation: [
        {
          kind: 'detection',
          text: '全站转化率 09-25 收于 2.8%，前 7 日均值 3.2%（偏离 -0.4pt），连续 7 日低于基线。',
        },
        {
          kind: 'attribution',
          text: '归因（单位 pt）：落地页B实验组 -0.38、新客渠道 -0.08、直播端 +0.04、自然流量 +0.02，合计 -0.40。',
        },
        {
          kind: 'rule',
          text: '命中规则「核心指标连续 5 日低于对比基线 → 触发实验复核」（当前已连续 7 日）。',
        },
        {
          kind: 'suggestion',
          text: '回滚落地页 B 实验，保留 B 组胜出的首屏组件单独复测。',
        },
      ],
      breakdown: [
        { dimension: '落地页B实验组', contribution: -0.38, value: 0.022, delta: '-31%' },
        { dimension: '新客渠道', contribution: -0.08, value: 0.026, delta: '-19%' },
        { dimension: '直播端', contribution: 0.04, value: 0.036, delta: '+6%' },
        { dimension: '自然流量', contribution: 0.02, value: 0.033, delta: '+3%' },
      ],
      actions: [
        {
          id: 'a3',
          conclusionId: 'c3',
          text: '回滚落地页 B 实验，保留胜出组件复测',
          impact: '找回转化率约 0.4pt，按日均访问 3.5 万折算约 +140 单/日',
        },
      ],
    },
    {
      id: 'c4',
      severity: 'low',
      title: '渠道C·展示广告 CTR 降至 1.4%，连续 9 日低于目标线',
      summary: '三套在投素材全部进入疲劳期（同素材投放 21 天），暂不影响 ROI。',
      window: '09-12 ~ 09-25',
      updatedAt: '2026-09-25 09:00',
      metricIds: ['ctr-display-c'],
      derivation: [
        {
          kind: 'detection',
          text: 'CTR 由 09-12 的 1.9% 降至 1.4%，连续 9 日低于 1.8% 目标线。',
        },
        {
          kind: 'attribution',
          text: '归因（单位 pt）：素材C3 -0.18、素材C2 -0.16、素材C1 -0.16，合计 -0.50。',
        },
        {
          kind: 'rule',
          text: '命中规则「CTR 连续 5 日低于目标 → 提示更换素材（不自动干预）」（当前已连续 9 日）。',
        },
        {
          kind: 'suggestion',
          text: '下周二投放日更换素材组，本周不动作。',
        },
      ],
      breakdown: [
        { dimension: '素材C3', contribution: -0.18, value: 0.013, delta: '-32%' },
        { dimension: '素材C2', contribution: -0.16, value: 0.014, delta: '-26%' },
        { dimension: '素材C1', contribution: -0.16, value: 0.015, delta: '-21%' },
      ],
      actions: [
        {
          id: 'a4',
          conclusionId: 'c4',
          text: '下周二投放日更换渠道C素材组',
          impact: 'CTR 预期回到 1.8% 目标线',
        },
      ],
    },
  ],
}
