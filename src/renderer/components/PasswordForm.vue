<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'

const props = defineProps<{ mode: 'create' | 'unlock' }>()

const { state, createVault, openVault } = useVault()
const toast = useToast()

const password = ref('')
const confirm = ref('')
const hint = ref('')
const show = ref(false)
const error = ref('')
const busy = computed(() => state.busy)

/**
 * 解锁模式下显示已保存的密码提示。
 *
 * 走 peekHint 而不是 getHint：前者不需要密码（提示语存在明文的 vault.meta 里），
 * 后者要求已经解锁 —— 在"还没解锁"的界面上它必然失败。
 */
const savedHint = ref('')

watch(
  () => [props.mode, state.dir] as const,
  async ([mode, dir]) => {
    if (mode !== 'unlock' || !dir) {
      savedHint.value = ''
      return
    }
    const res = await window.api.peekHint(dir)
    savedHint.value = res.ok ? res.data : ''
  },
  { immediate: true },
)

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
    const err = await createVault(password.value, hint.value)
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
  hint.value = ''
}

function back() {
  state.phase = 'gate'
  password.value = ''
  confirm.value = ''
  hint.value = ''
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

      <!--
        解锁模式下把当初写的提示语显示出来。提示语以明文存在 vault.meta 里，
        所以这里不需要密码就能读到 —— 它本来就是给"想不起密码的人"看的。
      -->
      <div v-if="mode === 'unlock' && savedHint" class="hintbox">
        <span class="hintlabel">密码提示</span>
        <span class="hinttext">{{ savedHint }}</span>
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

      <div v-if="mode === 'create'" class="field">
        <label>密码提示（可选）</label>
        <input
          v-model="hint"
          class="input"
          type="text"
          maxlength="200"
          placeholder="例如：常用那串 + 生日"
          @keyup.enter="submit"
        />
        <span class="tip warn-tip">
          提示语以<strong>明文</strong>保存在文件库里，锁定状态下也能看到 —— 这是为了让你
          忘记密码时能想起来。所以请勿直接把密码本身写进去。
        </span>
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
  background: var(--bg);
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
  background: var(--accent);
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
  color: var(--accent);
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
  background: var(--warn-soft);
  border: 1px solid var(--warn-line);
  color: var(--warn-text);
  font-size: 12px;
  line-height: 1.7;
}

.warnbox strong {
  color: var(--warn-text);
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

.tip {
  font-size: 11.5px;
  color: var(--faint);
  line-height: 1.6;
}

/* 明文保存这件事必须说清楚，所以给它一个提示色而不是灰色小字 */
.tip.warn-tip {
  color: var(--warn-text, var(--warn));
}

.tip.warn-tip strong {
  color: inherit;
}

/* 解锁界面上的提示语展示 */
.hintbox {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  background: var(--accent-soft);
  border: 1px solid var(--line);
}

.hintlabel {
  flex: 0 0 auto;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--accent);
}

.hinttext {
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.6;
  word-break: break-word;
}
</style>
