# 默认 TTS 引擎切换说明：Piper → sherpa-onnx wasm + vits-zh-aishell3

> 给主代理（lead）的接线与验收说明。所有结论均来自**实际下载并通读的上游源码**与**本地跑通的冒烟测试**，不是推测。
> 交付物仅 4 项：`src/layers/playback/tts/sherpa.js`、`scripts/fetch-sherpa-assets.mjs`、
> 运行时/模型资产（`tts/sherpa/`、`models/sherpa-zh/`）、本文档。其余文件只读未改。

---

## 1. 文件清单、字节数与校验结果

### 1.1 运行时 → `tts/sherpa/`

| 文件 | 字节数 | 校验 | 来源 |
| --- | ---: | --- | --- |
| `sherpa-onnx-tts.js` | 33,227 | ✅ 字节数通过（tree API `size`；非 LFS 无 sha256） | hf-mirror Space `k2-fsa/web-assembly-zh-en-tts-zipvoice` |
| `sherpa-onnx-wasm-main-tts.js` | 111,298 → **111,312**（打补丁后） | ✅ 字节数通过（补丁前 111,298） | 同上 |
| `sherpa-onnx-wasm-main-tts.wasm` | 13,473,435 | ✅ **sha256 + 字节数双通过** `d60db5247fa13e92ad291f8cb5cfe2f6823934c0fa430b177724929a587ab9fb`（= hf tree API `lfs.oid`） | 同上 |
| `sherpa-onnx-wasm-main-tts.data` | **0** | ✅ 本地生成的空占位（见 §4） | 本地生成 |

### 1.2 模型 → `models/sherpa-zh/`（`csukuangfj/vits-zh-aishell3`，license: **apache-2.0**，仓 sha `ae95e353daa4…`）

| 文件 | 字节数 | 校验 |
| --- | ---: | --- |
| `vits-aishell3.int8.onnx`（默认档） | 39,870,124 | ✅ **sha256 + 字节数双通过** `5ef667dbbe0795688da93d779828cf38e6ad8ef8e82aa7dc5804873a50556057` |
| `lexicon.txt` | 2,042,943 | ✅ 字节数通过 |
| `tokens.txt` | 1,671 | ✅ 字节数通过 |
| `phone.fst` | 88,630 | ✅ 字节数通过 |
| `date.fst` | 59,154 | ✅ 字节数通过 |
| `number.fst` | 64,482 | ✅ 字节数通过 |
| `new_heteronym.fst` | 21,974 | ✅ 字节数通过 |
| `MANIFEST.json` | 3,510 | ✅ 已生成（文件名/字节数/来源 URL/sha256/下载时间，含运行时与模型两组） |
| `vits-aishell3.onnx`（full 档，121,383,104） | — | ⬜ **未下载**（默认 int8；`--tier full` 可补） |
| `rule.far` | 180,717,014 | ⬜ **未下载**（`--with-rule-far` 可补）——见下方说明 |

**失败/未下载项如实说明**

1. `rule.far` 实测 **180,717,014 字节（172MB）**，比模型本身还大，是上游**英文**文本正则化的 FAR 归档；
   适配器 `ruleFars` 传空串、中文只用 `phone/date/number` 三个 FST，运行时完全不需要它。
   默认不下载（脚本会打印 skip 提示），需要时 `node scripts/fetch-sherpa-assets.mjs --with-rule-far`。
2. `vits-aishell3.onnx`（121MB）默认不下载，`--tier full` 可补。
3. 过程性失败（已修复，如实记录）：第一次跑脚本时用 resolve 直链的 `ETag` 当 sha256 校验，
   误报 wasm 与 int8 模型「sha256 不符」。查明该 `ETag` 实为 **xet 哈希**而非文件 sha256；
   改为读 **tree API 的 `lfs.oid`**（实测与本地 `Get-FileHash` 完全一致）后重跑，
   两个文件均「续传完成 + sha256+字节校验通过」，0 失败。
