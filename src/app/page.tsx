"use client";

import RoomViewer from "@/components/RoomViewer";

export default function Home() {
  return (
    <main className="relative w-full flex-1 bg-background flex flex-col">
      {/* Main Grid Interface */}
      <div className="flex-1 w-full z-10">
        <RoomViewer />
      </div>
    </main>
  );
}
