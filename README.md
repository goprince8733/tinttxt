# TintTXT — 网页版 TXT 听书器

HTTPS 网页应用（可添加到桌面），把本地 TXT 小说转成接近原生听书 App 的收听体验。
**默认全离线**：本地合成时文本不出设备（云端 TTS 时文本会发送到服务器），朗读由浏览器内自托管 WASM TTS 引擎合成，产物是真实 `<audio>` 媒体流，因此享受系统媒体后台豁免，熄屏/切后台可持续出声。

---

## 1. 运行方式

### 1.1 本地开发（需要 Node ≥18）

```bash
# 启动开发服务器（自带 COOP/COEP 头，多线程 WASM 必需）
node scripts/dev-server.mjs --port 8080
# 打开 http://127.0.0.1:8080
```

手机真机调试：同一局域网下访问服务器打印的局域网 IP（必须用 HTTPS 或 localhost 才有 MediaSession/WakeLock；开发时可用 `adb reverse` 或自签证书，见 §5）。

### 1.2 下载 TTS 模型（首次使用前）

**默认引擎：sherpa-onnx + AISHELL-3（真机 A/B 实测吐字清晰、听得懂）**

```bash
# 从国内可达镜像 hf-mirror.com 拉取 sherpa-onnx 运行时 + 中文模型
node scripts/fetch-sherpa-assets.mjs
```

| 档位 | 文件 | 体积 | 许可 |
|---|---|---|---|
| int8（默认） | vits-aishell3.int8.onnx | ~39 MB | Apache-2.0（模型+数据集） |
| full（可选） | vits-aishell3.onnx | ~121 MB | Apache-2.0 |

> 引擎选择的实测结论（v3）：**听得懂 > 流畅**。真机 A/B 试听 Piper 发音不可懂
> （“鸟语”；x_low 档词表无声音调键、发音缺损），sherpa 吐字清晰但单线程偏慢
> （桌面 RTF≈1.5 / 手机≈3）。界面卡顿已由 Web Worker 根治、与引擎解耦；
> sherpa 的速度短板由「云端 TTS」补齐、Piper 的音质短板由「Kokoro+WebGPU」补齐。

**可选引擎：Piper 中文（慧妍 huayan）——合成快（多线程 RTF≈0.1），但真机实测发音清晰度差**

```bash
node scripts/fetch-tts-assets.mjs    # Piper huayan medium 63.2MB / x_low 20.6MB
```

| 档位 | 文件 | 体积 | 许可 |
|---|---|---|---|
| medium | zh_CN-huayan-medium.onnx | 63.2 MB | 音色许可受限，仅个人非商业（含 GPL 组件） |
| x_low | zh_CN-huayan-x_low.onnx | 20.6 MB | 同上（⚠️ 词表无声调键，发音缺损，不建议） |

> ⚠️ huayan 音色 MODEL_CARD 许可为 Unknown，medium 档训练链含非商用的 lessac 数据集，
> **不可商用**；仅限个人非商业用途，且启用即需履行 espeak-ng GPL-3.0 分发义务。

模型下载后进入 Cache Storage，之后**完全离线可用**。也可在应用内「设置 → 下载本地模型」触发。
此外支持**自备音色模型导入**（设置 → 自定义音色模型：配对 `.onnx` + `.onnx.json`，仅存本机）。

### 1.3 静态部署

```bash
node scripts/build.mjs        # 产物输出到 dist/
```

把 `dist/` 部署到任意静态服务器（nginx/Caddy/OSS），要求：

