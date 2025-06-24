import { useAtomValue } from 'jotai';
import { State } from 'react-native-track-player';
import { unifiedIsPlayingAtom, unifiedIsBufferingAtom } from './stateAtoms';

export function useUnifiedPlaybackState() {
    const isPlaying = useAtomValue(unifiedIsPlayingAtom);
    const isBuffering = useAtomValue(unifiedIsBufferingAtom);

    let state = State.None;
    if (isBuffering) state = State.Buffering;
    else if (isPlaying) state = State.Playing;
    else state = State.Paused;

    return { state };
}