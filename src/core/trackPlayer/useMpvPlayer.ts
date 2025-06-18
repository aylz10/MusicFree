import { useState, useEffect } from 'react';
import { nativeMpvPlayer, MpvPlayerEvent } from './NativeMpvPlayer';
import trackPlayerService from './index';
import { TrackPlayerEvents } from '@/core.defination/trackPlayer';

/**
 * A unified React Hook to manage and expose MPV player state for UI components.
 * It listens to native MPV events for playback state and progress,
 * providing a single source of truth for all MPV-related UI updates.
 *
 * @returns An object containing the current player state:
 *          `isPlaying`, `isIdle`, `position`, and `duration`.
 */
export function useMpvPlayer() {
  const [isPlaying, setIsPlaying] = useState(nativeMpvPlayer.isPlaying);
  const [isIdle, setIsIdle] = useState(nativeMpvPlayer.isIdle);
  const [progress, setProgress] = useState({ position: 0, duration: 0 });

  useEffect(() => {
    // Handler for play state changes
    const handlePlayStateChanged = (state: { isPlaying: boolean; isIdle: boolean }) => {
      setIsPlaying(state.isPlaying);
      setIsIdle(state.isIdle);
    };

    // Handler for progress updates
    const handleProgressUpdate = (data: { position: number; duration: number }) => {
      setProgress({
        position: data.position ?? 0,
        duration: data.duration ?? 0,
      });
    };

    // Subscribe to events
    nativeMpvPlayer.addEventListener(MpvPlayerEvent.PlayStateChanged, handlePlayStateChanged);
    trackPlayerService.on(TrackPlayerEvents.ProgressChanged, handleProgressUpdate);

    // Cleanup on unmount
    return () => {
      nativeMpvPlayer.removeEventListener(MpvPlayerEvent.PlayStateChanged, handlePlayStateChanged);
      trackPlayerService.off(TrackPlayerEvents.ProgressChanged, handleProgressUpdate);
    };
  }, []); // Empty dependency array ensures this effect runs only once

  return { isPlaying, isIdle, ...progress };
}