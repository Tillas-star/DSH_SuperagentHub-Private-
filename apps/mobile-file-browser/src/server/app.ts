import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { AccessMode } from '../shared/types';
import type { PasswordStore } from './auth/password';
import type { PairingToken } from './auth/pairing';
import { LoginLimiter, PairingLimiter } from './auth/rate-limit';
import {
  SESSION_COOKIE_NAME,
  type SessionStore,
} from './auth/session';
import type { AppConfig } from './config';
import { describeRoots, listDirectory } from './directories';
import { AppError, isAppError, toApiErrorBody } from './errors';
import { sendImage } from './images';
import { PathGuard } from './paths';
import { RemotePolicy } from './remote';
import { ThumbnailService } from './thumbnails';

export interface AppOptions {
  config: AppConfig;
  passwordStore: PasswordStore;
  sessionStore: SessionStore;
  pairing: PairingToken;
  /** Directory containing the built Vite app (dist/web). Omit in API-only tests. */
  webDir?: string;
  now?: () => number;
  loginDelayMs?: number;
  logger?: boolean;
  https?: { key: string | Buffer; cert: string | Buffer };
  thumbnails?: ThumbnailService;
}

const PROTECTED_PATHS = new Set([
  '/api/roots',
  '/api/directories',
  '/api/thumbnails',
  '/api/images',
  '/api/session/logout',
]);

