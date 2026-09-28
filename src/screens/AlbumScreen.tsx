import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, Alert, Modal, Image, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import { Buffer } from 'buffer';
import { theme } from '../theme';
import { listStudies, listSopsForStudy, type StudyRow } from '../services/database';
import { listStudyFiles, studyDir, deleteStudyFiles } from '../services/fileStorage';
import { shareFileViaWhatsApp, shareStudyBundle } from '../services/SharingService';
import { formatWatermarkText } from '../services/WatermarkService';
import { renderDicomToBmpDataUri } from '../services/DicomViewer';
import { DEFAULT_DOCTOR } from '../services/fileStorage';

interface StudyCard {
  id: string;
  title: string;
  date: string;
  fileCount: number;
}

interface PreviewState {
  studyId: string;
  title: string;
  imagePath: string | null;
  fileCount: number;
  /** Set when the "image" is a rasterised DICOM frame. */
  dicomInfo: { patientName?: string; modality?: string; dims: string } | null;
}

export default function AlbumScreen() {
  const [search, setSearch] = useState('');
  const [studies, setStudies] = useState<StudyCard[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

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

  const openPreview = async (card: StudyCard) => {
    setPreviewBusy(true);
    try {
      const files = await listStudyFiles(card.id);
      const image = files.find((name) => /^watermarked_/i.test(name) && /\.(jpg|jpeg|png)$/i.test(name))
        ?? files.find((name) => /\.(jpg|jpeg|png)$/i.test(name));
      setPreview({
        studyId: card.id,
        title: card.title,
        imagePath: image ? `${studyDir(card.id)}${image}` : null,
        fileCount: card.fileCount,
        dicomInfo: null,
      });
      // No raster image — try to render the first DICOM file inline.
      if (!image) {
        const dcm = files.find((name) => /\.dcm$/i.test(name) || /^DICOM/i.test(name));
        if (dcm) {
          const b64 = await FileSystem.readAsStringAsync(`${studyDir(card.id)}${dcm}`, {
            encoding: FileSystem.EncodingType.Base64,
          });
          const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
          const rendered = renderDicomToBmpDataUri(bytes);
          if (rendered) {
            setPreview((p) => p && p.studyId === card.id ? {
              ...p,
              imagePath: rendered.uri,
              dicomInfo: {
                patientName: rendered.meta.patientName,
                modality: rendered.meta.modality,
                dims: `${rendered.meta.columns ?? '?'}×${rendered.meta.rows ?? '?'}`,
              },
            } : p);
          }
        }
      }
    } finally {
      setPreviewBusy(false);
    }
  };

  const exportStudy = async (studyId: string) => {
    try {
      const shared = await shareStudyBundle(studyId);
      if (!shared) Alert.alert('Ndarja nuk është e disponueshme', 'Aktivizo ndarjen në pajisjen tënde.');
    } catch (error) {
      Alert.alert('Gabim gjatë eksportit', String(error));
    }
  };

  const deleteCurrentStudy = () => {
    if (!preview) return;
    Alert.alert(
      'Fshi studimin',
      'Skedarët e tij do të hiqen nga telefoni. Vazhdojmë?',
      [
        { text: 'Anulo', style: 'cancel' },
        {
          text: 'Fshi',
          style: 'destructive',
          onPress: () => {
            deleteStudyFiles(preview.studyId)
              .then(() => {
                setPreview(null);
                reloadStudies();
              })
              .catch((e) => Alert.alert('Gabim gjatë fshirjes', String(e)));
          },
        },
      ],
    );
  };

  const reloadStudies = () => {
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
  };

  useEffect(() => {
    reloadStudies();
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
          <TouchableOpacity style={styles.card} onPress={() => openPreview(item)}>
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
              <Text style={styles.cardDate}>{item.date} · Prek për preview</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      {/* ── Preview modal: image + watermark overlay + export/share actions ── */}
      <Modal visible={preview !== null} animationType="slide" transparent>
        <View style={previewStyles.backdrop}>
          {preview && (
            <View style={previewStyles.sheet}>
              <View style={previewStyles.sheetHeader}>
                <Text style={previewStyles.sheetTitle}>{preview.title}</Text>
                <TouchableOpacity onPress={() => setPreview(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                  <Ionicons name="close" size={24} color={theme.colors.textPrimary} />
                </TouchableOpacity>
              </View>

              <View style={previewStyles.imageWrap}>
                {previewBusy ? (
                  <ActivityIndicator size="large" color={theme.colors.primary} />
                ) : preview.imagePath ? (
                  <Image source={{ uri: preview.imagePath }} style={previewStyles.image} resizeMode="contain" />
                ) : (
                  <View style={previewStyles.noImage}>
                    <Ionicons name="documents-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={previewStyles.noImageText}>
                      Nuk ka imazh. Studimi ka {preview.fileCount} skedarë (DICOM/të tjera).
                    </Text>
                  </View>
                )}
                {/* Watermark overlay — renders the exact stamp that a native
                    marker will bake into the shared file (WatermarkService). */}
                <View style={previewStyles.watermarkBox} pointerEvents="none">
                  <Text style={previewStyles.watermarkText}>
                    {formatWatermarkText({ doctor: DEFAULT_DOCTOR })}
                  </Text>
                </View>
              </View>

              {preview.dicomInfo && (
                <Text style={previewStyles.dicomMeta}>
                  DICOM — {preview.dicomInfo.modality ?? 'US'}
                  {preview.dicomInfo.patientName ? ` · ${preview.dicomInfo.patientName}` : ''}
                  {' · '}{preview.dicomInfo.dims} px
                </Text>
              )}

              <View style={previewStyles.actions}>
                <TouchableOpacity
                  style={[previewStyles.actionBtn, previewStyles.actionPrimary]}
                  onPress={() => preview && shareStudy(preview.studyId)}
                >
                  <Ionicons name="logo-whatsapp" size={20} color="#fff" />
                  <Text style={previewStyles.actionTextPrimary}>WhatsApp</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={previewStyles.actionBtn}
                  onPress={() => preview && exportStudy(preview.studyId)}
                >
                  <Ionicons name="share-social-outline" size={20} color={theme.colors.primaryLight} />
                  <Text style={previewStyles.actionText}>Eksporto (manifest + skedar)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={previewStyles.actionBtn} onPress={deleteCurrentStudy}>
                  <Ionicons name="trash-outline" size={20} color="#e05252" />
                  <Text style={[previewStyles.actionText, { color: '#e05252' }]}>Fshi</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>
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

const previewStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.colors.backgroundCard,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    padding: 20,
    gap: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxHeight: '90%',
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: '700', flex: 1 },
  imageWrap: {
    aspectRatio: 4 / 3,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  noImage: { alignItems: 'center', gap: 10, padding: 20 },
  noImageText: { color: theme.colors.textSecondary, textAlign: 'center', fontSize: 13 },
  watermarkBox: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  watermarkText: { color: 'rgba(255,255,255,0.85)', fontSize: 10, lineHeight: 14 },
  dicomMeta: { color: theme.colors.textSecondary, fontSize: 12, fontWeight: '600' },
  actions: { gap: 10 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  actionPrimary: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  actionText: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: '600' },
  actionTextPrimary: { color: '#fff', fontSize: 15, fontWeight: '700' },
});

