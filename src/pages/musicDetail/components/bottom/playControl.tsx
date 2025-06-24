import repeatModeConst from '@/constants/repeatModeConst';
import rpx from '@/utils/rpx';
import React from 'react';
import { InteractionManager, StyleSheet, View } from 'react-native';

import Icon from '@/components/base/icon.tsx';
import { showPanel } from '@/components/panels/usePanel';
import TrackPlayer, { useRepeatMode } from '@/core/trackPlayer';
import { useUnifiedPlaybackState } from '@/core/trackPlayer/useUnifiedPlaybackState';
import useOrientation from '@/hooks/useOrientation';
import delay from '@/utils/delay';
import { musicIsPaused } from '@/utils/trackUtils';

export default function () {
    const repeatMode = useRepeatMode();
    const { state } = useUnifiedPlaybackState();

    const orientation = useOrientation();

    console.log(repeatMode, repeatModeConst[repeatMode]);

    return (
        <>
            <View
                style={[
                    style.wrapper,
                    orientation === 'horizontal'
                        ? {
                              marginTop: 0,
                          }
                        : null,
                ]}>
                <Icon
                    color={'white'}
                    name={repeatModeConst[repeatMode].icon}
                    size={rpx(56)}
                    onPress={async () => {
                        InteractionManager.runAfterInteractions(async () => {
                            await delay(20, false);
                            TrackPlayer.toggleRepeatMode();
                        });
                    }}
                />
                <Icon
                    color={'white'}
                    name={'skip-left'}
                    size={rpx(56)}
                    onPress={() => {
                        TrackPlayer.skipToPrevious();
                    }}
                />
                <Icon
                    color={'white'}
                    name={musicIsPaused(state) ? 'play' : 'pause'}
                    size={rpx(96)}
                    onPress={() => {
                        if (musicIsPaused(state)) {
                            TrackPlayer.play();
                        } else {
                            TrackPlayer.pause();
                        }
                    }}
                />
                <Icon
                    color={'white'}
                    name={'skip-right'}
                    size={rpx(56)}
                    onPress={() => {
                        TrackPlayer.skipToNext();
                    }}
                />
                <Icon
                    color={'white'}
                    name={'playlist'}
                    size={rpx(56)}
                    onPress={() => {
                        showPanel('PlayList');
                    }}
                />
            </View>
        </>
    );
}

const style = StyleSheet.create({
    wrapper: {
        width: '100%',
        marginTop: rpx(36),
        height: rpx(100),
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
    },
});
