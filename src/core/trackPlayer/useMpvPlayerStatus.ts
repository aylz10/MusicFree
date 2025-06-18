import { useEffect, useState } from 'react';
import { nativeMpvPlayer, MpvPlayerEvent } from './NativeMpvPlayer';

/**
 * React Hook to manage and expose MPV player playback state synchronized with native events.
 * It listens to native MPV events and updates React state accordingly, making it easy
 * to build reactive UI components that reflect the true state of the player.
 *
 * @returns An object containing the current player state: `isPlaying` and `isIdle`.
 */
export function useMpvPlayerStatus() {
  const [isPlaying, setIsPlaying] = useState(nativeMpvPlayer.isPlaying);
  const [isIdle, setIsIdle] = useState(nativeMpvPlayer.isIdle);

  useEffect(() => {
    // Handler for the play state change event from the native module
    const handlePlayStateChanged = (state: { isPlaying: boolean; isIdle: boolean }) => {
      setIsPlaying(state.isPlaying);
      setIsIdle(state.isIdle);
    };

    // Subscribe to the event
    nativeMpvPlayer.addEventListener(MpvPlayerEvent.PlayStateChanged, handlePlayStateChanged);

    // Cleanup function to remove the listener when the component unmounts
    return () => {
      nativeMpvPlayer.removeEventListener(MpvPlayerEvent.PlayStateChanged, handlePlayStateChanged);
    };
  }, []); // Empty dependency array ensures this effect runs only once on mount

  return { isPlaying, isIdle };
}