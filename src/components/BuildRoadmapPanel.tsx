"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  Check,
  CheckCircle2,
  Circle,
  ClipboardCopy,
  Database,
  FileCode2,
  KeyRound,
  Plus,
  Trash2,
} from "lucide-react";
import type {
  AdjustmentLogEntry,
  EnvReadiness,
  RoadmapPhase,
} from "@/lib/types";

interface BuildRoadmapPanelProps {
  envReadiness: EnvReadiness;
  mode: "live" | "demo";
}

const ROADMAP_STORAGE_KEY = "rcc_roadmap_state_v4";
const ADJUSTMENTS_STORAGE_KEY = "rcc_adjustments_log_v4";
const STORAGE_SYNC_EVENT = "rcc_local_storage_sync";

function subscribeToLocalStorage(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(STORAGE_SYNC_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(STORAGE_SYNC_EVENT, callback);
  };
}

function useStoredJson<T>(key: string, fallback: T): [T, (next: T) => void] {
  const raw = useSyncExternalStore(
    subscribeToLocalStorage,
    () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null
  );

  let value = fallback;
  if (raw) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      value = fallback;
    }
  }

  const setValue = useCallback(
    (next: T) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
        window.dispatchEvent(new Event(STORAGE_SYNC_EVENT));
      } catch {
        // Ignore storage quota errors
      }
    },
    [key]
  );

  return [value, setValue];
}

const DEFAULT_PHASES: RoadmapPhase[] = [
  {
    phase: 1,
    title: "Phase 1: eBay Command Center & Stale Engine",
    status: "active",
    summary:
      "PostgreSQL source of truth, eBay Inventory/Negotiation API wrappers, stale detection radar, and 1-click COGS-protected interventions.",
    tasks: [
      {
        id: "p1-scaffold",
        label:
          "Scaffold Next.js (App Router) + TypeScript + Tailwind + @supabase/supabase-js + lucide-react",
        done: true,
        tag: "Core",
      },
      {
        id: "p1-schema",
        label:
          "Author PostgreSQL schema (supabase/schema.sql) for master inventory, listings, channel_jobs, stale_rules, and sales_orders",
        done: true,
        tag: "Supabase",
      },
      {
        id: "p1-ebay-lib",
        label:
          "Build src/lib/ebay.ts (OAuth token refresh, fetch active offers, update price, end & sell similar, send offers)",
        done: true,
        tag: "eBay API",
      },
      {
        id: "p1-sync-route",
        label:
          "Build POST /api/ebay/sync to pull active eBay listings into inventory_items and marketplace_listings",
        done: true,
        tag: "API Route",
      },
      {
        id: "p1-action-route",
        label:
          "Build POST /api/ebay/action to execute 10% price drops (clamped to floor_price) and End & Sell Similar",
        done: true,
        tag: "API Route",
      },
      {
        id: "p1-ui",
        label:
          "Build Web Command Center with Channel Status Strip, Stale-Item Radar, and Build Roadmap & Adjustments tabs",
        done: true,
        tag: "UI",
      },
    ],
  },
  {
    phase: 2,
    title: "Phase 2: Etsy API Sync & AI Field Mapper",
    status: "active",
    summary:
      "Translate eBay listings into Etsy-ready titles, stripped plain descriptions, mapped categories, SEO tags, and fee-adjusted prices.",
    tasks: [
      {
        id: "p2-gemini",
        label:
          "Build Gemini payload mapper (src/lib/gemini-mapper.ts & POST /api/ai/map) — shorten titles, strip HTML, fee-adjust prices, map Etsy taxonomy & <=13 tags",
        done: true,
        tag: "Gemini AI",
      },
      {
        id: "p2-etsy-api",
        label:
          "Connect Etsy Open API v3 (src/lib/etsy.ts, POST /api/etsy/crosslist, POST /api/etsy/sync) + interactive CrossListDrawer UI",
        done: true,
        tag: "Etsy API",
      },
    ],
  },
  {
    phase: 3,
    title: "Phase 3: Chrome/Arc Companion Extension",
    status: "active",
    summary:
      "Manifest V3 extension subscribed/polling channel_jobs for DOM auto-fill and CORS-safe image Blob injection.",
    tasks: [
      {
        id: "p3-ext-scaffold",
        label:
          "Scaffold zero-build Manifest V3 extension in /extension (manifest.json, background.js, popup UI)",
        done: true,
        tag: "Extension",
      },
      {
        id: "p3-realtime",
        label:
          "Connect extension to channel_jobs (execution_mode = 'extension') via /api/extension/jobs bridge and direct Supabase PostgREST",
        done: true,
        tag: "Queue",
      },
      {
        id: "p3-dom-fillers",
        label:
          "Build DOM form auto-fillers + CDN image Blob uploaders for Poshmark, Mercari, and Facebook Marketplace (with mandatory needs_user_confirm pause)",
        done: true,
        tag: "Automation",
      },
    ],
  },
  {
    phase: 4,
    title: "Phase 4: Anti-Double-Sell & Auto-Delist",
    status: "active",
    summary:
      "Real-time sale detection across API webhooks and inbound order emails to cascade delist jobs immediately.",
    tasks: [
      {
        id: "p4-webhooks",
        label:
          "Wire eBay/Etsy sale webhooks (/api/webhooks/ebay & /api/webhooks/etsy) to mark items sold and cascade delist jobs across active channels",
        done: true,
        tag: "Webhooks",
      },
      {
        id: "p4-email-parser",
        label:
          "Add inbound order-email parser (/api/inbound/order-email) for Poshmark, Mercari, and Facebook Marketplace sales + Sales Ledger UI",
        done: true,
        tag: "Inbound",
      },
      {
        id: "p4-deploy-live",
        label:
          "Run supabase/schema.sql in Supabase, populate .env.local, and load /extension unpacked in Chrome or Arc",
        done: false,
        tag: "Setup",
      },
    ],
  },
];

