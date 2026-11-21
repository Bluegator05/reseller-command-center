/**
 * Centralized Gemini API helper (Nov 2026 model lineup & REST schema).
 *
 * Model strategy tailored to Reseller Command Center workloads:
 * 1. Sourcing Vision (`vision`):
 *    - Primary: `gemini-4-hydrogen` (thinkingLevel: "LOW")
 *      Best-in-class multimodal detail reading (model plates, brand tags,
 *      hallmarks) with 5x fewer fabricated claims than Gemini 3.8 Flash.
 *    - Fallbacks: `gemini-3.8-flash` -> `gemini-3.5-flash-lite`
 * 2. Cross-List Field Mapping (`mapper`):
 *    - Primary: `gemini-3.5-flash-lite` (thinkingLevel: "MINIMAL")
 *      Sub-second structured JSON translation & Etsy 13-tag generation at
 *      ~$0.30/$2.50 per 1M tokens (5x cheaper than Hydrogen for bulk listing).
 *    - Fallbacks: `gemini-4-hydrogen` -> `gemini-3.8-flash`
 *
 * Follows Gemini 4 / Gemini 3.5+ REST rules:
 * - No deprecated sampling params (`temperature`, `top_p`, `top_k` omitted)
 * - Uses `thinkingConfig.thinkingLevel` (never `thinkingBudget` on 3.x/4.x)
 * - Uses `"LOW"` on Gemini 4 & 3.8 Flash (`"MINIMAL"` is rejected with HTTP 400)
 * - Uses `"MINIMAL"` on Gemini 3.5 Flash-Lite & 3.6 Flash
 */

export type GeminiTaskKind = "vision" | "mapper";

export const DEFAULT_VISION_MODELS = [
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
] as const;

export const DEFAULT_MAPPER_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-4-hydrogen",
  "gemini-3.8-flash",
] as const;

export function getGeminiApiKey(): string {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    ""
  ).trim();
}

export function getCandidateModels(task: GeminiTaskKind): string[] {
  const defaults =
    task === "vision" ? DEFAULT_VISION_MODELS : DEFAULT_MAPPER_MODELS;
  const specificOverride =
    task === "vision"
      ? process.env.GEMINI_VISION_MODEL?.trim()
      : process.env.GEMINI_MAPPER_MODEL?.trim();
  const sharedOverride = process.env.GEMINI_MODEL?.trim();

  const ordered: string[] = [];
  for (const candidate of [specificOverride, sharedOverride, ...defaults]) {
    if (candidate && !ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  }
  return ordered;
}

function buildGenerationConfig(
  model: string,
  task: GeminiTaskKind
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    responseMimeType: "application/json",
  };

  const lower = model.toLowerCase();
  if (lower.startsWith("gemini-2.5")) {
    // Legacy 2.5 series uses thinkingBudget instead of thinkingLevel
    config.thinkingConfig = { thinkingBudget: 0 };
  } else if (lower.includes("flash-lite") || lower.includes("3.6-flash")) {
    // Gemini 3.5 Flash-Lite & 3.6 Flash support MINIMAL for sub-second JSON
    config.thinkingConfig = {
      thinkingLevel: task === "mapper" ? "MINIMAL" : "LOW",
    };
  } else {
    // Gemini 4 Hydrogen/Neon/Argon/Carbon & Gemini 3.8 Flash require LOW/MEDIUM/HIGH
    // (MINIMAL returns HTTP 400 on these models)
    config.thinkingConfig = { thinkingLevel: "LOW" };
  }

  return config;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>;
    };
    finishReason?: string;
  }>;
}

export interface GeminiJsonResult<T> {
  data: T;
  modelUsed: string;
}

/**
 * Calls the Gemini REST `generateContent` endpoint with structured JSON output,
 * automatically falling back through the candidate model list if a model ID is
 * unavailable, deprecated, or temporarily throttled.
 */
export async function generateGeminiJson<T>(params: {
  task: GeminiTaskKind;
  parts: GeminiPart[];
  apiKey?: string;
}): Promise<GeminiJsonResult<T>> {
  const apiKey = (params.apiKey ?? getGeminiApiKey()).trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const candidates = getCandidateModels(params.task);
  const errors: string[] = [];

  for (const model of candidates) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: params.parts }],
            generationConfig: buildGenerationConfig(model, params.task),
          }),
          cache: "no-store",
        }
      );

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let detail = `HTTP ${res.status} (${model})`;
        try {
          const parsedErr = JSON.parse(errBody) as {
            error?: { message?: string };
          };
          if (parsedErr.error?.message) {
            detail = `${detail}: ${parsedErr.error.message}`;
          }
        } catch {
          if (errBody) detail = `${detail}: ${errBody.slice(0, 180)}`;
        }
        errors.push(detail);

        // Immediately surface auth/permission failures without burning fallback calls
        if (res.status === 401 || res.status === 403) {
          throw new Error(detail);
        }
        // Retry next model in fallback chain for 400/404/429/5xx
        continue;
      }

      const json = (await res.json()) as GeminiApiResponse;
      const responseParts = json.candidates?.[0]?.content?.parts ?? [];
      const rawJoined = responseParts
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const firstBrace = rawJoined.indexOf("{");
      const lastBrace = rawJoined.lastIndexOf("}");
      const rawText =
        firstBrace !== -1 && lastBrace > firstBrace
          ? rawJoined.slice(firstBrace, lastBrace + 1)
          : rawJoined;

      if (!rawText) {
        errors.push(`${model}: empty response`);
        continue;
      }

      const parsed = JSON.parse(rawText) as T;
      return { data: parsed, modelUsed: model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
        throw err;
      }
      if (!errors.includes(msg)) {
        errors.push(`${model}: ${msg}`);
      }
    }
  }

  throw new Error(
    errors.length > 0
      ? errors.join(" | ")
      : "All configured Gemini models failed to respond"
  );
}
