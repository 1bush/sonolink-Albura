/**
 * GroqService.ts
 *
 * Provides AI-powered insights for ultrasound scans using Groq's Llama-3-70b.
 * Used for the "Counsel" feature in the scanning UI.
 */

// Groq is optional. Never commit an API key to the mobile bundle; use a
// server-side proxy or secure runtime configuration if this fallback is needed.
const GROQ_API_KEY = '';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface GroqResponse {
  message: string;
}

export async function getScanCounsel(patientId: string, metadata: any): Promise<GroqResponse> {
  if (!GROQ_API_KEY) {
    return {
      message: 'The SonoScape export QR is automatically recognized — the station, file number, and export ID are displayed in the scan details.'
    };
  }

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama3-70b-8192',
        messages: [
          {
            role: 'system',
            content: 'You are an assistant for SonoLink, a medical imaging app. Provide a short, helpful summary about the scan status or device connection based on the provided metadata. Keep it under 2 sentences.'
          },
          {
            role: 'user',
            content: `Patient ID: ${patientId}. Metadata: ${JSON.stringify(metadata)}`
          }
        ],
        temperature: 0.5,
        max_tokens: 100,
      }),
    });

    const data = await response.json();
    return {
      message: data.choices[0]?.message?.content || 'Status recognized successfully.'
    };
  } catch (error) {
    console.error('Groq AI Error:', error);
    return {
      message: 'Automatic recognition active. Waiting for file transfer...'
    };
  }
}