const DEFAULT_ADJUSTMENTS: AdjustmentLogEntry[] = [
  {
    id: "adj-6",
    date: "2026-11-20",
    phase: 4,
    category: "workflow",
    title: "Unified Anti-Double-Sell Cascade Engine + Embedded SKU Matching",
    note: "All sale sources (eBay webhook, Etsy webhook, and Poshmark/Mercari/FB inbound order emails) route through processSaleAndCascadeDelist(), ending API listings immediately and queueing urgent DELIST jobs for extension channels.",
  },
  {
    id: "adj-5",
    date: "2026-11-20",
    phase: 3,
    category: "architecture",
    title: "Zero-Build MV3 Extension + CORS-Safe Service Worker Image Proxy",
    note: "Built /extension as pure Manifest V3 ES/DOM scripts so it loads unpacked directly in Chrome or Arc. Image URLs are fetched inside background.js and transferred as base64 Blobs into DataTransfer to bypass marketplace page CORS.",
  },
  {
    id: "adj-4",
    date: "2026-11-20",
    phase: 2,
    category: "api",
    title: "Gemini AI Mapper + Etsy 13-Tag / 20-Char Sanitizer",
    note: "Built src/lib/gemini-mapper.ts using Gemini structured JSON output with automatic fallback to deterministic taxonomy/tag mapping, enforcing Etsy's 13-tag / 20-char rules and fee-adjusted margin parity.",
  },
  {
    id: "adj-1",
    date: "2026-11-20",
    phase: 1,
    category: "pricing",
    title: "Strict COGS Floor Clamping on Bulk Price Drops",
    note: "Added computeClampedPriceDrop() so both single and bulk -10% drops clamp cleanly to inventory_items.floor_price and skip items already sitting at floor.",
  },
];

const CATEGORY_STYLES: Record<AdjustmentLogEntry["category"], string> = {
  architecture: "bg-[#EFF6FF] text-[#1D4ED8]",
  pricing: "bg-[#ECFDF5] text-[#0F766E]",
  api: "bg-[#FEF3C7] text-[#B45309]",
  workflow: "bg-[#F1F1EC] text-[#444854]",
};

