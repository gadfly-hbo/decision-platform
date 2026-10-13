import type { Runtime, UncappedLimits } from 'pi-agent-runtime'
import type { ActionItemDraft, ExtractionCalibration } from './types'
import { parseDraftsFromText, sanitizeReportForLlm } from './normalize'

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

/** M8：行动项数量上限——防长报告输出顶到单次输出截断线（优先级最高的少数几条） */
const MAX_ACTION_ITEMS = 6

const SYSTEM_PROMPT = `你是一个专业的商业行动方案提取引擎。你的任务是从分析报告中提取出具体的、可执行的行动项（Action Items）。
提取的行动项必须以 JSON 数组格式返回（可以只用一个代码块包裹，也可以裸输出），不可包含其他解释文字。
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
提取的行动项数量控制在 ${MAX_ACTION_ITEMS} 条以内（报告信息不足以支撑时更少）——只输出优先级最高的行动项，宁缺毋滥。
evidence 规则：facts 与 reasoning 只能来自报告正文；报告未提供数据支撑时 facts 置空数组、level 取「经验假设」、reasoning 说明报告未给出推导过程。
如果报告中没有明确的行动项，请返回空数组 []。`

const RETRY_INSTRUCTION = '\n\n（重试要求：上一次输出无法解析为 JSON 数组。这次只输出严格的 JSON 数组本身——不要任何解释文字、不要代码围栏、确保数组完整闭合。）'

export interface ExtractionInput {
  /** 业务任务 ID（账本权威单位）：报告级稳定，如 extract:<projectId>:<reportSlug> */
  taskId: string
  reportName: string
  reportContent: string
  calibration?: ExtractionCalibration
}

function buildUserPrompt(input: ExtractionInput, retry: boolean): string {
  const report = sanitizeReportForLlm(input.reportContent).slice(0, REPORT_CLIP_CHARS)
  const calibration = buildCalibrationSection(input.calibration)
  return `报告文件：${input.reportName}

报告内容：
${report}${calibration}${retry ? RETRY_INSTRUCTION : ''}

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
}

/**
 * 结构化抽取（M8：runText 文本入口 + 宿主解析）。
 * 模型回复经 parseDraftsFromText（围栏剥离 → 数组段提取 → 宽松修复 → 归一化）；
 * 解析失败自动带修复指令重试一次（同 taskId，账本正常累计），再失败上抛由报告管线落 failed。
 * 结构/枚举/置信度校验仍由 validateActionDrafts 全量执行，容错不放松校验。
 */
export function createExtractionRunner(options: { runtime: Runtime }): ExtractionRunner {
  const { runtime } = options
  const runOnce = async (input: ExtractionInput, retry: boolean): Promise<string> => {
    const result = await runtime.runText({
      taskId: input.taskId,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(input, retry),
      limits: EXTRACTION_LIMITS,
      modelRecovery: { extraAttempts: 1 },
    })
    if (result.status !== 'succeeded') {
      throw new Error(`抽取失败（${result.status}·${result.reason}）`)
    }
    return result.value
  }
  return {
    async runExtraction(input: ExtractionInput): Promise<ActionItemDraft[]> {
      try {
        return parseDraftsFromText(await runOnce(input, false))
      } catch (error) {
        if (error instanceof Error && /JSON|数组|解析/.test(error.message)) {
          return parseDraftsFromText(await runOnce(input, true))
        }
        throw error
      }
    },
  }
}
