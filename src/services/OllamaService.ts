

/** Configuration for connecting to a local Ollama server. */
export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeout?: number;
  fallbackModel?: string;
}

/** Default Ollama configuration — assumes Ollama is on the local network. */
export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  baseUrl: 'http://192.168.1.100:11434',
  model: 'llama3.2',
  timeout: 30000,
  fallbackModel: 'llama3',
};

/** Request body sent to the Ollama /api/generate endpoint. */
export interface OllamaRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: {
    temperature?: number;
    num_predict?: number;
    top_k?: number;
    top_p?: number;
  };
}

/** A non-streaming response complete result. */
export interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
  context?: number[];
}

/** A single streaming response chunk (when stream: true). */
export interface OllamaStreamChunk {
  model: string;
  response: string;
  done: boolean;
}

/** Internal: convert an OllamaRequest into the JSON body the API expects. */
export function buildOllamaRequestBody(request: OllamaRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    stream: request.stream ?? false,
  };
  if (request.options) {
    body.options = {};
    const opts = request.options;
    if (opts.temperature !== undefined) (body.options as Record<string, unknown>).temperature = opts.temperature;
    if (opts.num_predict !== undefined) (body.options as Record<string, unknown>).num_predict = opts.num_predict;
    if (opts.top_k !== undefined) (body.options as Record<string, unknown>).top_k = opts.top_k;
    if (opts.top_p !== undefined) (body.options as Record<string, unknown>).top_p = opts.top_p;
  }
    return body;
}

/**
 * Send a request to the Ollama API and return the full response.
 *
 * Uses the standard fetch API (available in React Native via the polyfills
 * bundled with Expo). The `timeout` in OllamaConfig is enforced via
 * AbortController, since React Native's fetch does not support a `timeout`
 * property natively.
 */
export async function callOllamaApi(
  config: OllamaConfig,
  request: OllamaRequest,
): Promise<OllamaResponse> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/generate`;
  const body = buildOllamaRequestBody({ ...request, stream: request.stream ?? false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Ollama error (HTTP ${response.status}): ${errorText}`);
    }

        const data = (await response.json()) as OllamaResponse;
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a streaming request to the Ollama API.
 * Calls `onChunk` for each partial response, then resolves with the full text.
 */
export async function callOllamaStream(
  config: OllamaConfig,
  request: OllamaRequest,
  onChunk: (chunk: OllamaStreamChunk) => void,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/generate`;
  const body = buildOllamaRequestBody({ ...request, stream: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Ollama streaming error (HTTP ${response.status}): ${errorText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter((line) => line.trim());
        for (const line of lines) {
          try {
            const chunk = JSON.parse(line) as OllamaStreamChunk;
            onChunk(chunk);
            if (chunk.done) break;
            fullText += chunk.response;
          } catch {
            // Skip non-JSON lines (keep-alive newlines)
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

        return fullText;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a clinical analysis prompt for ultrasound scans.
 * Produces a concise instruction for an AI to summarize an ultrasound
 * examination given patient/study identifiers and structured findings.
 */
export function buildUltrasoundAnalysisPrompt(
  patientId: string,
  studyId: string,
  findings: string[],
  measurements: string[] = [],
  impressions: string[] = [],
): string {
  const findingsSection = findings.length > 0
    ? `- Findings: ${findings.join(', ')}\n`
    : '';

  const measurementsSection = measurements.length > 0
    ? `- Measurements: ${measurements.join(', ')}\n`
    : '';

  const impressionsSection = impressions.length > 0
    ? `- Impression: ${impressions.join('; ')}`
    : '- Impression: Awaiting AI analysis';

  return `You are a medical AI assistant for an ultrasound imaging app.
Provide a concise clinical summary for the following ultrasound examination:

Patient ID: ${patientId}
Study ID: ${studyId}

${findingsSection}${measurementsSection}${impressionsSection}

Keep the response under 3 sentences. Focus on clinical relevance and next steps.`;
}

/**
 * Build a device connection analysis prompt for the AI assistant.
 */
export function buildDeviceAnalysisPrompt(
  connected: boolean,
  deviceType: string,
  connectionDetails: string,
  lastSeen: string,
): string {
  return `You are a medical imaging app assistant. Provide a brief status report:

Device: ${deviceType}
Connection Status: ${connected ? 'Connected' : 'Disconnected'}
Connection Details: ${connectionDetails}
Last Seen: ${lastSeen}

Provide immediate action items if disconnected, or confirmation if connected. Keep it under 2 sentences.`;
}

