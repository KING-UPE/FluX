"use client";

import { ConnectionState } from "@/lib/socket";

interface ConnectionLoaderProps {
  state: ConnectionState;
  onRetry: () => void;
}

const MESSAGES: Record<ConnectionState, { title: string; subtitle: string }> = {
  waking: {
    title: "Waking Up Server",
    subtitle: "The server is sleeping on Render's free tier. Hang tight, this takes about 30-60 seconds..."
  },
  connecting: {
    title: "Server is Awake!",
    subtitle: "Establishing a secure WebSocket connection..."
  },
  connected: {
    title: "Connected",
    subtitle: "You're in the room!"
  },
  failed: {
    title: "Connection Failed",
    subtitle: "Could not reach the signaling server. Check your internet connection."
  }
};

export default function ConnectionLoader({ state, onRetry }: ConnectionLoaderProps) {
  const { title, subtitle } = MESSAGES[state];

  // Progress simulation for the cold start
  const progressWidth = state === 'waking' ? 'animate-cold-start-progress' 
    : state === 'connecting' ? 'w-[85%]' 
    : state === 'connected' ? 'w-full' 
    : 'w-[10%]';

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
      
      {/* Animated Ring */}
      <div className="relative w-24 h-24 mb-10">
        {/* Outer spinning ring */}
        <div className={`absolute inset-0 rounded-full border-2 border-transparent ${
          state === 'failed' ? 'border-t-red-500' : 'border-t-neon-blue'
        } ${state !== 'failed' ? 'animate-spin' : ''}`} 
        style={{ animationDuration: '1.5s' }} />
        
        {/* Middle pulsing ring */}
        <div className={`absolute inset-3 rounded-full border border-white/10 ${
          state === 'waking' ? 'animate-pulse' : ''
        }`} />
        
        {/* Center dot */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className={`w-4 h-4 rounded-full ${
            state === 'connected' ? 'bg-green-400 shadow-[0_0_20px_#4ade80]' 
            : state === 'failed' ? 'bg-red-500 shadow-[0_0_20px_#ef4444]'
            : 'bg-neon-blue shadow-[0_0_20px_#00f0ff] animate-pulse'
          }`} />
        </div>

        {/* Orbiting particle (only during waking) */}
        {state === 'waking' && (
          <div className="absolute inset-[-8px] animate-spin" style={{ animationDuration: '3s' }}>
            <div className="w-2 h-2 bg-neon-blue/60 rounded-full" />
          </div>
        )}
      </div>

      {/* Status Text */}
      <h2 className="text-2xl font-semibold text-white mb-3">{title}</h2>
      <p className="text-white/40 max-w-sm text-sm leading-relaxed mb-8">{subtitle}</p>

      {/* Progress Bar */}
      {state !== 'failed' && (
        <div className="w-64 h-1 bg-white/5 rounded-full overflow-hidden">
          <div className={`h-full bg-neon-blue rounded-full transition-all duration-1000 ease-out ${progressWidth}`} />
        </div>
      )}

      {/* Steps indicator */}
      {state === 'waking' && (
        <div className="mt-8 flex items-center gap-6 text-xs text-white/30">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-neon-blue animate-pulse" />
            <span>Wake</span>
          </div>
          <div className="w-6 h-px bg-white/10" />
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            <span>Connect</span>
          </div>
          <div className="w-6 h-px bg-white/10" />
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            <span>Ready</span>
          </div>
        </div>
      )}

      {state === 'connecting' && (
        <div className="mt-8 flex items-center gap-6 text-xs text-white/30">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-green-400/60">Wake</span>
          </div>
          <div className="w-6 h-px bg-green-400/30" />
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-neon-blue animate-pulse" />
            <span>Connect</span>
          </div>
          <div className="w-6 h-px bg-white/10" />
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            <span>Ready</span>
          </div>
        </div>
      )}

      {/* Retry Button */}
      {state === 'failed' && (
        <button
          onClick={onRetry}
          className="mt-6 px-6 py-2.5 bg-white/5 border border-white/10 rounded-xl text-white/70 text-sm font-medium hover:bg-white/10 hover:border-white/20 transition-all duration-300"
        >
          Try Again
        </button>
      )}
    </div>
  );
}
