<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'

const { state, openVault, closeVault } = useVault()
const toast = useToast()

const password = ref('')
const error = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

async function unlock() {
  if (!password.value || state.busy) return
  error.value = ''
  const err = await openVault(password.value)
  password.value = ''
  if (err === 'RECOVERED') {
    toast.warn('已从上一次备份恢复，最近的部分改动可能丢失')
  } else if (err) {
    error.value = err
    void nextTick(() => inputEl.value?.focus())
  }
}

async function switchVault() {
  password.value = ''
  await closeVault()
}

/** 锁定时密钥已清空，直接退出不损失任何保护 */
function quitApp() {
  void window.api.windowClose()
}
</script>

<template>
  <div class="mask">
    <div class="box">
      <div class="icon">🔒</div>
      <h3>文件库已锁定</h3>
      <p class="reason">{{ state.lockReason || '已锁定' }}，内存中的密钥与目录已清空</p>

      <input
        ref="inputEl"
        v-model="password"
        class="input"
        type="password"
        autofocus
        placeholder="请输入主密码解锁"
        @keyup.enter="unlock"
      />

      <p v-if="error" class="err">{{ error }}</p>

      <button class="btn primary go" :disabled="!password || state.busy" @click="unlock">
        {{ state.busy ? '正在派生密钥…' : '解锁' }}
      </button>

      <div class="links">
        <button class="link" @click="switchVault">切换其它文件库</button>
        <span class="sep">·</span>
        <button class="link quit" @click="quitApp">退出程序</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.box {
  width: 340px;
  padding: 28px 26px;
  border-radius: 14px;
  background: var(--panel);
  box-shadow: 0 20px 50px var(--dropdown-shadow);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
}

.icon {
  font-size: 30px;
}

h3 {
  font-size: 16px;
  font-weight: 600;
}

.reason {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}

.box .input {
  text-align: center;
}

.err {
  font-size: 12px;
  color: var(--danger);
}

.go {
  width: 100%;
  height: 34px;
  justify-content: center;
}

.link {
  font-size: 12px;
  color: var(--muted);
}

.link:hover {
  color: var(--accent);
}

.link.quit:hover {
  color: var(--danger);
}

.links {
  display: flex;
  align-items: center;
  gap: 10px;
}

.links .sep {
  color: var(--faint);
  opacity: 0.5;
}
</style>