- **必须 HTTPS**（或 localhost）：Service Worker、MediaSession、Wake Lock、剪贴板都要求安全上下文。
- 响应头必须包含（多线程 WASM 需要，见 `server-headers.conf`）：
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  ```
- 模型文件放在站点根 `/models/`，运行时文件放 `/tts/`。
- 详细配置见 `dist/DEPLOY.md` 与 `server-headers.conf`。

### 1.4 一键部署到 Cloudflare Pages

```bash
node scripts/deploy-cloudflare.mjs              # 构建 + 切块 + _headers + 上传
node scripts/deploy-cloudflare.mjs --dry-run    # 只做本地处理，不上传
```

脚本自动完成四件事（详见文件头注释）：

1. `build.mjs --with-assets` 产出完整 `dist/`（含 models/ 与 tts/，约 191 MiB）；
2. **切块**：Cloudflare Pages 单文件上限 25 MiB，而 sherpa int8 模型 39.9MB、
   piper medium 63.2MB 超限 —— 超过 20 MiB 的文件在 `dist/` 里切成
   `<file>.p0/.p1/…` 并生成站点根 `/asset-chunks.json`；前端
   `src/layers/playback/tts/asset-chunks.js` 下载时按清单拼装、以原始 URL 写
   Cache Storage，上层与离线逻辑无感（本地 dev 不生成清单 → 走原路径）；
3. 写 `_headers`：COOP/COEP/CORP 等必需响应头 + 缓存策略；
4. `wrangler pages deploy` 上传（wrangler 4.x 要求 Node ≥22，脚本会自动使用
   `.tooling/node-v22*-win-x64`）。

凭据：环境变量 `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`，或外层
`../.credentials.yaml` 的 `CF_TOKEN`/`CF_ACCOUNT`。线上地址：`https://tinttxt.pages.dev`。

---

## 2. 架构（五层分离）

```
src/
├── core/contracts.js        共享类型 + 事件总线（层间唯一通信机制）
├── layers/
│   ├── file/                文件层：编码探测(UTF-8/GB18030/UTF-16/ANSI)、BOM、清洗
│   ├── structure/           结构层：章节识别、断句(偏移精确)、文本正则化
│   ├── storage/             存储层：IndexedDB books/state/marks/settings/stats、JSON 备份
│   └── playback/            播放层：状态机 + 分块预合成队列 + TTS 适配器 + 系统集成
│       └── tts/             TTS 适配器：local(默认)/cloud(可选)/speech-preview(降级)
├── ui/                      UI 层：书架/播放页/抽屉/自检页（不直接碰 IndexedDB）
├── app.js                   装配层：把五层接起来暴露给 UI
└── main.js                  入口
```

**关键约束（代码级强制）**：
- 播放层不读 DOM（`<audio>` 元素是播放层私有资产，UI 只通过 `player.xxx()` 控制）。
- UI 层不直接访问 IndexedDB，只调 `app.xxx()`。
- 换 TTS 引擎只改适配器，播放层只消费 `Blob`。

### 熄屏续播的实现（最高验收项）

1. 所有朗读是**真实 WAV 媒体流** → `<audio>` 播放，进入系统媒体会话，Chrome 官方明确「正在出声的页面不被后台冻结」。
2. **分块预合成**：按目标 100 秒/块（可配，落在 1–3 分钟区间）打包句子，逐句合成后无损拼接为单个 WAV，记录句级时间轴；播当前块时预取下 2 块。
3. **双 `<audio>` 元素交替**：下一块在备用元素预载，当前块 `ended` 时立即切换，块间空隙最小化。
4. MediaSession 注册 play/pause/seekto/seekbackward/seekforward/previoustrack/nexttrack → 锁屏/通知栏/耳机/车载可控。
5. Wake Lock（仅亮屏有效，属规范行为；熄屏后由媒体会话维持）。
6. 进度落盘：每句写一次（防抖 800ms），`visibilitychange/pagehide/beforeunload` 强制 flush，**不丢最后位置**。

---

## 3. 真机调试步骤

1. 手机与电脑同一 Wi-Fi，`node scripts/dev-server.mjs --port 8080`，访问打印的 `http://<局域网IP>:8080`（开发服务器已带 COOP/COEP）。
   - 若要 MediaSession/WakeLock 完整生效，需 HTTPS：用 `adb reverse tcp:8080 tcp:8080` + `chrome://inspect`，或部署到 HTTPS 域名。