4. 任务书里给的 Space `k2-fsa/web-assembly-tts-sherpa-onnx` **不存在**（`/api/spaces?author=k2-fsa`
   全量列表里 TTS wasm 空间只有 `web-assembly-zh-en-tts-zipvoice` 与 `web-assembly-en-tts-pocket`），
   改用前者（k2-fsa 官方静态空间，resolve 直链可达，无需认证）。
5. 备选路径 GitHub release `v2.0.1/sherpa-onnx-wasm-simd-2.0.1-vits-piper-en_US-libritts_r-medium.tar.bz2`
   （85,592,265 字节，含同版本三件套）下载到 52,477,952 字节时连接中断，**未纳入交付**；
   它是 `.tar.bz2`，解包需要本机 `tar`，与本项目「零依赖脚本」风格不符，故运行时来源定为 HF Space 直链。

---

## 2. 运行时真实 API（已通读源码 + 跑通）

### 2.1 模块加载（照抄上游 `wasm/tts/sherpa-onnx-tts.worker.js`）

```js
self.Module = {
  locateFile: (path, scriptDirectory = '') => scriptDirectory + path,
  setStatus: (status) => { /* 进度 */ },
  onRuntimeInitialized: () => { /* 此时 wasm + 预载包就绪 */ },
};
importScripts('sherpa-onnx-wasm-main-tts.js');  // ① Emscripten 胶水（必须先）
importScripts('sherpa-onnx-tts.js');            // ② OfflineTts 封装
// onRuntimeInitialized 之后：
tts = createOfflineTts(self.Module);            // 或 createOfflineTts(Module, myConfig)
```

浏览器里等价于：先挂 `window.Module` → 依次注入两个 `<script>`（同源 `/tts/sherpa/`）→
等 `onRuntimeInitialized`。**`window.Module` 必须在胶水脚本执行前就位**（胶水用
`var Module = typeof Module != 'undefined' ? Module : {}` 固定住它，之后再改无效）。

### 2.2 初始化

```js
// sherpa-onnx-tts.js
function createOfflineTts(Module, myConfig) // 返回 OfflineTts；myConfig 存在时**整体替换**默认配置
class OfflineTts {
  constructor(configObj, Module)             // 内部 initSherpaOnnxOfflineTtsConfig() + _SherpaOnnxCreateOfflineTts()
  get handle                                 // 句柄，0/undefined 表示创建失败
  get sampleRate                             // = Module._SherpaOnnxOfflineTtsSampleRate(handle)
  get numSpeakers                            // 本模型 = 174
  free()                                     // 销毁实例（释放 wasm 侧内存）
  generate(config)                           // 同步；见 2.3
  generateWithConfig(text, genConfig)        // 带 callback/参考音频的进阶入口
}
```

**vits 配置字段**（`initSherpaOnnxOfflineTtsVitsModelConfig` 实际编组的结构，按顺序）：
`{ model, lexicon, tokens, dataDir, noiseScale=0.667, noiseScaleW=0.8, lengthScale=1.0, dictDir(恒空) }`
外层：`{ offlineTtsModelConfig: { offlineTtsVitsModelConfig, …, numThreads, debug, provider },
ruleFsts, ruleFars, maxNumSentences, silenceScale }`（支持短别名 `vits` / `model`）。

我们实际传入的 config（`src/layers/playback/tts/sherpa.js` 的 `createInstance()`）：

```js
{
  offlineTtsModelConfig: {
    offlineTtsVitsModelConfig: {
      model: './model.onnx', lexicon: './lexicon.txt', tokens: './tokens.txt',
      dataDir: '',            // ← 关键：置空，绝不指向 espeak-ng-data
      noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0,
    },
    numThreads: 1,            // 该 wasm 构建未启用 -pthread，恒单线程
    debug: 0, provider: 'cpu',
  },
  ruleFsts: './phone.fst,./date.fst,./number.fst',
  ruleFars: '',               // 不用 rule.far
  maxNumSentences: 1,
}
```

### 2.3 合成

```js
// sherpa-onnx-tts.js
generate(config) {
  // config = { text: string, sid?: number=0, speed?: number=1.0 }
  // 内部：_SherpaOnnxOfflineTtsGenerateWithConfig(handle, textPtr, cfgWasm.ptr, 0, 0)
  // 返回：{ samples: Float32Array, sampleRate: number }   ← 同步返回，不是 Promise
  // 失败：直接 throw new Error('TTS generation failed') / 'config.text is required'
}
```

