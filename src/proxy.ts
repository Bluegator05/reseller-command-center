import { NextResponse, type NextRequest } from "next/server";
import {
  isOwnerLockEnabled,
  OWNER_COOKIE_NAME,
  verifyOwnerSessionToken,
  verifyPasscodeInput,
} from "@/lib/auth";

const PUBLIC_PATHS = [
  "/login",
  "/manifest.json",
  "/icon.svg",
  "/favicon.ico",
  "/api/auth/",
  "/api/webhooks/",
  "/api/inbound/order-email",
];

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/_next/")) return true;
  return PUBLIC_PATHS.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p
  );
}

/**
 * Next.js 16 Proxy guard for Owner Lock.
 * - Inactive when COMMAND_CENTER_PASSCODE is unset (local dev/demo).
 * - Enforces signed HttpOnly cookie on all UI + private API routes when set in Vercel.
 * - Allows Mac Mini Companion Extension calls to `/api/extension/jobs` when `x-owner-passcode` matches.
 * - Keeps eBay/Etsy webhooks & inbound order email endpoints accessible for signature-verified delivery.
 */
export async function proxy(request: NextRequest) {
  if (!isOwnerLockEnabled()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/extension/")) {
    const extPasscode = request.headers.get("x-owner-passcode")?.trim();
    if (extPasscode && verifyPasscodeInput(extPasscode)) {
      return NextResponse.next();
    }
  }

  const token = request.cookies.get(OWNER_COOKIE_NAME)?.value;
  const ok = await verifyOwnerSessionToken(token);
  if (ok) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Owner authentication required" },
      { status: 401 }
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
