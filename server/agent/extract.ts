import type { RunResult, Runtime, UncappedLimits } from 'pi-agent-runtime'
import type { ActionItemDraft, ExtractionCalibration } from './types'
import { sanitizeReportForLlm, validateActionDrafts } from './normalize'

/** 单次保护参数（PRD 初值）；累计策略显式不封顶，按任务账本持续累计。 */
export const EXTRACTION_LIMITS: UncappedLimits = {
  cumulative: 'unlimited',
  maxOutputTokens: 8192,
  modelTimeoutMs: 120_000,
  toolTimeoutMs: 30_000,
  controlTimeoutMs: 30_000,
}

/** 报告正文注入上限（字符）；超长截断，防止撑爆上下文与单次输出预算。 */
const REPORT_CLIP_CHARS = 16_000

const SYSTEM_PROMPT = `你是一个专业的商业行动方案提取引擎。你的任务是从分析报告中提取出具体的、可执行的行动项（Action Items）。
提取的行动项必须严格遵循 JSON 数组格式返回，不可包含其他任何内容（不要使用 markdown code block，不要解释文字）。
[
  {
    "title": "行动项标题",
    "rationale": "提出该行动的报告依据或洞察",
    "scene": "单店运营场景，必须严格取以下之一；判断不出则省略此字段：开业 / 日常 / 假日 / 大促",
    "lifecycle": "会员运营阶段，必须严格取以下之一；判断不出则省略此字段：A获取 / A激活 / R培育 / R复购 / R裂变",
    "expectedImpact": "预期效果（如：提升转化率 5%）",
    "priority": "high / medium / low",
    "effort": "high / medium / low",
    "evidence": {
      "facts": [{ "text": "支撑该结论的数据点或事实", "quote": "报告原文逐字引用（必须是报告中真实出现的句子，不得编造）" }],
      "level": "证据等级，必须严格取以下之一：数据支撑（报告中有明确数值/统计结果）/ 多源佐证（报告中多个独立发现共同支持）/ 逻辑推断（由报告事实经推理链得出）/ 经验假设（报告未给出数据，仅为经验性建议）",
      "reasoning": "报告所述从数据/事实推导出该结论的过程"
    }
  }
]
evidence 规则：facts 与 reasoning 只能来自报告正文；报告未提供数据支撑时 facts 置空数组、level 取「经验假设」、reasoning 说明报告未给出推导过程。
如果报告中没有明确的行动项，请返回空数组 []。`

export interface ExtractionInput {
  /** 业务任务 ID（账本权威单位）：报告级稳定，如 extract:<reportSlug> */
  taskId: string
  reportName: string
  reportContent: string
  calibration?: ExtractionCalibration
}

function buildUserPrompt(input: ExtractionInput): string {
  const report = sanitizeReportForLlm(input.reportContent).slice(0, REPORT_CLIP_CHARS)
  const calibration = buildCalibrationSection(input.calibration)
  return `报告文件：${input.reportName}

报告内容：
${report}${calibration}

请输出行动项 JSON 数组。`
}

/** G12 校准注入：近期驳回理由 + 人工补充方向；无数据不注入（prompt 形态不变）。 */
function buildCalibrationSection(calibration: ExtractionCalibration | undefined): string {
  if (!calibration) return ''
  const parts: string[] = []
  if (calibration.dismissalReasons.length > 0) {
    const reasons = calibration.dismissalReasons.slice(0, 10).map((r) => `- ${r}`).join('\n')
    parts.push(`用户已驳回此前提取的建议，驳回理由（这些方向已被判定为不适用或误报，避免重复提取同类建议，除非报告有新的强证据）：
${reasons}`)
  }
  if (calibration.manualAdditions.length > 0) {
    const additions = calibration.manualAdditions.slice(0, 10).map((a) => `- ${a.title}：${a.rationale}`).join('\n')
    parts.push(`用户在报告之外人工补充的建议方向（提取时可参考其关注点，但不得照抄为报告建议）：
${additions}`)
  }
  if (parts.length === 0) return ''
  return `\n\n${parts.join('\n\n')}`
}

export interface ExtractionRunner {
  runExtraction(input: ExtractionInput): Promise<ActionItemDraft[]>
  /** 原始 RunResult（失败语义/用量由调用方处理；测试与管线共用同一缝）。 */
  runExtractionRaw(input: ExtractionInput): Promise<RunResult<ActionItemDraft[]>>
}

/**
 * 结构化抽取 = runWorker（AGENT-RUNTIME P2：固定流程、机器消费的结构化变换）。
 * 模型回复由 SDK 严格 JSON.parse 后交给 validateActionDrafts 归一化；
 * 非严格 JSON / 非数组 → run 失败（INVALID_OUTPUT），由报告管线落 failed 状态可重试。
 */
export function createExtractionRunner(options: { runtime: Runtime }): ExtractionRunner {
  const { runtime } = options
  const runRaw = (input: ExtractionInput) =>
    runtime.runWorker({
      taskId: input.taskId,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input),
      limits: EXTRACTION_LIMITS,
      modelRecovery: { extraAttempts: 1 },
      validate: validateActionDrafts,
    })
  return {
    async runExtraction(input: ExtractionInput): Promise<ActionItemDraft[]> {
      const result = await runRaw(input)
      if (result.status !== 'succeeded') {
        throw new Error(`抽取失败（${result.status}·${result.reason}）`)
      }
      return result.value
    },
    runExtractionRaw: runRaw,
  }
}
