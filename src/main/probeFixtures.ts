/**
 * 探针夹具 —— 两个端到端探针共用。
 *
 * 为什么抽出来：媒体探针和界面探针都需要"一段真的能解码的音频"。
 * 各写一份的话，一处改了另一处没跟上，就会出现"一个探针绿、另一个红"，
 * 而红的那个其实只是夹具过期了。
 */

/**
 * 生成一段真实的 WAV（正弦波）。
 *
 * **必须是真文件**：全静音或者伪造的头部会让解码器行为不可预期，
 * 那样"探针失败"就分不清是协议坏了还是夹具坏了（这个坑踩过不止一次 ——
 * 手写 base64 测试 PDF 时也栽在同一类问题上）。
 *
 * 关于 `freq` 为什么默认 400 而不是常见的 440：
 * 200MB 量级的夹具要写一亿个样本，逐样本 `writeInt16LE` 慢到不可用。
 * 所以改成「造一个周期再平铺」。平铺要波形连续，周期就必须是整数个样本 ——
 * 440Hz 在 48kHz 下是 109.09 个样本，平铺会留下断点；
 * 400Hz 在 48kHz 下正好 120 个样本、在 8kHz 下正好 20 个，两种采样率都能整除。
 * 频率取多少与被测的东西无关，只要是一段能解码的真正弦即可。
 */
export function makeWav(seconds: number, sampleRate: number, freq = 400): Buffer {
  const samples = seconds * sampleRate
  const dataSize = samples * 2 // 16 bit 单声道
  const buf = Buffer.alloc(44 + dataSize)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // 单声道
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)

  // 一个完整周期，然后整块平铺 —— 比逐样本写快两个数量级
  const period = Math.max(1, Math.round(sampleRate / freq))
  const one = Buffer.alloc(period * 2)
  for (let i = 0; i < period; i++) {
    one.writeInt16LE(Math.round(Math.sin((2 * Math.PI * i) / period) * 12000), i * 2)
  }
  for (let off = 0; off < dataSize; off += one.length) {
    one.copy(buf, 44 + off, 0, Math.min(one.length, dataSize - off))
  }
  return buf
}