2. 导入一个 GBK 编码 txt（验收 1）。
3. 「设置 → 下载本地模型」，等 63MB 下载完成（断点：失败会提示，可重试）。
4. 播放 → 按电源键锁屏 ≥10 秒，**确认跨过至少一个音频块边界**（在「自检页」看当前块索引变化）。
5. 切到微信 60 秒 → 返回，确认仍在播或一键续上。
6. 蓝牙耳机连接后重复 4。
7. 强制杀掉浏览器 → 重新打开 → 应定位到上次那句，点「继续」。

### 华为/EMUI 后台白名单（必须做，否则系统可能查杀）

- 手机管家 → 应用启动管理 → 找到浏览器 → 关闭「自动管理」→ 打开 允许自启动/关联启动/后台活动
- 设置 → 电池 → 受保护应用 → 勾选浏览器
- 多任务卡片下拉加锁（防止清后台）
- 华为浏览器设置 → 关闭「省流加速/云端加速/极速模式」（会劫持媒体请求）
- 华为浏览器设置 → 实验室 → 媒体控制 → 允许网页在后台播放音频和视频
- 休眠时始终保持网络连接；关闭「省流量模式」

---

## 4. 已知限制（诚实清单）

> 以下为**已核实的平台限制**，非代码缺陷。纯网页方案在目标机型上无法 100% 保证熄屏连续，故同时给出备选路径。

| # | 限制 | 影响 | 缓解 / 备选 |
|---|---|---|---|
| L1 | 华为浏览器「添加到桌面」官方只承诺**网址快捷方式**，manifest standalone / 安装流程无官方文档保证；HarmonyOS 6 社区实测打开仍带地址栏 | PWA 独立窗口体验不保证 | 核心功能全部在普通标签页可用（PWA 仅渐进增强，这是架构前提） |
| L2 | 华为/EMUI 系统会冻结/查杀后台标签页（官方确认「灭屏一段时间三方应用停止播放」） | 长时间锁屏可能被中断 | 已做：真实音频流 + MediaSession + 白名单引导 + 中断后一键续听；**必须按 §3 配白名单** |
| L3 | 华为浏览器对第三方网页 MediaSession 表现无官方文档，仅社区实测（HarmonyOS NEXT 的 ArkWeb 会自动建 AVSession） | 锁屏卡片行为可能随版本变化 | 自检页提供实时状态，便于逐机型取证 |
| L4 | 网页无标准音频焦点 API；来电打断只能通过 `pause` 事件间接感知 | 打断恢复需用户点一次 | 已做：打断后 toast 提示 + 保持播放意图，回页自动恢复 |
| L5 | iOS/Safari 不在验收范围；`AudioContext` 后台挂起、`ended` 后台回归 bug（WebKit 261554） | iOS 可能无声 | 代码做特性检测 + 优雅提示，不崩溃（按需求不做兼容妥协） |
| L6 | 多线程 WASM 需要 COOP/COEP 响应头，部分共享主机不支持 | 合成速度降为单线程（仍可实时） | `server-headers.conf` 给出配置；缺头时自动单线程降级 |
| L7 | Piper 档 x_low 在个别 WASM 运行时有推理报错报告；huayan 音色许可不明 | Piper 档风险 | **默认引擎已切换为 sherpa-onnx（全 Apache-2.0）**；Piper 降为可选档（设置中显式选择），启用即展示 GPL 义务与非商用提示，见 `THIRD_PARTY_LICENSES.md` |
| L7b | sherpa 默认模型采样率 8000 Hz（模型元数据） | 听感偏电话音质 | 可在设置切 full 档（121MB）；或自备导入更高采样率模型（自定义音色功能） |
| L8 | 浏览器直出仅 WAV；MP3 需引入编码器 | 导出文件较大 | 已提供整本/章 WAV 合并下载（验收项原文允许「合并后下载方案」） |
| L9 | 纯网页无法申请 HarmonyOS 长时任务/AVSession | 后台优先级低于原生 | **备选路径**：封装为 HarmonyOS HAP（ArkWeb + AVSession + 长时任务），网页代码可整体复用；默认交付仍为网页版 |
| L10 | 浏览器清缓存会清 IndexedDB/Cache Storage | 书架与模型丢失 | 已提供 JSON 全量备份导出/导入入口 |

