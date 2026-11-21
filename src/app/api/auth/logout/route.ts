import { NextResponse } from "next/server";
import { OWNER_COOKIE_NAME } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ authenticated: false });
  res.cookies.set(OWNER_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
