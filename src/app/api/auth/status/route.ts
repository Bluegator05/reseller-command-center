import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  isOwnerLockEnabled,
  OWNER_COOKIE_NAME,
  verifyOwnerSessionToken,
} from "@/lib/auth";

export async function GET() {
  const lockEnabled = isOwnerLockEnabled();
  if (!lockEnabled) {
    return NextResponse.json({ lockEnabled: false, authenticated: true });
  }
  const cookieStore = await cookies();
  const token = cookieStore.get(OWNER_COOKIE_NAME)?.value;
  const authenticated = await verifyOwnerSessionToken(token);
  return NextResponse.json({ lockEnabled: true, authenticated });
}
