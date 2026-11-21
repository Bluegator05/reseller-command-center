import { NextResponse } from "next/server";
import {
  createOwnerSessionToken,
  getConfiguredPasscode,
  isOwnerLockEnabled,
  OWNER_COOKIE_NAME,
  verifyPasscodeInput,
} from "@/lib/auth";

export async function POST(request: Request) {
  if (!isOwnerLockEnabled()) {
    return NextResponse.json({
      authenticated: true,
      lockEnabled: false,
      message: "Owner Lock is not enabled (COMMAND_CENTER_PASSCODE is unset).",
    });
  }

  let body: { passcode?: string };
  try {
    body = (await request.json()) as { passcode?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (!body.passcode || !verifyPasscodeInput(body.passcode)) {
    return NextResponse.json(
      { error: "Incorrect owner passcode" },
      { status: 401 }
    );
  }

  const token = await createOwnerSessionToken(getConfiguredPasscode());
  const res = NextResponse.json({ authenticated: true, lockEnabled: true });
  res.cookies.set(OWNER_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
