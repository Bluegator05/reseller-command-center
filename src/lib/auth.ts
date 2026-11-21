export const OWNER_COOKIE_NAME = "rcc_owner_session";
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getConfiguredPasscode(): string {
  return (process.env.COMMAND_CENTER_PASSCODE || "").trim();
}

export function isOwnerLockEnabled(): boolean {
  return getConfiguredPasscode().length > 0;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generates a stateless HMAC-SHA256 signed owner session token valid for 30 days.
 * Works identically in Vercel Edge Runtime (proxy/middleware) and Node API routes.
 */
export async function createOwnerSessionToken(
  passcode: string
): Promise<string> {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  const payload = `owner.${exp}`;
  const sig = await hmacSha256(passcode, payload);
  return `${payload}.${sig}`;
}

export async function verifyOwnerSessionToken(
  token: string | undefined | null
): Promise<boolean> {
  const passcode = getConfiguredPasscode();
  if (!passcode) return true; // Lock disabled until COMMAND_CENTER_PASSCODE is set
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "owner") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const expected = await hmacSha256(passcode, `${parts[0]}.${parts[1]}`);
  return timingSafeEqualStr(parts[2], expected);
}

export function verifyPasscodeInput(candidate: string): boolean {
  const expected = getConfiguredPasscode();
  if (!expected) return true;
  return timingSafeEqualStr(candidate.trim(), expected);
}
