import Constants from 'expo-constants';

const MULE_ROUTER_API_KEY = Constants.expoConfig?.extra?.muleRouterApiKey;
const BASE_URL = 'https://api.mulerouter.ai/v1';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export const AiService = {
  async chatCompletion(messages: ChatMessage[], model: string = 'qwen3.7-max') {
    if (!MULE_ROUTER_API_KEY) {
      console.error('MuleRouter API Key is missing!');
      return null;
    }

    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MULE_ROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`MuleRouter Error: ${error}`);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error('AI Service Error:', error);
      return null;
    }
  },
};
