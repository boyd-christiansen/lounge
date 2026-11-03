import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

// Direct API client only. The CLI is never invoked by the application.
// Credentials stay on the server and never enter queue state or browser storage.
const requestOptions = { maxRetries: 0, timeoutInSeconds: 15 };
export function speechFailure(error) {
  const detail=error.body?.detail;
  if(error.statusCode===402 && /free users cannot use library voices via the api/i.test(String(detail?.message || '')))
    return 'Your free plan includes API access, but this Voice Library voice requires a paid plan. Choose a default voice to stay free, or upgrade and press Listen to retry.';
  if(error.statusCode===402 && /quota|insufficient.*credits|credits.*exhausted/i.test(String(detail?.status || '')))
    return 'Your ElevenLabs voice credits are exhausted. Check your available credits, then press Listen to retry.';
  if(error.statusCode===401)return 'Reconnect your ElevenLabs voice key';
  if(error.statusCode===402)return 'ElevenLabs requires payment for this request (402). Check your account’s billing or access, then press Listen to retry.';
  if(error.statusCode===429)return 'ElevenLabs credits or rate limit reached. Check your voice account, then press Listen to retry.';
  return 'ElevenLabs could not generate the voice. Try again shortly.';
}
export class Speech {
  constructor({ key = process.env.ELEVENLABS_API_KEY || '', clientFactory = apiKey => new ElevenLabsClient({ apiKey }) } = {}) {
    this.key = key; this.clientFactory = clientFactory; this.client = null;
    this.voices = []; this.active = 0; this.lastError = null; this.cache = new Map(); this.playbackError = null;
  }
  state() { return { ready: !!this.client, configured: !!this.key, voices: this.voices, provider: 'elevenlabs', error: this.lastError }; }
  async initialize() {
    if (!this.key) return this.state();
    try { return await this.connect(this.key); }
    catch (error) { this.lastError = error.message; throw error; }
  }
  async connect(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 300 || /[\r\n]/.test(key)) throw new Error('Enter an ElevenLabs API key');
    const client = this.clientFactory(key.trim());
    let data;
    try {
      // Listing voices verifies the connection without generating paid audio.
      data = await client.voices.search({ pageSize: 100 }, requestOptions);
    } catch (error) {
      throw new Error(error.statusCode === 401 ? 'ElevenLabs did not accept that key' : 'ElevenLabs could not list voices. Check the connection and key’s voice permissions.');
    }
    this.voices = (data.voices || []).filter(v => /^[A-Za-z0-9_-]{1,100}$/.test(v.voiceId)).map(v => ({ id: v.voiceId, name: String(v.name).slice(0, 100), ...(v.category?{category:v.category,libraryVoice:v.category==='professional'&&!!v.sharing&&!v.isOwner}:{}) }));
    this.cache.clear(); this.playbackError=null; this.key = key.trim(); this.client = client; this.lastError = null; return this.state();
  }
  disconnect() { this.cache.clear(); this.playbackError=null; this.key = ''; this.client = null; this.voices = []; this.lastError = null; return this.state(); }
  cachedGenerate(input) {
    if(input.retry===true){this.playbackError=null;this.lastError=null;}
    if(this.playbackError)return Promise.reject(new Error(this.playbackError));
    const key=JSON.stringify([input.text,input.voiceId || 'KH1SQLVulwP6uG4O3nmT',input.rate ?? 1,input.tone || 'natural']);
    const cached=this.cache.get(key);
    if(input.retry===true&&cached?.failed)this.cache.delete(key);
    else if(cached && Date.now()-cached.at<10*60*1000)return cached.promise;
    // Share a single paid generation between prefetch and playback. Cancelling
    // playback does not replay it or cancel another consumer's request.
    const entry={at:Date.now(),promise:this.generate(input)};
    this.cache.set(key,entry);
    while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);
    entry.promise.catch(error=>{entry.failed=true;this.playbackError=error.message;this.lastError=error.message;});
    return entry.promise;
  }
  async generate({ text, voiceId = 'KH1SQLVulwP6uG4O3nmT', rate = 1,tone='natural' }, signal) {
    if (!this.client) throw new Error('Connect ElevenLabs in Voice settings to use natural speech');
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) throw new Error('Read-aloud text must be between 1 and 5,000 characters');
    if (typeof voiceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(voiceId)) throw new Error('Choose a valid voice');
    if (!Number.isFinite(rate) || rate < .7 || rate > 1.2) throw new Error('Choose a speaking pace between 0.7 and 1.2');
    if(!['natural','upbeat'].includes(tone))throw new Error('Choose natural or upbeat delivery');
    if (this.active >= 2) throw new Error('A voice request is already in progress');
    this.active++;
    try {
      const audio = await this.client.textToSpeech.convert(voiceId, {
        text, modelId: 'eleven_multilingual_v2', outputFormat: 'mp3_44100_128',
        voiceSettings: { stability: tone==='upbeat'?.32:.45, similarityBoost: .75, style: tone==='upbeat'?.25:.15, useSpeakerBoost: true, speed: rate },
      }, { maxRetries: 0, timeoutInSeconds: 45, abortSignal: signal });
      const chunks = [];
      for await (const chunk of audio) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    } catch (error) {
      if (signal?.aborted) throw new Error('Voice playback was cancelled');
      throw new Error(speechFailure(error));
    } finally { this.active--; }
  }
}
