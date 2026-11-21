# 音色授权清单（Voice & Engine License Manifest）

> 本文档是 TintTXT 的合规交付物，逐项列出引擎代码、音色权重、训练数据集的许可证、
> 商用/分发结论、模型来源与校验值。所有结论均基于上游一手许可文件核实（附 URL）。
> 最后更新：2026-11-19

---

## 0. 结论摘要

| 档位 | 引擎代码 | 音色权重 | 训练数据 | 可商用 | 随本应用分发 | 本项目默认 |
|---|---|---|---|---|---|---|
| **sherpa-onnx + vits-zh-aishell3** | Apache-2.0（无 GPL 链接） | Apache-2.0 | AISHELL-3 = Apache-2.0 | ✅ 是 | ✅ 是 | **✅ v3 起默认档**（真机 A/B 实测吐字清晰） |
| Piper + zh_CN-huayan | **GPL-3.0 链**（espeak-ng） | **许可不明（Unknown）** | huayan 来源已 404；medium 叠加 lessac **非商用**链 | ❌ medium 不可商用 | ⚠️ 附 GPL 义务（§3.2 已列履行步骤） | ❌ 可选（**真机实测发音不可懂**；x_low 档词表无声调键） |
| 实验：Kokoro v1.1 multi-lang（未接入） | Apache-2.0（复用 sherpa 运行时） | Apache-2.0 | LongMaoData 免费授权（README 声明）+ 合成英文数据 | ✅ 是（Apache-2.0 条件内） | ⚠️ `models/kokoro/` 默认被 build 排除，`--with-kokoro` 才带 | ❌ 实验资产（§7） |
| 用户自备模型导入 | 不适用 | 用户自行提供 | 用户自行提供 | 由用户自负 | ❌ 不分发 | ✅ 支持 |

**v3 默认档说明（如实记录）**：默认 = **sherpa-onnx + aishell3（int8）**。真机 A/B 试听结论：
Piper 发音不可懂（"鸟语"），sherpa 吐字清晰 —— **听得懂优先于流畅**。Piper 的速度优势
（多线程 RTF≈0.1）与 sherpa 的清晰度各自保留为可选项；界面卡顿已由 Web Worker 根治，
与引擎选择解耦。

---

## 1. 默认引擎：sherpa-onnx（TTS 运行时）

| 项 | 值 |
|---|---|
| 组件 | sherpa-onnx（WASM TTS 构建，`wasm/tts`） |
| 许可证 | **Apache License 2.0** |
| 上游 | https://github.com/k2-fsa/sherpa-onnx （LICENSE：https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/LICENSE） |
| 文本前端 | **lexicon 模式**（`usePhonemize = false`），不链接、不分发 espeak-ng / piper-phonemize |
| 核实依据 | 官方 wasm/tts README 明确「option 2: lexicon — set usePhonemize = false … Neither option uses the espeak-ng-data」：<https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/wasm/tts/assets/README.md> |
| GPL 规避依据 | sherpa-onnx 自 v2.0.0 起移除内置 espeak-ng：`That library is GPL, so it stays optional: sherpa-onnx is GPL-free after this PR` — <https://github.com/k2-fsa/sherpa-onnx/commit/0b3647632f084758e573a588ee5c9425dadc5908> |
| 推理运行时 | onnxruntime-web（**MIT**）— <https://registry.npmjs.org/onnxruntime-web/1.18.0> |
| 商用 | ✅ 允许（Apache-2.0 明确授予专利与商用权） |

**本项目对它的修改（GPL §5 无关，Apache-2.0 §4 修改标注义务）**：
- 自托管副本 `tts/sherpa/sherpa-onnx-tts.js` 中显式关闭 phonemize 路径（若需改动，改动点记录于 `docs/engine-switch-notes.md`）；
- 按 Apache-2.0 要求在分发包中保留 NOTICE/版权声明（见 §5）。

## 2. 默认音色权重：vits-zh-aishell3

