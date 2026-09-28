/**
 * aiCounsel.ts
 *
 * AI-assisted scan counsel for the pairing flow. Two providers, tried in
 * order by PairingScreen:
 *
 *  1. getOllamaCounsel — local Ollama server (http://localhost:11434 via the
 *     host machine / dev tunnel). No API key needed. Preferred because patient
 *     metadata never leaves the device LAN.
 *  2. getScanCounsel — Groq cloud API. Only used when Ollama is unreachable.
 *     Requires the GROQ_API_KEY constant below to be filled in; without it
 *     this returns null immediately, which the caller treats as "no counsel".
 *
 * Both functions resolve to null on ANY failure (network, JSON, model error) —
 * they never throw, so the pairing flow can continue without counsel text.
 */

import type { SonoDropQRInfo } from '../protocol/sonoDropProtocol';

export interface CounselResult {
  message: string;
  source: 'ollama' | 'groq';
}

/** Set this to enable the Groq fallback (https://console.groq.com/keys). */
const GROQ_API_KEY = '';

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'llama3.2';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

const REQUEST_TIMEOUT_MS = 12_000;

function buildPrompt(patientId: string, parsed: SonoDropQRInfo): string {
  return (
    `You are a ultrasound workflow assistant. A sonographer just paired with a ` +
    `SonoScape scanner via QR. Patient ID: ${patientId || 'unknown'}. ` +
    `Scanner host: ${parsed.host}:${parsed.port}, wifi: ${parsed.ssid} (${parsed.encryptionName}). ` +
    `Write a 2-3 sentence clinical-ops summary: what to check on the pairing, ` +
    `and a reminder about DICOM export. Be concise and factual. No medical advice.`
  );
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Local Ollama counsel. Returns null if Ollama is unreachable or errors. */
export async function getOllamaCounsel(
  patientId: string,
  parsed: SonoDropQRInfo,
): Promise<CounselResult | null> {
  try {
    const res = await fetchWithTimeout(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildPrompt(patientId, parsed),
        stream: false,
        options: { temperature: 0.4, num_predict: 160 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.response;
    if (!text || !text.trim()) return null;
    return { message: text.trim(), source: 'ollama' };
  } catch {
    return null;
  }
}

/** Groq cloud counsel. Returns null without a key or on any failure. */
export async function getScanCounsel(
  patientId: string,
  parsed: SonoDropQRInfo,
): Promise<CounselResult | null> {
  if (!GROQ_API_KEY) return null;
  try {
    const res = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: 'You are a concise ultrasound workflow assistant.' },
          { role: 'user', content: buildPrompt(patientId, parsed) },
        ],
        temperature: 0.4,
        max_tokens: 160,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string | undefined = data?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) return null;
    return { message: text.trim(), source: 'groq' };
  } catch {
    return null;
  }
}