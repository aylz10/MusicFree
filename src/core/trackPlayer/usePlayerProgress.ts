import { useAtomValue } from 'jotai';
import { unifiedPositionAtom, unifiedDurationAtom } from './stateAtoms';

export function usePlayerProgress() {
  const position = useAtomValue(unifiedPositionAtom);
  const duration = useAtomValue(unifiedDurationAtom);
  return { position, duration };
}