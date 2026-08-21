import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../theme';
import { listStudies, listSopsForStudy, type StudyRow } from '../services/database';
import { listStudyFiles, studyDir } from '../services/fileStorage';
import { shareFileViaWhatsApp } from '../services/SharingService';

interface StudyCard {
  id: string;
  title: string;
  date: string;
  fileCount: number;
}

export default function AlbumScreen() {
  const [search, setSearch] = useState('');
  const [studies, setStudies] = useState<StudyCard[]>([]);

  const shareStudy = async (studyId: string) => {
    try {
      const files = await listStudyFiles(studyId);
      const image = files.find((name) => /^watermarked_/i.test(name) && /\.(jpg|jpeg|png)$/i.test(name))
        ?? files.find((name) => /\.(jpg|jpeg|png)$/i.test(name));
      if (!image) {
        Alert.alert('Nuk ka foto', 'Ky ekzaminim nuk ka ende foto për t’u dërguar.');
        return;
      }
      const shared = await shareFileViaWhatsApp(`${studyDir(studyId)}${image}`);
      if (!shared) Alert.alert('Ndarja nuk është e disponueshme', 'Instalo ose aktivizo WhatsApp/ndarjen në Android.');
    } catch (error) {
      Alert.alert('Gabim gjatë dërgimit', String(error));
    }
  };

  useEffect(() => {
    (async () => {
      const rows = await listStudies();
      const cards: StudyCard[] = await Promise.all(
        rows.map(async (s: StudyRow) => {
          const sops = await listSopsForStudy(s.ID);
          return {
            id: s.ID,
            title: s.Dept ? `DCOM-ALBURA · ${s.Dept}` : 'DCOM-ALBURA',
            date: formatDate(s.DateTime),
            fileCount: sops.length,
          };
        }),
      );
      setStudies(cards);
    })();
  }, []);

  const filtered = studies.filter(
    (s) => s.title.toLowerCase().includes(search.toLowerCase()) || s.date.includes(search),
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>ALBUM</Text>
        <Text style={styles.title}>All scans</Text>
      </View>

      <View style={styles.searchContainer}>
        <Ionicons name="search-outline" size={20} color={theme.colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search for patient, label or note"
          placeholderTextColor={theme.colors.textMuted}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <FlatList
        data={filtered}
        numColumns={2}
        keyExtractor={(item) => item.id}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No scans yet. Connect to the P50 to receive images.</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} onPress={() => shareStudy(item.id)}>
            <View style={styles.imagePlaceholder}>
              <Ionicons name="image-outline" size={48} color={theme.colors.textSecondary} />
              {item.fileCount > 0 && (
                <View style={styles.countBadge}>
                  <Text style={styles.countText}>{item.fileCount}</Text>
                </View>
              )}
            </View>
            <View style={styles.cardInfo}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardDate}>{item.date} · Prek për WhatsApp</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
    return d.toLocaleDateString('sq-AL', { day: '2-digit', month: 'short' });
  } catch {
    return iso.slice(0, 16);
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background, padding: 20 },
  header: { marginBottom: 20 },
  headerLabel: { color: theme.colors.primaryLight, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  title: { fontSize: 28, fontWeight: '700', color: theme.colors.textPrimary },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.backgroundCard,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  searchInput: { flex: 1, color: theme.colors.textPrimary, fontSize: 15 },
  list: { gap: 16 },
  row: { justifyContent: 'space-between' },
  card: {
    width: '48%',
    backgroundColor: theme.colors.backgroundCard,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  imagePlaceholder: {
    aspectRatio: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  emptyText: { color: theme.colors.textSecondary, textAlign: 'center', marginTop: 40, fontSize: 14 },
  cardInfo: { padding: 16, gap: 4 },
  cardTitle: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: '700' },
  cardDate: { color: theme.colors.textSecondary, fontSize: 12 },
});