### 备选路径（如验收要求 100% 保证）

把本项目静态产物打包进 HarmonyOS HAP：ArkWeb 组件加载同一批源码，用 `AVSession` + `longTask`（audio 类型）申请后台播放豁免，`@ohos.web.webview` 与网页间桥接 MediaSession 控制。此路径不改五层架构，仅替换播放层的系统集成部分。**默认交付仍是网页版**（按需求 §六.4）。

---

## 5. 验收清单

> 状态说明：
> ✅ = 自动化测试实测通过（单元 / headless 浏览器 CDP 端到端）；
> 🟡 = 代码实现 + 自动化覆盖，但该项依赖真机系统行为，需人工实测；
> ❌ = 本环境无法执行。

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 导入 GBK txt 不乱码 | ✅ | 单元测试 `tests/encoding.test.mjs`（GBK/UTF-8 BOM/UTF-16/强制编码 7 用例） |
| 2 | 关浏览器/重启后定位到上次那句 | ✅（浏览器侧）🟡（手机重启） | E2E `scripts/e2e-play.mjs`：播放→刷新→「进度已落盘且位置吻合」实测通过；手机重启后首次打开的恢复路径相同（`getLastBookId→openBook`），真机待验 |
| 3 | 锁屏 ≥10 秒持续出声、跨块不中断 | 🟡 | E2E 实测 `<audio>` currentTime 真实推进 + 跨块（第 3 章跳转后继续合成播放）；**锁屏/熄屏属系统行为，必须真机测**，自检页提供块索引与心跳取证 |
| 4 | 切微信 60 秒后仍在播或一键续上 | 🟡 | 同上；`visibilitychange` 恢复与打断 toast 已实现并有 E2E 覆盖（暂停→恢复路径） |
| 5 | 锁屏/通知栏/耳机按键可控 | 🟡 | E2E 实测 `MediaSession.playbackState/metadata` 已就绪、全 action handlers 注册；锁屏卡片实际表现需华为真机确认（见限制 L3） |
| 6 | 断网听已缓存内容 | 🟡 | 模型与应用壳均入 Cache Storage（E2E 实测下载后 `isReady=true`、SW 预缓存 40 项）；并已修复「SW activate 误删模型缓存」缺陷（见 §8）；完整离线场景需真机飞行模式验证 |
| 7 | JSON 导出导入完整还原 | ✅ | 单元测试 + 冒烟：`exportBackup()` 结构校验（books/state/marks/settings/stats 全量） |
| 8 | 逐句高亮与朗读同步 | ✅ | E2E 实测：播放中 `sentenceIndex` 随朗读推进；WAV 句级时间轴 + `timeupdate` 映射 |
| 9 | 改语速/音色/跳章后状态不乱、不重头开始 | ✅ | E2E 实测：语速 1.5× 生效且句序不回退；跳第 3 章精确落位（曾因偏移 bug 回第 1 章，已修复并加回归测试）；40/40 单元测试 |
| 10 | 华为手机（HarmonyOS，华为浏览器 + Chrome）实机通过 1–9 | ❌ | **本环境无华为真机，无法执行**。§3 给出逐步实测流程与白名单设置路径，`#diag` 自检页提供块索引/心跳/MediaSession/WakeLock 实时取证；结果需在目标机型上补测 |

**自动化验证汇总**（本环境实测）：单元测试 **44/44**；页面冒烟 `scripts/smoke.mjs` **19/19**；
端到端 `scripts/e2e-play.mjs`（真实 headless Edge：导入→模型下载→合成→出声→高亮→控制→引擎切换→刷新恢复）**23/23**；
全源码 `node --check` 0 失败；`node scripts/build.mjs` 构建成功。

---

## 6. 隐私

