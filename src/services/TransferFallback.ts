export type TransferAttempt = 'orthanc' | 'sonodrop-tcp' | 'optical-qr';

export interface TransferResult<T> {
  source: TransferAttempt;
  value: T;
}

export async function tryTransferSources<T>(
  sources: Array<{ name: TransferAttempt; run: () => Promise<T | null> }>,
  onAttempt?: (source: TransferAttempt) => void,
): Promise<TransferResult<T>> {
  const errors: string[] = [];
  for (const source of sources) {
    onAttempt?.(source.name);
    try {
      const value = await source.run();
      if (value != null) return { source: source.name, value };
      errors.push(`${source.name}: empty result`);
    } catch (error) {
      errors.push(`${source.name}: ${String(error)}`);
    }
  }
  throw new Error(`Asnjë burim transferimi nuk funksionoi. ${errors.join(' | ')}`);
}