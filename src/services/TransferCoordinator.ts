import { Buffer } from 'buffer';
import type { ReceivedFileFrame } from './framing';
import type { OpticalTransferResult } from './OpticalTransferService';

export type TransferMode = 'orthanc-dicomweb' | 'sonodrop-tcp' | 'decimen-optical';

export interface UnifiedReceivedFile {
  mode: TransferMode;
  name: string;
  kind: string;
  bytes: Buffer;
  patientId?: string;
  checksum?: string;
}

export type TransferCoordinatorEvent =
  | { type: 'file'; file: UnifiedReceivedFile; index: number }
  | { type: 'progress'; mode: TransferMode; message: string }
  | { type: 'error'; mode: TransferMode; message: string };

type Listener = (event: TransferCoordinatorEvent) => void;

/**
 * Application-level bridge between the two independent wire protocols.
 * SonoDrop TCP and Decimen QR never share a socket or parser; they only meet
 * here as a common file event before storage/DICOM/database processing.
 */
export class TransferCoordinator {
  private listeners: Listener[] = [];
  private nextIndex = 0;

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  private emit(event: TransferCoordinatorEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  acceptTcpFrame(frame: ReceivedFileFrame) {
    this.emit({
      type: 'file',
      index: this.nextIndex++,
      file: {
        mode: 'sonodrop-tcp',
        name: frame.name,
        kind: frame.kind,
        bytes: Buffer.from(frame.bytes),
      },
    });
  }

  acceptOpticalResult(result: OpticalTransferResult) {
    if (!result.success || !result.fileBytes || !result.fileName) {
      this.emit({
        type: 'error',
        mode: 'decimen-optical',
        message: result.error ?? 'Optical transfer did not produce a file.',
      });
      return;
    }

    this.emit({
      type: 'file',
      index: this.nextIndex++,
      file: {
        mode: 'decimen-optical',
        name: result.fileName,
        kind: result.fileType?.toLowerCase().includes('dicom') ? 'DICOM' : 'OPTICAL',
        bytes: Buffer.from(result.fileBytes),
        checksum: result.checksum,
      },
    });
  }

  progress(mode: TransferMode, message: string) {
    this.emit({ type: 'progress', mode, message });
  }

  error(mode: TransferMode, message: string) {
    this.emit({ type: 'error', mode, message });
  }

  reset() {
    this.nextIndex = 0;
  }
}