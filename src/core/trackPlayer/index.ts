import { getCurrentDialog, showDialog } from '@/components/dialogs/useDialog';
import {
    internalFakeSoundKey,
    localPluginPlatform,
    sortIndexSymbol,
    timeStampSymbol,
} from '@/constants/commonConst';
import { MusicRepeatMode } from '@/constants/repeatModeConst';
import delay from '@/utils/delay';
import getUrlExt from '@/utils/getUrlExt';
import { errorLog, trace } from '@/utils/log';
import { createMediaIndexMap } from '@/utils/mediaIndexMap';
import {
    getLocalPath,
    isSameMediaItem,
} from '@/utils/mediaUtils';
import Network from '@/utils/network';
import PersistStatus from '@/utils/persistStatus';
import { getQualityOrder } from '@/utils/qualities';
import { musicIsPaused } from '@/utils/trackUtils';
import EventEmitter from 'eventemitter3';
import { produce } from 'immer';
import { atom, getDefaultStore, useAtomValue } from 'jotai';
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

import { TrackPlayerEvents } from '@/core.defination/trackPlayer';
import type { IAppConfig } from '@/types/core/config';
import type { IMusicHistory } from '@/types/core/musicHistory';
import { ITrackPlayer } from '@/types/core/trackPlayer/index';
import minDistance from '@/utils/minDistance';
import { IPluginManager } from '@/types/core/pluginManager';
import { getAppUserAgent } from '@/utils/userAgentHelper'; // <--- 新增UA统一导入
import { ImgAsset } from '@/constants/assetsConst';
import { nativeMpvPlayer, MpvPlayerEvent } from './NativeMpvPlayer';
import { addFileScheme, exists, resolveImportedAssetOrPath } from '@/utils/fileUtils';



const currentMusicAtom = atom<IMusic.IMusicItem | null>(null);
const repeatModeAtom = atom<MusicRepeatMode>(MusicRepeatMode.QUEUE);
const qualityAtom = atom<IMusic.IQualityKey>('standard');
const playListAtom = atom<IMusic.IMusicItem[]>([]);


