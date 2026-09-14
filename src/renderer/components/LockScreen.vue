<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useVault } from '../composables/useVault'
import { useToast } from '../composables/useToast'

const { state, openVault, closeVault } = useVault()
const toast = useToast()

const password = ref('')
const error = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

/**
 * 密码提示。
 *
 * 锁定时主密钥已经清空，主进程里连 Vault 实例都没了，所以走 peekHint(dir) ——
 * 它直接读明文的 vault.meta，不需要密码。这正是"锁屏也能看到提示"的实现方式。
 * 目录取自 state.dir：这是锁定后唯一还知道库在哪的地方。
 */
const savedHint = ref('')

/**
 * 顶部窗口按钮的状态。
 *
 * 遮罩铺满了整个内容区，会把 TitleBar 盖住吗？不会 —— TitleBar 在 .content 之外，
 * 但遮罩自己有 backdrop-filter，视觉上仍需要一组"自己的"窗口按钮，
 * 这样用户在锁屏状态下不必去够最顶上那条 38px 的窄条就能关窗口。
 */
const maximized = ref(false)

onMounted(async () => {
  maximized.value = await window.api.windowIsMaximized()
  if (state.dir) {
    const res = await window.api.peekHint(state.dir)
    savedHint.value = res.ok ? res.data : ''
  }
})

function minimize() {
  void window.api.windowMinimize()
}
function toggleMax() {
  void window.api.windowToggleMaximize()
}
function close() {
  void window.api.windowClose()
}

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
    <!--
      右上角窗口按钮。遮罩本身 covers 整个内容区，很多用户的第一反应是
      "我要关掉这个窗口"，却在锁屏界面上找不到任何入口（原先只有底部一行
      「退出程序」文字链）。这里补齐标准的 最小化 / 最大化 / 关闭 三件套，
      位置与 TitleBar 完全对齐（38px 高，44px 宽），肌肉记忆能直接命中。
    -->
    <div class="winbtns">
      <button class="wbtn" title="最小化" @click="minimize"><i class="i-min" /></button>
      <button class="wbtn" :title="maximized ? '还原' : '最大化'" @click="toggleMax">
        <i :class="maximized ? 'i-restore' : 'i-max'" />
      </button>
      <button class="wbtn close" title="关闭窗口" @click="close"><i class="i-close" /></button>
    </div>

    <div class="box">
      <div class="icon">🔒</div>
      <h3>文件库已锁定</h3>
      <p class="reason">{{ state.lockReason || '已锁定' }}，内存中的密钥与目录已清空</p>

      <!-- 提示语存在明文的 vault.meta 里，所以锁定状态下也读得到 -->
      <div v-if="savedHint" class="hintbox">
        <span class="hintlabel">密码提示</span>
        <span class="hinttext">{{ savedHint }}</span>
      </div>

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

/* ---------------- 右上角窗口按钮 ---------------- */

.winbtns {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  height: 38px;
  /* 遮罩的 backdrop-filter 会吞掉鼠标事件之外的拖动，这里显式声明可交互 */
  -webkit-app-region: no-drag;
}

.wbtn {
  width: 44px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
}

.wbtn:hover {
  background: var(--hover);
}

.wbtn.close:hover {
  background: #e81123;
  color: #fff;
}

.wbtn i {
  width: 10px;
  height: 10px;
  display: block;
  position: relative;
}

.i-min::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4.5px;
  width: 10px;
  height: 1px;
  background: currentColor;
}

.i-max::before {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid currentColor;
  border-radius: 1px;
}

.i-restore::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  width: 8px;
  height: 7px;
  border: 1px solid currentColor;
}

.i-restore::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 0;
  width: 8px;
  height: 7px;
  border: 1px solid currentColor;
  background: var(--panel-2);
}

.i-close::before,
.i-close::after {
  content: '';
  position: absolute;
  left: 0;
  top: 4.5px;
  width: 11px;
  height: 1px;
  background: currentColor;
}

.i-close::before {
  transform: rotate(45deg);
}

.i-close::after {
  transform: rotate(-45deg);
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

/* 提示语是锁屏上唯一有用的信息，给它一块独立区域而不是塞进正文里 */
.hintbox {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 12px;
  border-radius: 8px;
  background: var(--accent-soft);
  border: 1px solid var(--line);
  text-align: left;
}

.hintlabel {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}

.hinttext {
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.6;
  word-break: break-word;
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
