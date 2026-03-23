import crypto from 'node:crypto';

interface JwtPayload {
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

const b64url = (obj: unknown) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresInSec = 86400 * 7, // 7 days
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: now, exp: now + expiresInSec };

  const unsigned = `${b64url(header)}.${b64url(fullPayload)}`;
  const sig = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const unsigned = `${headerB64}.${payloadB64}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(unsigned)
    .digest('base64url');

  if (sigB64 !== expected) return null;

  const payload = JSON.parse(
    Buffer.from(payloadB64!, 'base64url').toString(),
  ) as JwtPayload;

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