class TrackPlayerService extends EventEmitter<{
    [TrackPlayerEvents.PlayEnd]: () => void;
    [TrackPlayerEvents.CurrentMusicChanged]: (musicItem: IMusic.IMusicItem | null) => void;
    [TrackPlayerEvents.ProgressChanged]: (progress: {
        position: number;
        duration: number;
    }) => void;
}> implements ITrackPlayer {
    // 依赖
    private configService!: IAppConfig;
    private musicHistoryService!: IMusicHistory;
    private pluginManagerService!: IPluginManager;

    // --- 新增成员 ---
    public get activePlayerType(): 'rntp' | 'mpv' {
        return this._activePlayerType;
    }
    private _activePlayerType: 'rntp' | 'mpv' = 'rntp';
    private _isMpvInitialized: boolean = false;
    private _isRntpSetup: boolean = false;
    // 1-second silent WAV file as a base64 data URI
    private SILENT_TRACK_URL = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

    // 当前播放的音乐下标
    private currentIndex = -1;
    // 音乐播放器服务是否启动
    private serviceInited = false;
    // 播放队列索引map
    private playListIndexMap = createMediaIndexMap([] as IMusic.IMusicItem[]);


    private static maxMusicQueueLength = 10000;
    private static halfMaxMusicQueueLength = 5000;
    public static toggleRepeatMapping = {
        [MusicRepeatMode.SHUFFLE]: MusicRepeatMode.SINGLE,
        [MusicRepeatMode.SINGLE]: MusicRepeatMode.QUEUE,
        [MusicRepeatMode.QUEUE]: MusicRepeatMode.SHUFFLE,
    };
    public static fakeAudioUrl = "musicfree://fake-audio";
    public static proposedAudioUrl = "musicfree://proposed-audio";

    constructor() {
        super();
    }

    public get previousMusic() {
        const currentMusic = this.currentMusic;
        if (!currentMusic) {
            return null;
        }

        return this.getPlayListMusicAt(this.currentIndex - 1);
    }

    public get currentMusic() {
        return getDefaultStore().get(currentMusicAtom);
    }

    public get nextMusic() {
        const currentMusic = this.currentMusic;
        if (!currentMusic) {
            return null;
        }

        return this.getPlayListMusicAt(this.currentIndex + 1);
    }

    public get repeatMode() {
        return getDefaultStore().get(repeatModeAtom);
    }

    public get quality() {
        return getDefaultStore().get(qualityAtom);
    }

    public get playList() {
        return getDefaultStore().get(playListAtom);
    }


    injectDependencies(configService: IAppConfig, musicHistoryService: IMusicHistory, pluginManager: IPluginManager): void {
        this.configService = configService;
        this.musicHistoryService = musicHistoryService;
        this.pluginManagerService = pluginManager;
    }


    async setupTrackPlayer() {
        if (this.serviceInited) {
            return;
        }

        await this._initializeActivePlayer();

        const rate = PersistStatus.get('music.rate');
        const musicQueue = PersistStatus.get('music.playList');
        const repeatMode = PersistStatus.get('music.repeatMode');
        const progress = PersistStatus.get('music.progress');
        let track = PersistStatus.get('music.musicItem');
        const quality =
            PersistStatus.get('music.quality') ||
            this.configService.getConfig('basic.defaultPlayQuality') ||
            'standard';

        // 状态恢复
        if (rate) {
            this.setRate(+rate / 100);
        }
        if (repeatMode) {
            getDefaultStore().set(repeatModeAtom, repeatMode as MusicRepeatMode);
        }

        if (musicQueue && Array.isArray(musicQueue)) {
            this.addAll(
                musicQueue,
                undefined,
                repeatMode === MusicRepeatMode.SHUFFLE,
            );
        }

        if (track && this.isInPlayList(track)) {
            if (!this.configService.getConfig('basic.autoPlayWhenAppStart')) {
                track.isInit = true;
            }
            track.userAgent = getAppUserAgent();

            // 异步更新音源
            this.pluginManagerService.getByMedia(track)
                ?.methods.getMediaSource(track, quality)
                .then(async newSource => {
                    track.url = newSource?.url || track.url;
                    track.headers = newSource?.headers || track.headers;
                    track.userAgent = getAppUserAgent();

                    if (isSameMediaItem(this.currentMusic, track) && this._activePlayerType === 'rntp') {
                        await this.setTrackSource(track as Track, false);
                    }
                });
            this.setCurrentMusic(track);

            if (progress) {
                this.seekTo(progress);
            }
        }

        this.subscribeToEvents();
        this.serviceInited = true;
    }

    private async _initializeActivePlayer(useMpv?: boolean) {
        const useMpvPlayer = useMpv ?? this.configService.getConfig('player.useMpvPlayer');

        // RNTP 必须始终设置，以保证媒体通知和系统控件始终可用
        if (!this._isRntpSetup) {
            try {
                await ReactNativeTrackPlayer.setupPlayer();
                this._isRntpSetup = true;
            } catch (e) {
                errorLog('RNTP setup failed', e);
                // 即使RNTP失败，如果用户想用MPV，我们还是可以继续尝试
            }
        }

        if (useMpvPlayer) {
            try {
                const mpvOptions = {
                    ao: 'audiotrack',
                    vo: 'null',
                    cache: true,
                    'demuxer-max-bytes': 200, // in MB
                    'demuxer-readahead-secs': 10,
                    'network-timeout': 20,
                    'msg-level': 'all=v', // For debugging
                    hwdec: 'auto',
                    userAgent: getAppUserAgent(),
                };
                await nativeMpvPlayer.initialize(mpvOptions);
                this._isMpvInitialized = true;
                this._activePlayerType = 'mpv';
                trace('MPV player initialized successfully.');
                
                // 初始化MPV成功后，立即用静音轨道控制RNTP
                const shadowTrack = { url: this.SILENT_TRACK_URL, title: 'MPV Active', artist: ' ' };
                await ReactNativeTrackPlayer.reset();
                await ReactNativeTrackPlayer.add(shadowTrack);

            } catch (e) {
                errorLog('MPV player initialization failed.', e);
                showDialog('SimpleDialog', {
                    title: 'MPV播放器错误',
                    content: 'MPV播放器初始化失败，将回退到默认播放器。',
                });
                // 初始化失败，自动回退并保存配置
                nativeMpvPlayer.destroy();
                this.configService.setConfig('player.useMpvPlayer', false);
                this._activePlayerType = 'rntp';
            }
        } else {
            this._activePlayerType = 'rntp';
        }
    }

    public async handlePlayerConfigChange(useMpv: boolean) {
        if ((useMpv && this._activePlayerType === 'mpv') || (!useMpv && this._activePlayerType === 'rntp')) {
            return;
        }

        await this.stop();
        await this.reset();

        if (useMpv) {
            if (!this._isMpvInitialized) {
                await this._initializeActivePlayer(true);
            } else {
                this._activePlayerType = 'mpv';
                // 如果已经初始化，同样要确保RNTP处于受控状态
                const shadowTrack = { url: this.SILENT_TRACK_URL, title: 'MPV Active', artist: ' ' };
                await ReactNativeTrackPlayer.reset();
                await ReactNativeTrackPlayer.add(shadowTrack);
            }
        } else {
            // 切换到 RNTP
            this._activePlayerType = 'rntp';
            // MPV实例可以销毁以释放资源
            await nativeMpvPlayer.stop();
        }

        // 清空当前状态以备重新加载
        this.setCurrentMusic(null);
    }

    /**************** 播放队列 ******************/
    getMusicIndexInPlayList(musicItem?: IMusic.IMusicItem | null) {
        if (!musicItem) {
            return -1;
        }
        return this.playListIndexMap.getIndex(musicItem);
    }

    isInPlayList(musicItem?: IMusic.IMusicItem | null) {
        if (!musicItem) {
            return false;
        }

        return this.playListIndexMap.has(musicItem);
    }

    getPlayListMusicAt(index: number): IMusic.IMusicItem | null {
        const playList = this.playList;
        const len = playList.length;
        if (len === 0) {
            return null;
        }
        return playList[(index % len + len) % len]; // <--- 修正取模确保正数
    }

    isPlayListEmpty() {
        return this.playList.length === 0;
    }

    /****** 播放逻辑 *****/
    addAll(
        musicItems: Array<IMusic.IMusicItem>,
        beforeIndex?: number,
        shouldShuffle?: boolean,
    ): void {
        const now = Date.now();
        let newPlayList: IMusic.IMusicItem[] = [];
        let currentPlayList = this.playList;
        musicItems.forEach((item, index) => {
            item[timeStampSymbol] = now;
            item[sortIndexSymbol] = index;
        });

        if (beforeIndex === undefined || beforeIndex < 0) {
            // 1.1. 添加到歌单末尾，并过滤掉已有的歌曲
            newPlayList = currentPlayList.concat(
                musicItems.filter(item => !this.isInPlayList(item)),
            );
        } else {
            // 1.2. 新的播放列表，插入
            const indexMap = createMediaIndexMap(musicItems);
            const beforeDraft = currentPlayList
                .slice(0, beforeIndex)
                .filter(item => !indexMap.has(item));
            const afterDraft = currentPlayList
                .slice(beforeIndex)
                .filter(item => !indexMap.has(item));

            newPlayList = [...beforeDraft, ...musicItems, ...afterDraft];
        }

        // 如果太长了
        if (newPlayList.length > TrackPlayerService.maxMusicQueueLength) {
            newPlayList = this.shrinkPlayListToSize(
                newPlayList,
                beforeIndex ?? newPlayList.length - 1,
            );
        }

        // 2. 如果需要随机
        if (shouldShuffle) {
            newPlayList = shuffle(newPlayList);
        }
        // 3. 设置播放列表
        this.setPlayList(newPlayList);
    }

    add(
        musicItem: IMusic.IMusicItem | IMusic.IMusicItem[],
        beforeIndex?: number,
    ): void {
        this.addAll(
            Array.isArray(musicItem) ? musicItem : [musicItem],
            beforeIndex,
        );
    }

    addNext(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]): void {
        const shouldAutoPlay = this.isPlayListEmpty() || !this.currentMusic;

        this.add(musicItem, this.currentIndex + 1);

        if (shouldAutoPlay) {
            this.play(Array.isArray(musicItem) ? musicItem[0] : musicItem);
        }
    }

    async remove(musicItem: IMusic.IMusicItem): Promise<void> {
        const playList = this.playList;

        let newPlayList: IMusic.IMusicItem[] = [];
        let currentMusic: IMusic.IMusicItem | null = this.currentMusic;
        const targetIndex = this.getMusicIndexInPlayList(musicItem);
        let shouldPlayCurrent: boolean | null = null;
        if (targetIndex === -1) {
            // 1. 这种情况应该是出错了
            return;
        }
        // 2. 移除的是当前项
        if (this.currentIndex === targetIndex) {
            // 2.1 停止播放，移除当前项
            newPlayList = produce(playList, draft => {
                draft.splice(targetIndex, 1);
            });
            // 2.2 设置新的播放列表，并更新当前音乐
            if (newPlayList.length === 0) {
                currentMusic = null;
                shouldPlayCurrent = false;
            } else {
                currentMusic = newPlayList[this.currentIndex % newPlayList.length];
                try {
                    const state = (
                        await ReactNativeTrackPlayer.getPlaybackState()
                    ).state;
                    shouldPlayCurrent = !musicIsPaused(state);
                } catch {
                    shouldPlayCurrent = false;
                }
            }
            this.setCurrentMusic(currentMusic);
        } else {
            // 3. 删除
            newPlayList = produce(playList, draft => {
                draft.splice(targetIndex, 1);
            });
            // 如果删除的是当前播放歌曲之前的项，需要调整currentIndex
            if (targetIndex < this.currentIndex) {
                this.currentIndex--;
            }
        }

        this.setPlayList(newPlayList);
        if (shouldPlayCurrent === true) {
            await this.play(currentMusic, true);
        } else if (shouldPlayCurrent === false) {
            await ReactNativeTrackPlayer.reset();
        }
    }

    isCurrentMusic(musicItem?: IMusic.IMusicItem | null) {
        return isSameMediaItem(musicItem, this.currentMusic);
    }

    async play(
        musicItem?: IMusic.IMusicItem | null,
        forcePlay?: boolean,
    ): Promise<void> {
        try {
            // Step 0: 如果不传参，默认是播放当前音乐
            if (!musicItem) {
                musicItem = this.currentMusic;
            }
            if (!musicItem) {
                throw new Error(PlayFailReason.PLAY_LIST_IS_EMPTY);
            }

            // Step 1: 移动网络禁止播放检查
            const localPath = getLocalPath(musicItem);
            if (
                Network.isCellular &&
                !this.configService.getConfig('basic.useCelluarNetworkPlay') &&
                !LocalMusicSheet.isLocalMusic(musicItem) &&
                !localPath
            ) {
                await this.reset();
                throw new Error(PlayFailReason.FORBID_CELLUAR_NETWORK_PLAY);
            }

            // Step 2: 如果是当前正在播放的音频
            if (this.isCurrentMusic(musicItem) && !forcePlay) {
                await this.resume();
                return;
            }

            // Step 3: 如果没有在播放列表中，添加到队尾
            if (!this.isInPlayList(musicItem)) {
                this.add(musicItem);
            }

            // Step 4: 更新列表状态和当前音乐
            this.setCurrentMusic(musicItem);
            await ReactNativeTrackPlayer.setQueue([{
                ...musicItem,
                url: TrackPlayerService.proposedAudioUrl,
                artwork: resolveImportedAssetOrPath(musicItem.artwork?.trim()?.length ? musicItem.artwork : ImgAsset.albumDefault) as unknown as any,
            }, this.getFakeNextTrack()]);

            // Step 5: 获取音源 (这部分逻辑对于两个播放器是通用的)
            const track = await this._getPlayableTrack(musicItem);
            if (!track || !track.url) {
                throw new Error(PlayFailReason.INVALID_SOURCE);
            }

            // Step 6: 根据当前激活的播放器进行播放
            if (this._activePlayerType === 'mpv') {
                // MPV 播放逻辑
                trace('Playing with MPV', track);
                await nativeMpvPlayer.loadAndPlay(track as any);

                // MPV 播放逻辑
                trace('Playing with MPV', track);
                await nativeMpvPlayer.loadAndPlay(track as any);
                
                // --- 修复影子音轨逻辑 ---
                await ReactNativeTrackPlayer.reset();
                const shadowTrack = {
                    ...(track as Track),
                    url: this.SILENT_TRACK_URL, // 必须用一个虚拟/静音URL
                };
                await ReactNativeTrackPlayer.add(shadowTrack);
                await ReactNativeTrackPlayer.play(); // 播放以确保通知出现并响应媒体按钮

            } else {
                // RNTP 播放逻辑
                trace('Playing with RNTP', track);
                await this.setTrackSource(track as Track);
            }

            // Step 7: 新增历史记录
            this.musicHistoryService.addMusic(musicItem);

            // Step 8: 异步获取并设置补充信息
            this.fetchAndSetExtraTrackInfo(track);

        } catch (e: any) {
            this.handlePlayError(e, musicItem, forcePlay);
        }
    }

    async pause(): Promise<void> {
        if (this._activePlayerType === 'mpv') {
            await nativeMpvPlayer.pause();
        } else {
            await ReactNativeTrackPlayer.pause();
        }
    }

    async resume(): Promise<void> {
        if (this._activePlayerType === 'mpv') {
            await nativeMpvPlayer.resume();
        } else {
            await ReactNativeTrackPlayer.play();
        }
    }

    async stop(): Promise<void> {
        if (this._activePlayerType === 'mpv') {
            await nativeMpvPlayer.stop();
        }
        // 总是尝试停止RNTP以防万一
        await ReactNativeTrackPlayer.stop();
    }

    toggleRepeatMode(): void {
        this.setRepeatMode(TrackPlayerService.toggleRepeatMapping[this.repeatMode]);
    }

    // 清空播放队列
    async clearPlayList(): Promise<void> {
        this.setPlayList([]);
        this.setCurrentMusic(null);

        if (this._activePlayerType === 'mpv') {
            await nativeMpvPlayer.stop();
        }
        await ReactNativeTrackPlayer.reset();
        PersistStatus.set('music.musicItem', undefined);
        PersistStatus.set('music.progress', 0);
    }

    async skipToNext(): Promise<void> {
        if (this.isPlayListEmpty()) {
            this.setCurrentMusic(null);
            return;
        }

        await this.play(this.getPlayListMusicAt(this.currentIndex + 1), true);
    }

    async skipToPrevious(): Promise<void> {
        if (this.isPlayListEmpty()) {
            this.setCurrentMusic(null);
            return;
        }

        await this.play(
            this.getPlayListMusicAt(this.currentIndex === -1 ? 0 : this.currentIndex - 1),
            true,
        );
    }

    async changeQuality(newQuality: IMusic.IQualityKey): Promise<boolean> {
        if (newQuality === this.quality) {
            return true;
        }

        const musicItem = this.currentMusic;
        if (!musicItem) {
            return false;
        }

        try {
            const progress = await this.getProgress();
            const newTrack = await this._getPlayableTrack(musicItem, newQuality);

            if (!newTrack || !newTrack.url) {
                throw new Error(PlayFailReason.INVALID_SOURCE);
            }

            if (this.isCurrentMusic(musicItem)) {
                if (this._activePlayerType === 'mpv') {
                    await nativeMpvPlayer.loadAndPlay(newTrack as any);
                    await nativeMpvPlayer.seekTo(progress.position ?? 0);
                } else {
                    const playingState = (await ReactNativeTrackPlayer.getPlaybackState()).state;
                    await this.setTrackSource(newTrack as Track, !musicIsPaused(playingState));
                    await ReactNativeTrackPlayer.seekTo(progress.position ?? 0);
                }
                this.setQuality(newQuality);
                return true;
            }
            return false;
        } catch (e) {
            errorLog('changeQuality failed', e);
            return false;
        }
    }

    async playWithReplacePlayList(
        musicItem: IMusic.IMusicItem,
        newPlayList: IMusic.IMusicItem[],
    ): Promise<void> {
        if (newPlayList.length !== 0) {
            const now = Date.now();
            if (newPlayList.length > TrackPlayerService.maxMusicQueueLength) {
                newPlayList = this.shrinkPlayListToSize(
                    newPlayList,
                    newPlayList.findIndex(it => isSameMediaItem(it, musicItem)),
                );
            }

            newPlayList.forEach((it, index) => {
                it[timeStampSymbol] = now;
                it[sortIndexSymbol] = index;
            });

            this.setPlayList(
                this.repeatMode === MusicRepeatMode.SHUFFLE
                    ? shuffle(newPlayList)
                    : newPlayList,
            );
            await this.play(musicItem, true);
        }
    }

    async getProgress() {
        if (this._activePlayerType === 'mpv') {
            // MPV progress is event-driven, but we can provide a sync getter if needed,
            // though it might not be implemented on the native side.
            // For now, we rely on events. This getter is for RNTP compatibility.
            return { position: 0, duration: 0, buffered: 0 };
        }
        return ReactNativeTrackPlayer.getProgress();
    }

    async getRate() {
        if (this._activePlayerType === 'mpv') {
            // Assuming getRate exists on nativeMpvPlayer
            // return await nativeMpvPlayer.getRate();
            return 1; // Placeholder
        }
        return ReactNativeTrackPlayer.getRate();
    }
    async setRate(rate: number) {
        if (this._activePlayerType === 'mpv') {
            await nativeMpvPlayer.setRate(rate);
        } else {
            await ReactNativeTrackPlayer.setRate(rate);
        }
    }
    async seekTo(position: number) {
        if (this._activePlayerType === 'mpv') {
            await nativeMpvPlayer.seekTo(position);
        } else {
            await ReactNativeTrackPlayer.seekTo(position);
        }
    }
    async reset() {
        if (this._activePlayerType === 'mpv') {
            await nativeMpvPlayer.stop();
        }
        await ReactNativeTrackPlayer.reset();
    }


    /**************** 辅助函数 -- 设置内部状态 ****************/

    private setCurrentMusic(musicItem?: IMusic.IMusicItem | null) {
        // 设置UI内部状态的musicitem
        if (!musicItem) {
            this.currentIndex = -1;
            getDefaultStore().set(currentMusicAtom, null);
            PersistStatus.set('music.musicItem', undefined);
            PersistStatus.set('music.progress', 0);

            this.emit(TrackPlayerEvents.CurrentMusicChanged, null);
            return;
        }
        if (typeof musicItem.artwork !== 'string') {
            musicItem.artwork = ImgAsset.albumDefault;
        }
        this.currentIndex = this.getMusicIndexInPlayList(musicItem);
        getDefaultStore().set(currentMusicAtom, musicItem);

        this.emit(TrackPlayerEvents.CurrentMusicChanged, musicItem);
    }

    private setRepeatMode(mode: MusicRepeatMode) {
        const playList = this.playList;
        let newPlayList: IMusic.IMusicItem[];
        const prevMode = getDefaultStore().get(repeatModeAtom);
        if (
            (prevMode === MusicRepeatMode.SHUFFLE &&
                mode !== MusicRepeatMode.SHUFFLE) ||
            (mode === MusicRepeatMode.SHUFFLE &&
                prevMode !== MusicRepeatMode.SHUFFLE)
        ) {
            if (mode === MusicRepeatMode.SHUFFLE) {
                newPlayList = shuffle(playList);
            } else {
                newPlayList = this.sortByTimestampAndIndex(playList, true);
            }
            this.setPlayList(newPlayList);
        }

        getDefaultStore().set(repeatModeAtom, mode);
        // 更新下一首歌的信息
        ReactNativeTrackPlayer.updateMetadataForTrack(
            1,
            this.getFakeNextTrack(),
        );
        // 记录
        PersistStatus.set('music.repeatMode', mode);
    }

    private setQuality(quality: IMusic.IQualityKey) {
        getDefaultStore().set(qualityAtom, quality);
        PersistStatus.set('music.quality', quality);
    }

    // 设置音源
    private async setTrackSource(track: Track, autoPlay = true) {
        const clonedTrack = this.patchMediaArtwork(track);
        if (!clonedTrack) {
            return;
        }
        track.userAgent = getAppUserAgent(); // <--- 确保设置UA
        await ReactNativeTrackPlayer.setQueue([clonedTrack, this.getFakeNextTrack()]);
        PersistStatus.set('music.musicItem', track as IMusic.IMusicItem);
        PersistStatus.set('music.progress', 0);
        if (autoPlay) {
            await ReactNativeTrackPlayer.play();
        }
    }

    /**
     * 设置播放队列
     * @param newPlayList 播放队列
     * @param persist 是否持久化
     */
    private setPlayList(newPlayList: IMusic.IMusicItem[], persist = true) {
        getDefaultStore().set(playListAtom, newPlayList);

        this.playListIndexMap = createMediaIndexMap(newPlayList);

        if (persist) {
            PersistStatus.set('music.playList', newPlayList);
        }

        this.currentIndex = this.getMusicIndexInPlayList(this.currentMusic);
    }


    /**************** 辅助函数 -- 工具方法 ****************/
    private shrinkPlayListToSize = (
        queue: IMusic.IMusicItem[],
        targetIndex = this.currentIndex,
    ) => {
        // 播放列表上限，太多无法缓存状态
        if (queue.length > TrackPlayerService.maxMusicQueueLength) {
            if (targetIndex < TrackPlayerService.halfMaxMusicQueueLength) {
                queue = queue.slice(0, TrackPlayerService.maxMusicQueueLength);
            } else {
                const right = Math.min(
                    queue.length,
                    targetIndex + TrackPlayerService.halfMaxMusicQueueLength,
                );
                const left = Math.max(0, right - TrackPlayerService.maxMusicQueueLength);
                queue = queue.slice(left, right);
            }
        }
        return queue;
    }

    private mergeTrackSource(
        mediaItem: ICommon.IMediaBase,
        props: Record<string, any> | undefined,
    ) {
        const merged = props
            ? {
                ...mediaItem,
                ...props,
                id: mediaItem.id,
                platform: mediaItem.platform,
            }
            : mediaItem;
        merged.userAgent = getAppUserAgent(); // <--- 确保UA
        return merged;
    }

    private sortByTimestampAndIndex(array: any[], newArray = false) {
        if (newArray) {
            array = [...array];
        }
        return array.sort((a, b) => {
            const ts = a[timeStampSymbol] - b[timeStampSymbol];
            if (ts !== 0) {
                return ts;
            }
            return a[sortIndexSymbol] - b[sortIndexSymbol];
        });
    }

    private getFakeNextTrack() {
        let track: Track | undefined;
        const repeatMode = this.repeatMode;
        if (repeatMode === MusicRepeatMode.SINGLE) {
            // 单曲循环
            track = this.getPlayListMusicAt(this.currentIndex) as Track;
        } else {
            // 下一曲
            track = this.getPlayListMusicAt(this.currentIndex + 1) as Track;
        }

        const appUA = getAppUserAgent();

        if (track) {
            return produce(track, _ => {
                _.url = TrackPlayerService.fakeAudioUrl;
                _.$ = internalFakeSoundKey;
                _.userAgent = appUA;
                _.artwork = resolveImportedAssetOrPath(ImgAsset.albumDefault) as unknown as any;
            });
        } else {
            // 只有列表长度为0时才会出现的特殊情况
            return {
                url: TrackPlayerService.fakeAudioUrl,
                $: internalFakeSoundKey,
            } as Track;
        }
    }


    private async handlePlayFail() {
        // 如果自动跳转下一曲, 500s后自动跳转
        if (!this.configService.getConfig('basic.autoStopWhenError')) {
            await delay(500);
            await this.skipToNext();
        }
    }

    /**
 *
 * @param musicItem 音乐类型
 * @param type 媒体类型
 * @param abortFunction 如果函数为true，则中断
 * @returns
 */
    private async getSimilarMusic<T extends ICommon.SupportMediaType>(
        musicItem: IMusic.IMusicItem,
        type: T = 'music' as T,
        abortFunction?: () => boolean,
    ): Promise<ICommon.SupportMediaItemBase[T] | null> {
        const keyword = musicItem.alias || musicItem.title;
        const plugins = this.pluginManagerService.getSearchablePlugins(type);

        let distance = Infinity;
        let minDistanceMusicItem;
        let targetPlugin;

        const startTime = Date.now();

        for (let plugin of plugins) {
            // 超时时间：8s
            if (abortFunction?.() || Date.now() - startTime > 8000) {
                break;
            }
            if (plugin.name === musicItem.platform) {
                continue;
            }
            const results = await plugin.methods
                .search(keyword, 1, type)
                .catch(() => null);

            // 取前两个
            const firstTwo = results?.data?.slice(0, 2) || [];

            for (let item of firstTwo) {
                if (item.title === keyword && item.artist === musicItem.artist) {
                    distance = 0;
                    minDistanceMusicItem = item;
                    targetPlugin = plugin;
                    break;
                } else {
                    const dist =
                        minDistance(keyword, musicItem.title) +
                        minDistance(item.artist, musicItem.artist);
                    if (dist < distance) {
                        distance = dist;
                        minDistanceMusicItem = item;
                        targetPlugin = plugin;
                    }
                }
            }
            if (distance === 0) {
                break;
            }
        }
        if (minDistanceMusicItem && targetPlugin) {
            return minDistanceMusicItem as ICommon.SupportMediaItemBase[T];
        }

        return null;
    }

    private async _getPlayableTrack(musicItem: IMusic.IMusicItem, qualityOverride?: IMusic.IQualityKey): Promise<IMusic.IMusicItem | null> {
        const plugin = this.pluginManagerService.getByName(musicItem.platform);
        const qualityOrder = getQualityOrder(
            qualityOverride ?? this.configService.getConfig('basic.defaultPlayQuality') ?? 'standard',
            this.configService.getConfig('basic.playQualityOrder') ?? 'asc',
        );

        let source: IPlugin.IMediaSourceResult | null = null;
        for (let quality of qualityOrder) {
            if (this.isCurrentMusic(musicItem)) {
                source =
                    (await plugin?.methods?.getMediaSource(
                        musicItem,
                        quality,
                    )) ?? null;
                if (source) {
                    this.setQuality(quality);
                    break;
                }
            } else {
                return null;
            }
        }

        // 优先处理本地文件 for MPV
        if (musicItem.platform === localPluginPlatform && this._activePlayerType === 'mpv') {
            const localPath = getLocalPath(musicItem);
            if (localPath && (await exists(localPath))) {
                const isDSF = localPath.toLowerCase().endsWith('.dsf') || localPath.toLowerCase().endsWith('.dff');
                if (isDSF || !source) {
                    return {
                        ...musicItem,
                        url: addFileScheme(localPath),
                        duration: musicItem.duration || 0,
                        artwork: musicItem.artwork || ImgAsset.albumDefault,
                        userAgent: getAppUserAgent(),
                    };
                }
            }
        }

        if (!this.isCurrentMusic(musicItem)) {
            return null;
        }

        if (!source) {
            if (musicItem.source) {
                for (let quality of qualityOrder) {
                    if (musicItem.source[quality]?.url) {
                        source = musicItem.source[quality]!;
                        this.setQuality(quality);
                        break;
                    }
                }
            }
            if (!source && !musicItem.url) {
                if (this.configService.getConfig('basic.tryChangeSourceWhenPlayFail')) {
                    const similarMusic = await this.getSimilarMusic(
                        musicItem,
                        'music',
                        () => !this.isCurrentMusic(musicItem),
                    );

                    if (similarMusic) {
                        const similarMusicPlugin =
                            this.pluginManagerService.getByMedia(similarMusic);

                        for (let quality of qualityOrder) {
                            if (this.isCurrentMusic(musicItem)) {
                                source =
                                    (await similarMusicPlugin?.methods?.getMediaSource(
                                        similarMusic,
                                        quality,
                                    )) ?? null;
                                if (source) {
                                    this.setQuality(quality);
                                    break;
                                }
                            } else {
                                return null;
                            }
                        }
                    }
                }
            } else if (!source) { // musicItem.url exists
                source = { url: musicItem.url };
                this.setQuality('standard');
            }
        }

        if (!source) {
            return null;
        }

        if (getUrlExt(source.url) === '.m3u8') {
            // @ts-ignore
            source.type = 'hls';
        }
        const track = this.mergeTrackSource(musicItem, source) as IMusic.IMusicItem;
        track.userAgent = getAppUserAgent();
        return track;
    }

    private async fetchAndSetExtraTrackInfo(track: IMusic.IMusicItem) {
        const plugin = this.pluginManagerService.getByName(track.platform);
        let info: Partial<IMusic.IMusicItem> | null = null;
        try {
            info = (await plugin?.methods?.getMusicInfo?.(track)) ?? null;
            if (
                (typeof info?.url === 'string' && info.url.trim() === '') ||
                (info?.url && typeof info.url !== 'string')
            ) {
                delete info.url;
            }
        } catch (e) {
            errorLog('fetchAndSetExtraTrackInfo failed', e);
        }

        if (info && this.isCurrentMusic(track)) {
            const mergedTrack = this.mergeTrackSource(track, info);
            mergedTrack.userAgent = getAppUserAgent();
            getDefaultStore().set(currentMusicAtom, mergedTrack as IMusic.IMusicItem);
            
            await ReactNativeTrackPlayer.updateMetadataForTrack(
                0,
                mergedTrack as TrackMetadataBase,
            );
        }
    }

    private async handlePlayError(e: any, musicItem?: IMusic.IMusicItem | null, forcePlay?: boolean) {
        const message = e?.message;
        if (
            message ===
            'The player is not initialized. Call setupPlayer first.'
        ) {
            await ReactNativeTrackPlayer.setupPlayer();
            this.play(musicItem, forcePlay);
        } else if (message === PlayFailReason.FORBID_CELLUAR_NETWORK_PLAY) {
            if (getCurrentDialog()?.name !== 'SimpleDialog') {
                showDialog('SimpleDialog', {
                    title: '流量提醒',
                    content:
                        '当前非WIFI环境，侧边栏设置中打开【使用移动网络播放】功能后可继续播放',
                });
            }
        } else if (message === PlayFailReason.INVALID_SOURCE) {
            trace('音源为空，播放失败');
            await this.handlePlayFail();
        } else if (message === PlayFailReason.PLAY_LIST_IS_EMPTY) {
            trace('Play command issued but playlist is empty.');
        } else {
            trace('Unknown playback error', e);
            await this.handlePlayFail();
        }
    }

    public async destroy() {
        await this.stop();
        if (this._isMpvInitialized) {
            // nativeMpvPlayer.destroy(); // 假设有destroy方法
        }
        // ReactNativeTrackPlayer.destroy(); // RNTP的销毁
        this.serviceInited = false;
    }

    private subscribeToEvents() {
        // RNTP Events
        ReactNativeTrackPlayer.addEventListener(
            Event.PlaybackActiveTrackChanged,
            async evt => {
                if (
                    evt.track?.url === this.SILENT_TRACK_URL &&
                    this._activePlayerType === 'rntp'
                ) {
                    trace('影子轨道播放完毕，准备播放下一首');
                    await this.handlePlaybackEnd();
                }
            },
        );

        ReactNativeTrackPlayer.addEventListener(Event.PlaybackError, async e => {
            if (this._activePlayerType !== 'rntp') return;
            errorLog('RNTP Playback Error', e.message);
            const currentTrack = await ReactNativeTrackPlayer.getActiveTrack();
            if (currentTrack?.isInit) {
                ReactNativeTrackPlayer.updateMetadataForTrack(0, {
                    ...currentTrack,
                    // @ts-ignore
                    isInit: undefined,
                    userAgent: getAppUserAgent(),
                });
                return;
            }
            if (
                currentTrack?.url !== TrackPlayerService.fakeAudioUrl &&
                currentTrack?.url !== TrackPlayerService.proposedAudioUrl &&
                (await ReactNativeTrackPlayer.getActiveTrackIndex()) === 0 &&
                e.message &&
                e.message !== 'android-io-file-not-found'
            ) {
                this.handlePlayFail();
            }
        });

        // System Control Events
        ReactNativeTrackPlayer.addEventListener(Event.RemotePlay, () => this.resume());
        ReactNativeTrackPlayer.addEventListener(Event.RemotePause, () => this.pause());
        ReactNativeTrackPlayer.addEventListener(Event.RemoteNext, () => this.skipToNext());
        ReactNativeTrackPlayer.addEventListener(Event.RemotePrevious, () => this.skipToPrevious());
        ReactNativeTrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) => this.seekTo(position));

        // MPV Events
        nativeMpvPlayer.addEventListener(MpvPlayerEvent.Ended, () => {
            trace('MPV track ended');
            this.handlePlaybackEnd();
        });
        nativeMpvPlayer.addEventListener(MpvPlayerEvent.PlayStateChanged, (state) => {
            trace('MPV state changed', state);
            if (state.isPlaying) {
                ReactNativeTrackPlayer.play();
            } else {
                ReactNativeTrackPlayer.pause();
            }
        });
        nativeMpvPlayer.addEventListener(MpvPlayerEvent.Progress, (data) => {
            this.emit(TrackPlayerEvents.ProgressChanged, data);
            // Sync with notification
            const mpvDurationInSeconds = data.duration;
            ReactNativeTrackPlayer.updateMetadataForTrack(0, { duration: mpvDurationInSeconds });
        });
        nativeMpvPlayer.addEventListener(MpvPlayerEvent.Error, (e) => {
            errorLog('MPV Error', e);
            this.handlePlayFail();
        });
    }

    private async handlePlaybackEnd() {
        this.emit(TrackPlayerEvents.PlayEnd);
        if (this.repeatMode === MusicRepeatMode.SINGLE) {
            await this.play(null, true);
        } else {
            await this.skipToNext();
        }
    }

    private patchMediaArtwork(track: Track) {
        // Bug: React native track player 在设置音频时，artwork不能为null，并且部分情况下artwork不能为ImageSource类型
        if (!track) {
            return null;
        }
        return {
            ...track,
            artwork: resolveImportedAssetOrPath(
                track.artwork?.trim()?.length ? track.artwork : ImgAsset.albumDefault,
            ) as unknown as any,
        }
    }

}

export const usePlayList = () => useAtomValue(playListAtom);
export const useCurrentMusic = () => useAtomValue(currentMusicAtom);
export const useRepeatMode = () => useAtomValue(repeatModeAtom);
export const useMusicQuality = () => useAtomValue(qualityAtom);
export function useMusicState() {
    const playbackState = usePlaybackState();

    return playbackState.state;
}
export { State as MusicState, useProgress };

enum PlayFailReason {
    /** 禁止移动网络播放 */
    FORBID_CELLUAR_NETWORK_PLAY = 'FORBID_CELLUAR_NETWORK_PLAY',
    /** 播放列表为空 */
    PLAY_LIST_IS_EMPTY = 'PLAY_LIST_IS_EMPTY',
    /** 无效源 */
    INVALID_SOURCE = 'INVALID_SOURCE',
    /** 非当前音乐 */
}

const trackPlayerService = new TrackPlayerService();
export default trackPlayerService;