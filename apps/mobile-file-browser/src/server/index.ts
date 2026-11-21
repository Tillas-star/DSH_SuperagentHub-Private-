import { promises as fs } from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { createApp } from './app';
import { PasswordStore, validatePassword } from './auth/password';
import { PairingToken } from './auth/pairing';
import { SessionStore } from './auth/session';
import {
  createConfig,
  defaultDataDir,
  describeMode,
  lanIpv4Addresses,
  parseCliArgs,
  UsageError,
  USAGE,
  type AppConfig,
} from './config';
import { PathGuard } from './paths';
import { ThumbnailService } from './thumbnails';
import { formatDuration } from './util/fs';
import { APP_VERSION } from '../shared/version';

async function main(): Promise<void> {
  let cli;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    fail(error);
    process.exitCode = 1;
    return;
  }

  if (cli.help) {
    console.log(USAGE);
    return;
  }
  if (cli.version) {
    console.log(APP_VERSION);
    return;
  }

  try {
    const dataDir = defaultDataDir();

    if (cli.setPassword) {
      const store = new PasswordStore(dataDir);
      await store.load();
      await runSetPassword(store);
      return;
    }

    const config = await createConfig(cli);
    const passwordStore = new PasswordStore(config.dataDir);
    await passwordStore.load();
    if (config.mode === 'remote' && !passwordStore.hasPassword()) {
      throw new UsageError(
        '远程模式必须先用 npm start -- --set-password 设置访问密码，拒绝以无认证状态启动',
      );
    }
    if (config.mode === 'remote' && config.lan) {
      console.warn('警告: 远程模式同时开启了 --lan；建议去掉 --lan，只监听回环并让隧道转发。');
    }
    if (config.lan) {
      console.warn('警告: 局域网模式会向同一 Wi-Fi 的设备开放服务，请只连接可信网络。');
    }

    const sessionStore = new SessionStore(config.dataDir, config.sessionTtlMs);
    await sessionStore.load();
    if (cli.resetSessions) {
      const count = sessionStore.size();
      await sessionStore.deleteAll();
      console.log(`已清除 ${count} 个会话；所有已登录设备都需要重新登录。`);
    }

    const pairing = new PairingToken(config.pairingTtlMs);
    const guard = new PathGuard(config.roots);
    const thumbnails = new ThumbnailService({
      guard,
      cacheDir: config.thumbsDir,
      maxWidth: config.thumbWidth,
      maxImagePixels: config.maxImagePixels,
      maxCacheBytes: config.thumbsMaxSizeBytes,
      concurrency: 4,
    });
    try {
      const pruned = await thumbnails.prune();
      if (config.verbose && pruned.deleted > 0) {
        console.log(`缩略图缓存清理: 删除 ${pruned.deleted} 个文件。`);
      }
    } catch (error) {
      if (config.verbose) console.warn('缩略图缓存清理失败:', (error as Error).message);
    }

    const webDir = path.resolve(__dirname, '..', 'web');
    const hasWebAssets = await exists(path.join(webDir, 'index.html'));
    if (!hasWebAssets) {
      console.warn('警告: 未找到前端构建产物 dist/web；请先运行 npm run build，否则浏览器页面不可用。');
    }

    const https =
      config.tlsCert && config.tlsKey
        ? {
            cert: await fs.readFile(config.tlsCert),
            key: await fs.readFile(config.tlsKey),
          }
        : undefined;

    const app = await createApp({
      config,
      passwordStore,
      sessionStore,
      pairing,
      webDir: hasWebAssets ? webDir : undefined,
      logger: config.verbose,
      https,
      thumbnails,
    });

    try {
      await app.listen({ host: config.host, port: config.port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new UsageError(`端口 ${config.port} 已被占用，请用 --port 换一个端口`);
      }
      throw error;
    }

    const address = app.server.address();
    const port =
      address && typeof address === 'object' && 'port' in address ? address.port : config.port;
    printStartup(config, port, pairing, passwordStore.hasPassword());
    pairing.clearToken();

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`\n收到 ${signal}，正在退出…`);
      try {
        await app.close();
      } finally {
        process.exit(0);
      }
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    fail(error);
    process.exitCode = 1;
  }
}

