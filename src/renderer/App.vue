<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useVault } from './composables/useVault'
import TitleBar from './components/TitleBar.vue'
import VaultGate from './components/VaultGate.vue'
import PasswordForm from './components/PasswordForm.vue'
import MainWindow from './components/MainWindow.vue'
import LockScreen from './components/LockScreen.vue'
import ToastHost from './components/ToastHost.vue'

const { state, loadConfig, markLocked } = useVault()

const LOCK_TEXT: Record<string, string> = {
  idle: '闲置超时，已自动锁定',
  suspend: '系统进入休眠，已自动锁定',
  'system-lock': '系统已锁定，文件库同步锁定',
  manual: '已锁定',
}

let lastBeat = 0
function beat() {
  const now = Date.now()
  if (now - lastBeat < 3000) return
  lastBeat = now
  window.api.heartbeat()
}

onMounted(async () => {
  await loadConfig()
  state.maximized = await window.api.windowIsMaximized()

  window.api.onLocked((reason) => markLocked(LOCK_TEXT[reason] ?? LOCK_TEXT.manual!))
  window.api.onCountdown((s) => (state.countdown = s))
  window.api.onMaximizedChange((m) => (state.maximized = m))

  window.addEventListener('mousemove', beat)
  window.addEventListener('mousedown', beat)
  window.addEventListener('keydown', beat)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', beat)
  window.removeEventListener('mousedown', beat)
  window.removeEventListener('keydown', beat)
})
</script>

<template>
  <div class="shell">
    <TitleBar />
    <div class="content">
      <VaultGate v-if="state.phase === 'gate'" />
      <PasswordForm v-else-if="state.phase === 'setup'" mode="create" />
      <PasswordForm v-else-if="state.phase === 'unlock'" mode="unlock" />
      <MainWindow v-else />
    </div>
    <LockScreen v-if="state.phase === 'main' && state.locked" />
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--win);
  overflow: hidden;
}

.content {
  flex: 1;
  min-height: 0;
  position: relative;
}
</style>
