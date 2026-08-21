import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { theme } from '../theme';
import type { LastScanSummary, ConnStatus } from '../types';

interface Props {
  lastScan: LastScanSummary | null;
  connStatus: ConnStatus;
  onScanPress: () => void;
}

export default function HomeScreen({ lastScan, onScanPress }: Props) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Image
            source={require('../../assets/sonoscape-logo.png')}
            style={styles.logo}
            resizeMode="contain"
            accessibilityLabel="SonoScape"
          />
          <Text style={styles.clinicName}>ALBURA CLINIC</Text>
          <Text style={styles.welcomeTitle}>Welcome back.</Text>
          <Text style={styles.welcomeSubtitle}>
            Scan the QR from the SonoScape P50 to accept the image.
          </Text>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>0</Text>
            <Text style={styles.statLabel}>TODAY</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>11</Text>
            <Text style={styles.statLabel}>IN TOTAL</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.scanNowCard} onPress={onScanPress} activeOpacity={0.9}>
          <View style={styles.scanIconContainer}>
            <MaterialCommunityIcons name="view-grid-plus-outline" size={28} color={theme.colors.primaryLight} />
          </View>
          <View style={styles.scanInfo}>
            <Text style={styles.scanTitle}>Scan QR now</Text>
            <Text style={styles.scanDescription}>
              Place the QR code from the camera inside the frame.
            </Text>
          </View>
          <Ionicons name="add" size={24} color={theme.colors.textSecondary} />
        </TouchableOpacity>

        <View style={styles.activityHeader}>
          <Text style={styles.sectionTitle}>LAST ACTIVITY</Text>
          <TouchableOpacity>
            <Text style={styles.viewAll}>View all</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.activityList}>
          <ActivityItem title="DCOM-ALBURA" date="10 Jul" tag="no tag" />
          <ActivityItem title="DCOM-ALBURA" date="10 Jul" tag="no tag" />
          <ActivityItem title="DCOM-ALBURA" date="04 Jul" tag="no tag" />
          <ActivityItem title="DCOM-ALBURA" date="04 Jul" tag="no tag" />
        </View>
      </ScrollView>
    </View>
  );
}

function ActivityItem({ title, date, tag }: { title: string; date: string; tag: string }) {
  return (
    <View style={styles.activityItem}>
      <View style={styles.activityIcon}>
        <Ionicons name="image-outline" size={20} color={theme.colors.textSecondary} />
      </View>
      <View style={styles.activityInfo}>
        <Text style={styles.activityTitle}>{title}</Text>
        <Text style={styles.activitySubtitle}>{date} • {tag}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 20, gap: 20 },
  header: { marginTop: 20, marginBottom: 10 },
  logo: { width: 190, height: 58, alignSelf: 'flex-start', marginBottom: 12 },
  clinicName: { color: theme.colors.textSecondary, fontSize: 13, letterSpacing: 1, marginBottom: 4 },
  welcomeTitle: { color: theme.colors.textPrimary, fontSize: 28, fontWeight: '700' },
  welcomeSubtitle: { color: theme.colors.textSecondary, fontSize: 14, marginTop: 4, lineHeight: 20 },
  statsRow: { flexDirection: 'row', gap: 16 },
  statCard: {
    flex: 1,
    backgroundColor: theme.colors.backgroundCard,
    padding: 20,
    borderRadius: 24,
    height: 100,
    justifyContent: 'center',
  },
  statValue: { color: theme.colors.textPrimary, fontSize: 32, fontWeight: '700' },
  statLabel: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600', marginTop: 4 },
  scanNowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0D1B2A', // darker navy/teal
    padding: 20,
    borderRadius: 30,
    gap: 16,
  },
  scanIconContainer: {
    width: 60,
    height: 60,
    borderRadius: 20,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanInfo: { flex: 1 },
  scanTitle: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '700' },
  scanDescription: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 2 },
  activityHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
  sectionTitle: { color: theme.colors.textSecondary, fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  viewAll: { color: theme.colors.primaryLight, fontSize: 13, fontWeight: '600' },
  activityList: { gap: 12 },
  activityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.backgroundCard,
    padding: 16,
    borderRadius: 24,
    gap: 16,
  },
  activityIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityInfo: { gap: 2 },
  activityTitle: { color: theme.colors.textPrimary, fontSize: 16, fontWeight: '700' },
  activitySubtitle: { color: theme.colors.textSecondary, fontSize: 12 },
});

