export const MEMBER_METRIC_DEFS = [
  {
    id: 'memberSales',
    name: '会员零售额',
    unit: '元',
    caliber: '会员销售额；零售额 = 会员 + 非会员销售额（口径确认 2026-09-26）',
    format: 'currency',
  },
  {
    id: 'memberBuyers',
    name: '会员购买人数',
    unit: '人',
    caliber: '已去重（口径确认 2026-09-26）',
    format: 'number',
  },
  {
    id: 'memberNewCards',
    name: '会员开卡人数',
    unit: '人',
    caliber: '已去重（口径确认 2026-09-26）',
    format: 'number',
  },
  {
    id: 'totalSales',
    name: '零售额（大盘）',
    unit: '元',
    caliber: '会员 + 非会员销售额（口径确认 2026-09-26）',
    format: 'currency',
  },
  {
    id: 'newMemberBuyers',
    name: '新会员购买人数',
    unit: '人',
    caliber: '已去重（口径确认 2026-09-26）',
    format: 'number',
  },
  {
    id: 'newMemberRepeat',
    name: '新会员复购人数',
    unit: '人',
    caliber: '已去重（口径确认 2026-09-26）',
    format: 'number',
  },
] as const
