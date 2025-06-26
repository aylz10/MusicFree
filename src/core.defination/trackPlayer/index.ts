export enum TrackPlayerEvents {
    // 一首歌曲播放结束
    PlayEnd = 'play-end',
    // 更换正在播放的歌曲
    CurrentMusicChanged = 'current-music-changed',
    // 进度更新
    ProgressChanged = 'progress-changed',
}

export interface ITrackPlayer {
    // Properties
    readonly currentMusic: IMusic.IMusicItem | null;
    readonly previousMusic: IMusic.IMusicItem | null;
    readonly nextMusic: IMusic.IMusicItem | null;
    readonly repeatMode: import('@/constants/repeatModeConst').MusicRepeatMode;
    readonly quality: IMusic.IQualityKey;
    readonly playList: IMusic.IMusicItem[];

    // Methods
    setupTrackPlayer(): Promise<void>;
    play(musicItem?: IMusic.IMusicItem | null, forcePlay?: boolean): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<void>;
    reset(): Promise<void>;
    destroy(): Promise<void>;
    seekTo(position: number): Promise<void>;
    setRate(rate: number): Promise<void>;
    getRate(): Promise<number>;
    getProgress(): Promise<{ position: number; duration: number; buffered: number }>;
    changeQuality(quality: IMusic.IQualityKey): Promise<boolean>;
    add(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[], beforeIndex?: number): void;
    addAll(musicItems: IMusic.IMusicItem[], beforeIndex?: number, shouldShuffle?: boolean): void;
    addNext(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]): void;
    remove(musicItem: IMusic.IMusicItem): Promise<void>;
    clearPlayList(): Promise<void>;
    skipToNext(): Promise<void>;
    skipToPrevious(): Promise<void>;
    playWithReplacePlayList(musicItem: IMusic.IMusicItem, newPlayList: IMusic.IMusicItem[]): Promise<void>;
    isCurrentMusic(musicItem?: IMusic.IMusicItem | null): boolean;
    isInPlayList(musicItem?: IMusic.IMusicItem | null): boolean;
    isPlayListEmpty(): boolean;
    getPlayListMusicAt(index: number): IMusic.IMusicItem | null;
    getMusicIndexInPlayList(musicItem?: IMusic.IMusicItem | null): number;
    toggleRepeatMode(): void;
}