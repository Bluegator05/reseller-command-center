"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  Calendar,
  Car,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  Loader2,
  Package,
  Plus,
  Receipt,
  ShieldAlert,
  Trash2,
  TrendingUp,
} from "lucide-react";
import type {
  BusinessExpense,
  ExpenseCategoryType,
  InventoryItem,
  SalesOrderRecord,
  StaleRadarRow,
} from "@/lib/types";

interface AnalyticsTaxPanelProps {
  activeItems: StaleRadarRow[];
  draftItems: InventoryItem[];
  salesOrders: SalesOrderRecord[];
  expenses: BusinessExpense[];
  onOpenItemDetail?: (row: StaleRadarRow) => void;
  onAddExpense: (input: {
    expense_date: string;
    category: ExpenseCategoryType;
    description: string;
    vendor: string | null;
    miles: number | null;
    mileage_rate: number | null;
    amount: number;
    payment_method: string | null;
    receipt_ref: string | null;
    notes: string | null;
  }) => Promise<void>;
  onDeleteExpense: (expenseId: string) => Promise<void>;
}

const EXPENSE_CATEGORIES: Array<{ value: ExpenseCategoryType; label: string }> =
  [
    { value: "mileage", label: "Sourcing Mileage ($0.70/mi IRS)" },
    { value: "shipping_materials", label: "Shipping Materials (Mailers / Labels)" },
    { value: "supplies", label: "Packing & Prep Supplies" },
    { value: "storage", label: "Storage Unit / Warehouse" },
    { value: "software", label: "Software & Store Subscriptions" },
    { value: "equipment", label: "Equipment (Lighting / Scale / Printer)" },
    { value: "other", label: "Other Schedule C Expense" },
  ];

