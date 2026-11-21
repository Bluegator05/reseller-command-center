import { Suspense } from "react";
import { connection } from "next/server";
import { CommandCenterShell } from "@/components/CommandCenterShell";
import { loadCommandCenterData } from "@/lib/inventory-loader";

async function CommandCenterLoader() {
  await connection();
  const initialData = await loadCommandCenterData();
  return <CommandCenterShell initialData={initialData} />;
}

function CommandCenterSkeleton() {
  return (
    <div className="min-h-screen bg-[#F7F7F4] p-6">
      <div className="max-w-[1380px] mx-auto space-y-5 animate-pulse">
        <div className="h-14 bg-white border border-[#E4E4DD] rounded-xl" />
        <div className="h-24 bg-white border border-[#E4E4DD] rounded-xl" />
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3.5">
          <div className="h-20 bg-white border border-[#E4E4DD] rounded-xl" />
          <div className="h-20 bg-white border border-[#E4E4DD] rounded-xl" />
          <div className="h-20 bg-white border border-[#E4E4DD] rounded-xl" />
          <div className="h-20 bg-white border border-[#E4E4DD] rounded-xl" />
        </div>
        <div className="h-96 bg-white border border-[#E4E4DD] rounded-xl" />
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<CommandCenterSkeleton />}>
      <CommandCenterLoader />
    </Suspense>
  );
}
