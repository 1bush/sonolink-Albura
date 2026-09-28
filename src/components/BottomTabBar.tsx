import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../theme';
import type { TabKey } from '../types';

interface Props {
  active: TabKey;
  onChange: (tab: TabKey) => void;
}

// Renditja: DECIMEN (transferimi optik) është protocol-i i PARË dhe parazgjedhur,
// pastaj protocollet e tjera me radhë (Home, Scan/QR, Album, Settings).
const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'optical', label: 'DECIMEN', icon: 'flash-outline' },
  { key: 'home', label: 'Home', icon: 'home-outline' },
  { key: 'scan', label: 'Scan', icon: 'qr-code-outline' },
  { key: 'album', label: 'ALBUM', icon: 'images-outline' },
  // ADDITIVE SonoLink+Drita: tab i ri optik (nuk prek tab-et ekzistuese).
  { key: 'drita', label: 'DRITA', icon: 'sunny-outline' },
  { key: 'settings', label: 'SETTINGS', icon: 'settings-outline' },
];

export default function BottomTabBar({ active, onChange }: Props) {
  return (
    <View style={styles.root}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <TouchableOpacity
            key={tab.key}
            style={[styles.item, isActive && styles.itemActive]}
            onPress={() => onChange(tab.key)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={tab.icon}
              size={20}
              color={isActive ? theme.colors.primaryLight : theme.colors.textMuted}
            />
            <Text style={[styles.label, isActive && styles.labelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: theme.colors.backgroundCard,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  item: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: theme.radius.sm,
  },
  itemActive: {
    backgroundColor: 'rgba(47,184,169,0.12)',
  },
  label: {
    fontSize: 11,
    color: theme.colors.textMuted,
  },
  labelActive: {
    color: theme.colors.primaryLight,
  },
});
