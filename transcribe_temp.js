
const { transcribeAudio } = require('./src/services/transcriptionService');
const path = require('path');

async function runTranscription() {
  const audioFilePath = path.join(__dirname, 'voice-input.m4a');
  try {
    const transcript = await transcribeAudio(audioFilePath);
    console.log(transcript);
  } catch (error) {
    console.error('Transcription failed:', error.message);
    process.exit(1);
  }
}

runTranscription();
