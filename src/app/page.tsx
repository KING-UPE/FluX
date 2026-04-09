"use client";

import { useEffect, useState } from "react";
import RoomViewer from "@/components/RoomViewer";
import { getOrCreateDeviceName } from "@/lib/socket";

export default function Home() {
  const [deviceName, setDeviceName] = useState("Connecting...");

  useEffect(() => {
    setDeviceName(getOrCreateDeviceName());
  }, []);

  return (
    <main className="relative w-full min-h-screen bg-background flex flex-col">
      {/* Main Grid Interface */}
      <div className="flex-1 w-full z-10">
        <RoomViewer />
      </div>
      
    </main>
  );
}
