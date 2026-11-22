/**
 * 端到端播放验证：真实浏览器（headless Edge）里走完
 * 导入 txt → 下载 sherpa 模型 → 合成 → <audio> 出声 → 逐句高亮推进 → 暂停/跳句。
 * 前置：dev-server 运行于 8123，且 scripts/fetch-sherpa-assets.mjs 已执行。
 * 用法：node scripts/e2e-play.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import WebSocket from '../.tooling/e2e/node_modules/ws/wrapper.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;
const PROFILE = `H:\\workbuddy\\TintTXT\\.tooling\\e2e\\edge-e2e-${Date.now()}`;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  // 1. 准备测试书（多章，验证句子偏移修复）
  await mkdir(`${process.cwd()}\\.tooling\\e2e`, { recursive: true });
  const testTxt = [
    '第一章 起点',
    '清晨的阳光照进窗户，李明睁开了眼睛。今天是2026年11月19日，他决定去城里看看。',
    '街道上人来人往，热闹非凡。他走过一家书店，门口挂着一块牌子：新书八折。',
    '第二章 旅程',
    '火车缓缓开动，窗外的风景不断后退。他看着远方的山峦，心中充满期待。',
    '车厢里有人在聊天，有人说：我去过三次北京了。也有人沉默不语，只是望着窗外。',
    '第三章 归途',
    '天色渐暗，列车终于到站。他提起行李，走出了车厢，呼吸着夜晚清凉的空气。',
    '到家已经是晚上九点。他躺在床上，回想着这一天的经历，慢慢地闭上了眼睛。',
  ].join('\n');
  const txtPath = `${process.cwd()}\\.tooling\\e2e\\e2e-book.txt`;
  await writeFile(txtPath, testTxt, 'utf8');

  // 2. 启动 Edge
  const edge = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=414,896',
    // 自动化环境没有真实用户手势；真实用户通过点播放按钮满足手势要求（不受此旗标影响）
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });
  const edgeSpawnError = new Promise((resolve) => {
    edge.once('error', (e) => resolve(e));
    edge.once('spawn', () => resolve(null));
  });

  /** 结束 Edge 并清理 profile（等退出后再删，否则 Windows 句柄占用导致残留目录）。 */
  async function cleanup() {
    try {
      edge.kill();
    } catch { /* ignore */ }
    const exited = await Promise.race([
      new Promise((r) => edge.once('exit', () => r(true))),
      sleep(3000).then(() => false),
    ]);
    if (!exited) {
      try { edge.kill('SIGKILL'); } catch { /* ignore */ }
      await sleep(500);
    }
    for (let i = 0; i < 3; i++) {
      try {
        await import('node:fs').then((fs) => fs.promises.rm(PROFILE, { recursive: true, force: true }));
        break;
      } catch {
        await sleep(400);
      }
    }
  }

  const spawnErr = await edgeSpawnError;
  if (spawnErr) {
    console.error(`无法启动 Edge（${EDGE}）：${spawnErr.message}`);
    process.exit(2);
  }
  let wsUrl = null;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await sleep(200);
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* boot */ }
  }
  if (!wsUrl) { console.error('CDP 连接失败'); await cleanup(); process.exit(2); }

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  const consoleErrors = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  console.log(`\n== 打开 ${BASE}/?debug ==`);
  await send('Page.navigate', { url: `${BASE}/?debug` });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(250);
    try { ready = (await evalJs('window.__TINTTXT__ ? 1 : 0')) === 1; } catch { /* nav */ }
  }
  check('页面装配完成', ready);
  if (!ready) throw new Error('装配失败');

  // 3. 导入测试书（模拟用户手势路径：构造 File 走 importFiles）
  console.log('\n== 导入 ==');
  const imported = await evalJs(`(async () => {
    const app = window.__TINTTXT__.app;
    // 本地 dev-server 有 /.tooling/e2e/ 测试书；远程部署没有 → 回退内嵌同一份文本
    let text = null;
    try {
      const res = await fetch('/.tooling/e2e/e2e-book.txt');
      if (res.ok) text = await res.text();
    } catch { /* 远程 404 / 断网 */ }
    if (text === null) text = ${JSON.stringify(testTxt)};
    const blob = new Blob([text], { type: 'text/plain' });
    const file = new File([blob], 'e2e-book.txt', { type: 'text/plain' });
    const out = await app.importFiles([file]);
    return out.length === 1 ? out[0].book.id : null;
  })()`);
  check('导入 txt 成功', typeof imported === 'string' && imported.includes('e2e-book'), `id=${imported}`);

  // 4. 打开书：验证三章结构与句子偏移（回归：局部偏移 bug）
  console.log('\n== 结构 ==');
  const struct = await evalJs(`(async () => {
    const app = window.__TINTTXT__.app;
    const { book } = await app.openBook(${JSON.stringify(imported)});
    const sents = app.player.getSentences();
    let mono = true;
    for (let i = 1; i < sents.length; i++) if (sents[i].start < sents[i-1].start) mono = false;
    const rawOk = sents.every(s => s.raw === book.text.slice(s.start, s.end));
    return { chapters: book.chapters.length, sentences: sents.length, mono, rawOk,
             chapterTitles: book.chapters.map(c => c.title) };
  })()`);
  check('识别 3 章', struct.chapters === 3, JSON.stringify(struct.chapterTitles));
  check('句子偏移单调递增', struct.mono === true);
  check('句子 raw 与偏移一致', struct.rawOk === true);

  // 5. 下载默认引擎模型（v3 默认 = sherpa int8；同源 /models/，本地网络应该很快）
  console.log('\n== 模型下载 ==');
  const dlStart = Date.now();
  const dl = await evalJs(`(async () => {
    const app = window.__TINTTXT__.app;
    // 开书即自动触发下载 → 轮询到「文件就绪 + 引擎预热完成（active 切到本地 sherpa）」为止。
    // 注意 status==='ready' 只代表文件下完，wasm 编译/模型加载还要 1~3 秒。
    const t0 = Date.now();
    let last = await app.checkModel();
    while (Date.now() - t0 < 900000) {
      await app.resolveAdapter();
      const active = app.registry.active ? app.registry.active.id : '';
      if (active === 'local-sherpa') break;
      if (last.status === 'error') break;
      void app.downloadModel().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      last = await app.checkModel();
    }
    return { status: last.status, error: last.error || null, tier: last.tier, engine: last.engine };
  })()`);
  const dlMs = Date.now() - dlStart;
  check('模型下载成功（默认引擎 sherpa int8）', dl.status === 'ready' && dl.engine === 'local-sherpa', JSON.stringify(dl));
  console.log(`    （下载耗时 ${(dlMs / 1000).toFixed(1)}s）`);

  // sherpa 缓存完整性：同源 URL key 下的模型文件已在 Cache Storage
  const skey = await evalJs(`(async () => {
    const c = await caches.open('tinttxt-tts-sherpa-v1');
    const keys = (await c.keys()).map((r) => r.url);
    return { hasModel: keys.some((u) => u.endsWith('/models/sherpa-zh/vits-aishell3.int8.onnx')) };
  })()`);
  check('sherpa 模型以同源 URL key 入缓存', skey.hasModel === true, JSON.stringify(skey));

  const activeAdapter = await evalJs('window.__TINTTXT__.app.registry.active.id');
  check('默认引擎为 local-sherpa', activeAdapter === 'local-sherpa', `active=${activeAdapter}`);

  // 6. 播放：验证 <audio> 真实出声（currentTime 推进）+ 逐句高亮推进
  console.log('\n== 播放 ==');
  await evalJs('window.__TINTTXT__.app.player.play()');
  let playing = false;
  for (let i = 0; i < 80 && !playing; i++) {
    await sleep(250);
    playing = await evalJs(`window.__TINTTXT__.app.player.getState().status === 'playing'`);
  }
  check('进入 playing 状态', playing);

  // 等 currentTime 推进（headless 无音频设备时 Chrome 仍会推进虚拟时间轴）
  // 注意：用 _diag() 取真正 active 的元素——DOM 选择器可能选中无 src 的 standby 元素
  let t1 = 0;
  for (let i = 0; i < 40 && t1 <= 0; i++) {
    await sleep(250);
    t1 = await evalJs(`window.__TINTTXT__.app.player._diag().activeTime`);
  }
  const diagNow = await evalJs(`JSON.stringify(window.__TINTTXT__.app.player._diag())`);
  check('audio.currentTime 推进（真实媒体流在播放）', t1 > 0, `t=${t1} diag=${diagNow}`);

  // 逐句高亮推进：轮询等待真实的 sentenceIndex 变化（句长约 25–40 字 → 数秒到十数秒），
  // 不接受「状态是 playing 就算过」的弱断言
  const s1 = await evalJs('window.__TINTTXT__.app.player.getState().sentenceIndex');
  let s2 = s1;
  let advanced = false;
  for (let i = 0; i < 100 && !advanced; i++) {
    await sleep(250);
    s2 = await evalJs('window.__TINTTXT__.app.player.getState().sentenceIndex');
    if (s2 > s1) advanced = true;
  }
  const statusNow = await evalJs('window.__TINTTXT__.app.player.getState().status');
  check('逐句高亮随朗读推进（sentenceIndex 实际增长）', advanced, `s1=${s1} s2=${s2} status=${statusNow}`);

  // 7. 控制：暂停 → 恢复 → 跳句 → 跳章（验收项 9：状态不乱不重头）
  console.log('\n== 控制 ==');
  await evalJs('window.__TINTTXT__.app.player.pause()');
  await sleep(400);
  const paused = await evalJs('window.__TINTTXT__.app.player.getState().status');
  check('暂停生效', paused === 'paused', `status=${paused}`);

  await evalJs('window.__TINTTXT__.app.player.play()');
  await sleep(800);
  const resumed = await evalJs('window.__TINTTXT__.app.player.getState().status');
  check('恢复播放', resumed === 'playing', `status=${resumed}`);

  const beforeJump = await evalJs('window.__TINTTXT__.app.player.getState().sentenceIndex');
  await evalJs('window.__TINTTXT__.app.player.nextSentence()');
  await sleep(600);
  const afterJump = await evalJs('window.__TINTTXT__.app.player.getState().sentenceIndex');
  check('下一句跳转', afterJump === beforeJump + 1, `${beforeJump}→${afterJump}`);

  // 跳到第 3 章（验证多章 seek 正确，此前 bug 会 clamp 回第 1 章）
  const jump = await evalJs(`(async () => {
    const p = window.__TINTTXT__.app.player;
    const sents = p.getSentences();
    const third = sents.find(s => s.chapter === 2);
    if (!third) return { err: 'no third chapter sentence' };
    await p.seekToSentence(third.index, { play: false });
    const after = p.getState();
    return { target: third.index, got: after.sentenceIndex, charOffset: after.charOffset };
  })()`);
  check('跳到第 3 章句子正确（无 clamp 回第 1 章）', jump && jump.got === jump.target, JSON.stringify(jump));

  // 8. 语速切换不重头（验收项 9）
  const rateBefore = await evalJs('window.__TINTTXT__.app.player.getState().sentenceIndex');
  await evalJs('window.__TINTTXT__.app.player.setRate(1.5)');
  await sleep(1200);
  const rateAfter = await evalJs('window.__TINTTXT__.app.player.getState().sentenceIndex');
  const rateVal = await evalJs('window.__TINTTXT__.app.player.getState().rate');
  check('语速切换生效', Math.abs(rateVal - 1.5) < 0.001, `rate=${rateVal}`);
  check('语速切换后不从头开始', Math.abs(rateAfter - rateBefore) <= 1, `${rateBefore}→${rateAfter}`);

  // 9. MediaSession 已设置
  const ms = await evalJs(`(() => {
    if (!navigator.mediaSession) return 'unsupported';
    return navigator.mediaSession.playbackState + '|' + (navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : 'null');
  })()`);
  check('MediaSession 就绪', ms !== 'unsupported', `ms=${ms}`);

  // 10. 引擎切换真正生效（回归：updateSettings 曾与自身比较导致切换分支永不执行）
  //     v3 默认引擎 = sherpa，这里反向切到 Piper，并覆盖 Piper 的下载/缓存 key/合成链路。
  console.log('\n== 引擎切换 ==');
  await evalJs(`window.__TINTTXT__.app.updateSettings({ ttsEngine: 'local-piper' })`);
  await sleep(600);
  const eng1 = await evalJs(`JSON.stringify({
    engine: window.__TINTTXT__.app.getSettings().ttsEngine,
    status: window.__TINTTXT__.app.modelState().status,
    which: window.__TINTTXT__.app.modelState().engine,
  })`).then(JSON.parse);
  check('切到 piper：设置已保存且模型状态按 piper 重算',
    eng1.engine === 'local-piper' && eng1.which === 'local-piper' && eng1.status === 'idle',
    JSON.stringify(eng1));

  // piper 下载 + 缓存 key 回归（曾用 model:/… 这类 scheme 串 key，Cache API put 抛 TypeError）
  const pdl = await evalJs(`(async () => {
    const app = window.__TINTTXT__.app;
    let last = await app.checkModel();
    const t0 = Date.now();
    while (Date.now() - t0 < 900000) {
      await app.resolveAdapter();
      const active = app.registry.active ? app.registry.active.id : '';
      if (active === 'local-piper') break;
      if (last.status === 'error') break;
      void app.downloadModel().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
      last = await app.checkModel();
    }
    return { status: last.status, error: last.error || null, engine: last.engine };
  })()`);
  check('piper 模型下载成功', pdl.status === 'ready' && pdl.engine === 'local-piper', JSON.stringify(pdl));
  const pkey = await evalJs(`(async () => {
    const c = await caches.open('tinttxt-tts-v1');
    const keys = (await c.keys()).map((r) => r.url);
    return {
      hasModel: keys.some((u) => u.endsWith('/models/zh_CN-huayan-medium.onnx')),
      hasCfg: keys.some((u) => u.endsWith('/models/zh_CN-huayan-medium.onnx.json')),
    };
  })()`);
  check('piper 资产以同源 URL key 入缓存（scheme key 回归）',
    pkey.hasModel === true && pkey.hasCfg === true, JSON.stringify(pkey));
  const psyn = await evalJs(`(async () => {
    const r = await window.__TINTTXT__.app.registry.get('local-piper').synthesize('测试句子，验证链路。', { rate: 1 });
    return { size: r.blob ? r.blob.size : 0 };
  })()`);
  check('piper 单句合成出 WAV（>1KB）', psyn.size > 1024, JSON.stringify(psyn));

  await evalJs(`window.__TINTTXT__.app.updateSettings({ ttsEngine: 'local-sherpa' })`);
  await sleep(600);
  const eng2 = await evalJs(`(async () => JSON.stringify({
    engine: window.__TINTTXT__.app.getSettings().ttsEngine,
    status: window.__TINTTXT__.app.modelState().status,
    which: window.__TINTTXT__.app.modelState().engine,
    active: window.__TINTTXT__.app.registry.active.id,
    isReady: await window.__TINTTXT__.app.registry.get('local-sherpa').isReady(),
  }))()`).then(JSON.parse);
  check('切回 sherpa：适配器仍就绪可用',
    eng2.engine === 'local-sherpa' && eng2.status === 'ready' && eng2.active === 'local-sherpa' && eng2.isReady === true,
    JSON.stringify(eng2));

  // 11. 进度持久化：刷新后回到原句（验收项 2 的浏览器侧验证）
  console.log('\n== 持久化 ==');
  const persistBefore = await evalJs('window.__TINTTXT__.app.player.getState().sentenceIndex');
  await sleep(1500); // 等防抖落盘
  await evalJs('window.__TINTTXT__.app.player.pause()');
  await sleep(2000); // 给 pause-flush 的 IndexedDB 事务留足提交时间（曾用600ms出现竞态偶发）
  await send('Page.navigate', { url: `${BASE}/?debug` });
  // 刷新后等待重新装配
  let reloaded = false;
  for (let i = 0; i < 60 && !reloaded; i++) {
    await sleep(300);
    try { reloaded = (await evalJs('window.__TINTTXT__ ? 1 : 0')) === 1; } catch { /* 导航中 */ }
  }
  check('刷新后页面重新装配', reloaded);
  // 诊断：直读 state 存储原始行，连续两次（间隔3s）——
  //   updatedAt 陈旧 = 页面1的更新没落库；两次读之间值/时间变了 = 刷新后被覆盖
  const rawProbe = async () => evalJs(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('tinttxt');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const row = await new Promise((res) => {
      const t = db.transaction('state', 'readonly');
      const q = t.objectStore('state').get(${JSON.stringify('placeholder')});
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
    db.close();
    return row ? { idx: row.sentenceIndex, at: row.updatedAt, chunk: row.chunkIndex } : 'no-row';
  })()`.replace('placeholder', (await evalJs(`(async () => {
    const books = await window.__TINTTXT__.app.listBooks();
    const b = books.find((x) => x.id.startsWith('e2e-book'));
    return b ? b.id : '';
  })()`))));
  const raw1 = await rawProbe();
  const reloadAt = Date.now();
  await sleep(3000);
  const raw2 = await rawProbe();
  console.log(`    [诊断] state原始行 读1=${JSON.stringify(raw1)} 读2=${JSON.stringify(raw2)}（导航于 ${new Date(reloadAt).toLocaleTimeString()}）`);
  const restored = await evalJs(`(async () => {
    const app = window.__TINTTXT__.app;
    const books = await app.listBooks();
    const b = books.find(x => x.id.startsWith('e2e-book'));
    if (!b || !b.state) return { hasState: false };
    return { hasState: true, sentenceIndex: b.state.sentenceIndex };
  })()`);
  check('刷新后进度已落盘', restored.hasState === true, JSON.stringify(restored));
  if (restored.hasState) {
    check('落盘位置≈播放位置', Math.abs(restored.sentenceIndex - persistBefore) <= 2,
      `saved=${restored.sentenceIndex} played=${persistBefore}`);
  }

  check('全程无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('无 console.error（含落盘失败日志）', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  ws.close();
  await cleanup();

  console.log(`\n== E2E 结果：${pass} 通过 / ${fail} 失败 ==`);
  if (fail) { console.log('失败项：'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('E2E 异常:', e); process.exit(2); });
