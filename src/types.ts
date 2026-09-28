export type TabKey = 'home' | 'scan' | 'album' | 'settings' | 'optical' | 'drita';

export interface LastScanSummary {
  patientId: string;
  fileCount: number;
  when: string;
}

export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ActivityLogEntry {
  id: string;
  time: string;
  message: string;
  level: 'info' | 'success' | 'warning' | 'error';
}
