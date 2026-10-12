import { describe, expect, it } from 'vitest'
import {
  deriveActionConfidence,
  parseActionEvidence,
  sanitizeReportForLlm,
  validateActionDrafts,
} from './normalize'

describe('validateActionDrafts', () => {
  it('归一化合法行动项数组并派生 confidence', () => {
    const drafts = validateActionDrafts([
      {
        title: '提高复购频次',
        rationale: '报告指出复购率连续三周下滑',
        scene: '日常',
        lifecycle: 'R复购',
        expectedImpact: '复购率 +5%',
        priority: 'high',
        effort: 'medium',
        evidence: {
          facts: [{ text: '复购率 12%→9%', quote: '复购率由 12% 降至 9%' }],
          level: '数据支撑',
          reasoning: '报告第 2 节数据直接支持',
        },
      },
    ])
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      title: '提高复购频次',
      scene: '日常',
      lifecycle: 'R复购',
      priority: 'high',
      effort: 'medium',
      confidence: 0.92,
    })
  })

  it('非法枚举值降级：scene/lifecycle 省略、priority/effort 回 medium', () => {
    const drafts = validateActionDrafts([
      { title: 't', rationale: 'r', scene: '未知场景', lifecycle: 3, priority: 'urgent', effort: null },
    ])
    expect(drafts[0].scene).toBeUndefined()
    expect(drafts[0].lifecycle).toBeUndefined()
    expect(drafts[0].priority).toBe('medium')
    expect(drafts[0].effort).toBe('medium')
  })

  it('缺失字段补默认：rationale/expectedImpact 有兜底文案', () => {
    const drafts = validateActionDrafts([{ title: '只有标题' }])
    expect(drafts[0].rationale).toBe('报告中提出的行动建议')
    expect(drafts[0].expectedImpact).toBe('待评估')
  })

  it('无 evidence 的行动项 confidence 为经验假设基线 0.3', () => {
    const drafts = validateActionDrafts([{ title: 't' }])
    expect(drafts[0].confidence).toBe(0.3)
    expect(drafts[0].evidence).toBeUndefined()
  })

  it('过滤空标题项与非对象项', () => {
    const drafts = validateActionDrafts([
      { title: '   ' },
      { title: '有效' },
      'not-an-object',
      null,
    ])
    expect(drafts).toHaveLength(1)
    expect(drafts[0].title).toBe('有效')
  })

  it('非数组输入抛错（SDK 已 JSON.parse，结构性非法即失败）', () => {
    expect(() => validateActionDrafts({ nodes: [] })).toThrow()
    expect(() => validateActionDrafts('[]')).toThrow()
    expect(() => validateActionDrafts(null)).toThrow()
  })

  it('空数组合法（报告无行动项的正常语义）', () => {
    expect(validateActionDrafts([])).toEqual([])
  })
})

describe('parseActionEvidence', () => {
  it('保留逐字 quote，剔除空 text 的 fact', () => {
    const evidence = parseActionEvidence({
      facts: [
        { text: '事实一', quote: '原文引用一' },
        { text: '', quote: '空文本被剔除' },
        { text: '事实二' },
      ],
      level: '多源佐证',
      reasoning: '推导',
    })
    expect(evidence?.facts).toEqual([
      { text: '事实一', quote: '原文引用一' },
      { text: '事实二', quote: undefined },
    ])
    expect(evidence?.level).toBe('多源佐证')
  })

  it('非法 level 降级为逻辑推断；全空返回 undefined', () => {
    expect(parseActionEvidence({ facts: [{ text: '有事实' }], level: '瞎编' })?.level).toBe('逻辑推断')
    expect(parseActionEvidence(undefined)).toBeUndefined()
    expect(parseActionEvidence({ facts: [], level: '', reasoning: '' })).toBeUndefined()
    expect(parseActionEvidence({ facts: [], level: '瞎编', reasoning: '' })).toBeUndefined()
    expect(parseActionEvidence('text')).toBeUndefined()
  })

  it('有 level 无 facts 无 reasoning 仍保留（等级本身是信息）', () => {
    expect(parseActionEvidence({ level: '经验假设' })).toMatchObject({ level: '经验假设', facts: [] })
  })
})

describe('deriveActionConfidence（公式冻结：base + quote 加成上限 0.1，无 facts 封顶 0.5）', () => {
  it.each([
    ['数据支撑', 0, 0.9],
    ['数据支撑', 8, 1],
    ['多源佐证', 1, 0.77],
    ['逻辑推断', 0, 0.55],
    ['经验假设', 2, 0.34],
  ] as const)('%s + %d 条 quote → %f', (level, quoted, expected) => {
    // quoted=0 时仍有一条无 quote 的事实（有 facts 不触发封顶，仅无 quote 加成）
    const facts = [
      { text: 'plain-fact' },
      ...Array.from({ length: quoted }, (_, i) => ({ text: `f${i}`, quote: `q${i}` })),
    ]
    expect(deriveActionConfidence({ facts, level, reasoning: 'r' })).toBe(expected)
  })

  it('无 evidence 视为经验假设基线 0.3', () => {
    expect(deriveActionConfidence(undefined)).toBe(0.3)
  })

  it('无 facts 封顶 0.5（数据支撑级也不例外）', () => {
    expect(deriveActionConfidence({ facts: [], level: '数据支撑', reasoning: 'r' })).toBe(0.5)
  })
})

describe('sanitizeReportForLlm', () => {
  it('图片引用替换为占位，正文保留', () => {
    const out = sanitizeReportForLlm('结论 A\n![图](/a/b.png)\n见 <img src="x.jpg"> 与 file.webp 结尾')
    expect(out).toContain('结论 A')
    expect(out).not.toMatch(/\.png|\.jpg|\.webp/)
    expect(out).toContain('[图片已省略]')
    expect(out).toContain('[图片路径已省略]')
  })
})
