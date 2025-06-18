import { useState, useEffect } from 'react';
import trackPlayerService from './index';
import { TrackPlayerEvents } from '@/core.defination/trackPlayer';

/**
 * A custom hook to get real-time playback progress from the TrackPlayerService.
 * It listens to both MPV and RNTP events through a unified service event.
 *
 * @returns An object with `position` and `duration` in seconds.
 */
export function usePlayerProgress() {
  const [progress, setProgress] = useState({ position: 0, duration: 0 });

  useEffect(() => {
    const handleProgressUpdate = (data: { position: number; duration: number }) => {
      setProgress({
        position: data.position ?? 0,
        duration: data.duration ?? 0,
      });
    };

    // Subscribe to the unified progress event from our service
    trackPlayerService.on(TrackPlayerEvents.ProgressChanged, handleProgressUpdate);

    // Cleanup on unmount
    return () => {
      trackPlayerService.off(TrackPlayerEvents.ProgressChanged, handleProgressUpdate);
    };
  }, []);

  return progress;
}