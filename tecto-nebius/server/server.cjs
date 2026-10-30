require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

if (!process.env.NEBIUS_API_KEY) {
  console.error('NEBIUS_API_KEY missing. Check the .env file.');
  process.exit(1);
}

const client = new OpenAI({
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: process.env.NEBIUS_API_KEY
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const SYSTEM_PROMPT =
  'You are a privacy filter. Find ONLY direct identifiers of a real person in the text: ' +
  'full names of people, street addresses, school or workplace names tied to a person, ' +
  'and ID or account numbers. ' +
  'Do NOT flag feelings, events, health or mental health details, opinions, ' +
  'or general places like a city name. ' +
  'Reply ONLY with JSON: {"leaks":["exact substring from the text"]}. ' +
  'If there is nothing, reply {"leaks":[]}. ' +
  'Ignore tokens like [PAN REDACTED].';

function parseLeaks(raw) {
  const cleaned = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json|```/g, '')
    .trim();

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];

  const json = JSON.parse(match[0]);
  return Array.isArray(json.leaks) ? json.leaks : [];
}

app.post('/check', async (req, res) => {
  const text = String(req.body.text || '');
  console.log('\n[check] text length:', text.length);

  try {
    const out = await client.chat.completions.create({
      model: 'nvidia/nemotron-3-super-120b-a12b',
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text }
      ]
    });

    const raw = out.choices[0].message.content || '';
    console.log('[check] model said:', raw);

    const leaks = parseLeaks(raw).filter(l => typeof l === 'string' && text.includes(l));
    console.log('[check] leaks found:', leaks);

    res.json({ leaks });
  } catch (e) {
    console.error('[check] error:', e.message);
    res.status(500).json({ error: e.message, leaks: [] });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log('Tecto AI check on http://localhost:' + PORT));