- **文本永不离开设备**：朗读合成全程在浏览器内完成，TXT 内容不发送到任何服务器。
- **首次下载模型/运行时**会访问国内镜像 hf-mirror.com（仅二进制模型与运行时文件，**不含任何用户文本**；
  用户点「下载模型」即视为同意）；镜像失败自动落回同源，下载完成后**运行期零外联**。
- 云端 TTS 为**显式开关**，开启前弹出隐私提示并要求先配置端点；文本是否上云完全由用户决定。
- 系统 `speechSynthesis` 仅作「模型未下载」时的临时预览，UI 明确标注其不满足熄屏约束。

## 7. 测试

```bash
# 单元测试（44 项：编码探测/断句/章节/正则化/WAV 合并/多章偏移回归/下载看门狗）
node --test tests/

# 页面冒烟（需 dev-server 运行中）：装配/视图/路由/API/零 JS 错误 —— 19 项
node scripts/smoke.mjs

# 端到端（需 dev-server + 已执行 fetch-sherpa-assets.mjs）：
# 导入→模型下载→合成→<audio> 出声→逐句高亮→控制→引擎切换→刷新恢复 —— 23 项
node scripts/e2e-play.mjs
```

开发期依赖（仅测试用，非应用运行时依赖）：`ws` 安装于 `.tooling/e2e/`（`npm i ws --prefix .tooling/e2e`）。

## 8. 开发期发现并修复的缺陷（均已回归覆盖）

| 缺陷 | 影响 | 修复 | 回归 |
|---|---|---|---|
| `splitSentences` 对非首章返回章内**局部偏移** | 多章书切章失效、进度错误、二分定位乱 | 经统一助手加 `chapter.start` | `tests/sentences.test.mjs`「多章书句子偏移」（4 断言） |
| 自定义音色 Cache key `custom:x:model` 被当成 URL scheme | 导入音色必抛 TypeError | key 加 `/` 前缀（`customKey()`） | 浏览器 CDP 实测三路径 |
| `normalizeForSpeech` 把 match 数组当字符串传参 | 数字/日期正则化全部报错 | 回调改传 `m[0]` | 单元测试 6 用例 |
| 章节 200 字最小间距一刀切 | 短章节被吞 | 目录簇（≥3 连续）识别 + 间距规则重写 | 单元测试多正则格式用例 |
| **SW activate 按 `tinttxt-` 前缀删缓存** | 模型缓存被删→「已下载」状态丢失、断网无法朗读（验收 6） | 只清理 `tinttxt-precache-`/`tinttxt-runtime-` 版本缓存 | E2E：下载后 `isReady=true` 且 SW 激活后仍为 true |
| `fadeOut` 用 rAF | 锁屏时 rAF 冻结→定时关闭永不完成 | 改 `setTimeout`（出声页面豁免节流） | 代码审查 |
| 打断 `pause` 监听只挂 audioA | activeEl=B 时来电打断无提示 | 双元素监听 + 主动暂停去抖 | 代码审查 |
| 音频元素游离 DOM | 诊断页取不到状态、后台行为不保证 | 挂隐藏容器 `#tinttxt-audio-host` | 冒烟断言 `audioHost===2` |

### 第二轮系统性复查（全量代码审计）发现并修复的缺陷

审计方式：人工精读五层核心 + 两个只读审计代理逐行查 UI 层与 PWA/脚本层，共确认并修复 **30 项**：

**P1 功能错误（13 项，全部修复）**

