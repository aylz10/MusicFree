import { showDialog } from '@/components/dialogs/useDialog';
import {
    internalFakeSoundKey,
    sortIndexSymbol,
    timeStampSymbol,
} from '@/constants/commonConst';
import { ImgAsset } from '@/constants/assetsConst';
import { MusicRepeatMode } from '@/constants/repeatModeConst';
import { TrackPlayerEvents } from '@/core.defination/trackPlayer';
import type { IAppConfig } from '@/types/core/config';
import type { IMusicHistory } from '@/types/core/musicHistory';
import { IPluginManager } from '@/types/core/pluginManager';
import { ITrackPlayer } from '@/types/core/trackPlayer';
import delay from '@/utils/delay';
import { resolveImportedAssetOrPath, silentTrack } from '@/utils/fileUtils';
import { errorLog, trace } from '@/utils/log';
import { createMediaIndexMap } from '@/utils/mediaIndexMap';
import { getLocalPath, isSameMediaItem } from '@/utils/mediaUtils';
import Network from '@/utils/network';
import PersistStatus from '@/utils/persistStatus';
import { getQualityOrder } from '@/utils/qualities';
import { musicIsPaused } from '@/utils/trackUtils';
import { getAppUserAgent } from '@/utils/userAgentHelper';
import EventEmitter from 'eventemitter3';
import { produce } from 'immer';
import { atom, getDefaultStore, useAtomValue, SetStateAction } from 'jotai';
import shuffle from 'lodash.shuffle';
import ReactNativeTrackPlayer, {
    Event,
    State,
    Track,
    TrackMetadataBase,
    usePlaybackState,
    useProgress,
} from 'react-native-track-player';
import LocalMusicSheet from '../localMusicSheet';
import NativeMpvPlayer from './NativeMpvPlayer';
import {
    activePlayerAtom,
    unifiedDurationAtom,
    unifiedIsBufferingAtom,
    unifiedIsPlayingAtom,
    unifiedPositionAtom,
} from './stateAtoms';
import minDistance from '@/utils/minDistance';

const currentMusicAtom = atom<IMusic.IMusicItem | null>(null);
const repeatModeAtom = atom<MusicRepeatMode>(MusicRepeatMode.QUEUE);
const qualityAtom = atom<IMusic.IQualityKey>('standard');
const playListAtom = atom<IMusic.IMusicItem[]>([]);

type JotaiStore = {
    get: <Value>(atom: import('jotai').Atom<Value>) => Value;
    set: <Value, Result extends void | Promise<void>>(atom: import('jotai').WritableAtom<Value, [SetStateAction<Value>], Result>, value: SetStateAction<Value>) => Result;
    sub: (atom: import('jotai').Atom<unknown>, listener: () => void) => () => void;
}