| 项 | 值 |
|---|---|
| 模型 | `vits-aishell3.int8.onnx`（默认，39.3MB）/ `vits-aishell3.onnx`（可选 full，约 121MB） |
| 模型许可证 | **Apache-2.0**（模型卡 `license: apache-2.0`） |
| 来源 | https://huggingface.co/csukuangfj/vits-zh-aishell3 （国内镜像 https://hf-mirror.com/csukuangfj/vits-zh-aishell3 ） |
| 训练数据集 | **AISHELL-3**（OpenSLR SLR93），许可证 **Apache License v2.0** — https://openslr.org/93/ |
| 训练链 | 纯 AISHELL-3 训练，**无 lessac / Baker / CC-BY-NC 祖先** |
| 商用 | ✅ 允许 |
| 随本应用分发 | ✅（`scripts/fetch-sherpa-assets.mjs` 从上游镜像拉取；`models/sherpa-zh/MANIFEST.json` 记录来源与校验值） |

**文本前端所需附属文件（同仓库，同为 Apache-2.0 模型包一部分）**：
`lexicon.txt`、`tokens.txt`、`rule.far`、`date.fst`、`new_heteronym.fst`、`number.fst`、`phone.fst`。

**校验值**：见 `models/sherpa-zh/MANIFEST.json`（下载时生成：文件名、字节数、来源 URL、sha256/字节数校验结果）。

## 3. 可选（非默认）引擎：Piper + zh_CN-huayan —— 含 GPL 义务与许可风险

> 按「默认选许可证干净的档位」要求，本档**不作为默认**，仅保留为可选引擎；
> 若用户主动下载启用，须知晓以下义务与风险。

### 3.1 引擎与运行时的许可证

| 组件 | 许可证 | 证据 |
|---|---|---|
| rhasspy/piper（归档版） | MIT | https://github.com/rhasspy/piper/blob/2023.9.9-1/LICENSE.md |
| OHF-Voice/piper1-gpl（继任者） | **GPL-3.0**（v1.3.0 起） | https://github.com/OHF-Voice/piper1-gpl 、 https://newreleases.io/project/github/OHF-Voice/piper1-gpl/release/v1.3.0 |
| @diffusionstudio/piper-wasm（本项目采用的浏览器封装） | 声明 MIT，**但内嵌 GPL 组件** | https://registry.npmjs.org/@diffusionstudio/piper-wasm |
| **espeak-ng**（音素化，编译链接进 piper_phonemize.wasm） | **GPL-3.0-or-later** | https://raw.githubusercontent.com/espeak-ng/espeak-ng/master/COPYING |
| **espeak-ng-data**（数据文件，打进 .data 包） | **GPL-3.0 覆盖** | Fedora 打包声明：https://packages.fedoraproject.org/pkgs/espeak-ng/espeak-ng-devel/ |
| piper-phonemize | MIT 本体，但链接 espeak-ng（`MIT AND GPL-3.0-only`） | https://github.com/rhasspy/piper-phonemize/blob/master/LICENSE.md 、 https://pkgs.alpinelinux.org/package/edge/testing/ppc64le/piper-phonemize |
| onnxruntime-web | MIT | 同 §1 |

### 3.2 分发时的开源义务（GPLv3 §4/§6）

espeak-ng 被**编译链接进同一个 `piper_phonemize.wasm`**（构建脚本 `--preload-file espeak-ng-data`，数据打入同一 `.data` 包），
属 FSF 定义的「combining」而非「mere aggregation」（<https://www.gnu.org/licenses/gpl-faq.html#MereAggregation>），
因此**整个 wasm 二进制按 GPL-3.0 分发**。浏览器下载 `.wasm/.data` 构成「传输副本」（convey），触发义务：

1. **随附 GPL-3.0 全文**与全部版权声明；
2. **提供对应源码（Corresponding Source）**：espeak-ng 源码、piper-phonemize 源码、以及可复现该 wasm 的构建脚本（或按 §6 提供三年有效的书面要约）；
3. 若对上述组件有改动，**按 §5 在源码中标注修改**（本项目对 `piper-runtime.js` 的适配层改动属此列）；
4. **NOTICE/THIRD_PARTY_LICENSES** 汇总声明（见 §5）。

**已知事实**：本项目当前 `tts/` 目录分发的 `piper_phonemize.wasm/.data` 即属上述范围。
若随包分发 Piper 档，必须执行 1–4；若不希望承担该义务，请仅使用默认的 sherpa-onnx 档（不含任何 GPL 文件）。

### 3.3 音色权重的许可风险（huayan）

