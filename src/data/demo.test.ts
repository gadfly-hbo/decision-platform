import { demoBoardView } from './demo'
import { EVIDENCE_LEVELS } from './format'

/** 验收（.flow/tasks.md 任务4 + 契约 2.7）：3 条演示行动项各覆盖一种证据等级。 */
test('演示数据：3 条行动项，证据等级覆盖 数据支撑/逻辑推断/经验假设，isDemo 置位', () => {
  const items = demoBoardView.actionItems
  expect(items).toHaveLength(3)
  expect(items.map((it) => it.evidenceLevel)).toEqual(['数据支撑', '逻辑推断', '经验假设'])
  expect(demoBoardView.isDemo).toBe(true)
  expect(demoBoardView.reports).toEqual([])
})

test('演示数据：数据支撑项含报告原文逐字引用（quote），统计与列表同源', () => {
  const first = demoBoardView.actionItems[0]
  expect(first.evidence).not.toBeNull()
  const facts = first.evidence?.facts ?? []
  expect(facts.length).toBeGreaterThan(0)
  expect(facts[0].quote).toBeTruthy()
  const stats = {
    suggested: demoBoardView.actionItems.filter((i) => i.status === 'suggested').length,
    adopted: demoBoardView.actionItems.filter((i) => i.status === 'adopted').length,
    dismissed: demoBoardView.actionItems.filter((i) => i.status === 'dismissed').length,
    manual: demoBoardView.actionItems.filter((i) => i.sourceKind === 'manual').length,
  }
  expect(demoBoardView.stats).toEqual(stats)
  // 四级等级名均在术语表内（不发明集合外值）
  for (const level of demoBoardView.actionItems.map((i) => i.evidenceLevel)) {
    expect(EVIDENCE_LEVELS).toContain(level)
  }
})
