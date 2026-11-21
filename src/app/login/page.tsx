"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Compass, Loader2, Lock, ShieldCheck } from "lucide-react";

export default function OwnerLoginPage() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Invalid passcode");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error while unlocking command center.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F9F8] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white border border-[#E4E4DD] rounded-2xl shadow-sm p-6 space-y-5">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="w-12 h-12 rounded-2xl bg-[#0F766E] text-white flex items-center justify-center shadow-xs">
            <Compass className="w-6 h-6" />
          </div>
          <h1 className="text-base font-bold text-[#14151A]">
            Reseller Command Center
          </h1>
          <p className="text-xs text-[#5C606B]">
            Protected owner workspace · Enter your passcode to access inventory,
            COGS, and marketplace APIs.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div>
            <label
              htmlFor="owner-passcode"
              className="block text-[11px] font-semibold text-[#444B52] mb-1.5"
            >
              Owner Passcode
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-[#8E969D] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="owner-passcode"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Enter passcode…"
                className="w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border border-[#DDE2DF] bg-[#FAFBF9] focus:bg-white focus:border-[#0F766E] focus:outline-none"
                required
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-[#FEF2F2] border border-[#FECACA] px-3 py-2 text-xs text-[#B91C1C]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || !passcode.trim()}
            className="w-full py-2.5 rounded-xl bg-[#0F766E] text-white text-xs font-semibold hover:bg-[#0B5B55] disabled:opacity-50 transition flex items-center justify-center gap-2 cursor-pointer"
          >
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ShieldCheck className="w-4 h-4" />
            )}
            <span>Unlock Command Center</span>
          </button>
        </form>

        <p className="text-[11px] text-center text-[#7C858D]">
          Session stays unlocked for 30 days per device (iMac, MacBook Air, Mac
          Mini, iPhone).
        </p>
      </div>
    </div>
  );
}
