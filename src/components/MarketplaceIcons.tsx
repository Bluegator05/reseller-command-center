"use client";

import type { MarketplaceType } from "@/lib/types";

/**
 * Crisp inline SVG marketplace brand icons — including the authentic 4-color eBay logo.
 */
export function MarketplaceIcon({
  marketplace,
  size = 20,
}: {
  marketplace: MarketplaceType;
  size?: number;
}) {
  if (marketplace === "ebay") {
    return (
      <span
        className="inline-flex items-center justify-center rounded-md bg-white border border-[#E5E9E7] px-1.5 shadow-2xs shrink-0"
        style={{ height: size + 2 }}
        aria-hidden="true"
      >
        <svg
          width="34"
          height="14"
          viewBox="0 0 68 28"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <text
            x="0"
            y="22"
            fontFamily="Arial, Helvetica, sans-serif"
            fontWeight="800"
            fontSize="24"
            letterSpacing="-1.4"
          >
            <tspan fill="#E53238">e</tspan>
            <tspan fill="#0064D2">b</tspan>
            <tspan fill="#F5AF02">a</tspan>
            <tspan fill="#86B817">y</tspan>
          </text>
        </svg>
      </span>
    );
  }

  if (marketplace === "etsy") {
    return (
      <span
        className="inline-flex items-center justify-center rounded-md bg-[#F1641E] text-white font-serif font-bold shrink-0 shadow-2xs"
        style={{ width: size + 2, height: size + 2, fontSize: size * 0.62 }}
        aria-hidden="true"
      >
        E
      </span>
    );
  }

  if (marketplace === "poshmark") {
    return (
      <span
        className="inline-flex items-center justify-center rounded-md bg-[#7F0353] text-white shrink-0 shadow-2xs"
        style={{ width: size + 2, height: size + 2 }}
        aria-hidden="true"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 20V5h5.5a4.5 4.5 0 0 1 0 9H8" />
          <path d="M12 10.5a4.5 4.5 0 0 1 4.5 4.5c0 2.5-2 4.5-4.5 4.5" opacity="0.65" />
        </svg>
      </span>
    );
  }

  if (marketplace === "mercari") {
    return (
      <span
        className="inline-flex items-center justify-center rounded-md bg-[#4D5CE5] text-white font-sans font-extrabold shrink-0 shadow-2xs"
        style={{ width: size + 2, height: size + 2, fontSize: size * 0.58 }}
        aria-hidden="true"
      >
        M
      </span>
    );
  }

  // Facebook Marketplace
  return (
    <span
      className="inline-flex items-center justify-center rounded-md bg-[#1877F2] text-white shrink-0 shadow-2xs"
      style={{ width: size + 2, height: size + 2 }}
      aria-hidden="true"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.5-1.5h1.6V4.4c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.4-4 4.1v2.1H8.7v3h2.5V21h3.3z" />
      </svg>
    </span>
  );
}
