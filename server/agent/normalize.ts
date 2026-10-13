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

/* ---- M8 宿主解析：围栏剥离 / 数组段提取 / 宽松修复（对齐 pi-xanthil 已验证实现）---- */

/** 剥 ```json 围栏后做字符串感知的中括号配对，提取首个完整 JSON 数组段；无数组抛错。 */
export function extractJsonArrayText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const raw = fenced?.[1] ?? text
  // 对象开头直接拒（防嵌套数组误提取，如 {"nodes":[]} 里的 []）；修复重试会纠正格式
  const firstNonWs = raw.search(/\S/)
  if (firstNonWs >= 0 && raw[firstNonWs] === '{') {
    throw new Error(`模型输出是 JSON 对象而非数组：${text.slice(0, 300)}`)
  }
  const start = raw.indexOf('[')
  if (start < 0) throw new Error(`模型输出不含 JSON 数组：${text.slice(0, 300)}`)
  let inString = false
  let escaped = false
  let depth = 0
  for (let index = start; index < raw.length; index++) {
    const char = raw[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = inString
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '[') depth++
    if (char === ']') {
      depth--
      if (depth === 0) return raw.slice(start, index + 1)
    }
  }
  throw new Error(`模型输出的 JSON 数组不完整（可能被输出上限截断）：${raw.slice(start, start + 300)}`)
}

/** 字符串感知地剥离 JS 注释与尾逗号——不破坏字符串值内本身含斜杠或星号的内容。 */
export function repairLooseJson(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 1
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j] ?? '')) j++
      const after = input[j]
      if (after === '}' || after === ']') continue
    }
    out += ch
  }
  return out
}

/** 模型原始文本 → 行动项草稿：提取数组段 → 严格解析 → 宽松修复重试 → 归一化。全失败抛错。 */
export function parseDraftsFromText(text: string): ActionItemDraft[] {
  const raw = extractJsonArrayText(text)
  let parsed: unknown
  for (const candidate of [raw, repairLooseJson(raw)]) {
    try {
      parsed = JSON.parse(candidate) as unknown
      break
    } catch {
      // 尝试宽松修复候选
    }
  }
  if (!Array.isArray(parsed)) throw new Error('模型输出无法解析为 JSON 数组')
  return validateActionDrafts(parsed)
}
