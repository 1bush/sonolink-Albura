/**
 * Embedded Linux Bridge for SonoLink v3.5
 * Combines continuous background polling, passive TCP listening, and auto-reconnect
 * to communicate seamlessly with SonoScape P50 Elite (Embedded Linux core).
 */

import { EmbeddedTcpServer } from './EmbeddedTcpServer';
import { NetworkScanner } from './NetworkScanner';

export class EmbeddedLinuxBridge {
  private static isPollingActive: boolean = false;
  private static pollIntervalMs: number = 5000;
  private static timer: any = null;

  /**
   * Starts the continuous background scanner and embeds the TCP listening server.
   */
  public static async startBridge(port: number = 8899, onImageReceived?: (data: Buffer) => void): Promise<void> {
    if (EmbeddedLinuxBridge.isPollingActive) return;

    // 1. Start the embedded TCP listener
    try {
      await EmbeddedTcpServer.start(port, (chunk) => {
        if (onImageReceived) {
          onImageReceived(chunk);
        }
      });
      console.log(`[EmbeddedLinuxBridge] TCP Listener active on port ${port}`);
    } catch (err) {
      console.error('[EmbeddedLinuxBridge] Failed to start TCP listener:', err);
    }

    // 2. Start continuous background network discovery/polling loop
    EmbeddedLinuxBridge.isPollingActive = true;
    EmbeddedLinuxBridge.timer = setInterval(async () => {
      try {
        const foundDevices = await NetworkScanner.scanLocalNetwork();
        if (foundDevices && foundDevices.length > 0) {
          console.log('[EmbeddedLinuxBridge] P50 Elite active on network:', foundDevices);
        }
      } catch (err) {
        // Suppress network scan background errors to prevent spamming
      }
    }, EmbeddedLinuxBridge.pollIntervalMs);
  }

  /**
   * Stops the bridge service.
   */
  public static async stopBridge(): Promise<void> {
    EmbeddedLinuxBridge.isPollingActive = false;
    if (EmbeddedLinuxBridge.timer) {
      clearInterval(EmbeddedLinuxBridge.timer);
      EmbeddedLinuxBridge.timer = null;
    }
    await EmbeddedTcpServer.stop();
    console.log('[EmbeddedLinuxBridge] Stopped successfully.');
  }
}
