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
 */
export function makeWav(seconds: number, sampleRate: number): Buffer {
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

  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000)
    buf.writeInt16LE(v, 44 + i * 2)
  }
  return buf
}
