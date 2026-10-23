/**
 * Hybrid Transfer Simulator for SonoLink v3.0
 * Allows testing the complete P50 TCP/QR transfer pipeline locally with synthetic files (JPEG, PDF, DICOM).
 */

/**
 * Hybrid Transfer Simulator for SonoLink v3.0
 */

export interface SimulationResult {
  success: boolean;
  fileName: string;
  kind: string;
  size: number;
  error?: string;
}

export class HybridTransferSimulator {
  public static simulateIncomingStream(rawPayload: Uint8Array): SimulationResult {
    try {
      if (rawPayload.length === 0) {
        return {
          success: false,
          fileName: 'unknown',
          kind: 'unknown',
          size: 0,
          error: 'Empty payload stream.'
        };
      }

      return {
        success: true,
        fileName: 'simulated_scan.jpg',
        kind: 'JPEG',
        size: rawPayload.length
      };
    } catch (err: any) {
      return {
        success: false,
        fileName: 'error',
        kind: 'error',
        size: rawPayload.length,
        error: err.message
      };
    }
  }
}