const IRS_MILEAGE_RATE = 0.7;

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number>>) {
  const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [header.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function AnalyticsTaxPanel({
  activeItems,
  draftItems,
  salesOrders,
  expenses,
  onOpenItemDetail,
  onAddExpense,
  onDeleteExpense,
}: AnalyticsTaxPanelProps) {
  const [mountNow] = useState(() => Date.now());
  const [taxReservePct, setTaxReservePct] = useState<number>(25);
  const [expDate, setExpDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [expCategory, setExpCategory] =
    useState<ExpenseCategoryType>("mileage");
  const [expDesc, setExpDesc] = useState("");
  const [expVendor, setExpVendor] = useState("");
  const [expMiles, setExpMiles] = useState("");
  const [expAmount, setExpAmount] = useState("");
  const [expReceipt, setExpReceipt] = useState("");
  const [isSavingExp, setIsSavingExp] = useState(false);

  // 1. Sourcing ROI Leaderboard
  const sourcingLeaderboard = useMemo(() => {
    const map = new Map<
      string,
      {
        location: string;
        unitsSold: number;
        totalRevenue: number;
        totalNet: number;
        totalCostBasis: number;
        daysToSellSum: number;
        daysToSellCount: number;
        unsoldUnits: number;
        unsoldCapital: number;
      }
    >();

    const getBucket = (loc: string) => {
      const key = loc.trim() || "Unspecified Source";
      let entry = map.get(key);
      if (!entry) {
        entry = {
          location: key,
          unitsSold: 0,
          totalRevenue: 0,
          totalNet: 0,
          totalCostBasis: 0,
          daysToSellSum: 0,
          daysToSellCount: 0,
          unsoldUnits: 0,
          unsoldCapital: 0,
        };
        map.set(key, entry);
      }
      return entry;
    };

    for (const order of salesOrders) {
      if (order.fulfillment_status === "unpaid") continue;
      const b = getBucket(order.source_location || "Unspecified Source");
      b.unitsSold += 1;
      b.totalRevenue += order.gross_sale_price;
      b.totalNet += order.true_net_after_cogs;
      b.totalCostBasis += order.cogs + (order.prep_cost ?? 0);
      if (order.acquired_at) {
        const acq = Date.parse(order.acquired_at);
        const sold = Date.parse(order.sold_at);
        if (!Number.isNaN(acq) && !Number.isNaN(sold) && sold >= acq) {
          b.daysToSellSum += Math.round((sold - acq) / 86400000);
          b.daysToSellCount += 1;
        }
      }
    }

    for (const item of activeItems) {
      const b = getBucket(item.source_location || "Unspecified Source");
      b.unsoldUnits += 1;
      b.unsoldCapital += item.total_cost_basis;
    }
    for (const draft of draftItems) {
      const b = getBucket(draft.source_location || "Unspecified Source");
      b.unsoldUnits += 1;
      b.unsoldCapital += draft.cogs + (draft.prep_cost ?? 0);
    }

    return [...map.values()]
      .map((b) => ({
        ...b,
        avgNet: b.unitsSold > 0 ? b.totalNet / b.unitsSold : 0,
        roiPct:
          b.totalCostBasis > 0 ? (b.totalNet / b.totalCostBasis) * 100 : 0,
        avgDaysToSell:
          b.daysToSellCount > 0
            ? Math.round(b.daysToSellSum / b.daysToSellCount)
            : null,
      }))
      .sort((a, b) => b.totalNet - a.totalNet || b.roiPct - a.roiPct);
  }, [salesOrders, activeItems, draftItems]);

  // 2. Schedule C Business Net Income Summary
  const scheduleCSummary = useMemo(() => {
    const grossSales = salesOrders
      .filter((o) => o.fulfillment_status !== "unpaid")
      .reduce((s, o) => s + o.gross_sale_price, 0);
    const totalRefunds = salesOrders.reduce(
      (s, o) => s + (o.refund_amount ?? 0),
      0
    );
    const salesNetAfterCogs = salesOrders.reduce(
      (s, o) => s + o.true_net_after_cogs,
      0
    );
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const totalMiles = expenses.reduce((s, e) => s + (e.miles ?? 0), 0);
    const netBusinessIncome = salesNetAfterCogs - totalExpenses;
    const estQuarterlyTax = Math.max(0, netBusinessIncome * 0.25);

    return {
      grossSales,
      totalRefunds,
      salesNetAfterCogs,
      totalExpenses,
      totalMiles,
      netBusinessIncome,
      estQuarterlyTax,
    };
  }, [salesOrders, expenses]);

  // 4. Year-End IRS Inventory Valuation Snapshot (Schedule C Part III)
  const valuation = useMemo(() => {
    const activeCogs = activeItems.reduce((s, i) => s + i.cogs, 0);
    const activePrep = activeItems.reduce((s, i) => s + i.prep_cost, 0);
    const activeRetail = activeItems.reduce((s, i) => s + i.listed_price, 0);

    const draftCogs = draftItems.reduce((s, i) => s + i.cogs, 0);
    const draftPrep = draftItems.reduce((s, i) => s + (i.prep_cost ?? 0), 0);
    const draftRetail = draftItems.reduce((s, i) => s + i.target_price, 0);

    const totalUnits = activeItems.length + draftItems.length;
    const totalBasis = activeCogs + activePrep + draftCogs + draftPrep;
    const totalRetail = activeRetail + draftRetail;

    return {
      activeUnits: activeItems.length,
      activeBasis: activeCogs + activePrep,
      draftUnits: draftItems.length,
      draftBasis: draftCogs + draftPrep,
      totalUnits,
      totalBasis,
      totalRetail,
    };
  }, [activeItems, draftItems]);

  const handleSubmitExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expDesc.trim()) return;
    setIsSavingExp(true);
    try {
      const isMileage = expCategory === "mileage";
      const milesVal = isMileage ? Math.max(0, Number(expMiles) || 0) : null;
      const amountVal = isMileage
        ? Math.round((milesVal || 0) * IRS_MILEAGE_RATE * 100) / 100
        : Math.max(0, Number(expAmount) || 0);

      await onAddExpense({
        expense_date: expDate,
        category: expCategory,
        description: expDesc.trim(),
        vendor:
          expVendor.trim() || (isMileage ? "IRS Standard Mileage" : null),
        miles: milesVal,
        mileage_rate: isMileage ? IRS_MILEAGE_RATE : null,
        amount: amountVal,
        payment_method: isMileage ? "Mileage Log" : "Business Amex",
        receipt_ref: expReceipt.trim() || null,
        notes: null,
      });

      setExpDesc("");
      setExpVendor("");
      setExpMiles("");
      setExpAmount("");
      setExpReceipt("");
    } finally {
      setIsSavingExp(false);
    }
  };

  const handleExportInventorySnapshotCsv = () => {
    const today = new Date(mountNow).toISOString().slice(0, 10);
    const header = [
      "Snapshot Date",
      "Status",
      "SKU",
      "Title",
      "Bin",
      "Date Purchased",
      "Where Purchased",
      "Tax Category",
      "Receipt Ref",
      "COGS",
      "Prep Cost",
      "Total Inventory Cost Basis",
      "Target/Listed Ask",
    ];
    const rows = [
      ...activeItems.map((i) => [
        today,
        "Active Listed",
        i.sku,
        i.title,
        i.bin_location || "",
        i.acquired_at ? i.acquired_at.slice(0, 10) : "",
        i.source_location || "",
        i.tax_category,
        i.receipt_ref || "",
        i.cogs.toFixed(2),
        i.prep_cost.toFixed(2),
        i.total_cost_basis.toFixed(2),
        i.listed_price.toFixed(2),
      ]),
      ...draftItems.map((d) => [
        today,
        "Death Pile (Unlisted)",
        d.sku,
        d.title,
        d.bin_location || "",
        d.acquired_at ? d.acquired_at.slice(0, 10) : "",
        d.source_location || "",
        d.tax_category || "inventory_cogs",
        d.receipt_ref || "",
        d.cogs.toFixed(2),
        (d.prep_cost ?? 0).toFixed(2),
        (d.cogs + (d.prep_cost ?? 0)).toFixed(2),
        d.target_price.toFixed(2),
      ]),
    ];
    downloadCsv(`irs-ending-inventory-valuation-${today}.csv`, header, rows);
  };

  const handleExportExpensesCsv = () => {
    const today = new Date(mountNow).toISOString().slice(0, 10);
    const header = [
      "Date",
      "Schedule C Category",
      "Description",
      "Vendor",
      "Miles",
      "IRS Rate",
      "Deductible Amount",
      "Payment Method",
      "Receipt Ref",
    ];
    const rows = expenses.map((e) => [
      e.expense_date,
      e.category,
      e.description,
      e.vendor || "",
      e.miles != null ? e.miles.toFixed(1) : "",
      e.mileage_rate != null ? e.mileage_rate.toFixed(2) : "",
      e.amount.toFixed(2),
      e.payment_method || "",
      e.receipt_ref || "",
    ]);
    downloadCsv(`schedule-c-expenses-mileage-${today}.csv`, header, rows);
  };

  // Quarterly Tax Readiness Review & 1099-K Monitor
  const quarterlyReview = useMemo(() => {
    const reserveAmount = Math.max(
      0,
      (scheduleCSummary.netBusinessIncome * taxReservePct) / 100
    );

    const missingReceiptActive = activeItems.filter(
      (i) => !i.receipt_ref || !i.receipt_ref.trim()
    );
    const missingReceiptDraft = draftItems.filter(
      (d) => !d.receipt_ref || !d.receipt_ref.trim()
    );
    const missingCogsActive = activeItems.filter((i) => !i.cogs || i.cogs <= 0);
    const missingSourceActive = activeItems.filter(
      (i) => !i.source_location || !i.acquired_at
    );
    const missingExpenseReceipts = expenses.filter(
      (e) => e.category !== "mileage" && (!e.receipt_ref || !e.receipt_ref.trim())
    );
    const mileageLoggedCount = expenses.filter(
      (e) => e.category === "mileage"
    ).length;
    const openReturnsOrUnpaid = salesOrders.filter(
      (o) =>
        o.fulfillment_status === "returned" || o.fulfillment_status === "unpaid"
    );

    // Per-marketplace gross sales for 1099-K threshold tracking
    const chTotals = new Map<string, { label: string; gross: number; orders: number }>();
    const labels: Record<string, string> = {
      ebay: "eBay",
      etsy: "Etsy",
      poshmark: "Poshmark",
      mercari: "Mercari",
      facebook: "FB Market",
    };
    for (const [k, label] of Object.entries(labels)) {
      chTotals.set(k, { label, gross: 0, orders: 0 });
    }
    for (const o of salesOrders) {
      if (o.fulfillment_status === "unpaid") continue;
      const bucket = chTotals.get(o.marketplace);
      if (bucket) {
        bucket.gross += o.gross_sale_price;
        bucket.orders += 1;
      }
    }

    const totalFlags =
      missingReceiptActive.length +
      missingReceiptDraft.length +
      missingCogsActive.length +
      missingSourceActive.length +
      missingExpenseReceipts.length +
      (mileageLoggedCount === 0 ? 1 : 0);

    return {
      reserveAmount,
      missingReceiptActive,
      missingReceiptDraft,
      missingCogsActive,
      missingSourceActive,
      missingExpenseReceipts,
      mileageLoggedCount,
      openReturnsOrUnpaid,
      channel1099k: [...chTotals.entries()].map(([key, v]) => ({ key, ...v })),
      totalFlags,
    };
  }, [
    scheduleCSummary.netBusinessIncome,
    taxReservePct,
    activeItems,
    draftItems,
    expenses,
    salesOrders,
  ]);

  const computedMileagePreview =
    expCategory === "mileage" && Number(expMiles) > 0
      ? Number(expMiles) * IRS_MILEAGE_RATE
      : null;

  return (
    <div className="space-y-5">
      {/* Top Schedule C Business Net Income Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white border border-[#E5E8E6] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5F666D]">
            <span>Sales Profit (After COGS)</span>
            <TrendingUp className="w-3.5 h-3.5 text-[#0F766E]" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-mono font-semibold text-[#171A1D]">
              +{fmtMoney(scheduleCSummary.salesNetAfterCogs)}
            </span>
            <span className="text-xs text-[#5F666D]">
              on {fmtMoney(scheduleCSummary.grossSales)}
            </span>
          </div>
        </div>

        <div className="bg-white border border-[#E5E8E6] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5F666D]">
            <span>Overhead, Supplies &amp; Mileage</span>
            <Receipt className="w-3.5 h-3.5 text-[#B45309]" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-mono font-semibold text-[#B45309]">
              -{fmtMoney(scheduleCSummary.totalExpenses)}
            </span>
            <span className="text-xs font-mono text-[#5F666D]">
              {scheduleCSummary.totalMiles.toFixed(1)} mi logged
            </span>
          </div>
        </div>

        <div className="bg-[#F4FAF8] border border-[#CDECE3] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs font-medium text-[#0F766E]">
            <span>True Schedule C Net Income</span>
            <FileSpreadsheet className="w-3.5 h-3.5 text-[#0F766E]" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-mono font-bold text-[#0F766E]">
              {scheduleCSummary.netBusinessIncome >= 0 ? "+" : ""}
              {fmtMoney(scheduleCSummary.netBusinessIncome)}
            </span>
            <span className="text-xs text-[#0F766E]/80">
              {fmtMoney(quarterlyReview.reserveAmount)} reserve ({taxReservePct}%)
            </span>
          </div>
        </div>

        <div className="bg-white border border-[#E5E8E6] rounded-xl px-4 py-3.5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
          <div className="flex items-center justify-between text-xs text-[#5F666D]">
            <span>IRS Ending Inventory (COGS)</span>
            <Package className="w-3.5 h-3.5 text-[#1D4ED8]" />
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-2xl font-mono font-semibold text-[#171A1D]">
              {fmtMoney(valuation.totalBasis)}
            </span>
            <span className="text-xs text-[#5F666D]">
              {valuation.totalUnits} unsold SKUs
            </span>
          </div>
        </div>
      </div>

      {/* Quarterly Estimated Tax Reserve, 1099-K Monitor & Missing Records Audit */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: Quarterly Reserve + IRS Deadlines + 1099-K */}
        <section className="lg:col-span-6 bg-white border border-[#E5E8E6] rounded-xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[#0F766E]" />
              <div>
                <h2 className="text-sm font-bold text-[#171A1D]">
                  Quarterly Estimated Tax Reserve &amp; 1099-K Monitor
                </h2>
                <p className="text-[11px] text-[#5F666D]">
                  Set aside estimated self-employment + federal/state taxes each quarter.
                </p>
              </div>
            </div>
            <div className="inline-flex rounded-lg border border-[#DCE1DE] p-0.5 text-[11px] font-semibold">
              {[15, 20, 25, 30].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setTaxReservePct(pct)}
                  className={`px-2 py-1 rounded-md cursor-pointer transition ${
                    taxReservePct === pct
                      ? "bg-[#0F766E] text-white"
                      : "text-[#5F666D] hover:text-[#171A1D]"
                  }`}
                >
                  {pct}%
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-[#F4FAF8] border border-[#CDECE3] p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold text-[#0F766E]">
                Recommended Tax Savings Transfer ({taxReservePct}% of Schedule C Net)
              </div>
              <div className="text-2xl font-mono font-bold text-[#0F766E] mt-0.5">
                {fmtMoney(quarterlyReview.reserveAmount)}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-1.5 text-center text-[10px] font-mono">
              {[
                ["Q1", "Apr 15"],
                ["Q2", "Jun 15"],
                ["Q3", "Sep 15"],
                ["Q4", "Jan 15"],
              ].map(([q, due]) => (
                <div
                  key={q}
                  className="px-2 py-1.5 rounded-lg bg-white border border-[#CDECE3]"
                >
                  <div className="font-bold text-[#0F766E]">{q}</div>
                  <div className="text-[#5F666D]">{due}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 1099-K Marketplace Threshold Tracker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-[#171A1D]">
                Per-Marketplace 1099-K Gross Volume
              </span>
              <span className="text-[#5F666D] font-mono">
                State $600 / Fed $2,500 watch
              </span>
            </div>
            <div className="space-y-1.5">
              {quarterlyReview.channel1099k.map((ch) => {
                const pct = Math.min(100, (ch.gross / 2500) * 100);
                const over600 = ch.gross >= 600;
                return (
                  <div key={ch.key} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-medium text-[#171A1D]">
                        {ch.label}{" "}
                        <span className="text-[#7C858D] font-mono">
                          ({ch.orders} orders)
                        </span>
                      </span>
                      <span className="font-mono font-semibold text-[#171A1D]">
                        {fmtMoney(ch.gross)}
                        {over600 && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] bg-[#FEF3C7] text-[#B45309]">
                            &gt;$600
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#EDF1EE] overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          over600 ? "bg-[#D97706]" : "bg-[#0F766E]"
                        }`}
                        style={{ width: `${Math.max(ch.gross > 0 ? 4 : 0, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Right: Quarterly Tax Readiness Review Checklist (Flags Missing Receipts / COGS / Dates) */}
        <section className="lg:col-span-6 bg-white border border-[#E5E8E6] rounded-xl p-4 sm:p-5 space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="w-4 h-4 text-[#0F766E]" />
              <div>
                <h2 className="text-sm font-bold text-[#171A1D]">
                  Quarterly Tax Readiness Review
                </h2>
                <p className="text-[11px] text-[#5F666D]">
                  Automatically flags missing receipts, $0 COGS, sourcing dates, or unlogged mileage before you file.
                </p>
              </div>
            </div>
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${
                quarterlyReview.totalFlags === 0
                  ? "bg-[#ECFDF5] text-[#0F766E]"
                  : "bg-[#FEF3C7] text-[#B45309]"
              }`}
            >
              {quarterlyReview.totalFlags === 0
                ? "Audit Ready ✓"
                : `${quarterlyReview.totalFlags} item${quarterlyReview.totalFlags === 1 ? "" : "s"} to review`}
            </span>
          </div>

          <div className="space-y-2 text-xs">
            {/* Check 1: Missing Inventory Receipts */}
            <div
              className={`p-3 rounded-xl border ${
                quarterlyReview.missingReceiptActive.length +
                  quarterlyReview.missingReceiptDraft.length ===
                0
                  ? "bg-[#F4FAF8] border-[#CDECE3]"
                  : "bg-[#FFFBEB] border-[#FDE68A]"
              }`}
            >
              <div className="flex items-center justify-between gap-2 font-semibold">
                <span className="flex items-center gap-1.5">
                  {quarterlyReview.missingReceiptActive.length +
                    quarterlyReview.missingReceiptDraft.length ===
                  0 ? (
                    <CheckCircle2 className="w-4 h-4 text-[#0F766E]" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-[#B45309]" />
                  )}
                  <span>Inventory Receipt / Invoice References</span>
                </span>
                <span className="font-mono text-[11px]">
                  {quarterlyReview.missingReceiptActive.length +
                    quarterlyReview.missingReceiptDraft.length ===
                  0
                    ? "All documented"
                    : `${quarterlyReview.missingReceiptActive.length + quarterlyReview.missingReceiptDraft.length} missing`}
                </span>
              </div>
              {quarterlyReview.missingReceiptActive.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {quarterlyReview.missingReceiptActive.slice(0, 5).map((r) => (
                    <button
                      key={r.item_id}
                      type="button"
                      onClick={() => onOpenItemDetail?.(r)}
                      className="px-2 py-1 rounded-md bg-white border border-[#F59E0B]/60 text-[11px] font-mono text-[#92400E] hover:bg-[#FEF3C7] cursor-pointer"
                    >
                      + Add Receipt: {r.sku} →
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Check 2: Missing COGS or Purchase Dates */}
            <div
              className={`p-3 rounded-xl border ${
                quarterlyReview.missingCogsActive.length +
                  quarterlyReview.missingSourceActive.length ===
                0
                  ? "bg-[#F4FAF8] border-[#CDECE3]"
                  : "bg-[#FEF2F2] border-[#FECACA]"
              }`}
            >
              <div className="flex items-center justify-between gap-2 font-semibold">
                <span className="flex items-center gap-1.5">
                  {quarterlyReview.missingCogsActive.length +
                    quarterlyReview.missingSourceActive.length ===
                  0 ? (
                    <CheckCircle2 className="w-4 h-4 text-[#0F766E]" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-[#DC2626]" />
                  )}
                  <span>COGS Basis &amp; Purchase Dates</span>
                </span>
                <span className="font-mono text-[11px]">
                  {quarterlyReview.missingCogsActive.length +
                    quarterlyReview.missingSourceActive.length ===
                  0
                    ? "Complete"
                    : `${quarterlyReview.missingCogsActive.length} $0 COGS · ${quarterlyReview.missingSourceActive.length} missing date/source`}
                </span>
              </div>
              {quarterlyReview.missingCogsActive.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {quarterlyReview.missingCogsActive.slice(0, 4).map((r) => (
                    <button
                      key={r.item_id}
                      type="button"
                      onClick={() => onOpenItemDetail?.(r)}
                      className="px-2 py-1 rounded-md bg-white border border-[#FECACA] text-[11px] font-mono text-[#B91C1C] cursor-pointer"
                    >
                      Fix COGS: {r.sku} →
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Check 3: Expense Receipts & Mileage */}
            <div
              className={`p-3 rounded-xl border ${
                quarterlyReview.missingExpenseReceipts.length === 0 &&
                quarterlyReview.mileageLoggedCount > 0
                  ? "bg-[#F4FAF8] border-[#CDECE3]"
                  : "bg-[#FFFBEB] border-[#FDE68A]"
              }`}
            >
              <div className="flex items-center justify-between gap-2 font-semibold">
                <span className="flex items-center gap-1.5">
                  {quarterlyReview.missingExpenseReceipts.length === 0 &&
                  quarterlyReview.mileageLoggedCount > 0 ? (
                    <CheckCircle2 className="w-4 h-4 text-[#0F766E]" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-[#B45309]" />
                  )}
                  <span>Expense Receipts &amp; Sourcing Mileage</span>
                </span>
                <span className="font-mono text-[11px]">
                  {quarterlyReview.mileageLoggedCount} mileage trips ·{" "}
                  {quarterlyReview.missingExpenseReceipts.length} missing receipt
                </span>
              </div>
              <p className="text-[11px] text-[#5F666D] mt-1">
                {quarterlyReview.missingExpenseReceipts.length > 0
                  ? `Add receipt references for ${quarterlyReview.missingExpenseReceipts.length} logged overhead expense(s) below.`
                  : "All overhead expenses have receipt references and sourcing mileage is logged."}
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Feature #1: Sourcing ROI Leaderboard */}
      <section className="bg-white border border-[#E5E8E6] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#ECEFE9] bg-[#FAFBF9] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Award className="w-4 h-4 text-[#0F766E]" />
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#171A1D]">
              Sourcing ROI Leaderboard — Where Your Best Flips Come From
            </h2>
          </div>
          <span className="text-[11px] font-mono text-[#5F666D]">
            Ranked by Realized Net Profit &amp; ROI %
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#ECEFE9] bg-[#FAFBF9] text-[11px] font-semibold uppercase tracking-wide text-[#5F666D]">
                <th className="py-2.5 pl-4 pr-3">Sourcing Location</th>
                <th className="py-2.5 px-3">Sold</th>
                <th className="py-2.5 px-3">Realized Net</th>
                <th className="py-2.5 px-3">Avg Net / Item</th>
                <th className="py-2.5 px-3">Sourcing ROI</th>
                <th className="py-2.5 px-3">Avg Days to Sell</th>
                <th className="py-2.5 pl-3 pr-4 text-right">Unsold Capital</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F4F2] text-xs">
              {sourcingLeaderboard.map((row, idx) => (
                <tr key={row.location} className="hover:bg-[#FAFBF9]">
                  <td className="py-2.5 pl-4 pr-3 font-semibold text-[#171A1D]">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={`w-5 h-5 rounded-full text-[10px] font-mono flex items-center justify-center ${
                          idx === 0
                            ? "bg-[#FEF3C7] text-[#B45309] font-bold"
                            : "bg-[#F2F4F3] text-[#5F666D]"
                        }`}
                      >
                        {idx + 1}
                      </span>
                      {row.location}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[#171A1D]">
                    {row.unitsSold}
                  </td>
                  <td className="py-2.5 px-3 font-mono font-bold text-[#0F766E]">
                    {row.unitsSold > 0 ? `+${fmtMoney(row.totalNet)}` : "—"}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[#444B52]">
                    {row.unitsSold > 0 ? fmtMoney(row.avgNet) : "—"}
                  </td>
                  <td className="py-2.5 px-3">
                    {row.unitsSold > 0 ? (
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 rounded-full bg-[#EDF1EE] overflow-hidden">
                          <div
                            className="h-full bg-[#0F766E] rounded-full"
                            style={{
                              width: `${Math.min(100, Math.max(8, row.roiPct / 4))}%`,
                            }}
                          />
                        </div>
                        <span className="font-mono font-semibold text-[#0F766E]">
                          {row.roiPct.toFixed(0)}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-[#8E969D]">Pending sale</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[#444B52]">
                    {row.avgDaysToSell != null ? `${row.avgDaysToSell}d` : "—"}
                  </td>
                  <td className="py-2.5 pl-3 pr-4 text-right font-mono text-[#5F666D]">
                    {row.unsoldUnits > 0
                      ? `${fmtMoney(row.unsoldCapital)} (${row.unsoldUnits})`
                      : "$0.00"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Feature #4: Year-End IRS Inventory Valuation Snapshot (Schedule C Part III) */}
      <section className="bg-white border border-[#E5E8E6] rounded-xl p-5 shadow-[0_1px_2px_rgba(20,21,26,0.03)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-[#0F766E]" />
              <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#171A1D]">
                IRS Year-End Inventory Valuation Snapshot (Schedule C — Part III)
              </h2>
            </div>
            <p className="mt-1 text-xs text-[#5F666D]">
              Exact cost basis of all unsold inventory on hand (Active Listed +
              Death Pile Backlog) required for Dec 31 Beginning/Ending Inventory
              reporting.
            </p>
          </div>
          <button
            type="button"
            onClick={handleExportInventorySnapshotCsv}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export IRS Inventory Valuation CSV
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl border border-[#ECEFE9] bg-[#FAFBF9] p-3.5">
            <div className="text-[11px] text-[#5F666D]">
              Active Listed Inventory ({valuation.activeUnits} SKUs)
            </div>
            <div className="mt-1 text-lg font-mono font-bold text-[#171A1D]">
              {fmtMoney(valuation.activeBasis)}
            </div>
            <div className="text-[11px] text-[#7C858D]">
              Cost basis (COGS + Prep)
            </div>
          </div>
          <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB] p-3.5">
            <div className="text-[11px] text-[#92400E]">
              Death Pile / Unlisted Backlog ({valuation.draftUnits} SKUs)
            </div>
            <div className="mt-1 text-lg font-mono font-bold text-[#92400E]">
              {fmtMoney(valuation.draftBasis)}
            </div>
            <div className="text-[11px] text-[#92400E]/80">
              Still counts as Ending Inventory on hand
            </div>
          </div>
          <div className="rounded-xl border border-[#CDECE3] bg-[#F4FAF8] p-3.5">
            <div className="text-[11px] text-[#0F766E] font-semibold">
              Total Unsold Cost Basis ({valuation.totalUnits} SKUs)
            </div>
            <div className="mt-1 text-lg font-mono font-bold text-[#0F766E]">
              {fmtMoney(valuation.totalBasis)}
            </div>
            <div className="text-[11px] text-[#0F766E]/80">
              {fmtMoney(valuation.totalRetail)} combined ask value
            </div>
          </div>
        </div>
      </section>

      {/* Feature #2: Overhead, Supplies & Sourcing Mileage Log */}
      <section className="bg-white border border-[#E5E8E6] rounded-xl shadow-[0_1px_2px_rgba(20,21,26,0.03)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#ECEFE9] bg-[#FAFBF9] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Car className="w-4 h-4 text-[#0F766E]" />
            <h2 className="text-xs font-semibold uppercase tracking-[0.06em] text-[#171A1D]">
              Schedule C Overhead, Supplies &amp; Sourcing Mileage Log
            </h2>
          </div>
          <button
            type="button"
            onClick={handleExportExpensesCsv}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#0F766E]/30 bg-[#F4FAF8] text-[#0F766E] hover:bg-[#E3F5EE] cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export Expenses CSV ({expenses.length})
          </button>
        </div>

        {/* Quick-Add Expense / Mileage Form */}
        <form
          onSubmit={handleSubmitExpense}
          className="p-4 border-b border-[#ECEFE9] bg-[#FCFDFC] grid grid-cols-1 md:grid-cols-12 gap-2.5 items-end"
        >
          <div className="md:col-span-2">
            <label className="block text-[10px] font-semibold uppercase text-[#5F666D] mb-1">
              Date
            </label>
            <input
              type="date"
              value={expDate}
              onChange={(e) => setExpDate(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white"
            />
          </div>
          <div className="md:col-span-3">
            <label className="block text-[10px] font-semibold uppercase text-[#5F666D] mb-1">
              Category
            </label>
            <select
              value={expCategory}
              onChange={(e) =>
                setExpCategory(e.target.value as ExpenseCategoryType)
              }
              className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DCE1DE] bg-white"
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="block text-[10px] font-semibold uppercase text-[#5F666D] mb-1">
              Description *
            </label>
            <input
              type="text"
              required
              value={expDesc}
              onChange={(e) => setExpDesc(e.target.value)}
              placeholder={
                expCategory === "mileage"
                  ? "e.g. Goodwill Bins + Estate Sales loop"
                  : "e.g. 200x Poly Mailers, Bubble Wrap"
              }
              className="w-full px-2.5 py-1.5 text-xs rounded-lg border border-[#DCE1DE] bg-white"
            />
          </div>
          {expCategory === "mileage" ? (
            <div className="md:col-span-2">
              <label className="block text-[10px] font-semibold uppercase text-[#5F666D] mb-1">
                Miles (@ $0.70/mi)
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                required
                value={expMiles}
                onChange={(e) => setExpMiles(e.target.value)}
                placeholder="34.5"
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white"
              />
            </div>
          ) : (
            <div className="md:col-span-2">
              <label className="block text-[10px] font-semibold uppercase text-[#5F666D] mb-1">
                Amount ($)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={expAmount}
                onChange={(e) => setExpAmount(e.target.value)}
                placeholder="29.95"
                className="w-full px-2.5 py-1.5 text-xs font-mono rounded-lg border border-[#DCE1DE] bg-white"
              />
            </div>
          )}
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={isSavingExp}
              className="w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0F766E] text-white hover:bg-[#0B5B55] disabled:opacity-50 cursor-pointer"
            >
              {isSavingExp ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              {computedMileagePreview != null
                ? `Log ${fmtMoney(computedMileagePreview)}`
                : "Log Expense"}
            </button>
          </div>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#ECEFE9] bg-[#FAFBF9] text-[11px] font-semibold uppercase text-[#5F666D]">
                <th className="py-2 pl-4 pr-3">Date</th>
                <th className="py-2 px-3">Category</th>
                <th className="py-2 px-3">Description &amp; Vendor</th>
                <th className="py-2 px-3">Receipt / Miles</th>
                <th className="py-2 px-3 text-right">Deductible</th>
                <th className="py-2 pl-2 pr-4 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F4F2] text-xs">
              {expenses.map((exp) => (
                <tr key={exp.id} className="hover:bg-[#FAFBF9]">
                  <td className="py-2.5 pl-4 pr-3 font-mono text-[#5F666D] whitespace-nowrap">
                    {exp.expense_date}
                  </td>
                  <td className="py-2.5 px-3 whitespace-nowrap">
                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-[#F2F4F3] text-[#444B52]">
                      {exp.category.replace("_", " ")}
                    </span>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="font-medium text-[#171A1D]">
                      {exp.description}
                    </div>
                    {exp.vendor && (
                      <div className="text-[11px] text-[#7C858D]">
                        {exp.vendor}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-mono text-[#5F666D] whitespace-nowrap">
                    {exp.miles != null
                      ? `${exp.miles} mi × $${(exp.mileage_rate ?? 0.7).toFixed(2)}`
                      : exp.receipt_ref || "—"}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono font-bold text-[#B45309] whitespace-nowrap">
                    -{fmtMoney(exp.amount)}
                  </td>
                  <td className="py-2.5 pl-2 pr-4 text-right">
                    <button
                      type="button"
                      onClick={() => onDeleteExpense(exp.id)}
                      title="Delete expense"
                      className="p-1 rounded text-[#8A929A] hover:text-[#B91C1C] hover:bg-[#FEF2F2] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
