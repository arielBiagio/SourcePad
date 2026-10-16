import { fakeSupabase } from './fake-supabase.js';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import express from 'express';
import { fixtureEmbedder } from './embedding-fixture.js';
import { rateLimit, MemoryStore } from 'express-rate-limit';

const fake = await fakeSupabase();
const limiterStores = [];
const config = readConfig({ PORT: '4317', APP_URL: 'http://127.0.0.1:4317', AUTH_PROVIDER: 'supabase', SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OPENROUTER_API_KEY: 'test-not-real' });
const appOptions = {
  config, embedder: fixtureEmbedder, chatStream: async (messages,signal,options) => (async function* () {
    let content = '**Respuesta de prueba**';
    if (options?.grounded) {
      const { question,untrustedSources } = JSON.parse(messages[1].content);
      const source = untrustedSources[0];
      content = JSON.stringify(question.includes('sin evidencia')
        ? { insufficientEvidence: true,segments: [] }
        : { insufficientEvidence: false,segments: [{ text: 'Según el documento: ' + source.text,citations: [{ sourceId: source.id,quote: source.text.slice(0,200) }] }] });
    }
    yield { choices: [{ delta: { content } }] };
  })(),
  rateLimitFactory: options => {
    const store = new MemoryStore(); limiterStores.push(store);
    return rateLimit({ ...options,store });
  },
};
const app = await createApp(appOptions);
// Endpoint de fixture: este archivo sólo arranca en Playwright, nunca en producción.
const testApp = express();
// Cada caso recibe sus propios limitadores en memoria. No cambia límites reales.
testApp.post('/__test/reset',async (req,res) => { await Promise.all(limiterStores.map(store => store.resetAll())); res.sendStatus(204); });
testApp.get('/__test/confirmation-link', (req, res) => {
  const link = fake.confirmationLink(req.query.email);
  res.status(link ? 200 : 404).json({ link });
});
testApp.use(app);
const server = testApp.listen(config.port, '127.0.0.1', () => console.log('Servidor E2E local listo'));
async function close() {
  server.closeAllConnections();
  server.close();
  await fake.close();
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