const ALLOWED_METHODS: Record<string, readonly string[]> = {
  '/healthz': ['GET', 'HEAD'],
  '/api/session': ['GET', 'HEAD'],
  '/api/session/pair': ['POST'],
  '/api/session/login': ['POST'],
  '/api/session/logout': ['POST'],
  '/api/roots': ['GET', 'HEAD'],
  '/api/directories': ['GET', 'HEAD'],
  '/api/thumbnails': ['GET', 'HEAD'],
  '/api/images': ['GET', 'HEAD'],
};

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const loginDelayMs = options.loginDelayMs ?? config.loginDelayMs;
  const guard = new PathGuard(config.roots);
  const thumbnails =
    options.thumbnails ??
    new ThumbnailService({
      guard,
      cacheDir: config.thumbsDir,
      maxWidth: config.thumbWidth,
      maxImagePixels: config.maxImagePixels,
      maxCacheBytes: config.thumbsMaxSizeBytes,
      concurrency: 4,
    });
  const remote = new RemotePolicy(config);
  const loginLimiter = new LoginLimiter(now);
  const pairingLimiter = new PairingLimiter(now);

  const app = Fastify({
    bodyLimit: 8192,
    trustProxy: false,
    logger: options.logger
      ? {
          serializers: {
            req(request) {
              const url = request.url ?? '';
              const queryIndex = url.indexOf('?');
              return {
                method: request.method,
                url: queryIndex === -1 ? url : url.slice(0, queryIndex),
              };
            },
          },
        }
      : false,
    routerOptions: { ignoreTrailingSlash: true },
    ...(options.https ? { https: options.https } : {}),
  });

  await app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    if (!remote.checkHost(request)) {
      reply.code(403).send(toApiErrorBody('forbidden-path'));
      return;
    }
    if (!enforceMethod(request, reply)) return;
    if (request.method === 'POST' && !remote.checkOrigin(request)) {
      reply.code(403).send(toApiErrorBody('forbidden-path'));
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    const routePath = requestPath(request);
    if (PROTECTED_PATHS.has(routePath) && !currentSession(request)) {
      reply.code(401).send(toApiErrorBody('unauthorized'));
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (remote.isSecure(request)) {
      reply.header('Strict-Transport-Security', 'max-age=15552000');
    }
    return payload;
  });

  app.get('/healthz', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });

  app.get('/api/session', async (request, reply) => {
    const token = sessionToken(request);
    const session = currentSession(request);
    reply.header('Cache-Control', 'no-store');
    if (token && !session) clearSessionCookie(reply, remote.isSecure(request));
    return {
      authenticated: Boolean(session),
      mode: config.mode satisfies AccessMode,
      passwordConfigured: options.passwordStore.hasPassword(),
      pairingAvailable: options.pairing.available(now()),
      ...(session ? { expiresAt: new Date(session.expiresAt).toISOString() } : {}),
    };
  });

  app.post('/api/session/pair', async (request, reply) => {
    const ip = remote.clientIp(request);
    const rate = pairingLimiter.check(ip);
    if (!rate.ok) {
      reply
        .code(429)
        .header('Retry-After', String(rate.retryAfterSeconds))
        .send(toApiErrorBody('rate-limited'));
      return;
    }
    const body = request.body as { token?: unknown } | undefined;
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!options.pairing.consume(token, now())) {
      pairingLimiter.fail(ip);
      reply.code(401).send(toApiErrorBody('unauthorized'));
      return;
    }
    pairingLimiter.success(ip);
    const created = await options.sessionStore.create();
    setSessionCookie(reply, created.token, created.expiresAt, remote.isSecure(request), now());
    reply.code(204).send();
  });

  app.post('/api/session/login', async (request, reply) => {
    const ip = remote.clientIp(request);
    const started = Date.now();
    // Apply a fixed minimum delay before every login response, including
    // rate-limited and failed ones, so response timing does not reveal which
    // step failed.
    const finish = async (send: () => void): Promise<void> => {
      const elapsed = Date.now() - started;
      if (elapsed < loginDelayMs) await sleep(loginDelayMs - elapsed);
      send();
    };

    const rate = loginLimiter.check(ip);
    if (!rate.ok) {
      await finish(() => {
        reply
          .code(429)
          .header('Retry-After', String(rate.retryAfterSeconds))
          .send(toApiErrorBody('rate-limited'));
      });
      return;
    }
    const body = request.body as { password?: unknown } | undefined;
    const password = typeof body?.password === 'string' ? body.password : '';
    const valid = password.length > 0 && (await options.passwordStore.verify(password));
    if (!valid) {
      loginLimiter.fail(ip);
      await finish(() => {
        reply.code(401).send(toApiErrorBody('invalid-credentials'));
      });
      return;
    }
    loginLimiter.success(ip);
    const previous = sessionToken(request);
    if (previous) await options.sessionStore.delete(previous);
    const created = await options.sessionStore.create();
    setSessionCookie(reply, created.token, created.expiresAt, remote.isSecure(request), now());
    await finish(() => {
      reply.code(204).send();
    });
  });

  app.post('/api/session/logout', async (request, reply) => {
    await options.sessionStore.delete(sessionToken(request));
    clearSessionCookie(reply, remote.isSecure(request));
    reply.code(204).send();
  });

  app.get('/api/roots', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { roots: describeRoots(config) };
  });

  app.get('/api/directories', async (request, reply) => {
    const { root, path: relativePath } = readQuery(request, ['root', 'path']);
    if (!root) throw new AppError('not-found');
    const directory = await listDirectory(
      { guard, showHidden: config.showHidden, maxEntries: config.maxEntries },
      root,
      relativePath,
    );
    reply.header('Cache-Control', 'no-store');
    return directory;
  });

  app.get('/api/thumbnails', async (request, reply) => {
    const { root, path: relativePath, w } = readQuery(request, ['root', 'path', 'w']);
    if (!root || !relativePath) throw new AppError('not-found');
    const width = w && /^\d+$/.test(w) ? Number(w) : undefined;
    const result = await thumbnails.get(root, relativePath, width);
    return thumbnails.send(request, reply, result);
  });

  app.get('/api/images', async (request, reply) => {
    const { root, path: relativePath, preview } = readQuery(request, ['root', 'path', 'preview']);
    if (!root || !relativePath) throw new AppError('not-found');
    const resolved = await guard.resolve(root, relativePath);
    let stat;
    try {
      stat = await fs.stat(resolved.absolutePath);
    } catch {
      throw new AppError('not-found');
    }
    if (!stat.isFile()) throw new AppError('not-found');
    return sendImage(request, reply, resolved.absolutePath, path.basename(resolved.absolutePath), {
      preview: preview === '1' || preview === 'true',
    });
  });

  let hasWebAssets = false;
  if (options.webDir) {
    try {
      await fs.access(path.join(options.webDir, 'index.html'));
      hasWebAssets = true;
    } catch {
      hasWebAssets = false;
    }
  }

  if (hasWebAssets && options.webDir) {
    await app.register(fastifyStatic, {
      root: options.webDir,
      wildcard: false,
      index: false,
      cacheControl: true,
      maxAge: 86_400_000,
      dotfiles: 'deny',
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const routePath = requestPath(request);
    if (routePath === '/api' || routePath.startsWith('/api/') || routePath === '/healthz') {
      reply.code(404).send(toApiErrorBody('not-found'));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply.code(405).header('Allow', 'GET, HEAD').send(toApiErrorBody('method-not-allowed'));
      return;
    }
    if (path.extname(routePath) !== '' || routePath.startsWith('/assets/')) {
      reply.code(404).send(toApiErrorBody('not-found'));
      return;
    }
    if (!hasWebAssets || !options.webDir) {
      reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send('前端资源尚未构建，请先运行 npm run build。');
      return;
    }
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('index.html');
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    if (isAppError(error)) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(error.retryAfterSeconds));
      }
      reply.code(error.status).send(toApiErrorBody(error.code));
      return;
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      reply.code(413).send(toApiErrorBody('bad-request'));
      return;
    }
    if (statusCode === 400 || statusCode === 415) {
      reply.code(400).send(toApiErrorBody('bad-request'));
      return;
    }
    if (statusCode === 404) {
      reply.code(404).send(toApiErrorBody('not-found'));
      return;
    }
    if (statusCode === 405) {
      reply.code(405).send(toApiErrorBody('method-not-allowed'));
      return;
    }
    request.log.error({ err: error }, 'unhandled request error');
    reply.code(500).send(toApiErrorBody('internal'));
  });

  return app;

  function currentSession(request: FastifyRequest) {
    return options.sessionStore.validate(sessionToken(request));
  }
}

function enforceMethod(request: FastifyRequest, reply: FastifyReply): boolean {
  const routePath = requestPath(request);
  const allowed = ALLOWED_METHODS[routePath];
  if (!allowed) return true;
  const method = request.method.toUpperCase();
  if (allowed.includes(method)) return true;
  reply
    .code(405)
    .header('Allow', allowed.join(', '))
    .send(toApiErrorBody('method-not-allowed'));
  return false;
}

function requestPath(request: FastifyRequest): string {
  const url = request.url;
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.replace(/\/+$/, '');
  return pathname;
}

function sessionToken(request: FastifyRequest): string | undefined {
  const value = request.cookies?.[SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: number,
  secure: boolean,
  nowMs: number,
): void {
  const maxAge = Math.max(1, Math.floor((expiresAt - nowMs) / 1000));
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge,
  });
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE_NAME, '', {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: 0,
    expires: new Date(0),
  });
}

function readQuery(
  request: FastifyRequest,
  keys: string[],
): Record<string, string | undefined> {
  const query = request.query as Record<string, unknown> | undefined;
  const result: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = query?.[key];
    if (value === undefined) {
      result[key] = undefined;
    } else if (typeof value === 'string') {
      result[key] = value;
    } else {
      throw new AppError('forbidden-path');
    }
  }
  return result;
}
