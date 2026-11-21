"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  History,
  Loader2,
  Play,
  Puzzle,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import type { ChannelJob, JobStatusType } from "@/lib/types";

interface ExtensionQueuePanelProps {
  jobs: ChannelJob[];
  recentJobs?: ChannelJob[];
  onUpdateJobStatus: (params: {
    jobId: string;
    status: JobStatusType;
    externalUrl?: string;
    listedPrice?: number;
  }) => Promise<void>;
}

const CHANNEL_BADGE: Record<string, string> = {
  poshmark: "bg-[#FEF2F2] text-[#9F1239] border border-[#FECDD3]",
  mercari: "bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE]",
  facebook: "bg-[#ECFDF5] text-[#0F766E] border border-[#A7F3D0]",
};

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getActionLabel(job: ChannelJob): string {
  switch (job.action) {
    case "update_price":
      return "Price Drop";
    case "end_and_sell_similar":
      return "End & Sell Similar";
    case "send_offer":
      return "Send Offer";
    case "promote_listing":
      return "Promoted Listings";
    case "delist":
      return "Auto-Delist";
    case "create":
      return `Cross-List → ${job.marketplace}`;
  }
}

export function ExtensionQueuePanel({
  jobs,
  recentJobs = [],
  onUpdateJobStatus,
}: ExtensionQueuePanelProps) {
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  const needsConfirmJobs = jobs.filter(
    (j) => j.status === "needs_user_confirm"
  );
  const pendingJobs = jobs.filter(
    (j) => j.status === "pending" || j.status === "processing"
  );
  const completedJobs = jobs.filter(
    (j) => j.status === "completed" || j.status === "failed"
  );

  const handleSimulateRun = async (job: ChannelJob) => {
    setBusyJobId(job.id);
    try {
      const price = Number(job.payload?.suggestedPrice ?? 0);
      if (job.marketplace === "facebook") {
        // Respect blueprint safety gate: FB Marketplace pauses in needs_user_confirm
        await onUpdateJobStatus({
          jobId: job.id,
          status: "needs_user_confirm",
        });
      } else {
        await onUpdateJobStatus({
          jobId: job.id,
          status: "completed",
          listedPrice: price,
        });
      }
    } finally {
      setBusyJobId(null);
    }
  };

  const handleConfirmPublished = async (job: ChannelJob) => {
    setBusyJobId(job.id);
    try {
      await onUpdateJobStatus({
        jobId: job.id,
        status: "completed",
        listedPrice: Number(job.payload?.suggestedPrice ?? 0),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Header + Install Banner */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-white border border-[#E4E4DD] rounded-xl p-5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Puzzle className="w-4 h-4 text-[#14151A]" />
                <h2 className="text-base font-semibold text-[#14151A]">
                  Chrome / Arc Companion Extension Queue
                </h2>
              </div>
              <p className="text-xs text-[#5C606B] mt-1 leading-relaxed">
                Listening to{" "}
                <code className="font-mono text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                  channel_jobs
                </code>{" "}
                where{" "}
                <code className="font-mono text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                  execution_mode = &apos;extension&apos;
                </code>
                . Handles DOM form auto-fill and CORS-safe CDN image{" "}
                <code className="font-mono">Blob</code> injection for Poshmark,
                Mercari, and Facebook Marketplace.
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-[#ECECE6] bg-[#FAF9F6] px-3.5 py-2.5">
              <div className="text-[11px] text-[#5C606B]">Pending Auto-Fill</div>
              <div className="text-xl font-semibold font-mono tabular-nums text-[#1D4ED8] mt-0.5">
                {pendingJobs.length}
              </div>
            </div>
            <div className="rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3.5 py-2.5">
              <div className="text-[11px] text-[#B45309]">
                Needs User Confirm
              </div>
              <div className="text-xl font-semibold font-mono tabular-nums text-[#B45309] mt-0.5">
                {needsConfirmJobs.length}
              </div>
            </div>
            <div className="rounded-lg border border-[#ECECE6] bg-[#FAF9F6] px-3.5 py-2.5">
              <div className="text-[11px] text-[#5C606B]">Completed Jobs</div>
              <div className="text-xl font-semibold font-mono tabular-nums text-[#0F766E] mt-0.5">
                {completedJobs.filter((j) => j.status === "completed").length}
              </div>
            </div>
          </div>
        </div>

        {/* Load Unpacked Card */}
        <div className="bg-white border border-[#E4E4DD] rounded-xl p-5 shadow-[0_1px_2px_rgba(20,21,26,0.03)] flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-[#14151A]">
              <Terminal className="w-4 h-4" />
              <span>Load Unpacked (Chrome / Arc)</span>
            </div>
            <ol className="mt-2.5 space-y-1.5 text-xs text-[#5C606B] list-decimal list-inside">
              <li>
                Open{" "}
                <code className="font-mono text-[#14151A]">
                  chrome://extensions
                </code>{" "}
                or{" "}
                <code className="font-mono text-[#14151A]">
                  arc://extensions
                </code>
              </li>
              <li>Enable Developer Mode → click Load Unpacked</li>
              <li>
                Select{" "}
                <code className="font-mono text-[#14151A]">
                  reseller-command-center/extension
                </code>
              </li>
            </ol>
          </div>
          <div className="mt-3 pt-3 border-t border-[#ECECE6] flex items-center gap-1.5 text-[11px] text-[#0F766E] font-medium">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            <span>Zero build step · FB safety confirm gate active</span>
          </div>
        </div>
      </div>

      {/* Needs User Confirm (Facebook Marketplace Safety Gate) */}
      {needsConfirmJobs.length > 0 && (
        <section className="bg-white border border-[#FDE68A] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="px-4 py-3 border-b border-[#FDE68A] bg-[#FFFBEB] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-[#B45309]" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#92400E]">
                Awaiting Manual Publish Confirmation (needs_user_confirm)
              </h3>
            </div>
            <span className="font-mono text-xs text-[#B45309]">
              {needsConfirmJobs.length} paused
            </span>
          </div>
          <div className="divide-y divide-[#FEF3C7]">
            {needsConfirmJobs.map((job) => {
              const isBusy = busyJobId === job.id;
              const price = Number(job.payload?.suggestedPrice ?? 0);
              return (
                <div
                  key={job.id}
                  className="p-4 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase ${CHANNEL_BADGE[job.marketplace] || ""}`}
                      >
                        {job.marketplace}
                      </span>
                      <code className="font-mono text-xs font-semibold text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                        {job.item_sku || job.item_id}
                      </code>
                      <span className="font-mono text-xs font-semibold text-[#14151A]">
                        ${price.toFixed(2)}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-[#14151A] mt-1">
                      {String(job.payload?.mappedTitle || job.item_title || "")}
                    </p>
                    <p className="text-xs text-[#5C606B] mt-0.5">
                      DOM form &amp; CDN photos injected — paused before Publish
                      click for account safety. Confirm once published on
                      Facebook Marketplace.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleConfirmPublished(job)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#115E59] disabled:opacity-50 transition cursor-pointer shrink-0"
                  >
                    {isBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    )}
                    Confirm Published
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Pending Queue */}
      <section className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
        <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#14151A]" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#14151A]">
              Pending Extension Jobs
            </h3>
          </div>
          <span className="font-mono text-xs text-[#5C606B]">
            {pendingJobs.length} queued
          </span>
        </div>

        {pendingJobs.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#5C606B]">
            No pending extension jobs. Open any item&apos;s{" "}
            <strong className="text-[#14151A]">Cross-List</strong> drawer on the
            Stale-Item Radar tab to queue Poshmark, Mercari, or Facebook
            Marketplace jobs.
          </div>
        ) : (
          <div className="divide-y divide-[#F1F1EC]">
            {pendingJobs.map((job) => {
              const isBusy = busyJobId === job.id;
              const price = Number(job.payload?.suggestedPrice ?? 0);
              return (
                <div
                  key={job.id}
                  className="p-4 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase ${CHANNEL_BADGE[job.marketplace] || ""}`}
                      >
                        {job.marketplace}
                      </span>
                      {job.action === "delist" && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]">
                          URGENT DELIST
                        </span>
                      )}
                      <code className="font-mono text-xs font-semibold text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                        {job.item_sku || job.item_id}
                      </code>
                      {price > 0 && (
                        <span className="font-mono text-xs font-semibold text-[#14151A]">
                          ${price.toFixed(2)}
                        </span>
                      )}
                      <span className="text-[11px] font-mono text-[#8A8E99]">
                        Queued {formatTime(job.created_at)}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-[#14151A] mt-1">
                      {job.action === "delist"
                        ? `Sold on another channel — remove ${job.marketplace} listing immediately`
                        : String(job.payload?.mappedTitle || job.item_title || "")}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleSimulateRun(job)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50 transition cursor-pointer shrink-0 ${
                      job.action === "delist"
                        ? "bg-[#B91C1C] hover:bg-[#991B1B]"
                        : "bg-[#14151A] hover:bg-[#272A34]"
                    }`}
                  >
                    {isBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    {job.action === "delist"
                      ? "Execute Delist Now"
                      : job.marketplace === "facebook"
                        ? "Simulate Auto-Fill (Pauses for Confirm)"
                        : "Simulate Extension Auto-Fill"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Completed Extension History */}
      {completedJobs.length > 0 && (
        <section className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="px-4 py-3 border-b border-[#ECECE6] bg-[#FAF9F6] flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#14151A]">
              Completed Extension Jobs
            </h3>
            <span className="font-mono text-xs text-[#5C606B]">
              {completedJobs.length} finished
            </span>
          </div>
          <div className="divide-y divide-[#F1F1EC]">
            {completedJobs.slice(0, 10).map((job) => (
              <div
                key={job.id}
                className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#0F766E] shrink-0" />
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${CHANNEL_BADGE[job.marketplace] || ""}`}
                  >
                    {job.marketplace}
                  </span>
                  <code className="font-mono text-[#14151A] bg-[#F1F1EC] px-1.5 py-0.5 rounded">
                    {job.item_sku || job.item_id.slice(0, 8)}
                  </code>
                  <span className="text-[#5C606B] truncate">
                    {String(job.payload?.mappedTitle || job.item_title || "")}
                  </span>
                </div>
                <span className="font-mono text-[11px] text-[#8A8E99]">
                  {formatTime(job.completed_at || job.created_at)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Channel Jobs Execution Log (All API & Extension Jobs) */}
      <section className="bg-white border border-[#E5E8E6] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#EEF1EF] bg-[#F8FAF9] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-[#0F766E]" />
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#171A1D]">
              Recent Channel Jobs Log
            </h3>
          </div>
          <span className="font-mono text-[11px] text-[#5F666D]">
            channel_jobs · {recentJobs.length} recent
          </span>
        </div>

        {recentJobs.length === 0 ? (
          <div className="px-4 py-6 text-xs text-[#5F666D]">
            No API interventions or cross-lists executed yet.
          </div>
        ) : (
          <div className="divide-y divide-[#F1F4F2]">
            {recentJobs.slice(0, 20).map((job) => {
              const payload = job.payload || {};
              const detailText =
                job.action === "update_price" &&
                typeof payload.previousPrice === "number" &&
                typeof payload.newPrice === "number"
                  ? `$${payload.previousPrice.toFixed(2)} → $${payload.newPrice.toFixed(2)}${payload.wasClamped ? " (floor clamped)" : ""}`
                  : job.action === "end_and_sell_similar" &&
                      typeof payload.newExternalListingId === "string"
                    ? `Relisted as #${payload.newExternalListingId}`
                    : job.action === "send_offer" &&
                        typeof payload.offerPrice === "number"
                      ? `Offer $${payload.offerPrice.toFixed(2)} to ${payload.watchersCount ?? "?"} watcher(s)`
                      : job.action === "promote_listing"
                        ? `Promoted to ${String(payload.adRatePct ?? 4)}% ad rate (${String(payload.daysListed ?? "30+")}d rule)`
                        : job.action === "create" &&
                            typeof payload.price === "number"
                          ? `Listed #${payload.externalListingId ?? "draft"} at $${payload.price.toFixed(2)}`
                          : job.action === "delist"
                            ? `Anti-double-sell delist (${String(payload.reason ?? "sold")})`
                            : job.error_message || "Executed";

              return (
                <div
                  key={job.id}
                  className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <CheckCircle2
                      className={`w-3.5 h-3.5 shrink-0 ${
                        job.status === "failed"
                          ? "text-[#B91C1C]"
                          : "text-[#0F766E]"
                      }`}
                    />
                    <code className="font-mono font-medium text-[#171A1D] bg-[#F2F4F3] px-1.5 py-0.5 rounded shrink-0">
                      {job.item_sku || job.item_id.slice(0, 8)}
                    </code>
                    <span className="font-semibold text-[#171A1D] shrink-0">
                      {getActionLabel(job)}
                    </span>
                    <span className="text-[#5F666D] truncate">{detailText}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums text-[#8A929A]">
                    <span className="uppercase">{job.marketplace}</span>
                    <span>·</span>
                    <span className="uppercase">{job.execution_mode}</span>
                    <span>·</span>
                    <span>
                      {formatTime(job.completed_at || job.created_at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
