import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize OpenAI client configured for Nebius Token Factory
const nebiusClient = new OpenAI({
  baseURL: process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: process.env.NEBIUS_API_KEY || 'dummy_key'
});

app.post('/api/policy', async (req, res) => {
  const { userInstruction } = req.body;

  // 1. MOCK MODE (For local offline testing / before Builder credits arrive)
  if (process.env.USE_MOCK_NVIDIA === 'true' || !process.env.NEBIUS_API_KEY) {
    return res.status(200).json({
      success: true,
      mode: 'MOCK',
      policy: {
        rules: [
          { category: 'email', action: 'redact' },
          { category: 'phone', action: 'redact' },
          { category: 'identity_card', action: 'redact' },
          { category: 'salary', action: 'review' }
        ],
        explanation: `Generated security policy for: "${userInstruction || 'Default Rules'}" via Nemotron (Mock Mode).`
      }
    });
  }

  // 2. LIVE NEBIUS TOKEN FACTORY CALL
  try {
    const completion = await nebiusClient.chat.completions.create({
      model: process.env.NEBIUS_MODEL || 'nvidia/Nemotron-3.5-Lightning',
      messages: [
        {
          role: 'system',
          content: 'You are Tecto Nebius policy engine. Output JSON containing data masking rules (categories: phone, email, identity_card, financial) based on user instructions.'
        },
        { role: 'user', content: userInstruction }
      ],
      response_format: { type: 'json_object' }
    });

    const policy = JSON.parse(completion.choices[0].message.content);
    return res.status(200).json({ success: true, mode: 'LIVE', policy });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🛡️ Tecto Nebius Backend running on http://localhost:${PORT}`);
});