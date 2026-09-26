import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type StoredActionStatus = 'pending' | 'accepted' | 'rejected' | 'executed'

export const ACTION_STATUSES: readonly StoredActionStatus[] = [
  'pending',
  'accepted',
  'rejected',
  'executed',
] as const

export interface ActionRecord {
  status: StoredActionStatus
  /** 已执行时的落地说明（可选） */
  executedNote?: string
  /** 行动所属结论的期次（首次更新时记录，后续不变） */
  period: string
  updatedAt: string
  /** 行动文本（首次记录，供跨周对照展示） */
  text?: string
  /** 归因维度 运营模式·二级渠道（首次记录，供本期表现匹配） */
  dimension?: string
}

export type ActionStore = Record<string, ActionRecord>

export interface ActionPatch {
  status?: StoredActionStatus
  executedNote?: string
  text?: string
  dimension?: string
}

const MAX_NOTE_LENGTH = 500

/** 读取行动存储；文件不存在/损坏按空 store（损坏记日志——行动历史非关键数据，不阻塞看板） */
export function readActionStore(filePath: string): ActionStore {
  try {
    if (!existsSync(filePath)) return {}
    return JSON.parse(readFileSync(filePath, 'utf-8')) as ActionStore
  } catch (error) {
    console.warn('[actions] 存储文件损坏，按空处理：', (error as Error).message)
    return {}
  }
}

export function writeActionStore(filePath: string, store: ActionStore): void {
  mkdirSync(dirname(filePath), { recursive: true })
  // 原子写（tmp+rename）：避免崩溃半写导致下次读取按空 store 清史
  const tmp = join(dirname(filePath), '.' + basename(filePath) + '.tmp')
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8')
  renameSync(tmp, filePath)
}

/** 纯函数：更新单条行动记录（校验 status 四态、备注长度；period 首次记录后不变），返回新 store */
export function updateActionRecord(
  store: ActionStore,
  actionId: string,
  patch: ActionPatch,
  period: string,
  updatedAt: string,
): ActionStore {
  if (patch.status !== undefined && !ACTION_STATUSES.includes(patch.status)) {
    throw new Error(`非法 status：${String(patch.status)}（合法值：${ACTION_STATUSES.join('/')}）`)
  }
  if (patch.executedNote !== undefined && typeof patch.executedNote !== 'string') {
    throw new Error('备注必须是字符串')
  }
  if (patch.executedNote !== undefined && patch.executedNote.length > MAX_NOTE_LENGTH) {
    throw new Error(`备注超长（>${MAX_NOTE_LENGTH} 字）`)
  }
  const existing = store[actionId]
  const next: ActionRecord = {
    status: patch.status ?? existing?.status ?? 'pending',
    ...(patch.executedNote !== undefined || existing?.executedNote !== undefined
      ? { executedNote: patch.executedNote ?? existing?.executedNote }
      : {}),
    period: existing?.period ?? period,
    updatedAt,
    ...(existing?.text || patch.text ? { text: existing?.text ?? patch.text } : {}),
    ...(existing?.dimension || patch.dimension
      ? { dimension: existing?.dimension ?? patch.dimension }
      : {}),
  }
  return { ...store, [actionId]: next }
}
