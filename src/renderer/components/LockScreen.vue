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

      <button class="link" @click="switchVault">切换其它文件库</button>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(238, 240, 244, 0.94);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.box {
  width: 340px;
  padding: 28px 26px;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 20px 50px rgba(20, 26, 40, 0.16);
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
</style>
