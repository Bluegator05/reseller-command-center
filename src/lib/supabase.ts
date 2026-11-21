import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EnvReadiness } from "./types";

let browserClient: SupabaseClient | null = null;
let adminClient: SupabaseClient | null = null;

export function getEnvReadiness(): EnvReadiness {
  const supabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim());
  const supabaseAnonKey = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  );
  const supabaseServiceKey = Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  );
  const ebayClientId = Boolean(process.env.EBAY_CLIENT_ID?.trim());
  const ebayClientSecret = Boolean(process.env.EBAY_CLIENT_SECRET?.trim());
  const ebayRefreshToken = Boolean(process.env.EBAY_REFRESH_TOKEN?.trim());
  const ebayEnv = (process.env.EBAY_ENV || "PRODUCTION").toUpperCase();

  const geminiApiKey = Boolean(process.env.GEMINI_API_KEY?.trim());
  const etsyApiKey = Boolean(process.env.ETSY_API_KEY?.trim());
  const etsyShopId = Boolean(process.env.ETSY_SHOP_ID?.trim());
  const etsyAuthToken = Boolean(
    process.env.ETSY_ACCESS_TOKEN?.trim() ||
      process.env.ETSY_REFRESH_TOKEN?.trim()
  );

  return {
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceKey,
    ebayClientId,
    ebayClientSecret,
    ebayRefreshToken,
    ebayEnv,
    geminiApiKey,
    etsyApiKey,
    etsyShopId,
    etsyAuthToken,
    isSupabaseReady: supabaseUrl && (supabaseServiceKey || supabaseAnonKey),
    isEbayReady: ebayClientId && ebayClientSecret && ebayRefreshToken,
    isGeminiReady: geminiApiKey,
    isEtsyReady: etsyApiKey && etsyShopId && etsyAuthToken,
  };
}

export function isSupabaseConfigured(): boolean {
  return getEnvReadiness().isSupabaseReady;
}

export function isSupabaseAdminConfigured(): boolean {
  const env = getEnvReadiness();
  return env.supabaseUrl && env.supabaseServiceKey;
}

/**
 * Browser / client-side Supabase client (uses anon key).
 * Returns null if NEXT_PUBLIC_SUPABASE_URL / ANON_KEY are not yet configured.
 */
export function getSupabaseBrowserClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) {
    return null;
  }

  if (!browserClient) {
    browserClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }

  return browserClient;
}

/**
 * Server-side Supabase client for API routes and Server Components.
 * Prefers SUPABASE_SERVICE_ROLE_KEY to bypass RLS for background sync & job queues,
 * falling back to anon key if only the public key is provided.
 */
export function getSupabaseServerClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !key) {
    return null;
  }

  if (!adminClient) {
    adminClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return adminClient;
}
