/**
 * 主密码策略（基线 P1-4）
 * 强制要求：8 位以上，且同时包含字母和数字。不满足一律不放行。
 */

export interface PasswordRule {
  key: 'length' | 'letter' | 'digit'
  label: string
  passed: boolean
}

export function checkPassword(password: string): PasswordRule[] {
  return [
    { key: 'length', label: '至少 8 位', passed: password.length >= 8 },
    { key: 'letter', label: '包含字母', passed: /[A-Za-z]/.test(password) },
    { key: 'digit', label: '包含数字', passed: /\d/.test(password) },
  ]
}

/** 返回所有未满足的规则文案。空数组表示通过。 */
export function passwordIssues(password: string): string[] {
  const value = typeof password === 'string' ? password : ''
  const failed = checkPassword(value).filter((r) => !r.passed)
  if (failed.length === 0) return []
  return [`主密码需满足：${failed.map((r) => r.label).join('、')}`]
}

export interface StrengthInfo {
  /** 0~4 */
  score: number
  label: string
  tone: 'weak' | 'fair' | 'good' | 'strong'
}

/** 仅供界面提示强度，不参与放行判断 —— 放行只看 passwordIssues */
export function passwordStrength(password: string): StrengthInfo {
  let score = 0
  if (password.length >= 8) score++
  if (password.length >= 12) score++
  if (/[A-Za-z]/.test(password) && /\d/.test(password)) score++
  if (/[^A-Za-z0-9]/.test(password)) score++
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++

  if (score <= 1) return { score: 1, label: '弱', tone: 'weak' }
  if (score === 2) return { score: 2, label: '一般', tone: 'fair' }
  if (score === 3) return { score: 3, label: '较强', tone: 'good' }
  return { score: 4, label: '强', tone: 'strong' }
}
