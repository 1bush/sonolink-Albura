/**
 * OllamaCounselService.ts
 *
 * Provides the AI "Counsel" feature for the scan UI using a LOCAL Ollama
 * server — no API key, no external account, works completely offline on the
 * clinic's LAN. This is the preferred provider for the counsel feature.
 *
 * The sonoDrop QR on the P50 already carries the station/file/patientId — we
 * call the local model to turn that into a short, clinically useful summary.
 *
 * If Ollama is not reachable we fall back to a built-in description so the UI
 * never shows an empty box.
 */

import {
  callOllamaApi,
  DEFAULT_OLLAMA_CONFIG,
  buildUltrasoundAnalysisPrompt,
  type OllamaConfig,
} from './OllamaService';

export interface OllamaCounselResponse {
  message: string;
}

/**
 * Builds a short summary of the scan using the local Ollama model.
 *
 * `metadata` is the parsed sonoDrop QR payload (host, port, patientId, etc.).
 * No API key is required — only a reachable Ollama server at config.baseUrl.
 */
export async function getOllamaCounsel(
  patientId: string,
  metadata: any,
  config: OllamaConfig = DEFAULT_OLLAMA_CONFIG,
): Promise<OllamaCounselResponse> {
  const shortTimeout = config.timeout ?? 15000;

  const short = shortTimeoutMs(config.timeout);

  const prompt = buildUltrasoundAnalysisPrompt(
    patientId,
    '',
    [
      `Station: ${metadata?.ssid ?? 'P50'}`,
      `Export host: ${metadata?.host ?? 'unknown'}`,
      `Patient: ${patientId}`,
    ],
    [],
    ['Awaiting device transfer.'],
  );

  try {
    const result = await callOllamaApi(
      { ...config, timeout: short },
      {
        model: config.model,
        prompt,
        stream: false,
        options: { temperature: 0.4, num_predict: 120 },
      },
    );
    const text = result.response?.trim();
    if (text) {
      return { message: text };
    }
  } catch (e) {
    console.warn('Ollama counsel unavailable, using built-in fallback:', e);
  }

  return fallbackCounsel(patientId);
}

/** Built-in response when no local Ollama server is reachable. */
export function fallbackCounsel(patientId: string): OllamaCounselResponse {
  return {
    message: `The export details for patient ${patientId || 'this study'} were read from the SonoScape QR. ` +
      'Start a local Ollama server (ollama run llama3.2) to add AI analysis automatically.',
  };
}

/* Wrap small timer guards (kept tiny to avoid blocking the scan flow). */
function shortTimeoutMs(t?: number): number {
  return t && isFinite(t) ? t : 15000;
}