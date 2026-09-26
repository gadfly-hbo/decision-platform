import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMemberWeeklyCsv } from '../report/parseCsv'
import { buildConclusions } from './engine'
import type { MetricKey, MetricValue } from '../report/types'
import type { Conclusion } from '../../src/data/types'

const sampleCsv = readFileSync(join(__dirname, '../report/testdata', 'sample.csv'), 'utf-8')
const report = parseMemberWeeklyCsv(sampleCsv, '会员周报4213-2026-09-26.csv')

const conclusions = buildConclusions(report)
const titles = conclusions.map((c) => c.title).join('\n')

/** 预期数字来自 docs/real-data-walkthrough.md 的独立复算（走查时用 python 算过一遍） */
test('整体背离结论：会员 +8.8% vs 大盘 -5.9%（high）', () => {
  const c = conclusions.find((c) => c.title.includes('背离'))
  expect(c).toBeDefined()
  expect(c!.severity).toBe('high')
  expect(c!.title).toContain('+8.8%')
  expect(c!.title).toContain('-5.9%')
  expect(c!.derivation[0].text).toContain('会员零售额整体同比')
  expect(c!.window).toContain('2026-09-26')
})

test('整体结构结论：增长依赖存量，新客/复购萎缩（high）', () => {
  const c = conclusions.find((c) => c.title.includes('存量'))
  expect(c).toBeDefined()
  expect(c!.severity).toBe('high')
  expect(c!.title).toContain('-1.8%')
  expect(c!.title).toContain('-0.6%')
})

test('渠道异动：西南加盟进入结论，维度带运营模式，占比可复算', () => {
  const c = conclusions.find((c) => c.title.includes('西南加盟'))
  expect(c).toBeDefined()
  expect(c!.title).toContain('加盟·A品牌-西南加盟')
  expect(c!.title).toContain('+37.8%')
  expect(c!.title).toContain('+38.7%')
  // breakdown 为全局归因，含最大拖累 鲁苏加盟
  const drag = c!.breakdown.find((r) => r.dimension === '加盟·A品牌-鲁苏分公司')
  expect(drag).toBeDefined()
  expect(drag!.contribution).toBeCloseTo(-2675712, -1)
})

test('规模门槛过滤：小基数高增速（湖北直营 +239.9%）不进结论', () => {
  expect(titles).not.toContain('直营·A品牌-湖北分公司')
  const mentioned = conclusions.some((c) => c.title.includes('湖北分公司') && c.title.includes('直营'))
  expect(mentioned).toBe(false)
})

test('交叉信号：新零售运营组 开卡涨购买跌', () => {
  const c = conclusions.find((c) => c.title.includes('新零售运营组'))
  expect(c).toBeDefined()
  expect(c!.title).toContain('开卡')
  expect(c!.title).toContain('购买')
})

test('信噪比收敛：结论 ≤8 条且按严重度排序', () => {
  expect(conclusions.length).toBeLessThanOrEqual(8)
  const rank = { high: 0, medium: 1, low: 2 }
  const ranks = conclusions.map((c) => rank[c.severity])
  expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
})

test('每条结论：推导四步齐、归因按 |贡献| 降序、行动带人工确认提示', () => {
  for (const c of conclusions as Conclusion[]) {
    expect(c.derivation.map((s) => s.kind)).toEqual(['detection', 'attribution', 'rule', 'suggestion'])
    const abs = c.breakdown.map((r) => Math.abs(r.contribution))
    expect([...abs].sort((a, b) => b - a)).toEqual(abs)
    expect(c.actions.length).toBeGreaterThan(0)
    expect(c.actions[0].text).toMatch(/确认|核查|评估/)
  }
})

