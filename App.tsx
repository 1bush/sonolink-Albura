// App.tsx — pika hyrëse e aplikacionit.
import React, { useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, Modal, SafeAreaView } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { theme } from './src/theme';
import BottomTabBar from './src/components/BottomTabBar';
import HomeScreen from './src/screens/HomeScreen';
import AlbumScreen from './src/screens/AlbumScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import PairingScreen from './src/screens/PairingScreen';
import OpticalScreen from './src/screens/OpticalScreen';
// ADDITIVE SonoLink+Drita: ekran i ri optik (file i ri, nuk prek ekranet ekzistuese).
import DritaExtrasScreen from './src/screens/DritaExtrasScreen';
import { initDatabase } from './src/services/database';
import { ensureRootDir } from './src/services/fileStorage';
import type { TabKey, LastScanSummary, ConnStatus } from './src/types';

export default function App() {
  const [ready, setReady] = useState(false);
  // DECIMEN (transferimi optik) hapet i pari — protocol aktiv parazgjedhur.
  const [activeTab, setActiveTab] = useState<TabKey>('optical');
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [lastScan, setLastScan] = useState<LastScanSummary | null>(null);
  const [connStatus, setConnStatus] = useState<ConnStatus>('disconnected');
  const [userName] = useState('Dr. Rovena Stroni');

  useEffect(() => {
    (async () => {
      await initDatabase();
      await ensureRootDir();
      setReady(true);
    })();
  }, []);

  const handleFileReceived = useCallback((studyId: string, fileCount: number) => {
    setConnStatus('connected');
    setLastScan({
      patientId: studyId,
      fileCount,
      when: new Date().toLocaleString('sq-AL'),
    });
  }, []);

  if (!ready) {
    return <View style={styles.root} />;
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />

      <View style={styles.content}>
        {activeTab === 'home' && (
          <HomeScreen
            lastScan={lastScan}
            connStatus={connStatus}
            onScanPress={() => setActiveTab('scan')}
          />
        )}
        {activeTab === 'scan' && (
          <PairingScreen
            onFileReceived={handleFileReceived}
            onClose={() => setActiveTab('home')}
          />
        )}
        {activeTab === 'album' && <AlbumScreen />}
        {activeTab === 'settings' && <SettingsScreen userName={userName} appVersion="3.0.0" />}
        {activeTab === 'optical' && <OpticalScreen onOpenP50Scan={() => setActiveTab('scan')} />}
        {/* ADDITIVE SonoLink+Drita: tab i ri optik nativ. */}
        {activeTab === 'drita' && <DritaExtrasScreen />}
      </View>

      <BottomTabBar active={activeTab} onChange={setActiveTab} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
  },
});
