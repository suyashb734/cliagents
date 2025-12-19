const fs = require('fs');
const OpenAI = require('openai');

// Lazy initialization - only create client when needed
let openai = null;

function getOpenAIClient() {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY environment variable is required for transcription');
    }
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openai;
}

async function transcribeAudio(audioFilePath) {
  try {
    const client = getOpenAIClient();
    const transcript = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: "whisper-1",
    });
    return transcript.text;
  } catch (error) {
    console.error('Error transcribing audio:', error);
    throw error;
  }
}

module.exports = { transcribeAudio };