test('数字自洽：渠道结论标题中的偏离占比可由行数据复算', () => {
  const c = conclusions.find((x) => x.title.includes('西南加盟'))!
  const total = report.rows.reduce((s, r) => s + (r.metrics.memberSales.current - r.metrics.memberSales.previous), 0)
  const row = report.rows.find((r) => r.channel === 'A品牌-西南加盟')!
  const share = ((row.metrics.memberSales.current - row.metrics.memberSales.previous) / total) * 100
  expect(c.title).toContain(`${share >= 0 ? '+' : ''}${share.toFixed(1)}%`)
})

/* ---- REVIEW cycle 1 边界与潜伏缺陷回归 ---- */

function synthRow(overrides: Partial<Record<MetricKey, MetricValue>> & { channel?: string; mode?: string }) {
  return {
    brand: 'A品牌',
    mode: overrides.mode ?? '加盟',
    region: 'A品牌-华东区',
    channel: overrides.channel ?? 'A品牌-合成行',
    metrics: {
      memberSales: { current: 1000000, previous: 1000000 },
      memberBuyers: { current: 1000, previous: 1000 },
      memberNewCards: { current: 500, previous: 500 },
      totalSales: { current: 2000000, previous: 2000000 },
      newMemberBuyers: { current: 400, previous: 400 },
      newMemberRepeat: { current: 40, previous: 40 },
      ...overrides,
    },
  }
}

test('同期无基数（previous=0）：不产生 Infinity/NaN，仍可进大额偏离结论，叙述写明无基数', () => {
  const rows = [
    ...report.rows,
    synthRow({ channel: 'A品牌-新渠道', memberSales: { current: 3000000, previous: 0 } }),
  ]
  const out = buildConclusions({ period: report.period, rows })
  const json = JSON.stringify(out)
  expect(json).not.toMatch(/Infinity|NaN/)
  const c = out.find((x) => x.title.includes('新渠道'))
  expect(c).toBeDefined()
  expect(c!.title).toContain('同期无基数')
  expect(c!.title).toContain('占整体偏离')
  const self = c!.breakdown.find((r) => r.dimension.includes('新渠道'))
  expect(self!.delta).toBe('同期无基数')
})

test('R3 整体异动按指标名命名标题（购买/开卡各自正确），无括号后缀', () => {
  const rows = [
    synthRow({
      memberBuyers: { current: 1200, previous: 1000 },
      memberNewCards: { current: 2500, previous: 2000 },
    }),
  ]
  const out = buildConclusions({ period: '2026-09-26', rows })
  const buyer = out.find((c) => c.id === 'c-overall-memberBuyers')
  expect(buyer).toBeDefined()
  expect(buyer!.title).toContain('会员购买人数整体同比 +20.0%')
  const cards = out.find((c) => c.id === 'c-overall-memberNewCards')
  expect(cards).toBeDefined()
  expect(cards!.title).toContain('会员开卡人数整体同比 +25.0%')
  expect(cards!.title).not.toContain('（')
})

test('R2 严重度：新客与复购双萎缩 high，单萎缩 medium', () => {
  const both = buildConclusions({
    period: '2026-09-26',
    rows: [synthRow({
      memberSales: { current: 1100000, previous: 1000000 },
      newMemberBuyers: { current: 380, previous: 400 },
      newMemberRepeat: { current: 38, previous: 40 },
    })],
  })
  expect(both.find((c) => c.id === 'c-structure')!.severity).toBe('high')

  const single = buildConclusions({
    period: '2026-09-26',
    rows: [synthRow({
      memberSales: { current: 1100000, previous: 1000000 },
      newMemberBuyers: { current: 380, previous: 400 },
      newMemberRepeat: { current: 42, previous: 40 },
    })],
  })
  expect(single.find((c) => c.id === 'c-structure')!.severity).toBe('medium')
})

test('R5 交叉信号带基数门槛：开卡同期 ≥100 人才可触发', () => {
  const rows = [
    synthRow({
      channel: 'A品牌-小基数渠道',
      memberNewCards: { current: 60, previous: 50 },
      memberBuyers: { current: 20, previous: 40 },
    }),
    synthRow({
      channel: 'A品牌-足基数渠道',
      memberNewCards: { current: 110, previous: 100 },
      memberBuyers: { current: 40, previous: 80 },
    }),
  ]
  const out = buildConclusions({ period: '2026-09-26', rows })
  expect(out.some((c) => c.title.includes('小基数渠道'))).toBe(false)
  expect(out.some((c) => c.title.includes('足基数渠道'))).toBe(true)
})

