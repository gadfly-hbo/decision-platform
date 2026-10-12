import type {
  ActionEvidence,
  ActionEvidenceLevel,
  ActionItemDraft,
  ActionLevel,
  ActionLifecycle,
  ActionScene,
} from './types'

export const ACTION_SCENES = new Set<string>(['开业', '日常', '假日', '大促'])
export const ACTION_LIFECYCLES = new Set<string>(['A获取', 'A激活', 'R培育', 'R复购', 'R裂变'])
export const ACTION_LEVELS = new Set<string>(['high', 'medium', 'low'])
export const ACTION_EVIDENCE_LEVELS = new Set<string>(['数据支撑', '多源佐证', '逻辑推断', '经验假设'])

const ACTION_EVIDENCE_LEVEL_BASE: Record<ActionEvidenceLevel, number> = {
  数据支撑: 0.9,
  多源佐证: 0.75,
  逻辑推断: 0.55,
  经验假设: 0.3,
}

/**
 * confidence = base(level) + 每条带逐字 quote 的 fact +0.02（上限 +0.1），
 * 无 facts 封顶 0.5；无 evidence 视为经验假设基线 0.3。
 * 公式对齐 pi-xanthil 冻结版，调整需回 PRD 复议。
 */
export function deriveActionConfidence(evidence: ActionEvidence | undefined): number {
  if (!evidence) return 0.3
  let score = ACTION_EVIDENCE_LEVEL_BASE[evidence.level]
  const quoted = evidence.facts.filter((fact) => fact.quote).length
  score += Math.min(quoted * 0.02, 0.1)
  if (evidence.facts.length === 0) score = Math.min(score, 0.5)
  return Math.round(Math.min(1, score) * 100) / 100
}

export function parseActionEvidence(raw: unknown): ActionEvidence | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const facts = (Array.isArray(record.facts) ? record.facts : [])
    .filter((fact): fact is Record<string, unknown> => typeof fact === 'object' && fact !== null && !Array.isArray(fact))
    .map((fact) => ({
      text: String(fact.text ?? '').trim(),
      quote: String(fact.quote ?? '').trim() || undefined,
    }))
    .filter((fact) => fact.text.length > 0)
  const level = ACTION_EVIDENCE_LEVELS.has(String(record.level))
    ? (String(record.level) as ActionEvidenceLevel)
    : undefined
  const reasoning = String(record.reasoning ?? '').trim()
  if (!level && facts.length === 0 && !reasoning) return undefined
  return { facts, level: level ?? '逻辑推断', reasoning }
}

/**
 * runWorker 的 validate：SDK 已对模型回复做严格 JSON.parse，这里拿到的是解析后的值。
 * 结构归一化（枚举/兜底/派生 confidence）；非数组即结构性失败，抛错使 run 失败。
 */
export function validateActionDrafts(value: unknown): ActionItemDraft[] {
  if (!Array.isArray(value)) throw new Error('行动项输出必须是 JSON 数组')
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item) => {
      const evidence = parseActionEvidence(item.evidence)
      return {
        title: String(item.title ?? '').trim(),
        rationale: String(item.rationale ?? '').trim() || '报告中提出的行动建议',
        scene: ACTION_SCENES.has(String(item.scene)) ? (String(item.scene) as ActionScene) : undefined,
        lifecycle: ACTION_LIFECYCLES.has(String(item.lifecycle))
          ? (String(item.lifecycle) as ActionLifecycle)
          : undefined,
        expectedImpact: String(item.expectedImpact ?? '').trim() || '待评估',
        metricRef: String(item.metricRef ?? '').trim() || undefined,
        priority: ACTION_LEVELS.has(String(item.priority)) ? (String(item.priority) as ActionLevel) : 'medium',
        effort: ACTION_LEVELS.has(String(item.effort)) ? (String(item.effort) as ActionLevel) : 'medium',
        confidence: deriveActionConfidence(evidence),
        evidence,
      }
    })
    .filter((item) => item.title.trim().length > 0)
}

/** 图片引用替换为占位（脱图），正文保留 */
export function sanitizeReportForLlm(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片已省略]')
    .replace(/<img\b[^>]*>/gi, '[图片已省略]')
    .replace(/\S+\.(?:png|jpe?g|gif|webp|heic|svg)(?:\?\S*)?/gi, '[图片路径已省略]')
}