async function runSetPassword(store: PasswordStore): Promise<void> {
  console.log('设置访问密码（至少 12 个字符，输入不会回显）。');
  if (store.hasPassword()) console.log('已有访问密码，本次将覆盖它。');

  let first: string;
  let second: string;
  if (process.stdin.isTTY) {
    first = await promptHidden('访问密码: ');
    validatePassword(first);
    second = await promptHidden('再次输入: ');
  } else {
    // Non-interactive use (piping or automation): read both lines at once.
    const input = await readAllStdin();
    const lines = input.split(/\r?\n/);
    first = lines[0] ?? '';
    second = lines[1] ?? '';
    process.stdout.write('访问密码: ********\n再次输入: ********\n');
  }
  validatePassword(first);
  if (first !== second) throw new UsageError('两次输入的密码不一致');
  await store.setPassword(first);
  console.log('访问密码已保存（仅保存 scrypt 哈希）。忘记密码时在电脑上重新运行 --set-password。');
}

async function readAllStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return data;
}

async function promptHidden(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const finish = (): void => {
      cleanup();
      process.stdout.write('\n');
    };
    const onEnd = (): void => {
      finish();
      reject(new Error('没有读取到密码输入'));
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          finish();
          reject(new Error('已取消'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
    stdin.once('end', onEnd);
  });
}

function printStartup(
  config: AppConfig,
  port: number,
  pairing: PairingToken,
  passwordConfigured: boolean,
): void {
  const scheme = config.tlsCert ? 'https' : 'http';
  const lanAddresses = config.lan ? lanIpv4Addresses() : [];
  const localBase = `${scheme}://127.0.0.1:${port}/`;
  const pairFragment = `#pair=${encodeURIComponent(pairing.token)}`;

  console.log('');
  console.log(`mobile-files ${APP_VERSION}`);
  console.log(`模式      ${describeMode(config)}`);
  if (config.mode === 'remote') {
    console.log(`本机调试  ${localBase}`);
    for (const address of lanAddresses) console.log(`局域网    ${scheme}://${address}:${port}/`);
    console.log(`公网地址  ${config.publicUrl?.origin}   （需隧道已启动）`);
    console.log(`隧道提示  tailscale serve --bg ${port}`);
    console.log(`监听      ${config.host}:${port}（远程模式默认只监听回环，不需要路由器端口映射）`);
    console.log('登录      外网使用访问密码；配对二维码只在局域网/本机模式下提供');
  } else {
    const localUrl = `${localBase}${pairFragment}`;
    const lanUrls = lanAddresses.map(
      (address) => `${scheme}://${address}:${port}/${pairFragment}`,
    );
    const qrUrl = lanUrls[0] ?? localUrl;
    console.log(`本机访问  ${localUrl}`);
    for (const url of lanUrls) console.log(`局域网    ${url}`);
    console.log('外网访问  使用 --public-url https://... 并启动 Tailscale/Cloudflare 隧道（见 README）');
    if (lanUrls.length === 0 && config.lan) {
      console.log('提醒      没有找到局域网 IPv4 地址；请检查网络连接。');
    }
    console.log('');
    console.log('手机扫码配对（一次性，10 分钟内有效）:');
    qrcode.generate(qrUrl, { small: true });
  }
  console.log(
    `认证      ${passwordConfigured ? '访问密码已设置；外网登录使用密码' : '未设置访问密码；仅可用一次性配对链接'}`,
  );
  console.log(`会话有效期 ${formatDuration(config.sessionTtlMs)}；Ctrl+C 退出`);
  console.log('只读浏览：没有上传、删除、重命名或下载按钮。');
  console.log('');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n错误: ${message}`);
  if (error instanceof UsageError) {
    console.error('运行 npm start -- --help 查看用法。');
  }
}

void main();