| 档位 | MODEL_CARD 声明 | 训练链 | 商用结论 |
|---|---|---|---|
| zh_CN-huayan-medium（63.2MB） | `License: Unknown` | 微调自 lessac（**Blizzard 2013 明确排除商业用途**） | ❌ **不可商用** |
| zh_CN-huayan-x_low（20.6MB） | `License: Unknown` | 从零训练，但数据集条款未知（上游 HuaYan_TTS 仓库已 404） | ⚠️ **许可不明，不建议分发** |

证据（一手）：
- medium MODEL_CARD：https://huggingface.co/rhasspy/piper-voices/raw/main/zh/zh_CN/huayan/medium/MODEL_CARD
- x_low MODEL_CARD：https://huggingface.co/rhasspy/piper-voices/raw/main/zh/zh_CN/huayan/x_low/MODEL_CARD
- lessac/Blizzard 2013 非商用条款：https://www.cstr.inf.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html
- Piper 官方点名 huayan 无记录许可：https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/COMMERCIAL_USE.md
- 音色权利不来自仓库 MIT：`The Piper project makes no license grant of its own over voice models` — https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/LICENSING.md
- 上游数据仓库 404：https://huggingface.co/rhasspy/piper-voices/discussions/34

**因此：本应用默认不下载、不分发 huayan 音色**；Piper 档如被用户主动启用，仅限个人非商业用途，
并需自行承担 §3.1–3.3 的义务与风险。文档与 UI 均已标注。

### 3.4 规避 GPL 的替代（记录在案）

- **已采纳**：默认档 sherpa-onnx lexicon 前端 + aishell3（全 Apache-2.0），见 §1–§2；
- 其他许可干净的中文音色（供用户自备导入时参考）：
  - **Kokoro-82M**：Apache-2.0（权重与音色），含 8 个中文音色 — https://huggingface.co/hexgrad/Kokoro-82M
  - **MeloTTS**：MIT，明确允许商用 — https://github.com/fakharimran77/melotts
  - Piper `zh_CN-chaowen-medium`：数据集 CC0（但微调自 hifi_tts_92 = CC BY 4.0，需署名；仍依赖 espeak-ng GPL）
  - ❌ ChatTTS：模型 CC BY-NC 4.0，**不可商用** — https://pypi.org/project/chattts/0.2.1/
  - ❌ matcha-icefall-zh-baker：`non-commercial use only` — https://huggingface.co/csukuangfj/matcha-icefall-zh-baker/raw/main/README.md

## 4. 用户自备音色模型（自定义导入）

| 项 | 说明 |
|---|---|
| 功能 | 设置 → 自定义音色模型：用户选择本地 `.onnx` + `.onnx.json`（Piper 格式）配对文件 |
| 存储 | 仅存本机浏览器 Cache Storage（`tinttxt-tts-custom-v1`），**不上传、不随包分发** |
| 法律定性 | GPLv3 §2：`You may make, run and propagate covered works that you do not convey, without conditions` —— 应用在用户本机内存中加载用户自备文件**不构成分发**，应用不因用户选择而承担再分发义务 |
| UI 声明 | 已提示「模型文件仅保存在本机浏览器缓存中，不会上传；应用不附带这些模型，请自行确认所选模型的授权允许你的用途」 |
| 用户责任 | 音色的许可合规（商用/再分发）由用户自行判断与承担 |

## 5. 分发必附声明文件清单

随 `dist/` 分发时必须包含：

1. **`THIRD_PARTY_LICENSES.md`**（本文件）；
2. **GPL-3.0 全文**（`licenses/GPL-3.0.txt`）——**仅当**随包分发 Piper/espeak-ng 档资产时必需；
3. **Apache-2.0 全文**（`licenses/Apache-2.0.txt`）——sherpa-onnx、onnxruntime-web、aishell3 模型；
4. **MIT 全文**——onnxruntime-web 等（并入 THIRD_PARTY_LICENSES）；
5. **各音色 `MODEL_CARD`**（随模型文件存放于 `models/<模型目录>/MODEL_CARD`）——Piper 官方要求再分发 .onnx 必须附带；
6. **NOTICE**（Apache-2.0 的署名与修改标注）；
7. 若对 `tts/sherpa/sherpa-onnx-tts.js` 或 `tts/piper-runtime.js` 有本地修改：修改说明写入 `docs/engine-switch-notes.md` 并在对应源文件头部注释标注。

## 6. 联网与隐私边界（与音色无关但同属合规）