export function BuildRoadmapPanel({
  envReadiness,
  mode,
}: BuildRoadmapPanelProps) {
  const [phases, persistPhases] = useStoredJson<RoadmapPhase[]>(
    ROADMAP_STORAGE_KEY,
    DEFAULT_PHASES
  );
  const [adjustments, persistAdjustments] = useStoredJson<AdjustmentLogEntry[]>(
    ADJUSTMENTS_STORAGE_KEY,
    DEFAULT_ADJUSTMENTS
  );
  const [newTitle, setNewTitle] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newPhase, setNewPhase] = useState<number>(2);
  const [newCategory, setNewCategory] =
    useState<AdjustmentLogEntry["category"]>("architecture");
  const [copiedEnv, setCopiedEnv] = useState(false);

  const toggleTask = (phaseNum: number, taskId: string) => {
    const updated = phases.map((phase) => {
      if (phase.phase !== phaseNum) return phase;
      return {
        ...phase,
        tasks: phase.tasks.map((t) =>
          t.id === taskId ? { ...t, done: !t.done } : t
        ),
      };
    });
    persistPhases(updated);
  };

  const handleAddAdjustment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newNote.trim()) return;
    const entry: AdjustmentLogEntry = {
      id: `adj-${Date.now()}`,
      date: new Date().toISOString().slice(0, 10),
      phase: newPhase,
      category: newCategory,
      title: newTitle.trim(),
      note: newNote.trim(),
    };
    persistAdjustments([entry, ...adjustments]);
    setNewTitle("");
    setNewNote("");
  };

  const handleRemoveAdjustment = (id: string) => {
    persistAdjustments(adjustments.filter((a) => a.id !== id));
  };

  const totalTasks = phases.reduce((sum, p) => sum + p.tasks.length, 0);
  const completedTasks = phases.reduce(
    (sum, p) => sum + p.tasks.filter((t) => t.done).length,
    0
  );
  const overallPct =
    totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const envItems = [
    { key: "NEXT_PUBLIC_SUPABASE_URL", ready: envReadiness.supabaseUrl },
    {
      key: "SUPABASE_SERVICE_ROLE_KEY",
      ready: envReadiness.supabaseServiceKey,
    },
    { key: "EBAY_CLIENT_ID / SECRET", ready: envReadiness.ebayClientId && envReadiness.ebayClientSecret },
    { key: "EBAY_REFRESH_TOKEN", ready: envReadiness.ebayRefreshToken },
    { key: "GEMINI_API_KEY", ready: envReadiness.geminiApiKey },
    { key: "ETSY_API_KEY / SHOP_ID", ready: envReadiness.etsyApiKey && envReadiness.etsyShopId },
    { key: "ETSY_ACCESS_TOKEN", ready: envReadiness.etsyAuthToken },
  ];

  const handleCopyEnvTemplate = async () => {
    const template = [
      "NEXT_PUBLIC_SUPABASE_URL=",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY=",
      "SUPABASE_SERVICE_ROLE_KEY=",
      "",
      "EBAY_CLIENT_ID=",
      "EBAY_CLIENT_SECRET=",
      "EBAY_REFRESH_TOKEN=",
      "EBAY_ENV=PRODUCTION",
      "",
      "GEMINI_API_KEY=",
      "GEMINI_VISION_MODEL=gemini-4-hydrogen",
      "GEMINI_MAPPER_MODEL=gemini-3.5-flash-lite",
      "",
      "ETSY_API_KEY=",
      "ETSY_SHOP_ID=",
      "ETSY_ACCESS_TOKEN=",
      "ETSY_REFRESH_TOKEN=",
      "ETSY_SHIPPING_PROFILE_ID=",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(template);
      setCopiedEnv(true);
      setTimeout(() => setCopiedEnv(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <div className="space-y-6">
      {/* Progress Overview + Environment Readiness */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-white border border-[#E4E4DD] rounded-xl p-5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#14151A]">
                Phased Build Progress (Phases 1–4)
              </h2>
              <p className="text-xs text-[#5C606B] mt-0.5">
                Phases 1 &amp; 2 code complete — next up: Phase 3 Chrome/Arc
                Manifest V3 Extension for Poshmark, Mercari, and Facebook
                Marketplace.
              </p>
            </div>
            <div className="text-right font-mono tabular-nums">
              <div className="text-2xl font-semibold text-[#14151A]">
                {overallPct}%
              </div>
              <div className="text-[11px] text-[#5C606B]">
                {completedTasks} / {totalTasks} milestones
              </div>
            </div>
          </div>

          <div className="mt-4 h-2 w-full bg-[#ECECE6] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#14151A] rounded-full transition-all duration-300"
              style={{ width: `${overallPct}%` }}
            />
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            {phases.map((p) => {
              const done = p.tasks.filter((t) => t.done).length;
              const pct = Math.round((done / p.tasks.length) * 100);
              return (
                <div
                  key={p.phase}
                  className="border border-[#ECECE6] bg-[#FAF9F6] rounded-lg px-3 py-2.5"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[#14151A]">
                      Phase {p.phase}
                    </span>
                    <span className="font-mono tabular-nums text-[11px] text-[#5C606B]">
                      {done}/{p.tasks.length}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1 bg-[#E4E4DD] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        pct === 100
                          ? "bg-[#0F766E]"
                          : pct > 0
                            ? "bg-[#1D4ED8]"
                            : "bg-[#C8C8BE]"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Live Credentials & Schema Diagnostics */}
        <div className="bg-white border border-[#E4E4DD] rounded-xl p-5 shadow-[0_1px_2px_rgba(20,21,26,0.03)] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-[#14151A]" />
                <h2 className="text-sm font-semibold text-[#14151A]">
                  Environment Readiness
                </h2>
              </div>
              <span
                className={`text-[11px] font-semibold px-2 py-0.5 rounded-md ${
                  mode === "live"
                    ? "bg-[#ECFDF5] text-[#0F766E]"
                    : "bg-[#EFF6FF] text-[#1D4ED8]"
                }`}
              >
                {mode === "live" ? "Live Mode" : "Demo Fallback"}
              </span>
            </div>

            <ul className="mt-3 space-y-1.5">
              {envItems.map((item) => (
                <li
                  key={item.key}
                  className="flex items-center justify-between text-xs py-1 border-b border-[#F1F1EC] last:border-0"
                >
                  <code className="font-mono text-[11px] text-[#353841]">
                    {item.key}
                  </code>
                  <span
                    className={`text-[11px] font-medium ${
                      item.ready ? "text-[#0F766E]" : "text-[#9A6700]"
                    }`}
                  >
                    {item.ready ? "Set" : "Missing"}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-4 pt-3 border-t border-[#ECECE6] flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[#5C606B] font-mono">
              <Database className="w-3.5 h-3.5 text-[#8A8E99]" />
              supabase/schema.sql
            </span>
            <button
              type="button"
              onClick={handleCopyEnvTemplate}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[#E4E4DD] bg-[#FAF9F6] hover:bg-[#F1F1EC] text-[11px] font-medium text-[#14151A] transition cursor-pointer"
            >
              {copiedEnv ? (
                <>
                  <Check className="w-3 h-3 text-[#0F766E]" />
                  Copied .env
                </>
              ) : (
                <>
                  <ClipboardCopy className="w-3 h-3" />
                  Copy .env Template
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Phase Checklists + Adjustments Log */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-7 space-y-4">
          {phases.map((phase) => {
            const doneCount = phase.tasks.filter((t) => t.done).length;
            const allDone = doneCount === phase.tasks.length;
            return (
              <div
                key={phase.phase}
                className="bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.03)]"
              >
                <div className="px-5 py-3.5 border-b border-[#ECECE6] bg-[#FAF9F6] flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-[#14151A]">
                        {phase.title}
                      </h3>
                      {allDone ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-[#ECFDF5] text-[#0F766E]">
                          Complete
                        </span>
                      ) : phase.status === "active" ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-[#14151A] text-white">
                          Built
                        </span>
                      ) : phase.status === "next" ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-[#EFF6FF] text-[#1D4ED8]">
                          Next Up
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-[#5C606B] mt-0.5">
                      {phase.summary}
                    </p>
                  </div>
                  <span className="font-mono tabular-nums text-xs text-[#5C606B]">
                    {doneCount}/{phase.tasks.length} done
                  </span>
                </div>

                <ul className="divide-y divide-[#F1F1EC]">
                  {phase.tasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        onClick={() => toggleTask(phase.phase, task.id)}
                        className="w-full px-5 py-3 flex items-start gap-3 text-left hover:bg-[#FAF9F6] transition cursor-pointer"
                      >
                        {task.done ? (
                          <CheckCircle2 className="w-4 h-4 text-[#0F766E] shrink-0 mt-0.5" />
                        ) : (
                          <Circle className="w-4 h-4 text-[#C2C3BC] shrink-0 mt-0.5" />
                        )}
                        <span
                          className={`text-sm flex-1 leading-snug ${
                            task.done
                              ? "text-[#6D717D] line-through decoration-[#C2C3BC]"
                              : "text-[#14151A]"
                          }`}
                        >
                          {task.label}
                        </span>
                        {task.tag && (
                          <span className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#F1F1EC] text-[#5C606B]">
                            {task.tag}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        {/* Adjustments Log */}
        <div className="xl:col-span-5 bg-white border border-[#E4E4DD] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="px-5 py-3.5 border-b border-[#ECECE6] bg-[#FAF9F6] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileCode2 className="w-4 h-4 text-[#14151A]" />
              <h3 className="text-sm font-semibold text-[#14151A]">
                Adjustments &amp; Decisions Log
              </h3>
            </div>
            <span className="font-mono text-[11px] text-[#5C606B]">
              {adjustments.length} entries
            </span>
          </div>

          <form
            onSubmit={handleAddAdjustment}
            className="p-4 border-b border-[#ECECE6] bg-[#FCFCFA] space-y-2.5"
          >
            <div className="flex items-center gap-2">
              <select
                aria-label="Target Phase"
                value={newPhase}
                onChange={(e) => setNewPhase(Number(e.target.value))}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-[#E4E4DD] bg-white text-[#14151A] focus:outline-none focus:border-[#14151A]"
              >
                <option value={1}>Phase 1</option>
                <option value={2}>Phase 2</option>
                <option value={3}>Phase 3</option>
                <option value={4}>Phase 4</option>
              </select>

              <select
                aria-label="Adjustment Category"
                value={newCategory}
                onChange={(e) =>
                  setNewCategory(
                    e.target.value as AdjustmentLogEntry["category"]
                  )
                }
                className="text-xs px-2.5 py-1.5 rounded-lg border border-[#E4E4DD] bg-white text-[#14151A] focus:outline-none focus:border-[#14151A]"
              >
                <option value="architecture">Architecture</option>
                <option value="pricing">Pricing</option>
                <option value="api">API</option>
                <option value="workflow">Workflow</option>
              </select>
            </div>

            <input
              id="input-adjustment-title"
              type="text"
              placeholder="Adjustment title..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg border border-[#E4E4DD] bg-white text-[#14151A] placeholder:text-[#8A8E99] focus:outline-none focus:border-[#14151A]"
            />

            <textarea
              id="input-adjustment-note"
              rows={2}
              placeholder="Rationale, constraint, or schema change details..."
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              className="w-full text-xs px-3 py-2 rounded-lg border border-[#E4E4DD] bg-white text-[#14151A] placeholder:text-[#8A8E99] focus:outline-none focus:border-[#14151A] resize-none"
            />

            <button
              id="btn-add-adjustment"
              type="submit"
              disabled={!newTitle.trim() || !newNote.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#14151A] text-white hover:bg-[#272A34] disabled:opacity-40 transition cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Log Adjustment
            </button>
          </form>

          <div className="divide-y divide-[#F1F1EC] max-h-[540px] overflow-y-auto">
            {adjustments.map((entry) => (
              <div key={entry.id} className="p-4 group">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${CATEGORY_STYLES[entry.category]}`}
                    >
                      {entry.category}
                    </span>
                    <span className="font-mono text-[11px] text-[#5C606B]">
                      P{entry.phase} · {entry.date}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label="Remove log entry"
                    onClick={() => handleRemoveAdjustment(entry.id)}
                    className="opacity-0 group-hover:opacity-100 text-[#8A8E99] hover:text-[#B91C1C] transition cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <h4 className="text-xs font-semibold text-[#14151A] mt-1.5">
                  {entry.title}
                </h4>
                <p className="text-xs text-[#5C606B] mt-1 leading-relaxed">
                  {entry.note}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
