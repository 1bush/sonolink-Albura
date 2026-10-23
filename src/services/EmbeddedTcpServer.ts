/**
 * Embedded TCP Server for SonoLink v3.0
 * Runs a local background server inside the mobile app to receive direct connections
 * and data streams from SonoScape P50 Elite over Wi-Fi.
 */

import TcpSocket from 'react-native-tcp-socket';

export interface ServerStatus {
  isRunning: boolean;
  port: number;
  connectedClients: number;
  lastError?: string;
}

export class EmbeddedTcpServer {
  private static server: any = null;
  private static status: ServerStatus = {
    isRunning: false,
    port: 8899,
    connectedClients: 0
  };

  /**
   * Starts the local TCP server on the device.
   */
  public static start(port: number = 8899, onDataReceived?: (data: Buffer) => void): Promise<ServerStatus> {
    return new Promise((resolve, reject) => {
      if (EmbeddedTcpServer.server) {
        resolve(EmbeddedTcpServer.status);
        return;
      }

      try {
        EmbeddedTcpServer.server = TcpSocket.createServer((socket: any) => {
          EmbeddedTcpServer.status.connectedClients++;

          socket.on('data', (chunk: Buffer) => {
            if (onDataReceived) {
              onDataReceived(chunk);
            }
          });

          socket.on('close', () => {
            EmbeddedTcpServer.status.connectedClients = Math.max(0, EmbeddedTcpServer.status.connectedClients - 1);
          });

          socket.on('error', (err: any) => {
            EmbeddedTcpServer.status.lastError = err.message;
          });
        });

        EmbeddedTcpServer.server.listen({ port, host: '0.0.0.0' }, () => {
          EmbeddedTcpServer.status.isRunning = true;
          EmbeddedTcpServer.status.port = port;
          resolve(EmbeddedTcpServer.status);
        });

        EmbeddedTcpServer.server.on('error', (err: any) => {
          EmbeddedTcpServer.status.lastError = err.message;
          reject(err);
        });
      } catch (err: any) {
        EmbeddedTcpServer.status.lastError = err.message;
        reject(err);
      }
    });
  }

  /**
   * Stops the local server.
   */
  public static stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!EmbeddedTcpServer.server) {
        resolve();
        return;
      }

      EmbeddedTcpServer.server.close(() => {
        EmbeddedTcpServer.server = null;
        EmbeddedTcpServer.status.isRunning = false;
        EmbeddedTcpServer.status.connectedClients = 0;
        resolve();
      });
    });
  }

  public static getStatus(): ServerStatus {
    return { ...EmbeddedTcpServer.status };
  }
}