适配器 `synthesize(text, {voice, rate, signal, onProgress})` →
`{ blob: WAV Blob, mime: 'audio/wav', durationSeconds, chars }`（自写 RIFF/PCM/单声道/16-bit 头，
与 `src/layers/playback/wav.js` 的 `parseWav`/`mergeWavParts` 兼容，冒烟测试已验证可解析）。

**语速映射**（`sherpa-onnx/csrc/offline-tts-vits-model.cc` L86–90 原文）：

```cpp
float length_scale = config_.vits.length_scale;
if (speed != 1 && speed > 0) { length_scale = 1. / speed; }
```

即 `speed` 会**覆盖**配置里的 `lengthScale`，且两者互为倒数。因此适配器
`speed = clamp(rate, 0.5, 2)` ⇒ 生效 `lengthScale = 1/rate ∈ [0.5, 2]`，与要求的
「rate 越快 lengthScale 越小（1/rate，夹在 0.5–2）」完全等价，且不用为改语速重建实例。

**`maxNumSentences` 语义**（`sherpa-onnx/csrc/offline-tts.cc` L211–214 原文）：

> "Maximum number of sentences that we process at a time. This is to avoid OOM for very
> long input text. If you set it to -1, then we process all sentences in a single batch."

是**批窗口**、不是截断上限；设 1 表示逐句处理，长文本不会丢句。

### 2.4 单线程

`wasm/tts/CMakeLists.txt` 的 `MY_FLAGS` 里只有
`FORCE_FILESYSTEM / INITIAL_MEMORY=512MB / ALLOW_MEMORY_GROWTH / STACK_SIZE / ALLOW_TABLE_GROWTH /
EXPORTED_FUNCTIONS / --preload-file / EXPORTED_RUNTIME_METHODS`，**没有任何 `-pthread`**，
且运行时胶水里 `PThread`/`SharedArrayBuffer` 出现次数为 0 → 只能单线程。
适配器恒定 `numThreads: 1`（满足「crossOriginIsolated=false 时降为 1」的要求，任何情况都不越界）。

---

## 3. `usePhonemize` 开关的位置与我们如何关闭

- **master 版** `wasm/tts/sherpa-onnx-tts.js`（41,427 字节）：
  - 第 **1103** 行 `let usePhonemize = true;`，紧跟 `function setUsePhonemize(value) { usePhonemize = value; }`
  - `createOfflineTts` 的 `case 0`（vits）：`modelUsesPhonemize = usePhonemize; if (!usePhonemize) vits.lexicon = './lexicon-en-us.txt';`
  - **注意**：这个开关只决定「默认配置里填不填 lexicon」；真正的 espeak/piper-phonemize 音素化
    发生在 demo 的 `app-tts.js` 里（它 `importScripts('piper-phonemize/piper-phonemize.js')` 并把
    `phonemeCodepoints` 传给 `generateWithConfig`）——**我们不加载 piper-phonemize，也不走那条路**。
- **本项目实际分发的副本**（Space 构建，33,227 字节）：`usePhonemize` / `setUsePhonemize`
  **grep 命中数 = 0**（这个开关是后来才加进 master 的），它的 `case 0` 写的是
  `vits.dataDir = './espeak-ng-data'`。
- **我们如何关闭/规避（四重保险）**：
  1. 传自定义 `myConfig` **整体替换**默认配置：`dataDir: ''` + `lexicon: './lexicon.txt'`
     → C++ 侧走 lexicon 前端，`dataDir` 为空不会去读 espeak-ng-data；
  2. 适配器里 `if (typeof window.setUsePhonemize === 'function') window.setUsePhonemize(false);`
     —— 当前副本是空操作，**将来若换成带开关的新版胶水会自动生效**；
  3. 不分发也不加载 `index.html` / `app-tts.js` / `piper-phonemize/*`（上游 demo 才需要）；
  4. 给 Emscripten 胶水打补丁清掉预载清单（含 `/espeak-ng-data/**`，见 §4）。

