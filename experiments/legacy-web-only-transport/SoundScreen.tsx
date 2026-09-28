// src/screens/SoundScreen.tsx
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ToastAndroid } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as DocumentPicker from 'expo-document-picker';
import { Camera } from 'expo-camera';
import { theme } from '../theme';
import { SoundSender, SoundReceiver, type SoundTransferProgress, type SoundTransferResult } from '../services/SoundTransferService';

type SoundMode = 'send' | 'receive';

interface SoundScreenProps {
  onOpenP50Scan?: () => void;
}

export default function SoundScreen({ onOpenP50Scan }: SoundScreenProps) {
  const [mode, setMode] = useState<SoundMode>('receive');
  const [status, setStatus] = useState<string>('Ready to receive');
  const [progress, setProgress] = useState<number>(0);
  const [fileName, setFileName] = useState<string>('');
  const [fileSize, setFileSize] = useState<string>('');
  
  const receiverRef = useRef<SoundReceiver | null>(null);
  const senderRef = useRef<SoundSender | null>(null);
  
  const requestMicPermission = async (): Promise<boolean> => {
    try {
      const result = await Camera.requestPermissionsAsync();
      return result.status === 'granted';
    } catch {
      return false;
    }
  };
  
  const startReceiving = useCallback(async () => {
    setStatus('Requesting microphone permission...');
    const hasPerm = await requestMicPermission();
    if (!hasPerm) {
      Alert.alert('Permission Required', 'Microphone access is needed to receive sound transfers.');
      setStatus('Permission denied');
      return;
    }
    
    setStatus('Listening for sound transfer...');
    
    const receiver = new SoundReceiver({
      onFrame: (frame) => {
        console.log('Frame:', frame.header.sequence);
      },
      onComplete: (result: SoundTransferResult) => {
        setStatus(result.success ? 'Complete! ' + result.fileSize + ' bytes' : 'Transfer failed');
        setProgress(100);
        setFileSize(result.success ? (result.fileSize / 1024).toFixed(1) + ' KB' : '');
        if (result.success) saveReceivedFile(result);
      },
      onError: (error: string) => {
        setStatus('Error: ' + error);
        console.error('Sound error:', error);
      },
      onProgress: (progress: SoundTransferProgress) => {
        setProgress(Math.round((progress.framesReceived / progress.total) * 100));
        setStatus('Receiving: ' + progress.framesReceived + '/' + progress.total + ' frames');
      },
    });
    
    receiverRef.current = receiver;
    await receiver.start();
  }, []);
  
  const stopReceiving = useCallback(() => {
    receiverRef.current?.stop();
    receiverRef.current = null;
    setStatus('Stopped');
    setProgress(0);
    setFileSize('');
  }, []);
  
  const startSending = useCallback(async () => {
    setStatus('Select a file...');
    
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'video/*', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });
      
      if (result.canceled || !result.assets || result.assets.length === 0) return;
      
      const asset = result.assets[0];
      setFileName(asset.name);
      setFileSize(asset.size ? (asset.size / 1024 / 1024).toFixed(2) + ' MB' : '');
      setStatus('Sending: ' + asset.name + '...');
      
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
      const fileData = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      
      const sender = new SoundSender(
        fileData,
        asset.name,
        asset.mimeType || 'application/octet-stream',
        DEFAULT_CONFIG,
        (progress: SoundTransferProgress) => {
          setProgress(Math.round((progress.framesSent / progress.total) * 100));
          setStatus('Sending: ' + progress.framesSent + '/' + progress.total + ' frames');
        },
        (error: string) => {
          setStatus('Error: ' + error);
          console.error('Send error:', error);
        },
        () => {
          setStatus('Send complete!');
        }
      );
      
      senderRef.current = sender;
      await sender.start();
    } catch (error) {
      setStatus('Failed to select file');
      console.error('Picker error:', error);
    }
  }, []);
  
  const stopSending = useCallback(() => {
    senderRef.current?.stop();
    senderRef.current = null;
    setStatus('Stopped');
    setProgress(0);
    setFileName('');
    setFileSize('');
  }, []);
  
  const saveReceivedFile = async (result: SoundTransferResult) => {
    try {
      if (!result.success || !result.fileBytes) return;
      
      const cacheDir = FileSystem.cacheDirectory;
      const timestamp = Date.now();
      const fileUri = cacheDir + '/sono_' + timestamp + '.jpg';
      
      const base64 = btoa(String.fromCharCode(...result.fileBytes));
      await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: 'base64' });
      
      const permResult = await MediaLibrary.requestPermissionsAsync();
      if (permResult.status === 'granted') {
        await MediaLibrary.createAssetAsync(fileUri);
        await MediaLibrary.createAlbumAsync('SonoLink', fileUri, false);
        ToastAndroid.show('File saved to gallery!', ToastAndroid.SHORT);
      } else {
        ToastAndroid.show('File saved to cache', ToastAndroid.SHORT);
      }
    } catch (error) {
      console.error('Save failed:', error);
      Alert.alert('Save Failed', 'Could not save the received file.');
    }
  };
