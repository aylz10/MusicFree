import { NativeModules, NativeEventEmitter } from 'react-native';

const { MpvPlayer } = NativeModules;

/**
 * Events emitted from the native MpvPlayer module.
 */
export enum MpvPlayerEvent {
  /**
   * Fired when the player has finished playing a track.
   */
  Ended = 'Ended',
  /**
   * Fired when the player's play/pause state changes.
   * The event payload is a boolean: `true` if playing, `false` if paused.
   */
  PlayStateChanged = 'PlayStateChanged',
  /**
   * Fired periodically with the current playback progress.
   * The event payload is an object: `{ position: number, duration: number }`.
   */
  Progress = 'Progress',
  /**
   * Fired when an error occurs.
   * The event payload is a string with the error message.
   */
  Error = 'Error',
}

/**
 * Options for initializing the player.
 */
export interface PlayerOptions {
  // Define any initialization options here if needed in the future.
  // For example: `logLevel: 'debug' | 'info' | 'error'`.
}

/**
 * Parameters for loading and playing a track.
 */
export interface LoadParams {
  url: string;
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
}

/**
 * A TypeScript wrapper around the native MpvPlayer module.
 * It provides a type-safe API and manages player state.
 */
class NativeMpvPlayer {
  public readonly eventEmitter: NativeEventEmitter;
  private _isPlaying: boolean = false;
  private _isIdle: boolean = true;

  constructor() {
    this.eventEmitter = new NativeEventEmitter(MpvPlayer);
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.addEventListener(MpvPlayerEvent.PlayStateChanged, (state: { isPlaying: boolean; isIdle: boolean }) => {
      this._isPlaying = state.isPlaying;
      this._isIdle = state.isIdle;
    });
  }

  /**
   * Initializes the MPV player instance.
   * Must be called before any other player operations.
   * @param options - Player initialization options.
   */
  async initialize(options: PlayerOptions = {}): Promise<void> {
    return MpvPlayer.initialize(options);
  }

  /**
   * Loads and starts playing a track.
   * @param params - The track to play.
   */
  async loadAndPlay(params: LoadParams): Promise<void> {
    return MpvPlayer.loadAndPlay(params);
  }

  /**
   * Pauses the currently playing track.
   */
  async pause(): Promise<void> {
    return MpvPlayer.pause();
  }

  /**
   * Resumes the currently paused track.
   */
  async resume(): Promise<void> {
    return MpvPlayer.resume();
  }

  /**
   * Seeks to a specific position in the track.
   * @param position - The position to seek to, in seconds.
   */
  async seekTo(position: number): Promise<void> {
    return MpvPlayer.seekTo(position);
  }

  /**
   * Sets the player volume.
   * @param volume - The volume level, from 0.0 to 1.0.
   */
  async setVolume(volume: number): Promise<void> {
    return MpvPlayer.setVolume(volume);
  }

  /**
   * Sets the playback rate.
   * @param rate - The playback rate (e.g., 1.0 for normal speed).
   */
  async setRate(rate: number): Promise<void> {
    return MpvPlayer.setRate(rate);
  }

  /**
   * Stops playback and releases resources.
   */
  async stop(): Promise<void> {
    return MpvPlayer.stop();
  }

  /**
   * Destroys the player instance and releases all resources.
   */
  async destroy(): Promise<void> {
    return MpvPlayer.destroy();
  }

  /**
   * Adds a listener for a player event.
   * @param event - The event to listen for.
   * @param listener - The function to call when the event is emitted.
   */
  addEventListener(event: MpvPlayerEvent, listener: (...args: any[]) => void) {
    this.eventEmitter.addListener(event, listener);
  }

  /**
   * Removes a listener for a player event.
   * @param event - The event to stop listening to.
   * @param listener - The listener instance to remove.
   */
  removeEventListener(event: MpvPlayerEvent, _listener: (...args: any[]) => void) {
    // As per user feedback, `removeListener` might not exist.
    // Using `removeAllListeners` as a fallback. This will remove all listeners for the given event.
    this.eventEmitter.removeAllListeners(event);
  }

  /**
   * Synchronously gets the current playing state.
   * @returns `true` if the player is currently playing, otherwise `false`.
   */
  get isPlaying(): boolean {
    return this._isPlaying;
  }

  /**
   * Synchronously gets the current idle state.
   * @returns `true` if the player is idle (not playing or paused), otherwise `false`.
   */
  get isIdle(): boolean {
    return this._isIdle;
  }
}

/**
 * A singleton instance of the NativeMpvPlayer.
 */
export const nativeMpvPlayer = new NativeMpvPlayer();