class TrackPlayer extends EventEmitter<{
    [TrackPlayerEvents.PlayEnd]: () => void;
    [TrackPlayerEvents.CurrentMusicChanged]: (musicItem: IMusic.IMusicItem | null) => void;
    [TrackPlayerEvents.ProgressChanged]: (progress: {
        position: number;
        duration: number;
    }) => void;
}> implements ITrackPlayer {
    private configService!: IAppConfig;
    private musicHistoryService!: IMusicHistory;
    private pluginManagerService!: IPluginManager;
    private _store: JotaiStore;
    private _activePlayerType: 'rntp' | 'mpv' = 'rntp';
    private currentIndex = -1;
    private serviceInited = false;
    private playListIndexMap = createMediaIndexMap([] as IMusic.IMusicItem[]);

    private static maxMusicQueueLength = 10000;
    private static halfMaxMusicQueueLength = 5000;
    private static toggleRepeatMapping = {
        [MusicRepeatMode.SHUFFLE]: MusicRepeatMode.SINGLE,
        [MusicRepeatMode.SINGLE]: MusicRepeatMode.QUEUE,
        [MusicRepeatMode.QUEUE]: MusicRepeatMode.SHUFFLE,
    };
    private static fakeAudioUrl = "musicfree://fake-audio";

    constructor() {
        super();
        this._store = getDefaultStore();
    }

    injectDependencies(configService: IAppConfig, musicHistoryService: IMusicHistory, pluginManager: IPluginManager): void {
        this.configService = configService;
        this.musicHistoryService = musicHistoryService;
        this.pluginManagerService = pluginManager;
    }

    async setupTrackPlayer() {
        if (this.serviceInited) return;

        await ReactNativeTrackPlayer.setupPlayer();
        this._initializeMpvPlayer();
        this._subscribeToEvents();

        const rate = PersistStatus.get('music.rate');
        if (rate) this.setRate(+rate / 100);

        const repeatMode = PersistStatus.get('music.repeatMode');
        if (repeatMode) this._store.set(repeatModeAtom, repeatMode as MusicRepeatMode);

        const musicQueue = PersistStatus.get('music.playList');
        if (musicQueue && Array.isArray(musicQueue)) {
            this.addAll(musicQueue, undefined, repeatMode === MusicRepeatMode.SHUFFLE);
        }

        const track = PersistStatus.get('music.musicItem');
        if (track && this.isInPlayList(track)) {
            if (!this.configService.getConfig('basic.autoPlayWhenAppStart')) {
                track.isInit = true;
            }
            this.setCurrentMusic(track);
            const progress = PersistStatus.get('music.progress');
            if (progress) this.seekTo(progress);
        }

        this.serviceInited = true;
    }

    private _initializeMpvPlayer() {
        const userAgent = getAppUserAgent();
        const cacheSize = this.configService.getConfig('player.cacheSize' as any) ?? 128;
        NativeMpvPlayer.initialize({
            "vo": "null", "ao": "audiotrack", "user-agent": userAgent,
            "hwdec": "auto-safe", "demuxer-max-bytes": `${Number(cacheSize) * 1024 * 1024}`,
            "demuxer-readahead-secs": "300", "network-timeout": "10", "cache": "yes",
        }).catch(e => errorLog("MPV Initialization failed", e));
    }

    private _subscribeToEvents() {
        // --- RNTP Events ---
        ReactNativeTrackPlayer.addEventListener(Event.PlaybackState, (event) => {
            if (this._activePlayerType !== 'rntp') return;
            this._store.set(unifiedIsPlayingAtom, !musicIsPaused(event.state));
            this._store.set(unifiedIsBufferingAtom, event.state === State.Buffering || event.state === State.Connecting);
        });

        ReactNativeTrackPlayer.addEventListener(Event.PlaybackProgressUpdated, (event) => {
            if (this._activePlayerType !== 'rntp') return;
            this._store.set(unifiedPositionAtom, event.position);
            this._store.set(unifiedDurationAtom, event.duration);
        });

        ReactNativeTrackPlayer.addEventListener(Event.RemotePlay, () => this.resume());
        ReactNativeTrackPlayer.addEventListener(Event.RemotePause, () => this.pause());
        ReactNativeTrackPlayer.addEventListener(Event.RemoteNext, () => this.skipToNext());
        ReactNativeTrackPlayer.addEventListener(Event.RemotePrevious, () => this.skipToPrevious());
        ReactNativeTrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => this.seekTo(position));

        ReactNativeTrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (evt) => {
            if (this._activePlayerType !== 'rntp') return;
            if (evt.track?.url === TrackPlayer.fakeAudioUrl) {
                await this._handlePlaybackEnd();
            }
        });

        ReactNativeTrackPlayer.addEventListener(Event.PlaybackError, async (e) => {
            if (this._activePlayerType !== 'rntp') return;
            errorLog('RNTP Playback Error', e.message);
            this.handlePlayFail();
        });

        // --- MPV Events ---
        NativeMpvPlayer.addPlayStateChangedListener(({ isPlaying }) => {
            if (this._activePlayerType !== 'mpv') return;
            this._store.set(unifiedIsPlayingAtom, isPlaying);
        });

        NativeMpvPlayer.addProgressListener(({ position, duration }) => {
            if (this._activePlayerType !== 'mpv') return;
            this._store.set(unifiedPositionAtom, position);
            if (duration > 0) this._store.set(unifiedDurationAtom, duration);
        });

        NativeMpvPlayer.addEndedListener(async () => {
            if (this._activePlayerType !== 'mpv') return;
            await this._handlePlaybackEnd();
        });

        NativeMpvPlayer.addErrorListener(({ error }) => {
            if (this._activePlayerType !== 'mpv') return;
            errorLog('MPV Playback Error', error);
            this.handlePlayFail();
        });

        NativeMpvPlayer.addBufferListener(({ isBuffering }) => {
            if (this._activePlayerType !== 'mpv') return;
            this._store.set(unifiedIsBufferingAtom, isBuffering);
        });
    }

    async play(musicItem?: IMusic.IMusicItem | null, forcePlay?: boolean): Promise<void> {
        try {
            if (!musicItem) musicItem = this.currentMusic;
            if (!musicItem) throw new Error(PlayFailReason.PLAY_LIST_IS_EMPTY);

            const localPath = getLocalPath(musicItem);
            if (Network.isCellular && !this.configService.getConfig('basic.useCelluarNetworkPlay') && !LocalMusicSheet.isLocalMusic(musicItem) && !localPath) {
                await this.reset();
                throw new Error(PlayFailReason.FORBID_CELLUAR_NETWORK_PLAY);
            }

            if (this.isCurrentMusic(musicItem) && !forcePlay) {
                await this.resume();
                return;
            }

            // Not resuming, so it's a new playback. Stop everything first for a clean state.
            await this.stop();

            if (!this.isInPlayList(musicItem)) this.add(musicItem);
            this.setCurrentMusic(musicItem);

            const playerType = musicItem.url?.startsWith('musicfree://') ? 'mpv' : 'rntp';
            this._activePlayerType = playerType;
            this._store.set(activePlayerAtom, playerType);
            this._store.set(unifiedPositionAtom, 0);
            this._store.set(unifiedDurationAtom, musicItem.duration || 0);
            this._store.set(unifiedIsBufferingAtom, true);

            const trackWithSource = await this._getPlayableTrack(musicItem);
            if (!trackWithSource?.url) throw new Error(PlayFailReason.INVALID_SOURCE);

            this.musicHistoryService.addMusic(musicItem);
            trace('Playing track', { player: playerType, title: trackWithSource.title });

            if (playerType === 'mpv') {
                // 1. 创建一个纯净的静音轨道，并复制元数据
                const metadataTrack: Track = {
                    url: resolveImportedAssetOrPath(silentTrack.url) as string,
                    // 从真实音轨复制元数据
                    id: trackWithSource.id,
                    title: trackWithSource.title,
                    artist: trackWithSource.artist,
                    duration: trackWithSource.duration,
                    artwork: resolveImportedAssetOrPath(trackWithSource.artwork?.trim?.()?.length ? trackWithSource.artwork : ImgAsset.albumDefault) as unknown as any,
                    platform: trackWithSource.platform,
                    userAgent: getAppUserAgent(),
                };
                // 2. 将这个纯净的元数据轨道交给 RNTP
                await ReactNativeTrackPlayer.reset();
                await ReactNativeTrackPlayer.add([metadataTrack, this.getFakeNextTrack()]);
                await ReactNativeTrackPlayer.play(); // 播放静音以激活媒体会话

                // 3. 让 MPV 播放真正的音源
                NativeMpvPlayer.loadAndPlay(trackWithSource);
            } else {
                await this.setTrackSource(trackWithSource as Track, true);
            }

            this._store.set(unifiedIsPlayingAtom, true);
            this._store.set(unifiedIsBufferingAtom, false);

            this._fetchAndApplyMusicInfo(trackWithSource);
        } catch (e: any) {
            this._handlePlayError(e, musicItem, forcePlay);
        }
    }

    async pause(): Promise<void> {
        if (this._activePlayerType === 'mpv') await NativeMpvPlayer.pause();
        else await ReactNativeTrackPlayer.pause();
        this._store.set(unifiedIsPlayingAtom, false);
    }

    async resume(): Promise<void> {
        if (this._activePlayerType === 'mpv') await NativeMpvPlayer.resume();
        else await ReactNativeTrackPlayer.play();
        this._store.set(unifiedIsPlayingAtom, true);
    }

    async stop(): Promise<void> {
        await NativeMpvPlayer.stop();
        await ReactNativeTrackPlayer.stop();
        this._activePlayerType = 'rntp';
        this._store.set(activePlayerAtom, 'rntp');
        this._store.set(unifiedIsPlayingAtom, false);
    }

    async reset(): Promise<void> {
        await NativeMpvPlayer.stop();
        await ReactNativeTrackPlayer.reset();
        this._store.set(unifiedIsPlayingAtom, false);
        this._store.set(unifiedPositionAtom, 0);
        this._store.set(unifiedDurationAtom, 0);
    }

    async destroy(): Promise<void> {
        await this.reset();
        await NativeMpvPlayer.destroy();
        this.serviceInited = false;
    }

    async seekTo(position: number): Promise<void> {
        if (this._activePlayerType === 'mpv') await NativeMpvPlayer.seekTo(position);
        else await ReactNativeTrackPlayer.seekTo(position);
    }

    async setRate(rate: number): Promise<void> {
        await ReactNativeTrackPlayer.setRate(rate);
        await NativeMpvPlayer.setRate(rate);
    }

    async getProgress() {
        return ReactNativeTrackPlayer.getProgress();
    }

    async getRate() {
        return ReactNativeTrackPlayer.getRate();
    }

    async changeQuality(newQuality: IMusic.IQualityKey): Promise<boolean> {
        if (newQuality === this.quality) return true;
        const musicItem = this.currentMusic;
        if (!musicItem) return false;

        try {
            const progress = await this.getProgress();
            const newTrack = await this._getPlayableTrack(musicItem, newQuality);
            if (!newTrack?.url) throw new Error(PlayFailReason.INVALID_SOURCE);

            if (this.isCurrentMusic(musicItem)) {
                await this.play(newTrack, true);
                await this.seekTo(progress.position ?? 0);
                this.setQuality(newQuality);
            }
            return true;
        } catch {
            return false;
        }
    }

    private async _getPlayableTrack(musicItem: IMusic.IMusicItem, qualityOverride?: IMusic.IQualityKey): Promise<IMusic.IMusicItem | null> {
        if (musicItem.url?.startsWith("musicfree://")) {
            return { ...musicItem, userAgent: getAppUserAgent() };
        }

        const plugin = this.pluginManagerService.getByName(musicItem.platform);
        const qualityOrder = getQualityOrder(
            qualityOverride ?? this.configService.getConfig('basic.defaultPlayQuality') ?? 'standard',
            'asc'
        );

        let source: IPlugin.IMediaSourceResult | null = null;
        for (const quality of qualityOrder) {
            if (!this.isCurrentMusic(musicItem)) return null;
            source = (await plugin?.methods?.getMediaSource(musicItem, quality)) ?? null;
            if (source) {
                this.setQuality(quality);
                break;
            }
        }

        if (!source && musicItem.source) {
            for (const quality of qualityOrder) {
                if (musicItem.source[quality]?.url) {
                    source = musicItem.source[quality]!;
                    this.setQuality(quality);
                    break;
                }
            }
        }

        if (!source && musicItem.url) {
            source = { url: musicItem.url };
        }

        if (!source) {
             if (this.configService.getConfig('basic.tryChangeSourceWhenPlayFail')) {
                const similarMusic = await this.getSimilarMusic(musicItem, 'music', () => !this.isCurrentMusic(musicItem));
                if (similarMusic) {
                    const similarPlugin = this.pluginManagerService.getByMedia(similarMusic);
                    for (const quality of qualityOrder) {
                        if (!this.isCurrentMusic(musicItem)) return null;
                        source = (await similarPlugin?.methods?.getMediaSource(similarMusic, quality)) ?? null;
                        if (source) {
                            this.setQuality(quality);
                            return this.mergeTrackSource(similarMusic, source) as IMusic.IMusicItem;
                        }
                    }
                }
            }
            return null;
        }

        return this.mergeTrackSource(musicItem, source) as IMusic.IMusicItem;
    }

    private async _fetchAndApplyMusicInfo(track: IMusic.IMusicItem) {
        const plugin = this.pluginManagerService.getByName(track.platform);
        if (!plugin?.methods?.getMusicInfo) return;

        try {
            const info = await plugin.methods.getMusicInfo(track);
            if (info && this.isCurrentMusic(track)) {
                if (typeof info.url === 'string' && info.url.trim() === '') delete info.url;
                const mergedTrack = this.mergeTrackSource(track, info);
                this._store.set(currentMusicAtom, mergedTrack as IMusic.IMusicItem);

                const metadataForRntp = { ...mergedTrack };
                // If the URL is a custom scheme for MPV, DO NOT pass it to RNTP metadata updates.
                if (metadataForRntp.url?.startsWith('musicfree://')) {
                    delete (metadataForRntp as Partial<IMusic.IMusicItem>).url;
                }
                await ReactNativeTrackPlayer.updateMetadataForTrack(0, metadataForRntp as TrackMetadataBase);
            }
        } catch (e) {
            errorLog('Failed to fetch music info', e);
        }
    }

    private async _handlePlaybackEnd() {
        this.emit(TrackPlayerEvents.PlayEnd);
        if (this.repeatMode === MusicRepeatMode.SINGLE) {
            await this.play(null, true);
        } else {
            await this.skipToNext();
        }
    }

    private _handlePlayError(e: any, musicItem?: IMusic.IMusicItem | null, forcePlay?: boolean) {
        const message = e?.message;
        if (message === 'The player is not initialized. Call setupPlayer first.') {
            this.setupTrackPlayer().then(() => this.play(musicItem, forcePlay));
        } else if (message === PlayFailReason.FORBID_CELLUAR_NETWORK_PLAY) {
            showDialog('SimpleDialog', { title: '流量提醒', content: '当前非WIFI环境，请在设置中允许使用移动网络播放。' });
        } else if (message === PlayFailReason.INVALID_SOURCE) {
            trace('音源为空，播放失败');
            this.handlePlayFail();
        } else {
            trace('Unknown playback error', e);
            this.handlePlayFail();
        }
    }

    public get previousMusic() { return this.getPlayListMusicAt(this.currentIndex - 1); }
    public get currentMusic() { return this._store.get(currentMusicAtom); }
    public get nextMusic() { return this.getPlayListMusicAt(this.currentIndex + 1); }
    public get repeatMode() { return this._store.get(repeatModeAtom); }
    public get quality() { return this._store.get(qualityAtom); }
    public get playList() { return this._store.get(playListAtom); }
    getMusicIndexInPlayList(musicItem?: IMusic.IMusicItem | null) { if (!musicItem) return -1; return this.playListIndexMap.getIndex(musicItem); }
    isInPlayList(musicItem?: IMusic.IMusicItem | null) { if (!musicItem) return false; return this.playListIndexMap.has(musicItem); }
    getPlayListMusicAt(index: number): IMusic.IMusicItem | null { const p = this.playList; const l = p.length; if (l === 0) return null; return p[(index % l + l) % l]; }
    isPlayListEmpty() { return this.playList.length === 0; }
    isCurrentMusic(musicItem?: IMusic.IMusicItem | null) { return isSameMediaItem(musicItem, this.currentMusic); }
    addAll(musicItems: IMusic.IMusicItem[], beforeIndex?: number, shouldShuffle?: boolean) { const now = Date.now(); let newPlayList: IMusic.IMusicItem[] = []; let currentPlayList = this.playList; musicItems.forEach((item, index) => { item[timeStampSymbol] = now; item[sortIndexSymbol] = index; }); if (beforeIndex === undefined || beforeIndex < 0) { newPlayList = currentPlayList.concat(musicItems.filter(item => !this.isInPlayList(item))); } else { const indexMap = createMediaIndexMap(musicItems); const before = currentPlayList.slice(0, beforeIndex).filter(item => !indexMap.has(item)); const after = currentPlayList.slice(beforeIndex).filter(item => !indexMap.has(item)); newPlayList = [...before, ...musicItems, ...after]; } if (newPlayList.length > TrackPlayer.maxMusicQueueLength) { newPlayList = this.shrinkPlayListToSize(newPlayList, beforeIndex ?? newPlayList.length - 1); } if (shouldShuffle) { newPlayList = shuffle(newPlayList); } this.setPlayList(newPlayList); }
    add(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[], beforeIndex?: number) { this.addAll(Array.isArray(musicItem) ? musicItem : [musicItem], beforeIndex); }
    addNext(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]) { const shouldAuto = this.isPlayListEmpty() || !this.currentMusic; this.add(musicItem, this.currentIndex + 1); if (shouldAuto) this.play(Array.isArray(musicItem) ? musicItem[0] : musicItem); }
    async remove(musicItem: IMusic.IMusicItem) { const playList = this.playList; let newPlayList: IMusic.IMusicItem[] = []; let currentMusic: IMusic.IMusicItem | null = this.currentMusic; const targetIndex = this.getMusicIndexInPlayList(musicItem); let shouldPlayCurrent: boolean | null = null; if (targetIndex === -1) return; if (this.currentIndex === targetIndex) { newPlayList = produce(playList, d => { d.splice(targetIndex, 1); }); if (newPlayList.length === 0) { currentMusic = null; shouldPlayCurrent = false; } else { currentMusic = newPlayList[this.currentIndex % newPlayList.length]; try { const state = (await ReactNativeTrackPlayer.getPlaybackState()).state; shouldPlayCurrent = !musicIsPaused(state); } catch { shouldPlayCurrent = false; } } this.setCurrentMusic(currentMusic); } else { newPlayList = produce(playList, d => { d.splice(targetIndex, 1); }); if (targetIndex < this.currentIndex) this.currentIndex--; } this.setPlayList(newPlayList); if (shouldPlayCurrent === true) await this.play(currentMusic, true); else if (shouldPlayCurrent === false) await ReactNativeTrackPlayer.reset(); }
    toggleRepeatMode() { this.setRepeatMode(TrackPlayer.toggleRepeatMapping[this.repeatMode]); }
    async clearPlayList() { this.setPlayList([]); this.setCurrentMusic(null); await this.reset(); PersistStatus.set('music.musicItem', undefined); PersistStatus.set('music.progress', 0); }
    async skipToNext() { if (this.isPlayListEmpty()) { this.setCurrentMusic(null); return; } await this.play(this.getPlayListMusicAt(this.currentIndex + 1), true); }
    async skipToPrevious() { if (this.isPlayListEmpty()) { this.setCurrentMusic(null); return; } await this.play(this.getPlayListMusicAt(this.currentIndex === -1 ? 0 : this.currentIndex - 1), true); }
    async playWithReplacePlayList(musicItem: IMusic.IMusicItem, newPlayList: IMusic.IMusicItem[]) { if (newPlayList.length === 0) return; const now = Date.now(); if (newPlayList.length > TrackPlayer.maxMusicQueueLength) newPlayList = this.shrinkPlayListToSize(newPlayList, newPlayList.findIndex(it => isSameMediaItem(it, musicItem))); newPlayList.forEach((it, i) => { it[timeStampSymbol] = now; it[sortIndexSymbol] = i; }); this.setPlayList(this.repeatMode === MusicRepeatMode.SHUFFLE ? shuffle(newPlayList) : newPlayList); await this.play(musicItem, true); }
    private setCurrentMusic(musicItem?: IMusic.IMusicItem | null) { if (!musicItem) { this.currentIndex = -1; this._store.set(currentMusicAtom, null); PersistStatus.set('music.musicItem', undefined); PersistStatus.set('music.progress', 0); this.emit(TrackPlayerEvents.CurrentMusicChanged, null); return; } if (typeof musicItem.artwork !== 'string') musicItem.artwork = ImgAsset.albumDefault; this.currentIndex = this.getMusicIndexInPlayList(musicItem); this._store.set(currentMusicAtom, musicItem); this.emit(TrackPlayerEvents.CurrentMusicChanged, musicItem); }
    private setRepeatMode(mode: MusicRepeatMode) { const playList = this.playList; let newPlayList: IMusic.IMusicItem[]; const prevMode = this._store.get(repeatModeAtom); if ((prevMode === MusicRepeatMode.SHUFFLE && mode !== MusicRepeatMode.SHUFFLE) || (mode === MusicRepeatMode.SHUFFLE && prevMode !== MusicRepeatMode.SHUFFLE)) { if (mode === MusicRepeatMode.SHUFFLE) newPlayList = shuffle(playList); else newPlayList = this.sortByTimestampAndIndex(playList, true); this.setPlayList(newPlayList); } this._store.set(repeatModeAtom, mode); ReactNativeTrackPlayer.updateMetadataForTrack(1, this.getFakeNextTrack()); PersistStatus.set('music.repeatMode', mode); }
    private setQuality(quality: IMusic.IQualityKey) { this._store.set(qualityAtom, quality); PersistStatus.set('music.quality', quality); }
    private async setTrackSource(track: Track, autoPlay = true) { const clonedTrack = this.patchMediaArtwork(track); if (!clonedTrack) return; track.userAgent = getAppUserAgent(); await ReactNativeTrackPlayer.setQueue([clonedTrack, this.getFakeNextTrack()]); PersistStatus.set('music.musicItem', track as IMusic.IMusicItem); PersistStatus.set('music.progress', 0); if (autoPlay) await ReactNativeTrackPlayer.play(); }
    private setPlayList(newPlayList: IMusic.IMusicItem[], persist = true) { this._store.set(playListAtom, newPlayList); this.playListIndexMap = createMediaIndexMap(newPlayList); if (persist) PersistStatus.set('music.playList', newPlayList); this.currentIndex = this.getMusicIndexInPlayList(this.currentMusic); }
    private shrinkPlayListToSize = (q: IMusic.IMusicItem[], i = this.currentIndex) => { if (q.length > TrackPlayer.maxMusicQueueLength) { if (i < TrackPlayer.halfMaxMusicQueueLength) q = q.slice(0, TrackPlayer.maxMusicQueueLength); else { const r = Math.min(q.length, i + TrackPlayer.halfMaxMusicQueueLength); const l = Math.max(0, r - TrackPlayer.maxMusicQueueLength); q = q.slice(l, r); } } return q; }
    private mergeTrackSource(mediaItem: ICommon.IMediaBase, props: Record<string, any> | undefined) { const merged = props ? { ...mediaItem, ...props, id: mediaItem.id, platform: mediaItem.platform } : mediaItem; merged.userAgent = getAppUserAgent(); return merged; }
    private sortByTimestampAndIndex(a: any[], n = false) { if (n) a = [...a]; return a.sort((x, y) => { const ts = x[timeStampSymbol] - y[timeStampSymbol]; if (ts !== 0) return ts; return x[sortIndexSymbol] - y[sortIndexSymbol]; }); }
    private getFakeNextTrack() { let track: Track | undefined; const r = this.repeatMode; if (r === MusicRepeatMode.SINGLE) track = this.getPlayListMusicAt(this.currentIndex) as Track; else track = this.getPlayListMusicAt(this.currentIndex + 1) as Track; const ua = getAppUserAgent(); if (track) return produce(track, _ => { _.url = TrackPlayer.fakeAudioUrl; _.$ = internalFakeSoundKey; _.userAgent = ua; _.artwork = resolveImportedAssetOrPath(ImgAsset.albumDefault) as unknown as any; }); return { url: TrackPlayer.fakeAudioUrl, $: internalFakeSoundKey } as Track; }
    private async handlePlayFail() { if (!this.configService.getConfig('basic.autoStopWhenError')) { await delay(500); await this.skipToNext(); } }
    private patchMediaArtwork(track: Track) { if (!track) return null; return { ...track, artwork: resolveImportedAssetOrPath(track.artwork?.trim?.()?.length ? track.artwork : ImgAsset.albumDefault) as unknown as any }; }
    private async getSimilarMusic<T extends ICommon.SupportMediaType>(musicItem: IMusic.IMusicItem, type: T = 'music' as T, abort?: () => boolean): Promise<ICommon.SupportMediaItemBase[T] | null> { const keyword = musicItem.alias || musicItem.title; const plugins = this.pluginManagerService.getSearchablePlugins(type); let dist = Infinity; let bestMatch: any = null; const start = Date.now(); for (const p of plugins) { if (abort?.() || Date.now() - start > 8000) break; if (p.name === musicItem.platform) continue; const res = await p.methods.search(keyword, 1, type).catch(() => null); const topTwo = res?.data?.slice(0, 2) || []; for (const item of topTwo) { if (item.title === keyword && item.artist === musicItem.artist) { return item as any; } const d = minDistance(keyword, item.title) + minDistance(item.artist, musicItem.artist); if (d < dist) { dist = d; bestMatch = item; } } } return bestMatch; }
}

export const usePlayList = () => useAtomValue(playListAtom);
export const useCurrentMusic = () => useAtomValue(currentMusicAtom);
export const useRepeatMode = () => useAtomValue(repeatModeAtom);
export const useMusicQuality = () => useAtomValue(qualityAtom);
export function useMusicState() { const s = usePlaybackState(); return s.state; }
export { State as MusicState, useProgress };

enum PlayFailReason {
    FORBID_CELLUAR_NETWORK_PLAY = 'FORBID_CELLUAR_NETWORK_PLAY',
    PLAY_LIST_IS_EMPTY = 'PLAY_LIST_IS_EMPTY',
    INVALID_SOURCE = 'INVALID_SOURCE',
}

const trackPlayer = new TrackPlayer();
export default trackPlayer;