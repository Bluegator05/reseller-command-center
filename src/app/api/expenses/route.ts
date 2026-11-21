import { NextResponse } from "next/server";
import {
  addDemoExpense,
  deleteDemoExpense,
  getDemoStore,
} from "@/lib/demo-store";
import { roundCurrency } from "@/lib/stale-engine";
import { getEnvReadiness, getSupabaseServerClient } from "@/lib/supabase";
import type { ExpenseCategoryType } from "@/lib/types";

export async function GET() {
  try {
    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();
    if (supabase && envReadiness.isSupabaseReady) {
      const { data, error } = await supabase
        .from("business_expenses")
        .select("*")
        .order("expense_date", { ascending: false })
        .limit(500);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ mode: "live", expenses: data ?? [] });
    }
    return NextResponse.json({
      mode: "demo",
      expenses: getDemoStore().expenses,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load expenses",
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      expense_date?: string;
      category?: ExpenseCategoryType;
      description?: string;
      vendor?: string | null;
      miles?: number | null;
      mileage_rate?: number | null;
      amount?: number;
      payment_method?: string | null;
      receipt_ref?: string | null;
      notes?: string | null;
    };

    if (!body.description?.trim()) {
      return NextResponse.json(
        { error: "Expense description is required" },
        { status: 400 }
      );
    }

    const category: ExpenseCategoryType = body.category || "supplies";
    const mileageRate = category === "mileage" ? Number(body.mileage_rate || 0.7) : null;
    const miles =
      category === "mileage" && body.miles != null ? Number(body.miles) : null;
    const computedAmount =
      category === "mileage" && miles != null && mileageRate != null
        ? roundCurrency(miles * mileageRate)
        : roundCurrency(Math.max(0, Number(body.amount) || 0));

    const record = {
      expense_date: body.expense_date || new Date().toISOString().slice(0, 10),
      category,
      description: body.description.trim(),
      vendor:
        body.vendor?.trim() ||
        (category === "mileage" ? "IRS Standard Mileage" : null),
      miles,
      mileage_rate: mileageRate,
      amount: computedAmount,
      payment_method:
        body.payment_method ||
        (category === "mileage" ? "Mileage Log" : "Business Amex"),
      receipt_ref: body.receipt_ref?.trim() || null,
      notes: body.notes?.trim() || null,
    };

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();
    if (supabase && envReadiness.isSupabaseReady) {
      const { data, error } = await supabase
        .from("business_expenses")
        .insert(record)
        .select("*")
        .single();
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ mode: "live", expense: data }, { status: 201 });
    }

    const expense = addDemoExpense(record);
    return NextResponse.json({ mode: "demo", expense }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to save expense",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { error: "Missing expense id" },
        { status: 400 }
      );
    }

    const envReadiness = getEnvReadiness();
    const supabase = getSupabaseServerClient();
    if (supabase && envReadiness.isSupabaseReady) {
      const { error } = await supabase
        .from("business_expenses")
        .delete()
        .eq("id", id);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      return NextResponse.json({ mode: "live", deleted: true });
    }

    const deleted = deleteDemoExpense(id);
    return NextResponse.json({ mode: "demo", deleted });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete expense",
      },
      { status: 500 }
    );
  }
}
