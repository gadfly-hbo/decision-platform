import { describe, expect, it } from 'vitest'
import { envKeyFor, hasApiKey, MINIMAX_M3, MIMO_FLASH, transportFor } from './model'

describe('模型链接入（显式凭据，密钥不进配置）', () => {
  it('envKeyFor 映射 provider → 环境变量名', () => {
    expect(envKeyFor('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
    expect(envKeyFor('xiaomi-token-plan-cn')).toBe('XIAOMI_TOKEN_PLAN_CN_API_KEY')
    expect(envKeyFor('other-provider')).toBe('OTHER_PROVIDER_API_KEY')
  })

  it('hasApiKey/transportFor 随环境变量出现与消失', () => {
    const key = envKeyFor(MINIMAX_M3.provider)
    const prev = process.env[key]
    delete process.env[key]
    expect(hasApiKey(MINIMAX_M3)).toBe(false)
    expect(transportFor(MINIMAX_M3)).toBeNull()
    process.env[key] = 'test-key'
    expect(hasApiKey(MINIMAX_M3)).toBe(true)
    expect(transportFor(MINIMAX_M3)).not.toBeNull()
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  })

  it('模型候选声明主备顺序与协议', () => {
    expect(MINIMAX_M3.id).toBe('MiniMax-M3')
    expect(MINIMAX_M3.protocol).toBe('anthropic-messages')
    expect(MIMO_FLASH.id).toBe('mimo-v2.6-flash')
    expect(MIMO_FLASH.protocol).toBe('openai-completions')
  })
})
