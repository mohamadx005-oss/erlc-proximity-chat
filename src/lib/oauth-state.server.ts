/** Signed, short-lived state strings for OAuth round-trips. Server-only. */

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(): Promise<CryptoKey> {
  const secret = process.env["APP_STATE_SECRET"];
  if (!secret) throw new Error("APP_STATE_SECRET is not configured");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const MAX_AGE_MS = 10 * 60 * 1000;

export async function signState(payload: Record<string, string>): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify({ ...payload, t: Date.now() })));
  const sig = await crypto.subtle.sign("HMAC", await key(), encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyState(state: string | null): Promise<Record<string, string> | null> {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await key(), fromB64url(sig), encoder.encode(body));
  if (!ok) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Record<string, string>;
    const t = Number(parsed["t"]);
    if (!Number.isFinite(t) || Date.now() - t > MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function appOrigin(request: Request): string {
  const u = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || u.host;
  const isLocal = host.startsWith("localhost") || host.startsWith("127.");
  return `${isLocal ? u.protocol.replace(":", "") : "https"}://${host}`;
}

export function errorRedirect(request: Request, message: string): Response {
  const url = new URL("/", appOrigin(request));
  url.searchParams.set("auth_error", message);
  return Response.redirect(url.toString(), 302);
}