| 缺陷 | 影响 | 修复 |
|---|---|---|
| `ensureChunk` 并发时返回 AbortController 而非 Promise | 播放状态被污染成「块越界: NaN」（预取与跨块切换竞态） | inflight 存 `{controller,promise}`，并发方拿到同一 Promise |
| `updateSettings` 拿 patch 与**自己刚写入的值**比较 | 引擎/档位切换分支是死代码：选了 Piper 实际仍用 sherpa、横幅不同步 | 保存前快照 `prev` 再比较；并 `await checkModel` |
| 「读完本章」定时关闭无任何触发点 | 选项纯摆设，锁屏会一直播 | 记录设定章，`SENTENCE` 事件跨章即 `fadeOut`；换书自动取消 |
| SW `staleWhileRevalidate` 只查 RUNTIME 不回退 PRECACHE | 首次安装后离线刷新白屏（模块/CSS 只在 PRECACHE） | 加全局 `caches.match` 兜底 |
| 导航响应无条件覆写 `/index.html` 缓存 | 打开 manifest/图标即可污染应用壳→离线回退乱码 | 仅 `content-type: text/html` 才刷新 |
| SW 更新提示链路前半段断裂 | 永远收不到「新版本可用」；reload 也不会激活 waiting | bridge 监听 `updatefound/reg.waiting` 广播；点击先 `SKIP_WAITING` 再于 `controllerchange` 刷新 |
| nginx 示例按自身用法 `nginx -t` 直接失败 | 交付物不可用（server{} 嵌套） | 改为纯指令 include（裸 location），types/gzip 补全 |
| `local.js` 运行期回退 hf-mirror 外链 | 违反当时的「零外联」解读 | 曾改为纯同源；后与部署线统一口径为**「镜像优先 + 同源兜底 + 10s 卡死看门狗」**（仅首次下载，见 §6 隐私），并顺带修复缓存 key `model:/…` 的 scheme TypeError（piper 下载路径此前从未跑通） |
| 恢复进度用 `sentenceIndex` 而非 `charOffset` | 跳行/断句设置一变，恢复位置漂移（违反需求 D） | 恢复与书签一律优先字符偏移，缺省才回退句序 |
| 云端 TTS 无端点配置入口，开启即报错 | 开关形同虚设 | 设置页新增端点输入；未配置时要求填写否则拒绝启用；`resolveAdapter` 双条件守卫 |
| 音色下拉选择完全无效 | 用户调音色无任何变化 | sherpa 174 说话人模型按 voice id 映射 sid（暴露 5 个音色）；预览档设 `u.voice` |
| 自定义音色「使用」不切引擎 | 提示成功但合成仍走 sherpa（不加载 Piper 模型） | 自动切 `ttsEngine='local-piper'` + 作废旧音频缓存 + 刷新状态 |
| 单书 JSON 导出携带 settings、导入无条件覆盖 | 导入一本书把用户设置静默回滚 | 单书导出剔除 settings；合并模式跳过 settings、统计按日取大值 |

**P2 体验/健壮性（12 项，全部修复）**：跨块 seek 把旧块秒数套到新块（锁屏快进跳错位）；暂停态跳句卡 loading；切书不取消 speechSynthesis（预览档串音）；`addStat` 并发读改写丢统计；批量导入单文件失败中断整批 + 同名文件改动无提示（需求 D 补齐）；引擎/档位切换不清音频缓存（混采样率合并失败）；书签跳转句序漂移；导出取消不中断在途合成；Esc 连带关闭底层抽屉；重命名后锁屏仍旧名；`voiceschanged` 缺失致预览音色列表为空；档位切换后音色标签不刷新。

**P3/脚本层（9 项）**：fetch 脚本 5xx 丢断点、Content-Range 起点不校验、x_low 配置零校验；smoke/e2e 断言过松（路由退化必过、高亮弱断言、console 过滤过宽）；`build --clean` 文档与实现不符、清单 fileCount 不自洽；PRECACHE 缺 `sherpa.js`；`networkFirst` 离线给 JS 返回 HTML；`main.js` 与 bridge 重复注册 SW；测试 profile 残留（13 个已清理）。

**补齐的需求缺口**：多文件排队播放（队列条 + 卡片加入 + 导入后一键排队 + 读完自动续播下一本书）；恢复时「回退 15 秒」入口。

> 说明：`scripts/deploy-cloudflare.mjs`、`src/layers/playback/tts/asset-chunks.js`、README §1.4 为**并行会话产出**（Cloudflare Pages 25MiB 分块部署方案），非本轮修复内容；已验证语法与全链路集成（本地构建与测试全过），未回退。
