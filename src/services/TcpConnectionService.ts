/**
 * TcpConnectionService.ts
 */
import TcpSocket from 'react-native-tcp-socket';
import * as Network from 'expo-network';
import { Buffer } from 'buffer';
import { buildHeartbeat, buildFileAck } from '../protocol/sonoDropProtocol';
import type { SonoDropQRInfo } from '../protocol/sonoDropProtocol';
import { FileFrameReader, type ReceivedFileFrame } from './framing';
import { findDeviceIP } from './NetworkScanner';

export type ConnectionEvent =
  | { type: 'connecting' }
  | { type: 'connected'; localIP: string; localPort: number }
  | { type: 'file'; frame: ReceivedFileFrame; index: number }
  | { type: 'error'; message: string }
  | { type: 'disconnected' }
  | { type: 'log'; message: string; level: 'info' | 'success' | 'warning' | 'error' };

type Listener = (event: ConnectionEvent) => void;

const LISTEN_PORT_RANGE = { min: 40000, max: 49999 };

export class TcpConnectionService {
  private client: ReturnType<typeof TcpSocket.createConnection> | null = null;
  private server: ReturnType<typeof TcpSocket.createServer> | null = null;
  private listeners: Listener[] = [];
  private frameReader = new FileFrameReader();
  private fileIndex = 0;
  private connected = false;

  on(listener: Listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: ConnectionEvent) {
    this.listeners.forEach((l) => l(event));
  }

  private log(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info') {
    this.emit({ type: 'log', message, level });
  }

  async getLocalIP(): Promise<string> {
    try {
      const ip = await Network.getIpAddressAsync();
      return ip || '0.0.0.0';
    } catch {
      return '0.0.0.0';
    }
  }

  async connect(qrInfo: SonoDropQRInfo): Promise<void> {
    this.emit({ type: 'connecting' });
    this.log(`Duke u lidhur me P50 në ${qrInfo.host}:${qrInfo.port}...`);

    try {
      await this.attemptConnection(qrInfo.host, qrInfo.port, qrInfo.patientId);
    } catch (err) {
      this.log(`Lidhja me ${qrInfo.host} dështoi. Duke kërkuar pajisjen në rrjet...`, 'warning');
      const discoveredHost = await findDeviceIP(qrInfo.port);
      if (discoveredHost) {
        this.log(`Pajisja u gjet në ${discoveredHost}. Duke u lidhur...`, 'success');
        await this.attemptConnection(discoveredHost, qrInfo.port, qrInfo.patientId);
      } else {
        throw new Error('Pajisja nuk u gjet në rrjet.');
      }
    }
  }

  private async attemptConnection(host: string, port: number, patientId: string): Promise<void> {
    const localIP = await this.getLocalIP();
    const localPort =
      LISTEN_PORT_RANGE.min + Math.floor(Math.random() * (LISTEN_PORT_RANGE.max - LISTEN_PORT_RANGE.min));

    await this.startLocalServer(localPort);

    return new Promise<void>((resolve, reject) => {
      try {
        this.client = TcpSocket.createConnection(
          { host, port, tls: false },
          () => {
            this.connected = true;
            this.log('Lidhja TCP u hap me sukses', 'success');
            const heartbeat = buildHeartbeat({
              localIP,
              localPort,
              patientId,
              username: 'SonoLink',
            });
            this.client!.write(heartbeat);
            this.emit({ type: 'connected', localIP, localPort });
            resolve();
          }
        );

        this.client.on('error', (err) => {
          this.log(`Gabim në lidhjen TCP: ${err?.message ?? err}`, 'error');
          this.emit({ type: 'error', message: String(err?.message ?? err) });
          reject(err);
        });

        this.client.on('close', () => {
          if (this.connected) {
            this.connected = false;
            this.log('Lidhja TCP u mbyll', 'warning');
            this.emit({ type: 'disconnected' });
          }
        });

        this.client.on('data', (data) => {
          this.handleIncomingBytes(data);
        });
      } catch (err: any) {
        this.log(`Gabim: ${err?.message ?? err}`, 'error');
        reject(err);
      }
    });
  }

  private async startLocalServer(port: number): Promise<void> {
    if (this.server) {
        try { this.server.close(); } catch {}
    }
    return new Promise((resolve, reject) => {
      try {
        this.server = TcpSocket.createServer((socket) => {
          this.log('Aparati u lidh me serverin lokal — duke pritur skedarë...', 'info');
          socket.on('data', (data) => this.handleIncomingBytes(data));
          socket.on('error', (err) => this.log(`Gabim socket: ${err?.message ?? err}`, 'error'));
        }).listen({ port, host: '0.0.0.0' });

        this.server.on('error', (err: any) => {
          this.log(`Gabim në serverin lokal: ${err?.message ?? err}`, 'error');
          reject(err);
        });

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleIncomingBytes(data: Buffer | string) {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const frames = this.frameReader.push(buf);
    for (const frame of frames) {
      this.log(`Skedari u mor: ${frame.name} (${formatSize(frame.bytes.length)})`, 'success');
      this.emit({ type: 'file', frame, index: this.fileIndex });
      this.sendFileAck(this.fileIndex, 0);
      this.fileIndex += 1;
    }
  }

  private sendFileAck(index: number, status: 0 | 1) {
    const ack = buildFileAck(index, status);
    this.client?.write(ack);
  }

  disconnect() {
    this.log('Duke u shkëputur...', 'info');
    try {
      this.client?.destroy();
    } catch {}
    try {
      this.server?.close();
    } catch {}
    this.client = null;
    this.server = null;
    this.connected = false;
    this.frameReader.reset();
    this.fileIndex = 0;
    this.emit({ type: 'disconnected' });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
