// App.tsx — mode shell. The app opens in Student mode (a WebView onto the
// server's live map) because that's who the app is for. "I run this cafe"
// in settings flips to the Cafe Console; the camera and TFLite model are
// never mounted in Student mode.
import './global.css';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import CafeConsole from './src/CafeConsole';
import { VIEWER_URL } from './src/config';

type Mode = 'student' | 'cafe';
const MODE_KEY = '@tambay/mode';

function StudentMode(): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  return (
    <View className="flex-1 bg-slate-950">
      {failed ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center text-base text-slate-300">
            Could not reach the map server.
          </Text>
          <Text className="mt-2 text-center text-xs text-slate-500">{VIEWER_URL}</Text>
          <Pressable
            onPress={() => setFailed(false)}
            className="mt-4 rounded-full bg-emerald-500 px-6 py-2"
          >
            <Text className="font-semibold text-slate-950">Retry</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          source={{ uri: VIEWER_URL }}
          style={{ flex: 1, backgroundColor: '#020617' }}
          startInLoadingState
          renderLoading={() => (
            <View style={StyleSheet.absoluteFill} className="items-center justify-center">
              <ActivityIndicator color="#10B981" />
            </View>
          )}
          onError={() => setFailed(true)}
        />
      )}
    </View>
  );
}

function Shell(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(MODE_KEY).then((m) => setMode(m === 'cafe' ? 'cafe' : 'student'));
  }, []);
  const setModePersist = (m: Mode) => {
    setMode(m);
    void AsyncStorage.setItem(MODE_KEY, m);
  };

  if (mode == null) {
    return <View className="flex-1 bg-slate-950" />;
  }

  return (
    <View className="flex-1 bg-slate-950">
      {mode === 'student' ? <StudentMode /> : <CafeConsole />}

      {/* floating settings gear */}
      <Pressable
        onPress={() => setSettingsOpen(true)}
        style={[styles.gear, { top: insets.top + 8 }]}
        accessibilityLabel="Settings"
      >
        <Text className="text-base">⚙️</Text>
      </Pressable>

      <Modal
        visible={settingsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <View className="flex-1 items-center justify-center bg-black/60 px-8">
          <View className="w-full max-w-sm rounded-3xl bg-slate-900 p-5">
            <Text className="text-lg font-bold text-slate-100">Tambay-AI</Text>
            <Text className="mt-1 text-xs text-slate-400">
              Student mode shows the live seat map. Cafe mode turns this phone into the sensor.
            </Text>
            <Pressable
              onPress={() => {
                setModePersist(mode === 'student' ? 'cafe' : 'student');
                setSettingsOpen(false);
              }}
              className="mt-4 flex-row items-center justify-between rounded-2xl bg-slate-800 px-4 py-3"
            >
              <Text className="text-sm font-semibold text-slate-200">I run this cafe</Text>
              <Text className="text-sm font-bold" style={{ color: mode === 'cafe' ? '#10B981' : '#64748b' }}>
                {mode === 'cafe' ? 'ON' : 'OFF'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setSettingsOpen(false)}
              className="mt-3 items-center rounded-2xl bg-slate-800 py-3"
            >
              <Text className="text-sm font-semibold text-slate-300">Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  gear: {
    position: 'absolute',
    right: 12,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(2, 6, 23, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
