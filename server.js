import 'dotenv/config';
import { createApp } from './src/app.js';
import { readConfig } from './src/config.js';

const config = readConfig();
const app = await createApp({ config });
app.listen(config.port, () => {
  console.log(`SourcePad: ${config.appURL} · autenticación: ${config.authProvider}`);
  if (config.authProvider === 'supabase' && !config.supabaseReady) {
    console.log('Supabase pendiente. Configurá las variables indicadas en .env.example.');
  }
});
