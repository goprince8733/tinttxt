# Kokoro 本地化可行性实验记录（2026-11-20）

> 结论先行：**Kokoro 是免费中文音质天花板（Apache-2.0 可分发），配置/链路全部打通，
> 但单线程 wasm 实测 RTF≈3.3 且与模型精度无关 → 连续听书不可用；
> 免费极致路线的唯一出路是 WebGPU（本机硬件已实测可用）。**

## 1. 已打通的部分（全部实测通过）

| 项 | 结果 |
|---|---|
| 资源下载 | `scripts/fetch-kokoro-assets.mjs`（curl.exe + 字节/sha256 双校验），hf-mirror 直链，16 文件就位 `models/kokoro/` |
| 运行时 | **现有 sherpa-onnx wasm 不用换**（字符串扫描内置 kokoro；config 解析正确，`sampleRate=24000`、`numSpeakers=103`） |
| 配置要点 | 必须**显式传 kokoro config 且其余子配置全空**（否则被 vits→matcha→zipvoice 抢选型）；`dataDir:'./espeak-ng-data'`（旧运行时 Validate 强制，缺了报 "Please provide --kokoro-data-dir"） |
| espeak-ng-data | 只需7个核心文件 ≈2.4MB（phondata/manifest/phonindex/phontab/intonations + cmn_dict + en_dict），下载脚本已内置 |
| NaN 验收 | int8 **与** fp32 均 0 NaN（3段文本、peak 0.33~0.40）——上游 #4086 的 NaN 病根在本构建未复现，但仍建议接入后常驻校验 |
| 中文前端 | lexicon-zh 转 token 正常（探针日志可见 ConvertTextToTokenIds 输出） |
| 许可 | Apache-2.0（仓库 LICENSE），可公开分发；需保留 LICENSE + 来源标注 |
| 防误传 | `build.mjs` 默认排除 `models/kokoro/`（17文件/480MB含fp32），`--with-kokoro` 才带 |

## 2. 速度：核心否定性实验（int8 vs fp32）

同一台机、同一段文本、同一运行时（单线程 wasm，无 pthread）：

| 文本 | int8（109MB） | fp32（310MB） | 音频时长 |
|---|---|---|---|
| 18 字 | 13.19s / **RTF 3.31** | 12.82s / **RTF 3.22** | 3.98s |
| 30 字 | 22.58s / **RTF 3.27** | 24.24s / **RTF 3.51** | 6.9s |
| 75 字 | 54.12s / **RTF 3.21** | 55.91s / **RTF 3.32** | 16.85s |

**结论：换 fp32 对速度零收益（3.3 ≈ 3.3）。** 调研里"int8 比 fp32 慢2.4×"是原生 CPU（M1/x86 VNNI）结论，
不迁移到 wasm（两条路在 wasm 上同样受单线程算力封顶）。瓶颈 = **单线程 wasm 本身 ≈ 树莓派4 算力**
（树莓派4 原生4线程 RTF 3.19，与我们几乎相同）。

推论：
- wasm 路线保持 **int8**（体积109MB vs 310MB，速度一样）；
- fp32 模型保留（`models/kokoro/model.onnx`）——**它是 WebGPU 路线要用的同一文件**；
- 句级流水线/预缓冲只能改善观感，改不了 RTF>1 的断档数学；多线程 wasm（需重编+2×收益）也到不了 RTF<1。

## 3. 别人为何"能用"（调研交叉验证）

- **场景不同**：Timeline Studio = 视频配音一次性离线渲染（等进度条，不追求实时），且它自己在 v1.0.3 已把中文换成 WebGPU 方案；浏览器 demo = 短句；服务端原生 RTF 0.1~0.7。
- **硬证据**（同机同模型）：wasm 单线程 RTF 2.0 连播150秒 → 361/361 片段全部迟到；WebGPU RTF 0.105 → 1230/1230 全部提前就绪（briantung.me/blog/tts-engines-in-the-browser/）。
- **主流解法**：WebGPU（RTF 0.1~0.4）、多线程 wasm（≈1.0）、离线渲染、短句容忍。

## 4. 本机 WebGPU 实测（路线前提，已验证）

`node .tooling/e2e/webgpu-probe.mjs`：
- navigator.gpu ✓，**真实 NVIDIA GPU 适配器**（非 SwiftShader；需 headless 加 `--enable-unsafe-webgpu`，普通 Chrome/Edge 默认开启）
- 计算验证：1024³ 矩阵乘 ×50 轮平均 **1.59ms ≈ 6.7 TFLOPS**，checksum 正确
- buffer 上限 2GB（fp32 模型310MB + 激活绰绰有余）
- ORT WebGPU EP 官方支持列表第一列 = Windows Chrome/Edge（正是目标环境）；Safari/Firefox 需 wasm 回退

## 5. 路线（按性价比）

1. ~~int8→fp32 提速~~ —— **已完成，否定**（见 §2）
2. **句级流水线 + 预缓冲**（首句即播、后台流水）——改善观感，2~3天
3. **WebGPU 主路线**：fp32 模型 + onnxruntime-web WebGPU EP + 保留 sherpa 的 lexicon-zh 中文前端，
   能力探测自动降级 wasm —— **唯一能达到 RTF<1 的免费路径**，1~2周
4. 不为速度换模型（matcha 数据集非商用 / piper 许可 Unknown / ZipVoice 需克隆参考音频）
5. 付费云端 TTS：方案在 `docs/cloud-tts-payment-plan.md`，接口按原计划完成，排在免费极致之后

## 6. 工具与探针

| 工具 | 用途 |
|---|---|
| `scripts/fetch-kokoro-assets.mjs [--tier fp32]` | 下载+双校验（curl.exe 无人值守） |
| `.tooling/e2e/kokoro-probe.mjs [--tier-fp32]` | 浏览器端配置/NaN/RTF 三段式验收 |
| `.tooling/e2e/webgpu-probe.mjs [--vulkan]` | WebGPU 适配器 + 真实算力验证 |
| `models/kokoro/MANIFEST.json` | 文件清单 + sha256 |
