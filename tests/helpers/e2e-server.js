import { fakeSupabase } from './fake-supabase.js';
import { createApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import express from 'express';
import { fixtureEmbedder } from './embedding-fixture.js';
import { rateLimit, MemoryStore } from 'express-rate-limit';

const fake = await fakeSupabase();
const limiterStores = [];
const streamGates=new Map();
function waitForRelease(query,signal){
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{streamGates.delete(query);signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason);};
    if(signal.aborted)return reject(signal.reason);
    streamGates.set(query,()=>{cleanup();resolve();});signal.addEventListener('abort',abort,{once:true});
  });
}
const config = readConfig({ PORT: '4317', APP_URL: 'http://127.0.0.1:4317', AUTH_PROVIDER: 'supabase', SUPABASE_URL: fake.url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OPENROUTER_API_KEY: 'test-not-real' });
const appOptions = {
  config, embedder: fixtureEmbedder, chatStream: async (messages,signal,options) => (async function* () {
    let content = '**Respuesta de prueba**';
    const generalQuery=messages.at(-1)?.content;
    if(!options?.grounded&&generalQuery?.startsWith('QA_GENERAL_STREAM_')){
      if(generalQuery.includes('BEFORE'))await waitForRelease(generalQuery,signal);
      yield {choices:[{delta:{content:'Parte recibida 😎.'}}]};
      await waitForRelease(generalQuery,signal);signal.throwIfAborted();
      yield {choices:[{delta:{content:' Final.'}}]};return;
    }
    if (options?.grounded) {
      const { question,untrustedSources } = JSON.parse(messages[1].content);
      const source = untrustedSources[0];
      if(question.startsWith('QA_STREAM_')){
        const segment=text=>({text,citations:[{sourceId:source.id}]});
        const first=segment('Primer bloque validado.');
        if(question.includes('LAYOUT'))first.text='Primer bloque validado.\n'+'Concepto respaldado.\n'.repeat(35);
        if(question.includes('EMPTY_FIRST'))first.citations=[{}];
        if(question.includes('MULTI'))first.citations.push({sourceId:source.id});
        yield {choices:[{delta:{content:'{"insufficientEvidence":false,"segments":['+JSON.stringify(first)}}]};
        await waitForRelease(question,signal);signal.throwIfAborted();
        if(question.includes('TRUNCATED')){yield {choices:[{delta:{},finish_reason:'length'}]};return;}
        const second=segment('Segundo bloque:\n• Energía solar.\n• Fuente renovable.');
        if(question.includes('INVALID'))second.citations[0].sourceId='F99';
        yield {choices:[{delta:{content:','+JSON.stringify(second)+']}'}}]};return;
      }
      content = JSON.stringify(question.includes('sin evidencia')
        ? { insufficientEvidence: true,segments: [] }
        : { insufficientEvidence: false,segments: [{ text: 'Según el documento: ' + source.text,citations: [{ sourceId: source.id }] }] });
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
testApp.post('/__test/reset',async (req,res) => {for(const release of streamGates.values())release();await Promise.all(limiterStores.map(store => store.resetAll())); res.sendStatus(204); });
testApp.get('/__test/stream-state',(req,res)=>res.json({waiting:streamGates.has(req.query.query)}));
testApp.post('/__test/release-stream',express.json(),(req,res)=>{streamGates.get(req.body.query)?.();res.sendStatus(204);});
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