- **运行期零外联（首次下载之后）**：运行时所有资源（运行时 js/wasm、模型）均同源自托管；
  **首次下载**模型/运行时时按「hf-mirror 镜像优先、同源兜底」尝试（仅二进制资源，不含任何用户文本，
  用户点「下载模型」即视为同意），下载写入缓存后运行期不再有任何外部请求；
  `scripts/fetch-*.mjs`（Node 端、用户显式执行）同样使用该镜像。
- **云端 TTS**：默认关闭；开启前弹出隐私确认（「开启后每段文本将发送到你配置的云端服务器」），需用户显式确认。
- **文本不出设备（非硬约束）**：本地档下合成全程在浏览器内完成，TXT 内容不发送到任何服务器；云端 TTS 时文本会发送到第三方服务器（用户显式开启）。
- `speechSynthesis` 预览档：仅本地朗读，不上传文本（但不满足熄屏约束，UI 已标注）。

---

## 7. 实验资产（未接入默认链路）：Kokoro v1.1 multi-lang

> 状态：**实验**。链路已打通（配置/NaN/词典均验收通过）但因单线程 wasm RTF≈3.3 未接入播放链路；
> `build.mjs` **默认排除 `models/kokoro/`**，只有显式 `--with-kokoro` 才会进入 dist 随包分发。

| 项 | 值 |
|---|---|
| 引擎代码 | 复用 sherpa-onnx WASM 运行时（Apache-2.0，见 §1，无新增代码许可） |
| 模型权重 | `csukuangfj/kokoro-multi-lang-v1_1`（fp32，310.5MB）与 `csukuangfj/kokoro-int8-multi-lang-v1_1`（108.9MB）；**仓库 LICENSE 实测为 Apache License 2.0**（已存 `models/kokoro/LICENSE`） |
| 训练数据 | 中文 100 音色来自 LongMaoData「freely and permissively granted」+ 约 3 小时众包合成英文数据（hexgrad/Kokoro-82M-v1.1-zh README 原文）；**无 non-commercial 条款** |
| 残留风险（低） | LongMaoData 授权仅 README 一句话描述，**无可核验的授权文本**；音色名（zf_001 等）为编号，**不得描述为「真人授权音色」** |
| espeak-ng-data（7 文件，随 `--with-kokoro` 分发时） | **espeak-ng 数据文件受 GPL-3.0 覆盖**（同 §3.2 定性）：若随包分发须履行 §3.2 义务；不带则不受影响（v2.0.0+ 运行时已不读取） |
| 可商用 / 分发 | ✅ 在 Apache-2.0 条件内允许（保留 LICENSE + NOTICE + 标注修改）；附负责任使用声明：**禁止冒充真实录音/他人声音** |
| 校验值 | `models/kokoro/MANIFEST.json`（每文件字节数 + sha256；下载器 `scripts/fetch-kokoro-assets.mjs` 每次自动核验） |
| 来源直链 | `https://hf-mirror.com/<repo>/resolve/main/<file>`（国内镜像，非境外 CDN 直连） |

---

## 附录 A：校验值获取方式

```bash
# 重新生成/核对模型校验清单
node scripts/fetch-sherpa-assets.mjs --verify
# 输出 models/sherpa-zh/MANIFEST.json：每文件的字节数、来源 URL、sha256
```

## 附录 B：核实方法与证据强度说明

| 结论 | 证据强度 |
|---|---|
| sherpa-onnx Apache-2.0 / lexicon 可绕开 espeak-ng | 强（LICENSE 原文 + 官方 README + 官方 commit） |
| aishell3 模型与数据集 Apache-2.0 | 强（模型卡 + OpenSLR 官方页） |
| espeak-ng GPL-3.0 且数据文件同受覆盖 | 强（COPYING 原文 + Fedora 打包声明） |
| huayan 许可 Unknown / medium 非商用链 | 强（MODEL_CARD 原文 + Blizzard 官方许可 + Piper 官方文档） |
| Kokoro Apache-2.0 / 无 NC 条款 | 中（上游 LICENSE 文件原文 + hexgrad README；LongMaoData 授权无独立文本，见 §7 残留风险） |
| 「链接成单一程序不适用聚合例外」 | 强（FSF FAQ + 构建脚本事实）+ 法律适用属推断（无判例） |
| 用户本机加载自备文件不构成分发 | 强（GPLv3 §2 原文）+ 适用分析（无判例） |