/* ---- REVIEW cycle 2：下滑周符号正确性 ---- */

test('下滑周：拉动只标正贡献、拖累只标负贡献，不产生自我矛盾叙述', () => {
  // 镜像场景：会员 -10% vs 大盘 +10%，两负一正贡献
  const rows = [
    synthRow({ channel: 'A品牌-重创渠道', memberSales: { current: 700000, previous: 1000000 } }),
    synthRow({ channel: 'A品牌-次创渠道', memberSales: { current: 900000, previous: 1000000 } }),
    synthRow({ channel: 'A品牌-对冲渠道', memberSales: { current: 1100000, previous: 1000000 } }),
    synthRow({ totalSales: { current: 3300000, previous: 3000000 } }),
  ]
  const out = buildConclusions({ period: '2026-09-26', rows })
  const texts = out.flatMap((c) => [c.title, c.summary, ...c.derivation.map((s) => s.text)])
  const clauses = texts.flatMap((t) => t.split('，'))
  // 分句级：同一渠道不得同时被标为拉动与拖累
  for (const name of ['重创渠道', '对冲渠道']) {
    const asPull = clauses.filter((cl) => cl.includes(name) && cl.includes('为最大拉动')).length
    const asDrag = clauses.filter((cl) => cl.includes(name) && cl.includes('为最大拖累')).length
    expect(asPull + asDrag).toBeLessThanOrEqual(1)
  }
  // 拉动分句只含正贡献渠道，拖累分句只含负贡献渠道
  for (const cl of clauses.filter((x) => x.includes('为最大拉动'))) expect(cl).toContain('对冲渠道')
  for (const cl of clauses.filter((x) => x.includes('为最大拖累'))) expect(cl).toContain('重创渠道')

  // R4 下滑渠道的「最大拉动对照」指向正贡献渠道，且无 undefined/无 崩溃
  expect(texts.join('\n')).not.toContain('undefined')
  const down = out.find((c) => c.title.includes('重创渠道'))
  expect(down).toBeDefined()
  expect(down!.derivation[1].text).toContain('最大拉动对照：加盟·A品牌-对冲渠道')
})

test('R2/R5 的 metricIds[0] 与归因明细指标一致（证据区格式与数据同源）', () => {
  const r2 = conclusions.find((c) => c.id === 'c-structure')!
  expect(r2.metricIds[0]).toBe('newMemberBuyers')
  const r5 = conclusions.find((c) => c.id === 'c-cross-1')!
  expect(r5.metricIds[0]).toBe('memberBuyers')
})

test('R4 分级：大额偏离路径 medium，仅高增速路径 low', () => {
  // 小规模合成：高增速（32%≥30%）且基数占比过线（1.4M/3.4M≈41%），但偏离额 45 万 < 50 万 → fastPath-only → low
  const rows = [
    synthRow({ channel: 'A品牌-低体量高波动', memberSales: { current: 1850000, previous: 1400000 } }),
    synthRow({ channel: 'A品牌-平稳渠道一', memberSales: { current: 1050000, previous: 1000000 } }),
    synthRow({ channel: 'A品牌-平稳渠道二', memberSales: { current: 950000, previous: 1000000 } }),
  ]
  const out = buildConclusions({ period: '2026-09-26', rows })
  const low = out.find((x) => x.title.includes('低体量高波动'))
  expect(low).toBeDefined()
  expect(low!.severity).toBe('low')
  // 真实样本的大额偏离渠道仍为 medium
  const real = buildConclusions(report)
  expect(real.find((c) => c.title.includes('西南加盟'))!.severity).toBe('medium')
})
