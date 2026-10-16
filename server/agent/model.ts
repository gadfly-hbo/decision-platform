import { createPiTransport, type ModelConfig, type ModelTransport } from 'pi-agent-runtime'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 模型接入（AGENT-RUNTIME §INTEGRATION 输入 1）：显式 provider/id/protocol/endpoint + 显式 apiKey。
 * SDK 不发现本机认证文件——密钥发现是宿主行为：环境变量优先，缺省从本机凭据文件读取后显式传入，
 * 凭据不进入 SDK 配置模型、审计或日志。本文件是 server/agent/ 适配层的一部分（业务代码唯一
 * 允许触达 pi-agent-runtime 的位置）。
 */

/** 启动时从本机凭据文件加载模型密钥（Mac mini / MacBook 双端通用）：
 *   - MiniMax: ~/.pi/agent/auth.json → providers["minimax-cn"].key
 *   - Xiaomi MIMO: ~/.pi/agent/auth.json → providers["xiaomi-token-plan-cn"].key
 * 仅在进程环境变量未设置时注入，不覆盖显式值。 */
export function loadKeysFromDisk(home: string = homedir()): void {
  const authJson = join(home, '.pi', 'agent', 'auth.json')
  const providers = readAuthProviders(authJson)
  if (!process.env['MINIMAX_CN_API_KEY'] && !process.env['MINIMAX_API_KEY']) {
    const k = providers['minimax-cn']?.key ?? providers['minimax']?.key
    if (k) {
      process.env['MINIMAX_CN_API_KEY'] = k
      process.env['MINIMAX_API_KEY'] = k
    }
  }
  if (!process.env['XIAOMI_TOKEN_PLAN_CN_API_KEY']) {
    const k = providers['xiaomi-token-plan-cn']?.key
    if (k) process.env['XIAOMI_TOKEN_PLAN_CN_API_KEY'] = k
  }
}

function readAuthProviders(path: string): Record<string, { key?: string }> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { key?: string }>
  } catch {
    return {} // 文件不可读不阻塞启动
  }
}

/** 主模型：MiniMax-M3，anthropic-messages 协议（对齐 reports-factory 已验证配置）。原生多模态：图像输入开启（报告内嵌图表/扫描页/图片报告直送识别）。 */
export const MINIMAX_M3: ModelConfig = {
  provider: 'minimax-cn',
  id: 'MiniMax-M3',
  protocol: 'anthropic-messages',
  endpoint: 'https://api.minimaxi.com/anthropic',
  contextWindow: 1_048_576,
  maxOutputTokens: 32_768,
  reasoning: true,
  input: ['text', 'image'],
}

/** 备模型：小米 mimo-v2.6-flash，openai-completions 协议。全模态输入（官方规格：文本/图像/视频/音频），图像随主模型同链路透传。 */
export const MIMO_FLASH: ModelConfig = {
  provider: 'xiaomi-token-plan-cn',
  id: 'mimo-v2.6-flash',
  protocol: 'openai-completions',
  endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  reasoning: true,
  input: ['text', 'image'],
}

/** provider → 环境变量名（密钥只从环境/凭据文件来，不进配置文件与日志）。 */
export function envKeyFor(provider: string): string {
  const map: Record<string, string> = {
    'minimax-cn': 'MINIMAX_CN_API_KEY',
    'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  }
  return map[provider] ?? `${provider.replace(/-/g, '_').toUpperCase()}_API_KEY`
}

export function hasApiKey(cfg: ModelConfig): boolean {
  return Boolean(process.env[envKeyFor(cfg.provider)])
}

/** 单个 provider 的显式凭据 transport（缺密钥返回 null，不抛错——驱动状态展示与降级）。 */
export function transportFor(cfg: ModelConfig): ModelTransport | null {
  const apiKey = process.env[envKeyFor(cfg.provider)]
  if (!apiKey) return null
  return createPiTransport({ model: cfg, apiKey })
}

export interface Candidate {
  model: ModelConfig
  transport: ModelTransport
}

/** 按主备顺序返回有密钥的候选链；一个都没有时抛错（调用方决定降级语义）。 */
export function candidateChain(): Candidate[] {
  const out: Candidate[] = []
  for (const cfg of [MINIMAX_M3, MIMO_FLASH]) {
    const transport = transportFor(cfg)
    if (transport) out.push({ model: cfg, transport })
  }
  if (out.length === 0) {
    throw new Error('无可用模型密钥：请设置 MINIMAX_CN_API_KEY 或 XIAOMI_TOKEN_PLAN_CN_API_KEY')
  }
  return out
}

/** 密钥存在性（不发起网络请求），驱动状态展示。 */
export function modelChainAvailable(): boolean {
  return hasApiKey(MINIMAX_M3) || hasApiKey(MIMO_FLASH)
}

/** 模型链状态描述（主备 + 密钥就绪），驱动右栏运行详情。 */
export function modelChainStatus(): Array<{ role: '主' | '备'; provider: string; modelId: string; keyReady: boolean }> {
  return [
    { role: '主', provider: MINIMAX_M3.provider, modelId: MINIMAX_M3.id, keyReady: hasApiKey(MINIMAX_M3) },
    { role: '备', provider: MIMO_FLASH.provider, modelId: MIMO_FLASH.id, keyReady: hasApiKey(MIMO_FLASH) },
  ]
}
