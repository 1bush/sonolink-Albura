import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Switch, ScrollView, Button, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../theme';
import { loadOrthancConfig, OrthancService, saveOrthancConfig } from '../services/OrthancService';

interface Props {
  userName: string;
  appVersion: string;
}

export default function SettingsScreen({ userName: initialUserName }: Props) {
  const [clinicName, setClinicName] = useState('Klinika Albura');
  const [doctorName, setDoctorName] = useState(initialUserName);
  const [darkMode, setDarkMode] = useState(true);
  const [orthancUrl, setOrthancUrl] = useState('');
  const [orthancToken, setOrthancToken] = useState('');
  const [orthancStatus, setOrthancStatus] = useState('Nuk është konfiguruar');

  useEffect(() => {
    loadOrthancConfig().then((config) => {
      if (config) { setOrthancUrl(config.baseUrl); setOrthancToken(config.token ?? ''); setOrthancStatus('Konfigurimi u ngarkua'); }
    });
  }, []);

  const testOrthanc = async () => {
    const config = { baseUrl: orthancUrl.trim(), token: orthancToken.trim() };
    if (!config.baseUrl) { setOrthancStatus('Vendos URL e Orthanc'); return; }
    await saveOrthancConfig(config);
    const ok = await new OrthancService(config).testConnection();
    setOrthancStatus(ok ? 'Orthanc u lidh me sukses' : 'Orthanc nuk u përgjigj');
    if (!ok) Alert.alert('Gabim lidhjeje', 'Kontrollo URL, HTTPS, token-in dhe rrjetin e klinikës.');
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.headerLabel}>SETTINGS</Text>
      <Text style={styles.title}>Customize the app</Text>

      <View style={styles.card}>
        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>CLINIC NAME</Text>
          <TextInput
            style={styles.input}
            value={clinicName}
            onChangeText={setClinicName}
            placeholder="e.g. Albura Clinic"
            placeholderTextColor={theme.colors.textMuted}
          />
        </View>

        <View style={styles.inputGroup}>
          <Text style={styles.inputLabel}>DOCTOR'S NAME</Text>
          <TextInput
            style={styles.input}
            value={doctorName}
            onChangeText={setDoctorName}
            placeholder="e.g. Dr. Rovena Stroni"
            placeholderTextColor={theme.colors.textMuted}
          />
        </View>
      </View>

      <View style={styles.cardRow}>
        <View style={styles.iconCircle}>
          <Ionicons name="moon-outline" size={20} color={theme.colors.textPrimary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Dark mode</Text>
          <Text style={styles.rowSubtitle}>Recommended for ultrasound rooms</Text>
        </View>
        <Switch
          value={darkMode}
          onValueChange={setDarkMode}
          trackColor={{ false: '#767577', true: theme.colors.primaryLight }}
          thumbColor={darkMode ? '#fff' : '#f4f3f4'}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.inputLabel}>ORTHANC / DICOMWEB</Text>
        <TextInput style={styles.input} value={orthancUrl} onChangeText={setOrthancUrl} placeholder="https://orthanc.klinika.al" placeholderTextColor={theme.colors.textMuted} autoCapitalize="none" />
        <TextInput style={styles.input} value={orthancToken} onChangeText={setOrthancToken} placeholder="API token (opsional për test)" placeholderTextColor={theme.colors.textMuted} secureTextEntry autoCapitalize="none" />
        <Button title="Ruaj dhe testo Orthanc" onPress={testOrthanc} />
        <Text style={styles.rowSubtitle}>{orthancStatus}</Text>
      </View>

      <View style={styles.aboutCard}>
        <View style={styles.aboutHeader}>
          <Ionicons name="information-circle-outline" size={20} color={theme.colors.primaryLight} />
          <Text style={styles.aboutTitle}>About SonoLink</Text>
        </View>
        <Text style={styles.aboutText}>
          Scanning the QR code of the SonoScape P50 is automatically recognized (station, file number, export ID).
          The image itself must be uploaded from the gallery until the direct WiFi/socket transfer is connected to the device.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 20, gap: 20 },
  headerLabel: { color: theme.colors.primaryLight, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: '700', color: theme.colors.textPrimary, marginBottom: 10 },
  card: {
    backgroundColor: theme.colors.backgroundCard,
    borderRadius: 24,
    padding: 24,
    gap: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inputGroup: { gap: 8 },
  inputLabel: { fontSize: 12, fontWeight: '700', color: theme.colors.textSecondary, letterSpacing: 0.5 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.backgroundCard,
    borderRadius: 24,
    padding: 20,
    gap: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { color: theme.colors.textPrimary, fontSize: 16, fontWeight: '600' },
  rowSubtitle: { color: theme.colors.textSecondary, fontSize: 12 },
  aboutCard: {
    backgroundColor: 'rgba(47,184,169,0.05)',
    borderRadius: 24,
    padding: 20,
    gap: 12,
    borderWidth: 1,
    borderColor: 'rgba(47,184,169,0.2)',
  },
  aboutHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  aboutTitle: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' },
  aboutText: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
});

