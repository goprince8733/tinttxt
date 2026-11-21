/**
 * 集成冒烟测试：headless Edge + CDP
 * 验证：页面加载无 JS 错误、装配成功、核心视图/控件就位、路由与抽屉可用。
 * 用法：node scripts/smoke.mjs [baseUrl]   （需 dev-server 已启动）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from '../.tooling/e2e/node_modules/ws/wrapper.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8123';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const PROFILE = `H:\\workbuddy\\TintTXT\\.tooling\\e2e\\edge-profile-${Date.now()}`;

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=414,896',
    'about:blank',
  ], { stdio: 'ignore' });
  // Edge 路径不存在/启动失败：干净报错而不是未捕获异常崩溃
  const edgeSpawnError = new Promise((resolve) => {
    edge.once('error', (e) => resolve(e));
    edge.once('spawn', () => resolve(null));
  });

  /** 结束 Edge 并清理 profile（等进程退出后再删，否则 Windows 句柄占用导致残留）。 */
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
        await sleep(400); // 句柄释放延迟
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
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      wsUrl = j.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
  }
  if (!wsUrl) {
    console.error('无法连接 Edge CDP');
    await cleanup();
    process.exit(2);
  }

  // 创建新标签
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(created.webSocketDebuggerUrl, { perMessageDeflate: false });
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
      const args = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      // 只放过「离线/资源未缓存」类网络噪音（离线冒烟环境属预期）；
      // 不得按 '404'/'sw.js' 子串整体过滤——那会吞掉含这些字样的真实业务错误
      if (!/net::ERR_(NAME_NOT_RESOLVED|CONNECTION_|INTERNET_|NETWORK_|TIMED_OUT|ADDRESS_)/.test(args)) {
        consoleErrors.push(args);
      }
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });

  console.log(`\n== 打开 ${BASE}/?debug ==`);
  await send('Page.navigate', { url: `${BASE}/?debug` });
  // 等待装配完成
  let ctx = null;
  for (let i = 0; i < 60 && !ctx; i++) {
    await sleep(250);
    try {
      const r = await send('Runtime.evaluate', { expression: 'window.__TINTTXT__ ? 1 : 0', returnByValue: true });
      if (r.result.value === 1) ctx = true;
    } catch { /* 导航中 */ }
  }
  check('main.js 装配完成（window.__TINTTXT__ 存在）', !!ctx);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // 核心结构
  const structure = await evalJs(`JSON.stringify({
    shelf: !!document.querySelector('#view-shelf'),
    player: !!document.querySelector('#view-player'),
    diag: !!document.querySelector('#view-diag'),
    settings: !!document.querySelector('#settings-drawer'),
    mini: !!document.querySelector('#mini-bar, .mini-bar, [id*=mini]'),
    audioHost: document.querySelectorAll('#tinttxt-audio-host audio').length,
    importBtn: !!document.querySelector('#btn-import'),
    fileInput: !!document.querySelector('input[type=file]'),
    manifest: !!document.querySelector('link[rel=manifest]'),
    swBridge: !!document.querySelector('script[src*="sw-bridge"]'),
    theme: document.documentElement.dataset.theme,
    route: document.body.dataset.route,
  })`).then(JSON.parse);
  check('书架视图存在', structure.shelf);
  check('播放视图存在', structure.player);
  check('自检视图存在', structure.diag);
  check('设置抽屉存在', structure.settings);
  check('底部播放条存在', structure.mini, JSON.stringify(structure));
  check('播放层单音频元素挂载（规则5）', structure.audioHost === 1, `count=${structure.audioHost}`);
  check('导入按钮就位', structure.importBtn);
  check('文件 input 就位（手势触发）', structure.fileInput);
  check('manifest 已链接', structure.manifest);
  check('sw-bridge 已引用', structure.swBridge);

  // 路由切换（SPA，无整页导航）
  const navBefore = await evalJs('performance.getEntriesByType("navigation").length');
  // 必须由真实导航控件触发；退化到直接改 hash 说明控件缺失，算失败而非通过
  const clicked = await evalJs(`(() => {
    const t = document.querySelector('[data-tab="diag"], a[href="#diag"], [data-route="diag"]');
    if (!t) return false;
    t.click();
    return true;
  })()`);
  check('自检页导航控件存在且被点击', clicked === true, '未找到 #diag 导航控件');
  await sleep(400);
  const route = await evalJs('location.hash');
  check('hash 路由切到 #diag', route === '#diag', `hash=${route}`);
  const navAfter = await evalJs('performance.getEntriesByType("navigation").length');
  check('路由为 SPA（无整页加载）', navBefore === navAfter);

  // 设置抽屉开合
  await evalJs(`document.querySelector('[data-route="settings"]')?.click() || (location.hash='#settings')`);
  await sleep(300);
  const drawerOpen = await evalJs(`document.querySelector('#settings-drawer')?.getAttribute('aria-hidden')`);
  check('设置抽屉可打开', drawerOpen === 'false', `aria-hidden=${drawerOpen}`);

  // 统计/备份等关键 API 可调用
  const apiOk = await evalJs(`(async () => {
    const app = window.__TINTTXT__.app;
    const books = await app.listBooks();
    const stats = await app.getStats();
    const settings = app.getSettings();
    const model = app.modelState();
    const backup = await app.exportBackup();
    return Array.isArray(books) && typeof stats.streak === 'number' && typeof settings.rate === 'number'
      && typeof model.status === 'string' && backup.app === 'tinttxt';
  })()`);
  check('app API 全链路可用（listBooks/getStats/getSettings/exportBackup）', apiOk === true);

  // 状态机与播放器就位
  const playerOk = await evalJs(`(() => {
    const p = window.__TINTTXT__.app.player;
    const st = p.getState();
    return st.status === 'idle' && typeof p.play === 'function' && typeof p.seekToSentence === 'function'
      && p._chunkCount() === 0;
  })()`);
  check('播放器状态机初始 idle 且方法齐全', playerOk === true);

  // 断言页面零 JS 错误
  check('无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  ws.close();
  await cleanup();

  console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本异常:', e);
  process.exit(2);
});
