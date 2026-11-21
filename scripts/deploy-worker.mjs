/**
 * 云端 TTS Worker 部署脚本（Cloudflare Workers + KV）
 *
 * 做四件事：
 *   1. 检查凭据（复用主项目 ../.credentials.yaml 的 CLOUDFLARE_API_TOKEN/ACCOUNT_ID）；
 *   2. KV 命名空间 tinttxt-api-data 不存在则创建，把 id 回填 worker/wrangler.toml；
 *   3. wrangler deploy 发布；
 *   4. 探活 https://tinttxt-api.<子域>.workers.dev/api/health。
 *
 * 用法：node scripts/deploy-worker.mjs
 * 厂商 key 不在本脚本范围：npx wrangler secret put BAIDU_API_KEY（等 key 到手）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const workerDir = join(root, 'worker');
const tomlPath = join(workerDir, 'wrangler.toml');

const NODE = process.execPath;
// 与主项目 deploy-cloudflare.mjs 相同的工具链
const NODE22 = join(root, '.tooling', 'node-v22.14.0-win-x64', 'node.exe');
const WRANGLER = join(dirname(root), '.tools', 'cf', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const wranglerNode = existsSync(NODE22) ? NODE22 : NODE;

function log(msg) {
  console.log(`[deploy-worker] ${msg}`);
}

function runWrangler(args, opts = {}) {
  const r = spawnSync(wranglerNode, [WRANGLER, ...args], {
    cwd: workerDir,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  // 1) 凭据
  const credPath = join(dirname(root), '.credentials.yaml');
  let token = process.env.CLOUDFLARE_API_TOKEN || '';
  let account = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  if ((!token || !account) && existsSync(credPath)) {
    const text = readFileSync(credPath, 'utf8');
    const grab = (key) => {
      const m = text.match(new RegExp(`${key}:\\s*["']?([^"'\\n]+)["']?`));
      return m ? m[1].trim() : '';
    };
    token = token || grab('cloudflare_api_token') || grab('CLOUDFLARE_API_TOKEN');
    account = account || grab('cloudflare_account_id') || grab('CLOUDFLARE_ACCOUNT_ID');
  }
  if (!token || !account) {
    console.error('缺少 Cloudflare 凭据：CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（或 ../.credentials.yaml）');
    process.exit(1);
  }
  const env = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account };

  // 2) KV 命名空间：不存在则创建并回填 wrangler.toml
  //    注意：wrangler kv namespace create 无 --title 参数，title 自动生成为
  //    「<worker名>-<BINDING>」（即 tinttxt-api-DATA），list 匹配按此查找。
  log('检查/创建 KV 命名空间 …');
  const listRes = runWrangler(['kv', 'namespace', 'list'], { env });
  if (listRes.status !== 0) {
    console.error(`KV 列表失败：${listRes.stderr || listRes.stdout}`);
    process.exit(1);
  }
  let nsId = null;
  try {
    const list = JSON.parse(listRes.stdout);
    const found = list.find((n) => (n.title || '').includes('tinttxt-api'));
    nsId = found ? found.id : null;
  } catch {
    /* 输出非 JSON（如警告行）——下面创建时再取 */
  }
  if (!nsId) {
    const createRes = runWrangler(['kv', 'namespace', 'create', 'DATA'], { env });
    if (createRes.status !== 0) {
      console.error(`KV 创建失败：${createRes.stderr || createRes.stdout}`);
      process.exit(1);
    }
    const m = createRes.stdout.match(/id\s*=\s*([0-9a-f]{32})/);
    if (!m) {
      console.error(`无法从创建输出解析 namespace id：\n${createRes.stdout}`);
      process.exit(1);
    }
    nsId = m[1];
  }
  let toml = readFileSync(tomlPath, 'utf8');
  if (!toml.includes(nsId)) {
    toml = toml.replace(/id = "REPLACE_WITH_KV_NAMESPACE_ID"/, `id = "${nsId}"`);
    if (!toml.includes(nsId)) {
      // 已被别的 id 占位（换过账号）：直接替换那一行
      toml = toml.replace(/id = "[0-9a-f]{32}"/, `id = "${nsId}"`);
    }
    writeFileSync(tomlPath, toml, 'utf8');
    log(`wrangler.toml 已回填 KV id=${nsId}`);
  } else {
    log(`KV 已就绪（id=${nsId}）`);
  }

  // 3) 部署
  log('wrangler deploy …');
  const dep = runWrangler(['deploy'], { env });
  if (dep.status !== 0) {
    console.error(`部署失败：${dep.stderr || dep.stdout}`);
    process.exit(1);
  }
  const urlMatch = dep.stdout.match(/https:\/\/[a-z0-9-]+\.workers\.dev/);
  const url = urlMatch ? urlMatch[0] : 'https://tinttxt-api.<子域>.workers.dev';

  // 4) 探活
  log(`探活 ${url}/api/health …`);
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) {
        const j = await r.json();
        log(`健康：provider=${j.provider} configured=${j.configured}`);
        console.log(`\n✅ Worker 已上线：${url}`);
        console.log('   （供应商 configured=false 属预期：key 到手后 wrangler secret put 后重跑本脚本）');
        return;
      }
    } catch {
      /* 生效延迟，重试 */
    }
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  console.error('部署命令成功但探活超时——请稍后手动访问 /api/health 确认');
  process.exit(1);
}

main().catch((e) => {
  console.error('部署异常:', e);
  process.exit(1);
});
