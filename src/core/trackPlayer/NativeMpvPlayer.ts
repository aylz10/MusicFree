import { NativeEventEmitter, NativeModules } from 'react-native';

const { MpvPlayer } = NativeModules;
const eventEmitter = new NativeEventEmitter(MpvPlayer);

export type MpvPlayerStatus =
  | 'idle'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
  | 'buffering';

export const ON_MPV_PLAY_STATE_CHANGED = 'onMpvPlayStateChanged';
export const ON_MPV_PROGRESS = 'onMpvProgress';
export const ON_MPV_ENDED = 'onMpvEnded';
export const ON_MPV_ERROR = 'onMpvError';
export const ON_MPV_BUFFER = 'onMpvBuffer';
export const ON_MPV_VOLUME_CHANGED = 'onMpvVolumeChanged';
export const ON_MPV_RATE_CHANGED = 'onMpvRateChanged';


const NativeMpvPlayer = {
  initialize: (options: Record<string, any>) => MpvPlayer.initialize(options),
  destroy: () => MpvPlayer.destroy(),
  loadAndPlay: (track: IMusic.IMusicItem) => {
    const { url, headers, userAgent } = track;
    MpvPlayer.loadAndPlay({ url, headers, userAgent });
  },
  pause: () => MpvPlayer.pause(),
  resume: () => MpvPlayer.resume(),
  stop: () => MpvPlayer.stop(),
  seekTo: (seconds: number) => MpvPlayer.seekTo(seconds),
  setVolume: (volume: number) => MpvPlayer.setVolume(volume), // 0-1
  setRate: (rate: number) => MpvPlayer.setRate(rate),
  getIsPlaying: (): Promise<boolean> => MpvPlayer.getIsPlaying(),
  getPosition: (): Promise<number> => MpvPlayer.getPosition(),
  getDuration: (): Promise<number> => MpvPlayer.getDuration(),

  // Event listeners
  addPlayStateChangedListener: (
    callback: (event: { isPlaying: boolean }) => void,
  ) => eventEmitter.addListener(ON_MPV_PLAY_STATE_CHANGED, callback),

  addProgressListener: (
    callback: (event: { position: number; duration: number }) => void,
  ) => eventEmitter.addListener(ON_MPV_PROGRESS, callback),

  addEndedListener: (callback: () => void) =>
    eventEmitter.addListener(ON_MPV_ENDED, callback),

  addErrorListener: (callback: (event: { error: string }) => void) =>
    eventEmitter.addListener(ON_MPV_ERROR, callback),

  addBufferListener: (callback: (event: { isBuffering: boolean }) => void) =>
    eventEmitter.addListener(ON_MPV_BUFFER, callback),

  removeAllListeners: () => {
    eventEmitter.removeAllListeners(ON_MPV_PLAY_STATE_CHANGED);
    eventEmitter.removeAllListeners(ON_MPV_PROGRESS);
    eventEmitter.removeAllListeners(ON_MPV_ENDED);
    eventEmitter.removeAllListeners(ON_MPV_ERROR);
    eventEmitter.removeAllListeners(ON_MPV_BUFFER);
  },
};

export default NativeMpvPlayer;