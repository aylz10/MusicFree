import { atom } from 'jotai';

export const activePlayerAtom = atom<'rntp' | 'mpv'>('rntp');
export const unifiedPositionAtom = atom(0);
export const unifiedDurationAtom = atom(0);
export const unifiedIsPlayingAtom = atom(false);
export const unifiedIsBufferingAtom = atom(false);