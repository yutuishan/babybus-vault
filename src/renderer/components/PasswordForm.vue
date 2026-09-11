<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'

const props = defineProps<{ mode: 'create' | 'unlock' }>()

const { state, createVault, openVault } = useVault()
const toast = useToast()

const password = ref('')
const confirm = ref('')
const show = ref(false)
const error = ref('')
const busy = computed(() => state.busy)

/**
 * 规则在主进程里是强制校验（passwordIssues），这里只做同样的前端提示，
 * 避免用户输完才发现被拒。真正的放行判断永远以主进程为准。
 */
const rules = computed(() => [
  { label: '至少 8 位', passed: password.value.length >= 8 },
  { label: '包含字母', passed: /[A-Za-z]/.test(password.value) },
  { label: '包含数字', passed: /\d/.test(password.value) },
])

const strength = computed(() => {
  let score = 0
  const p = password.value
  if (p.length >= 8) score++
  if (p.length >= 12) score++
  if (/[A-Za-z]/.test(p) && /\d/.test(p)) score++
  if (/[^A-Za-z0-9]/.test(p)) score++
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++
  if (!p) return { label: '', tone: '', width: '0%' }
  if (score <= 1) return { label: '弱', tone: 'weak', width: '25%' }
  if (score === 2) return { label: '一般', tone: 'fair', width: '50%' }
  if (score === 3) return { label: '较强', tone: 'good', width: '75%' }
  return { label: '强', tone: 'strong', width: '100%' }
})

const canSubmit = computed(() => {
  if (busy.value) return false
  if (!password.value) return false
  if (props.mode === 'create') {
    return rules.value.every((r) => r.passed) && password.value === confirm.value
  }
  return true
})

async function submit() {
  error.value = ''
  if (!canSubmit.value) return

  if (props.mode === 'create') {
    const err = await createVault(password.value)
    if (err) error.value = err
    else toast.ok('文件库已创建')
  } else {
    const err = await openVault(password.value)
    if (err === 'RECOVERED') {
      toast.warn('manifest 主文件损坏，已从上一次备份恢复，最近的部分改动可能丢失')
    } else if (err) {
      error.value = err
      password.value = ''
    } else {
      toast.ok('已解锁')
    }
  }
  password.value = ''
  confirm.value = ''
}

function back() {
  state.phase = 'gate'
  password.value = ''
  confirm.value = ''
  error.value = ''
}
</script>

<template>
  <div class="wrap">
    <div class="panel">
      <button class="back" @click="back">← 返回</button>

      <div class="head">
        <h2>{{ mode === 'create' ? '设置主密码' : '输入主密码' }}</h2>
        <p>{{ mode === 'create' ? '为这个新的文件库设置一个主密码' : '解锁后即可查看目录与文件内容' }}</p>
      </div>

      <div class="dirbox">
        <span class="k">文件库位置</span>
        <span class="v">{{ state.dir }}</span>
      </div>

      <div class="field">
        <label>主密码</label>
        <div class="pw">
          <input
            v-model="password"
            class="input"
            :type="show ? 'text' : 'password'"
            autofocus
            placeholder="请输入主密码"
            @keyup.enter="submit"
          />
          <button class="eye" @click="show = !show">{{ show ? '隐藏' : '显示' }}</button>
        </div>
      </div>

      <div v-if="mode === 'create'" class="meter">
        <div class="bar"><i :class="strength.tone" :style="{ width: strength.width }" /></div>
        <span :class="strength.tone">{{ strength.label }}</span>
      </div>

      <ul v-if="mode === 'create'" class="rules">
        <li v-for="r in rules" :key="r.label" :class="{ pass: r.passed }">
          <span class="tick">{{ r.passed ? '✓' : '○' }}</span>{{ r.label }}
        </li>
      </ul>

      <div v-if="mode === 'create'" class="field">
        <label>确认主密码</label>
        <input
          v-model="confirm"
          class="input"
          :type="show ? 'text' : 'password'"
          placeholder="再次输入主密码"
          @keyup.enter="submit"
        />
        <span v-if="confirm && password !== confirm" class="err">两次输入不一致</span>
      </div>

      <div v-if="mode === 'create'" class="warnbox">
        <strong>主密码一旦忘记，数据永久无法恢复。</strong>
        本软件不联网、不设后门、不提供任何找回方式。请务必牢记或抄写在安全的地方。
      </div>

      <p v-if="error" class="err">{{ error }}</p>

      <button class="btn primary submit" :disabled="!canSubmit" @click="submit">
        {{ busy ? '正在派生密钥…' : mode === 'create' ? '创建并解锁' : '解锁' }}
      </button>

      <p v-if="mode === 'unlock'" class="foot">密码错误将无法显示任何目录与文件内容</p>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #fbfcfe;
  overflow-y: auto;
  padding: 24px;
}

.panel {
  width: 420px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.back {
  align-self: flex-start;
  font-size: 12.5px;
  color: var(--muted);
}

.back:hover {
  color: var(--accent);
}

.head h2 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 4px;
}

.head p {
  font-size: 12.5px;
  color: var(--muted);
}

.dirbox {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fafbfd;
}

.dirbox .k {
  font-size: 11.5px;
  color: var(--faint);
}

.dirbox .v {
  font-size: 12px;
  word-break: break-all;
}

.pw {
  position: relative;
}

.pw .input {
  padding-right: 56px;
}

.eye {
  position: absolute;
  right: 8px;
  top: 7px;
  font-size: 12px;
  color: var(--muted);
  padding: 3px 5px;
}

.eye:hover {
  color: var(--accent);
}

.meter {
  display: flex;
  align-items: center;
  gap: 9px;
}

.meter .bar {
  flex: 1;
  height: 4px;
  background: var(--line);
  border-radius: 3px;
  overflow: hidden;
}

.meter .bar i {
  display: block;
  height: 100%;
  transition: 0.25s;
}

.meter .bar i.weak {
  background: var(--danger);
}

.meter .bar i.fair {
  background: var(--warn);
}

.meter .bar i.good {
  background: #3b6ef5;
}

.meter .bar i.strong {
  background: var(--ok);
}

.meter span {
  font-size: 12px;
  width: 28px;
}

.meter span.weak {
  color: var(--danger);
}

.meter span.fair {
  color: var(--warn);
}

.meter span.good {
  color: #3b6ef5;
}

.meter span.strong {
  color: var(--ok);
}

.rules {
  list-style: none;
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--faint);
}

.rules li {
  display: flex;
  align-items: center;
  gap: 4px;
}

.rules li.pass {
  color: var(--ok);
}

.tick {
  font-size: 11px;
}

.warnbox {
  padding: 10px 12px;
  border-radius: 8px;
  background: #fff7ed;
  border: 1px solid #fcd9a8;
  color: #8a4b06;
  font-size: 12px;
  line-height: 1.7;
}

.warnbox strong {
  color: #a3450a;
}

.submit {
  height: 36px;
  justify-content: center;
  margin-top: 4px;
}

.foot {
  text-align: center;
  font-size: 12px;
  color: var(--faint);
}
</style>