**为什么不能直接用 master 的 `sherpa-onnx-tts.js`**：它在 `OfflineTts` 构造里无条件调用
`Module._SherpaOnnxOfflineTtsLang(...)`，而本 wasm 的导出表里**没有**这个符号
（实测 `SherpaOnnxOfflineTtsLang` 在胶水中出现 0 次），会直接 TypeError。
**胶水与 wasm 必须整套同版本**，这是升级时的硬约束。

---

## 4. 自托管副本的改动清单（§5 修改标注义务）

| # | 文件 | 改动 | 原因 | 可验证标记 |
| --- | --- | --- | --- | --- |
| 1 | `tts/sherpa/sherpa-onnx-wasm-main-tts.js` | 把 `metadata["files"]` 替换为 `[]/*tinttxt-no-preload*/`（**2 处**，只改 JSON 数据字面量，不动控制流） | 上游用 `--preload-file assets@.` 把「英文模型 + espeak-ng-data 目录清单」写进胶水，运行时会在虚拟 FS 建约 600 个文件；我们不分发任何上游预载资源 | 文件内可 grep `tinttxt-no-preload`；字节数 111,298 → 111,312（每处 +7）；脚本幂等（已打补丁会 skip） |
| 2 | `tts/sherpa/sherpa-onnx-wasm-main-tts.data` | 生成 **0 字节**占位文件 | 不分发上游预载包；适配器用 `Module.getPreloadedPackage = () => new ArrayBuffer(0)` 短路下载，空文件只是兜底（没有它，Emscripten 会 fetch 该路径并 404 导致初始化失败） | sha256 = `e3b0c442…`（空串） |
| 3 | `tts/sherpa/sherpa-onnx-tts.js` | **未改动**（与上游逐字节一致，sha256 见 MANIFEST） | 无需改动即可满足 lexicon 前端（靠 §3 的 config 覆盖） | — |
| 4 | 运行时来源 | 不加载 piper-phonemize、不携带 espeak-ng-data | 许可证要求 | `tts/sherpa/` 下仅 4 个文件 |

模型侧运行时注入：适配器用 `Module.FS_createDataFile('/', name, u8, true, true, true)` 把
`model.onnx / lexicon.txt / tokens.txt / phone.fst / date.fst / number.fst` 写进 Emscripten 虚拟 FS
（重复写入会先 `FS_unlink` 再建 —— 冒烟测试已验证该降级路径可用）。

---

## 5. 给主代理的 `app.js` 接线片段（可直接照抄）

