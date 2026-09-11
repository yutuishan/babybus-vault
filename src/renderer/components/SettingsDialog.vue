<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'

const model = defineModel<boolean>({ default: false })

const { state, patchConfig, lock } = useVault()
const toast = useToast()

const version = ref('')
const tab = ref<'general' | 'password'>('general')

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const pwBusy = ref(false)
const pwError = ref('')

const autoLockOptions = [
  { value: 1, label: '1 分钟' },
  { value: 5, label: '5 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' },
  { value: 0, label: '从不' },
]

const rules = computed(() => [
  { label: '至少 8 位', passed: newPassword.value.length >= 8 },
  { label: '包含字母', passed: /[A-Za-z]/.test(newPassword.value) },
  { label: '包含数字', passed: /\d/.test(newPassword.value) },
])

const canChange = computed(
  () =>
    !!oldPassword.value &&
    rules.value.every((r) => r.passed) &&
    newPassword.value === confirmPassword.value &&
    !pwBusy.value,
)

async function changePassword() {
  if (!canChange.value) return
  pwBusy.value = true
  pwError.value = ''
  try {
    const res = await window.api.changePassword(oldPassword.value, newPassword.value)
    if (!res.ok) {
      pwError.value = res.error
      return
    }
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    toast.ok('主密码已更新。文件内容未重新加密，只重新包装了每个文件的密钥。')
  } finally {
    pwBusy.value = false
  }
}

async function loadVersion() {
  version.value = await window.api.appVersion()
}

if (model.value) void loadVersion()
</script>

<template>
  <div v-if="model" class="mask" @click.self="model = false">
    <div class="dialog">
      <div class="head">
        <h3>设置</h3>
        <button class="x" @click="model = false">×</button>
      </div>

      <div class="tabs">
        <button :class="{ on: tab === 'general' }" @click="tab = 'general'">常规</button>
        <button :class="{ on: tab === 'password' }" @click="tab = 'password'">主密码</button>
      </div>

      <div v-if="tab === 'general'" class="body">
        <div class="row">
          <label>自动锁屏</label>
          <select
            class="input sel"
            :value="state.config?.autoLockMinutes ?? 5"
            @change="
              patchConfig({ autoLockMinutes: Number(($event.target as HTMLSelectElement).value) })
            "
          >
            <option v-for="o in autoLockOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </div>

        <label class="row check">
          <input
            type="checkbox"
            :checked="state.config?.lockOnSuspend ?? true"
            @change="
              patchConfig({ lockOnSuspend: ($event.target as HTMLInputElement).checked })
            "
          />
          <span>系统休眠或睡眠时自动锁定</span>
        </label>

        <label class="row check">
          <input
            type="checkbox"
            :checked="state.config?.rememberRecentVaults ?? true"
            @change="
              patchConfig({ rememberRecentVaults: ($event.target as HTMLInputElement).checked })
            "
          />
          <span>记住最近打开的文件库（仅保存路径，不保存密码）</span>
        </label>

        <div class="divider" />

        <div class="info">
          <div class="line"><span>文件库位置</span><b>{{ state.dir }}</b></div>
          <div class="line"><span>密钥派生</span><b>{{ state.vault.kdf }}（{{ state.vault.kdfImpl }}）</b></div>
          <div class="line"><span>文件数</span><b>{{ state.vault.fileCount }}</b></div>
          <div class="line"><span>版本</span><b>{{ version || '—' }}</b></div>
        </div>

        <p class="note">
          本软件不联网、不上传任何文件，也没有任何形式的后门。<br />
          忘记主密码将无法恢复数据，请务必牢记。
        </p>
      </div>

      <div v-else class="body">
        <div class="field">
          <label>原密码</label>
          <input v-model="oldPassword" class="input" type="password" placeholder="请输入当前主密码" />
        </div>

        <div class="field">
          <label>新密码</label>
          <input v-model="newPassword" class="input" type="password" placeholder="请输入新主密码" />
        </div>

        <ul class="rules">
          <li v-for="r in rules" :key="r.label" :class="{ pass: r.passed }">
            <span class="tick">{{ r.passed ? '✓' : '○' }}</span>{{ r.label }}
          </li>
        </ul>

        <div class="field">
          <label>确认新密码</label>
          <input
            v-model="confirmPassword"
            class="input"
            type="password"
            placeholder="再次输入新主密码"
          />
          <span v-if="confirmPassword && newPassword !== confirmPassword" class="err">
            两次输入不一致
          </span>
        </div>

        <p v-if="pwError" class="err">{{ pwError }}</p>

        <p class="note">
          修改主密码只会重新包装每个文件的密钥，<b>不会重新加密文件内容</b>，因此大文件库也能瞬间完成。
        </p>

        <div class="actions">
          <button class="btn" @click="model = false">关闭</button>
          <button class="btn primary" :disabled="!canChange" @click="changePassword">
            {{ pwBusy ? '处理中…' : '修改主密码' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: absolute;
  inset: 0;
  background: rgba(30, 36, 48, 0.26);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}

.dialog {
  width: 480px;
  max-height: 84%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(20, 26, 40, 0.24);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 18px 10px;
}

.head h3 {
  font-size: 15px;
}

.x {
  font-size: 19px;
  color: var(--faint);
  line-height: 1;
}

.x:hover {
  color: var(--text);
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 0 18px;
  border-bottom: 1px solid var(--line);
}

.tabs button {
  padding: 7px 12px;
  font-size: 12.5px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
}

.tabs button.on {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.body {
  padding: 16px 18px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
}

.row.check {
  justify-content: flex-start;
  cursor: pointer;
}

.sel {
  width: 150px;
  height: 30px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field label {
  font-size: 12px;
  color: var(--muted);
}

.divider {
  height: 1px;
  background: var(--line-soft);
  margin: 2px 0;
}

.info {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}

.info .line {
  display: flex;
  gap: 10px;
}

.info span {
  color: var(--faint);
  flex: 0 0 78px;
}

.info b {
  font-weight: 500;
  word-break: break-all;
}

.note {
  font-size: 11.5px;
  color: var(--faint);
  line-height: 1.8;
  background: #fafbfd;
  border: 1px solid var(--line-soft);
  border-radius: 7px;
  padding: 9px 11px;
}

.rules {
  list-style: none;
  display: flex;
  gap: 15px;
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

.err {
  font-size: 12px;
  color: var(--danger);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
