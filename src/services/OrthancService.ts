import * as SecureStore from 'expo-secure-store';
import { Buffer } from 'buffer';

export interface OrthancConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  token?: string;
  useDicomWeb?: boolean;
}

export interface OrthancStudy {
  orthancId: string;
  studyInstanceUid?: string;
  patientId?: string;
  patientName?: string;
  studyDate?: string;
  description?: string;
  seriesCount?: number;
}

export interface OrthancSeries {
  orthancId: string;
  seriesInstanceUid?: string;
  modality?: string;
  description?: string;
  instanceCount?: number;
}

const CONFIG_KEY = 'sonolink.orthanc.config';

export async function loadOrthancConfig(): Promise<OrthancConfig | null> {
  const value = await SecureStore.getItemAsync(CONFIG_KEY);
  if (!value) return null;
  try { return JSON.parse(value) as OrthancConfig; } catch { return null; }
}

export async function saveOrthancConfig(config: OrthancConfig): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(config));
}

export async function clearOrthancConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(CONFIG_KEY);
}

export class OrthancService {
  constructor(private readonly config: OrthancConfig) {}

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private headers(accept = 'application/json'): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    else if (this.config.username) {
      const encoded = Buffer.from(`${this.config.username}:${this.config.password ?? ''}`).toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Orthanc HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<boolean> {
    try { await this.request<string>('system'); return true; } catch { return false; }
  }

  async listStudies(limit = 50): Promise<OrthancStudy[]> {
    const ids = await this.request<string[]>('studies');
    const selected = ids.slice(0, limit);
    return Promise.all(selected.map(async (id) => {
      const data = await this.request<any>(`studies/${encodeURIComponent(id)}`);
      const tags = data.MainDicomTags ?? {};
      const patient = data.PatientMainDicomTags ?? {};
      return {
        orthancId: id,
        studyInstanceUid: tags.StudyInstanceUID,
        patientId: patient.PatientID,
        patientName: patient.PatientName,
        studyDate: tags.StudyDate,
        description: tags.StudyDescription,
        seriesCount: Array.isArray(data.Series) ? data.Series.length : undefined,
      };
    }));
  }

  async listSeries(studyId: string): Promise<OrthancSeries[]> {
    const study = await this.request<any>(`studies/${encodeURIComponent(studyId)}`);
    const ids: string[] = study.Series ?? [];
    return Promise.all(ids.map(async (id) => {
      const data = await this.request<any>(`series/${encodeURIComponent(id)}`);
      const tags = data.MainDicomTags ?? {};
      return {
        orthancId: id,
        seriesInstanceUid: tags.SeriesInstanceUID,
        modality: tags.Modality,
        description: tags.SeriesDescription,
        instanceCount: Array.isArray(data.Instances) ? data.Instances.length : undefined,
      };
    }));
  }

  async getPreview(instanceId: string): Promise<string> {
    const response = await fetch(this.url(`instances/${encodeURIComponent(instanceId)}/preview`), {
      headers: this.headers('image/jpeg'),
    });
    if (!response.ok) throw new Error(`Orthanc preview HTTP ${response.status}`);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  async downloadInstance(instanceId: string): Promise<ArrayBuffer> {
    const response = await fetch(this.url(`instances/${encodeURIComponent(instanceId)}/file`), {
      headers: this.headers('application/dicom'),
    });
    if (!response.ok) throw new Error(`Orthanc DICOM HTTP ${response.status}`);
    return response.arrayBuffer();
  }
}