```js
/* ---------- 顶部 import（新增一行，piper 那行保留） ---------- */
import { createLocalSherpaAdapter, SHERPA_TIERS } from './layers/playback/tts/sherpa.js';
import { createLocalPiperAdapter, MODEL_TIERS } from './layers/playback/tts/local.js'; // 保留为可选引擎

/* ---------- TTS 注册：sherpa 先注册 ⇒ TtsRegistry 自动把它设为默认 active ---------- */
const registry = new TtsRegistry();
const sherpaAdapter = createLocalSherpaAdapter();   // 新默认：本地离线（sherpa-onnx 中文）
const localAdapter = createLocalPiperAdapter();     // 保留：本地离线（Piper 中文），id 仍为 'local-piper'
const previewAdapter = createSpeechPreviewAdapter();
const cloudAdapter = createCloudTtsAdapter({ endpoint: '' });
registry.register(sherpaAdapter);                   // ← 必须排在 localAdapter 之前
registry.register(localAdapter);
registry.register(previewAdapter);
registry.register(cloudAdapter);
// 若不想依赖注册顺序，就在注册完后补一句：registry.setActive('local-sherpa');

/* ---------- resolveAdapter：sherpa 为默认，piper 为用户可选回退 ---------- */
async function resolveAdapter() {
  if (settings.cloudTtsEnabled) {
    registry.setActive('cloud-http');
    return registry.active;
  }
  // 用户在设置里显式选了 Piper → 尊重选择（保留旧引擎）
  if (settings.ttsEngine === 'local-piper') {
    const piperReady = await localAdapter.isReady().catch(() => false);
    if (piperReady || modelState.status === 'downloading') {
      registry.setActive('local-piper');
      return registry.active;
    }
    // piper 未就绪且没在下载：继续往下走 sherpa / 预览
  }
  const ready = await sherpaAdapter.isReady().catch(() => false);
  if (ready) {
    registry.setActive('local-sherpa');
    return registry.active;
  }
  if (modelState.status === 'downloading') {
    registry.setActive('local-sherpa');   // 用户点了下载 → 等它下完，不切预览
    return registry.active;
  }
  registry.setActive('speech-preview');   // 未下载且没在下 → 预览（标注不满足熄屏约束）
  return registry.active;
}

/* ---------- 模型下载 / 状态：改指向 sherpa ---------- */
async function downloadModel(tier = settings.sherpaTier || 'int8') {   // 档位是 'int8'|'full'
  if (modelState.status === 'downloading') return modelState;
  modelState.status = 'downloading';
  modelState.progress = 0;
  modelState.error = null;
  modelState.tier = tier;
  bus.emit(Events.STATE, { model: { ...modelState } });
  try {
    await sherpaAdapter.prepare({
      tier,                                    // SHERPA_TIERS = { int8, full }
      onProgress: (p) => {
        modelState.progress = Math.round(p * 100);
        bus.emit(Events.STATE, { model: { ...modelState } });
      },
    });
    modelState.status = 'ready';
    modelState.progress = 100;
    await resolveAdapter();
    bus.emit(Events.TOAST, { message: '本地模型已就绪（离线可用）', level: 'success' });
  } catch (e) {
    modelState.status = 'error';
    modelState.error = e.message;
    bus.emit(Events.ERROR, { message: `模型下载失败：${e.message}`, recoverable: true });
  }
  bus.emit(Events.STATE, { model: { ...modelState } });
  return modelState;
}

async function checkModel() {
  const ready = await sherpaAdapter.isReady().catch(() => false);
  modelState.status = ready ? 'ready' : 'idle';
  bus.emit(Events.STATE, { model: { ...modelState } });
  return modelState;
}
```

**需要主代理一并决定的设置项**（存储/UI 层，我这边只读不可改）：

- 新增 `settings.ttsEngine`：`'local-sherpa' | 'local-piper'`（默认 `'local-sherpa'`），piper 才有入口；
- 新增 `settings.sherpaTier`：`'int8' | 'full'`（默认 `'int8'`）。现有 `settings.modelTier`
  （`'medium' | 'x_low'`）是 Piper 的档位，**不要复用**，否则 `SHERPA_TIERS[tier]` 会判未知档位抛
  `SHERPA_UNKNOWN_TIER`；
- 音色 id：sherpa 为 `aishell3-int8` / `aishell3-full`，piper 仍为 `huayan-<tier>`。

**对现有 UI 的影响（已核对，均无需我改）**：

- `src/ui/settings.js:69` `if (active.id !== 'local-piper')` 才调 `listVoices()`；
  我们的 `listVoices()` **不会触发 prepare/下载**（只读 Cache Storage 加「（未下载）」后缀），
  所以打开设置页不会静默拉 42MB —— 这条是刻意设计，别改回会下载的写法。
- `src/ui/reader.js:495` 对 `local-piper` 有特判、其余走 `listVoices()`；`local-sherpa` 落在 else 分支，
  同样安全（标签由我们给出，含「（未下载）」）。
- `src/layers/playback/player.js` 逐句合成后用 `mergeWavParts` 拼块，要求**同采样率**；
  sherpa 每次返回的都是模型采样率（恒定），满足该约束。

---

## 6. 验证记录（本机无浏览器，用 Node 跑通了真实运行时）

冒烟脚本（临时，非交付）在 `%TEMP%\sherpa-smoke\smoke.mjs`，用 `vm.runInThisContext` 在全局作用域
执行胶水（等价浏览器 `<script>`），完整复现适配器的加载路径：

