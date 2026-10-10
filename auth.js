import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { parseCookie, stringifySetCookie } from 'cookie';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { BlockList, isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SESSION_SECONDS = 8 * 60 * 60;
const file = name => fileURLToPath(new URL(name, import.meta.url));
// Rate-limit identity comes only from the transport peer, never request headers.
export function normalizeClientAddress(value) {
  if (typeof value !== 'string') return 'unknown-peer';
  let address = value.trim();
  const bracketed = address.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracketed) address = bracketed[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d{1,5}$/.test(address)) address = address.slice(0, address.lastIndexOf(':'));
  const family = isIP(address);
  if (!family) return 'unknown-peer';
  if (family === 4) return address;
  // IPv6 scope identifiers are local interface metadata, not client identity.
  address = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = address.match(/^::ffff:([a-f0-9]+):([a-f0-9]+)$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return address;
}

function trustedProxy(env) {
  // No assumed hop count or guessed Render address ranges. Enable only verified
  // immediate proxy addresses; direct clients cannot opt in with headers.
  if (env.AUTH_TRUSTED_PROXY_CIDRS === undefined) return () => false;
  const ranges = new BlockList();
  for (const entry of env.AUTH_TRUSTED_PROXY_CIDRS.split(',')) {
    const parts = entry.trim().split('/'), address = parts[0], family = isIP(address);
    const bits = family === 4 ? 32 : 128;
    const prefix = parts.length === 1 ? bits : Number(parts[1]);
    if (!family || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1])) ||
        !Number.isInteger(prefix) || prefix < 1 || prefix > bits) throw new Error('Invalid trusted proxy configuration');
    ranges.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return (address, hop) => {
    const normalized = normalizeClientAddress(address), family = isIP(normalized);
    return hop === 0 && !!family && ranges.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
  };
}
export function readAuthConfig(env = process.env) {
  const required = ['AUTH_USERNAME', 'AUTH_PASSWORD_HASH', 'AUTH_SESSION_SECRET', 'AUTH_SESSION_VERSION', 'APP_ORIGIN'];
  if (required.some(name => !env[name] || env[name] !== env[name].trim())) throw new Error('Required authentication configuration missing or invalid');
  if (!['production', 'development', 'test'].includes(env.NODE_ENV)) throw new Error('NODE_ENV must be explicitly configured');
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { throw new Error('Invalid APP_ORIGIN'); }
  const production = env.NODE_ENV === 'production';
  if (origin.origin !== env.APP_ORIGIN || origin.username || origin.password ||
      (production ? origin.protocol !== 'https:' : !['http:', 'https:'].includes(origin.protocol))) throw new Error('Invalid APP_ORIGIN');
  if (!production && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Nonproduction auth requires loopback origin');
  if (env.AUTH_USERNAME.length > 128 || !/^[A-Za-z0-9_.-]{1,64}$/.test(env.AUTH_SESSION_VERSION)) throw new Error('Invalid auth identity/version');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(env.AUTH_SESSION_SECRET)) throw new Error('Session secret must be random base64url with at least 32 bytes');
  const key = Buffer.from(env.AUTH_SESSION_SECRET, 'base64url');
  if (key.length < 32 || key.toString('base64url') !== env.AUTH_SESSION_SECRET) throw new Error('Invalid session secret encoding');
  const hash = env.AUTH_PASSWORD_HASH.match(/^\$argon2id\$v=19\$([mtp]=\d+,[mtp]=\d+,[mtp]=\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/);
  const parameters = hash ? Object.fromEntries(hash[1].split(',').map(item => item.split('='))) : {};
  if (!hash || Object.keys(parameters).length !== 3 || +parameters.m < 19456 || +parameters.m > 131072 ||
      +parameters.t < 2 || +parameters.t > 6 || +parameters.p < 1 || +parameters.p > 4 ||
      Buffer.from(hash[2], 'base64').length < 16 || Buffer.from(hash[3], 'base64').length !== 32) {
    throw new Error('Invalid or unsupported Argon2id password hash');
  }
  return { username: env.AUTH_USERNAME, passwordHash: env.AUTH_PASSWORD_HASH, key,
    version: env.AUTH_SESSION_VERSION, origin: origin.origin, production };
}

export async function installAuthentication(app, express, env = process.env) {
  const config = readAuthConfig(env);
  // Also let the hashing library validate the encoded hash before listening.
  try { await argon2.verify(config.passwordHash, 'auth-configuration-validation'); }
  catch { throw new Error('Invalid authentication password hash'); }
  const cookieName = config.production ? '__Host-kalshi_session' : 'kalshi_session_dev';
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/' };
  app.set('trust proxy', trustedProxy(env));
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  const checkOrigin = (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        (req.get('origin') !== config.origin || req.get('sec-fetch-site') === 'cross-site')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
  const publicFiles = { '/login': 'login.html', '/login.js': 'login.js',
    '/auth-client.js': 'auth-client.js', '/styles.css': 'styles.css', '/sw.js': 'sw.js' };
  for (const [route, name] of Object.entries(publicFiles)) app.get(route, (req, res) => {
    if (route === '/login') res.set('Clear-Site-Data', '"cache"');
    res.sendFile(file(name));
  });
  app.get('/live', (req, res) => res.json({ ok: true }));
  const limitOptions = { standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' } };
  const globalLimit = rateLimit({ ...limitOptions, windowMs: 60000, limit: 20, keyGenerator: () => 'owner-login' });
  const clientLimit = rateLimit({ ...limitOptions, windowMs: 15 * 60000, limit: 5, skipSuccessfulRequests: true,
    keyGenerator: req => ipKeyGenerator(normalizeClientAddress(req.socket.remoteAddress)),
    // Forwarded headers are deliberately irrelevant to this limiter.
    validate: { xForwardedForHeader: false, forwardedHeader: false } });
  let verifying = 0;
  app.post('/auth/login', checkOrigin, globalLimit, clientLimit, express.json({ limit: '2kb' }), async (req, res) => {
    if (verifying >= 2) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    const username = typeof req.body?.username === 'string' ? req.body.username.slice(0, 129) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 1025) : '';
    verifying++;
    try {
      const passwordOK = await argon2.verify(config.passwordHash, password);
      const digest = value => createHash('sha256').update(value).digest();
      const usernameOK = timingSafeEqual(digest(username), digest(config.username));
      if (!usernameOK || !passwordOK || password.length > 1024) return res.status(401).json({ error: 'Invalid credentials' });
      const token = await new SignJWT({ sessionVersion: config.version })
        .setProtectedHeader({ alg: 'HS256' }).setSubject('owner').setIssuer(config.origin).setAudience(config.origin)
        .setIssuedAt().setExpirationTime(`${SESSION_SECONDS}s`).sign(config.key);
      res.set('Set-Cookie', stringifySetCookie({ name: cookieName, value: token, ...cookieOptions, maxAge: SESSION_SECONDS }));
      res.json({ ok: true });
    } catch {
      res.status(401).json({ error: 'Invalid credentials' });
    } finally { verifying--; }
  });
  app.use(async (req, res, next) => {
    try {
      const token = parseCookie(req.headers.cookie || '')[cookieName];
      if (!token || token.length > 2048) throw new Error('No session');
      const { payload } = await jwtVerify(token, config.key, { algorithms: ['HS256'],
        issuer: config.origin, audience: config.origin, requiredClaims: ['sub', 'iat', 'exp', 'sessionVersion'] });
      const now = Math.floor(Date.now() / 1000);
      if (payload.sub !== 'owner' || payload.sessionVersion !== config.version ||
          !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat > now ||
          payload.exp - payload.iat !== SESSION_SECONDS) throw new Error('Invalid session');
      return next();
    } catch {
      const pathname = req.path.toLowerCase();
      if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) return res.status(401).json({ error: 'Authentication required' });
      return res.redirect(303, '/login');
    }
  });
  app.use(checkOrigin);
  app.get('/auth/session', (req, res) => res.json({ authenticated: true }));
  app.post('/auth/logout', (req, res) => {
    // Clear HTTP caches where supported, never storage/localStorage.
    res.set('Clear-Site-Data', '"cache"');
    res.set('Set-Cookie', stringifySetCookie({ name: cookieName, value: '', ...cookieOptions, maxAge: 0, expires: new Date(0) }));
    res.json({ ok: true });
  });
  const protectedFiles = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
    '/signal-engine.js': 'signal-engine.js', '/manifest.json': 'manifest.json' };
  for (const [route, name] of Object.entries(protectedFiles)) app.get(route, (req, res) => res.sendFile(file(name)));
  // Only explicit frontend paths are served. Express never serves the checkout.
  app.use((error, req, res, next) => res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid request' }));
}
