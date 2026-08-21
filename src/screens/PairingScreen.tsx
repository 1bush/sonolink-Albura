import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { theme } from '../theme';
import {
  tryParseSonoDropQR,
} from '../protocol/sonoDropProtocol';
import { TcpConnectionService, type ConnectionEvent } from '../services/TcpConnectionService';
import { TransferCoordinator, type UnifiedReceivedFile } from '../services/TransferCoordinator';
import { ensureStudyDir } from '../services/fileStorage';
import { upsertStudy, insertSop, incrementStudyFileCount } from '../services/database';
import { saveFrame } from '../services/fileStorage';
import { getScanCounsel } from '../services/GroqService';
import { getOllamaCounsel } from '../services/OllamaCounselService';
import { DicomService } from '../services/DicomService';
import {
  decodeOpticalQrData,
  ingestOpticalFrame,
  type OpticalTransferResult,
} from '../services/OpticalTransferService';
import type { LTDecoder } from '../services/opticalProtocol';

interface Props {
  onFileReceived: (studyId: string, fileCount: number) => void;
  onClose: () => void;
}

export default function PairingScreen({ onFileReceived }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState<string>('disconnected');
  const [counselText, setCounselText] = useState('Waiting for QR code...');
  const serviceRef = useRef<TcpConnectionService | null>(null);
  const coordinatorRef = useRef(new TransferCoordinator());
  const scanLock = useRef(false);
  const studyIdRef = useRef<string>('');
  const opticalStateRef = useRef<{ decoder: LTDecoder | null; identity: string | null }>({
    decoder: null,
    identity: null,
  });
  const opticalTransferIdRef = useRef(`optical_${Date.now()}`);

  useEffect(() => {
    if (!permission?.granted) requestPermission();

    const svc = new TcpConnectionService();
    serviceRef.current = svc;
    const unsub = svc.on((event: ConnectionEvent) => {
      if (event.type === 'connected') setStatus('connected');
      if (event.type === 'disconnected') setStatus('disconnected');
      if (event.type === 'file') {
        coordinatorRef.current.acceptTcpFrame(event.frame);
      }
    });
    const unsubscribeCoordinator = coordinatorRef.current.on((event) => {
      if (event.type === 'progress') setCounselText(event.message);
      if (event.type === 'error') setCounselText(`${event.mode}: ${event.message}`);
      if (event.type === 'file') {
        handleUnifiedFile(event.file, event.index).catch((e) =>
          console.error('Save unified transfer file failed', e)
        );
      }
    });
    return () => {
      unsub();
      unsubscribeCoordinator();
      svc.disconnect();
      coordinatorRef.current.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission, requestPermission]);

  const handleUnifiedFile = async (file: UnifiedReceivedFile, index: number) => {
    const studyId = studyIdRef.current;
    if (!studyId) return;
    const frame = { kind: file.kind, name: file.name, bytes: file.bytes };
    await saveFrame(studyId, frame);

    // If the frame is a DICOM file, parse its headers so the album UI can
    // show patient/modality metadata instead of a generic placeholder.
    if (/\.dcm$/i.test(file.name) || file.kind.startsWith('DICOM')) {
      try {
        DicomService.parse(file.bytes);
      } catch (e) {
        console.error('[Dicom] parse failed', e);
      }
    }

    await insertSop({
      Name: file.name,
      Dir: studyId,
      Size: String(file.bytes.length),
      Status: 'received',
      Idx: index,
      StudyID: studyId,
    });
    await incrementStudyFileCount(studyId);
    onFileReceived(studyId, index + 1);
  };

  const processQrText = useCallback(
    async (text: string) => {
      const parsed = tryParseSonoDropQR(text);
      if (!parsed) return;

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      // Prefer local Ollama (no API key needed); fall back to Groq only if
      // Ollama is unreachable.
      let counsel = await getOllamaCounsel(parsed.patientId, parsed);
      if (!counsel || counsel.message.startsWith('The export details')) {
        const groq = await getScanCounsel(parsed.patientId, parsed);
        if (groq && groq.message) counsel = groq;
      }
      setCounselText(counsel.message);

      const studyId = `${Date.now()}_${parsed.patientId || 'unknown'}`;
      studyIdRef.current = studyId;
      await ensureStudyDir(studyId);
      await upsertStudy({ ID: studyId, DateTime: new Date().toISOString(), Dept: 'US', Num: 0 });

      try {
        await serviceRef.current?.connect(parsed);
      } catch (e: any) {
        console.error('Connection failed', e);
      }
    },
    []
  );

  const processOpticalFrame = useCallback((text: string) => {
    const bytes = decodeOpticalQrData(text);
    if (!bytes) return false;
    const studyId = studyIdRef.current || `optical_${Date.now()}`;
    studyIdRef.current = studyId;
    ensureStudyDir(studyId).catch(() => {});
    upsertStudy({ ID: studyId, DateTime: new Date().toISOString(), Dept: 'OPTICAL', Num: 0 }).catch(() => {});

    ingestOpticalFrame(opticalStateRef.current, bytes, {
      transferId: opticalTransferIdRef.current,
      onFrame: () => setCounselText('Optical frame received.'),
      onError: (error) => setCounselText(`Optical transfer: ${error}`),
      onComplete: (result: OpticalTransferResult) => {
        if (!result.success || !result.fileBytes || !result.fileName) return;
        coordinatorRef.current.acceptOpticalResult(result);
        setCounselText(`Optical transfer complete: ${result.fileName}`);
      },
    });
    return true;
  }, []);

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanLock.current) return;
    if (processOpticalFrame(data)) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return;
    }
    scanLock.current = true;
    processQrText(data).finally(() => {
      setTimeout(() => (scanLock.current = false), 2000);
    });
  };

  if (!permission?.granted) {
    return (
      <View style={styles.root}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <MaterialCommunityIcons name="view-grid-plus-outline" size={20} color={theme.colors.primaryLight} />
          <Text style={styles.headerLabel}>SCANNING</Text>
        </View>
        <Text style={styles.title}>Scan the device's QR code</Text>
        <Text style={styles.subtitle}>
          On SonoScape P50, press Share → QR and point the camera here.
        </Text>
      </View>

      <View style={styles.cameraContainer}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcodeScanned}
        />
        <View style={styles.overlay}>
          <View style={styles.guideFrame} />
          <View style={styles.toast}>
            <Text style={styles.toastText}>Place the QR code within the frame.</Text>
          </View>
        </View>
      </View>

      <View style={styles.counselCard}>
        <View style={styles.counselHeader}>
          <View style={styles.checkCircle}>
            <Ionicons name="checkmark" size={14} color={theme.colors.success} />
          </View>
          <Text style={styles.counselTitle}>counsel</Text>
        </View>
        <Text style={styles.counselText}>{counselText}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background, padding: 20 },
  header: { marginTop: 40, marginBottom: 20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  headerLabel: { color: theme.colors.primaryLight, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  title: { color: theme.colors.textPrimary, fontSize: 24, fontWeight: '700' },
  subtitle: { color: theme.colors.textSecondary, fontSize: 14, marginTop: 4, lineHeight: 20 },
  cameraContainer: {
    flex: 1,
    borderRadius: 40,
    overflow: 'hidden',
    backgroundColor: '#000',
    marginBottom: 20,
  },
  camera: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  guideFrame: {
    width: '70%',
    aspectRatio: 1,
    borderWidth: 4,
    borderColor: '#fff',
    borderRadius: 20,
  },
  toast: {
    position: 'absolute',
    bottom: 40,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  toastText: { color: '#fff', fontSize: 13 },
  counselCard: {
    backgroundColor: theme.colors.backgroundCard,
    borderRadius: 30,
    padding: 20,
    gap: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  counselHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  counselTitle: { color: theme.colors.success, fontSize: 15, fontWeight: '700' },
  counselText: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 },
});