```
emscripten glue bytes: 111312
preload patch marker present: true
wasm 初始化完成，用时 47 ms
FS_createDataFile 可用: true / FS_unlink 可用: true
  注入 /model.onnx 39870124 / /lexicon.txt 2042943 / /tokens.txt 1671
  注入 /phone.fst 88630 / /date.fst 59154 / /number.fst 64482
  重复写入 tokens.txt: 抛错后 unlink+重写成功        ← 重试/换档路径可用
createOfflineTts 可用: true
setUsePhonemize 存在: false                          ← 当前副本确实没有该开关
实例句柄: true  sampleRate: 8000  numSpeakers: 174   ← lexicon 前端建实例成功
合成结果: samples=40976 sampleRate=8000 duration=5.12s rms=0.0474 peak=0.220
WAV: tag=RIFF format=1 ch=1 rate=8000 bits=16
parseWav: ok rate=8000 ch=1 bits=16 dataLen=81952    ← 与 wav.js 兼容
SMOKE PASS
```

另外用第二段文本跑过一次（`他一边走一边唱着歌。` → 3.68s / 29,476 samples，
与默认文本的 4.79–5.87s 明显不同），确认**文本真的影响输出**、不是空转。
`node --check` 对 `src/layers/playback/tts/sherpa.js` 与 `scripts/fetch-sherpa-assets.mjs` 均 **exit 0**
（项目 `package.json` 已有 `"type": "module"`，`.js` 按 ESM 解析）。

---

## 7. 未完成项 / 风险 / 降级方案

1. **未在真实浏览器里验证**（本机无浏览器）。冒烟测试覆盖了：运行时初始化、模型注入 FS、
   createOfflineTts、合成、WAV 编码与解析、重复写入降级；**未覆盖**：`<script>` 注入、Cache Storage、
   AbortSignal 竞速、Service Worker 缓存。建议有浏览器的一方做一次
   「打开设置页 → 下载模型 → 播放一段」的手工验收。
2. **采样率 8000 Hz**：模型 ONNX metadata 明确写着 `sample_rate=8000`（`n_speakers=174` 同段），
   上游 sherpa 也按它标注，故播放速度与上游 demo 一致；但听感会偏电话音质。
   如需更高保真，试 `--tier full`（121MB，**未验证其 sample_rate**）；这是模型自身的导出选择，不是本实现的问题。
3. **`rule.far`（172MB）与 `new_heteronym.fst` 已/未下载但不引用**：见 §1、§4。
   若日后想启用 `rule.far`：下载后把适配器 `ruleFars` 改成 `'./rule.far'` 即可（`new_heteronym.fst`
   则加进 `ruleFsts` 末尾）——改之前建议先听效果。
4. **运行时版本偏旧**：来自 k2-fsa 官方静态 Space，比 master 少 `usePhonemize` 等新特性。
   升级必须**整套同版本替换**（`sherpa-onnx-tts.js` + `sherpa-onnx-wasm-main-tts.js` + `.wasm`），
   否则会撞上 §3 说的 `_SherpaOnnxOfflineTtsLang` 缺符号问题。
5. **主线程阻塞**：`tts.generate()` 是同步调用，长句会卡 UI。已按 ≤200 字符分块并在块间
   `await yieldToEventLoop()` 让 AbortSignal/绘制有机会执行；彻底方案是像上游一样搬进 Worker
   （需要把 Cache Storage 与 FS 注入逻辑一起搬，超出本次范围，未做）。
6. **首次 prepare 需联网下载约 56MB**（模型 42.0MB + 运行时 13.6MB），之后 Cache Storage 命中即离线可用；
   运行期零外联（首次下载完成后）：`hf-mirror` 仅用于**首次下载**模型/运行时
   （镜像优先、同源兜底、10s 卡死看门狗），见 README §6 隐私与部署线统一口径；
   下载脚本 `scripts/fetch-sherpa-assets.mjs` 同源镜像一致。
7. **Piper 侧未动**：`src/layers/playback/tts/local.js`、`scripts/fetch-tts-assets.mjs`、
   `models/zh_CN-huayan-*`、`tts/piper*` 全部保持原样，`local-piper` 适配器仍可注册使用。
