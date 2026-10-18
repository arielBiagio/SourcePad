import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { pdfFixture } from '../helpers/pdf-fixture.js';

async function selectPanel(page,name) {
  if (page.viewportSize().width <= 900) await page.locator(`[data-show-panel="${name}"]`).click();
}
async function openUpload(page) {
  if (await page.locator('#uploadDialog').isVisible()) return;
  await selectPanel(page,'sources'); await page.locator('#addSources').click();
  await expect(page.getByRole('dialog',{ name: 'Agregá tus fuentes' })).toBeVisible();
}
async function chatOptions(page) {
  await selectPanel(page,'chat');
}
async function sourceOptions(page,filename) {
  await selectPanel(page,'sources');
  const details = page.locator('.source-row').filter({has:page.getByRole('button',{name:'Abrir fuente '+filename,exact:true})}).locator('.source-details');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
}

test.beforeEach(async ({ page,request }) => {
  expect((await request.post('/__test/reset')).status()).toBe(204);
  // El navegador de QA sólo consume localhost; se omiten CDN/fuentes externas.
  await page.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    return ['127.0.0.1', 'localhost'].includes(host) ? route.continue() : route.abort();
  });
});

test('sin demo: preview no evita la sesión y el CRUD usa la cuenta',async({page})=>{
  await page.goto('/notebooks.html?preview=1');
  await expect(page).toHaveURL(/auth.html$/);
  await expect(page.getByRole('link',{name:/ejemplo|prueba/i})).toHaveCount(0);
  await createSourceNotebook(page);
  await page.goto('/notebooks.html?preview=1');
  await expect(page).not.toHaveURL(/preview=/);
  await expect(page.locator('#notebookGrid .card')).toHaveCount(1);
  await page.getByRole('heading',{name:'Biblioteca de prueba',exact:true}).click();
  await selectPanel(page,'tools');await page.locator('#editNotebook').click();
  await page.getByLabel('Título',{exact:true}).fill('Cuaderno editado');
  await page.getByRole('button',{name:'Guardar cambios'}).click();
  await expect(page.locator('#detailTitle')).toHaveText('Cuaderno editado');
  await selectPanel(page,'tools');await page.locator('#deleteNotebook').click();
  await page.getByRole('dialog',{name:'Eliminar cuaderno'}).getByRole('button',{name:'Eliminar cuaderno'}).click();
  await expect(page.locator('#notebookGrid .card')).toHaveCount(0);
});

test('interfaz unificada: login sin scroll, navegación activa y sin textos accesorios',async({page},testInfo)=>{
  await page.goto('/auth.html');
  for(const id of ['signInTab','signUpTab']){
    await page.locator('#'+id).click();
    expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('.auth-shell')).toBeInViewport();
  }
  await page.screenshot({path:'qa-artifacts/login-clean-'+testInfo.project.name+'.png',fullPage:true});
  await createSourceNotebook(page);
  const background=await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor);
  await expect(page.locator('.app-nav').getByRole('link',{name:/Cuadernos/})).toHaveAttribute('aria-current','page');
  await expect(page.getByText('Un espacio separado para cada tema, proyecto o idea.')).toHaveCount(0);
  await expect(page.locator('.sidebar-note')).toHaveCount(0);
  await page.locator('.app-nav').getByRole('link',{name:'Chat general',exact:true}).click();
  await expect(page.locator('.app-nav').getByRole('link',{name:'Chat general',exact:true})).toHaveAttribute('aria-current','page');
  expect(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe(background);
  await expect(page.locator('#messages')).toBeEmpty();
  await expect(page.getByText('Enter para enviar · Shift+Enter para salto de línea')).toHaveCount(0);
  await page.screenshot({path:'qa-artifacts/general-clean-'+testInfo.project.name+'.png',fullPage:true});
});

test('los controles esperan la carga del módulo antes de admitir clics',async({page})=>{
  await createSourceNotebook(page);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/assets/notebooks.js?*',async route=>{await gate;await route.continue();});
  await page.goto('/notebooks.html',{waitUntil:'commit'});
  try{await expect(page.locator('#createNotebook')).toBeDisabled();}finally{release();}
  await expect(page.locator('#createNotebook')).toBeEnabled();
  await page.locator('#createNotebook').click();
  await expect(page.locator('#notebookDialog')).toBeVisible();
});

test('original ocupa todo el viewport y el visor de citas sigue compacto',async({page},testInfo)=>{
  await createSourceNotebook(page);
  await uploadAndProcess(page,[
    {name:'original.pdf',mimeType:'application/pdf',buffer:pdfFixture(['Documento sintetico para revisar el original.','Segunda pagina del documento sintetico.'])},
    {name:'original.txt',mimeType:'text/plain',buffer:Buffer.from('Texto original sintético.')},
  ]);
  for(const name of ['original.pdf','original.txt']){
    await sourceOptions(page,name);
    await page.getByRole('button',{name:'Ver texto de '+name,exact:true}).click();
    await page.locator('#showOriginal').click();
    await expect(page.locator('#sourceTextPanel')).toHaveClass(/is-original/);
    await expect(page.locator(name.endsWith('.pdf')?'#originalPreview canvas':'#originalPreview pre')).toBeVisible();
    const rect=await page.locator('#sourceTextPanel').boundingBox(),size=page.viewportSize();
    expect(rect.width).toBeGreaterThanOrEqual(size.width-2);expect(rect.height).toBeGreaterThanOrEqual(size.height-2);
    if(name.endsWith('.pdf')){
      const canvas=page.locator('#originalPreview canvas');
      await expect(page.getByRole('button',{name:'Página siguiente',exact:true})).toBeEnabled();
      // Verifica tinta real: un rectángulo blanco no es una vista previa válida.
      expect(await canvas.evaluate(el=>{
        const data=el.getContext('2d').getImageData(0,0,el.width,el.height).data;
        let ink=0;for(let i=0;i<data.length;i+=4)if(data[i+3]&&data[i]<180&&data[i+1]<180&&data[i+2]<180)ink++;
        return ink;
      })).toBeGreaterThan(50);
      await page.getByRole('button',{name:'Página siguiente',exact:true}).click();
      await expect(canvas).toHaveAttribute('aria-label','Página 2 de 2');
      await expect(page.getByRole('button',{name:'Página anterior',exact:true})).toBeEnabled();
      await expect(page.getByRole('button',{name:'Página siguiente',exact:true})).toBeDisabled();
      const width=(await canvas.boundingBox()).width;
      await page.getByRole('button',{name:'Acercar PDF',exact:true}).click();
      await expect.poll(async()=>(await canvas.boundingBox()).width).toBeGreaterThan(width);
      await expect(page.getByRole('button',{name:'Alejar PDF',exact:true})).toBeEnabled();
    }
    await page.screenshot({path:'qa-artifacts/full-original-'+name+'-'+testInfo.project.name+'.png',fullPage:true});
    await page.locator('#closeSourceText').click();
    await expect(page.locator('#sourceTextPanel')).not.toHaveClass(/is-original/);
  }
});

test('historial abre al final y streaming ancla la pregunta sin arrastrar la lectura',async({page})=>{
  await streamingNotebook(page);
  const source={id:'F1',filename:'solar.txt',position:0,page_number:null,content:'La energía solar proviene del sol.'};
  const fixture={turns:Array.from({length:20},(_,i)=>({id:randomUUID(),question:'Pregunta previa '+i,answer:{insufficientEvidence:false,sources:[source],segments:[{text:'Contenido anterior. '.repeat(50),citations:[{sourceId:'F1',quote:source.content,kind:'source_reference'}]}]}})),hasMore:false};
  await page.route('**/conversation',route=>route.fulfill({json:fixture}));await page.reload();
  await expect(page.locator('#latestQuestion')).toHaveText('Pregunta previa 19');
  await expect.poll(()=>page.locator('#chatScroll').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThanOrEqual(2);
  await page.unroute('**/conversation');
  const query='QA_STREAM_LAYOUT_'+randomUUID();
  await page.locator('#semanticQuery').fill(query);await page.locator('#semanticQuery').press('Enter');
  let anchor;
  try{
    await expect(page.locator('#streamingBlocks .rag-paragraph')).toHaveCount(1);
    const positions=await page.locator('#chatScroll').evaluate(el=>({top:el.getBoundingClientRect().top+parseFloat(getComputedStyle(el).paddingTop),question:document.getElementById('streamingQuestion').getBoundingClientRect().top}));
    expect(Math.abs(positions.top-positions.question)).toBeLessThanOrEqual(3);
    await page.locator('#chatScroll').evaluate(el=>{el.scrollTop+=120;});
    anchor=(await page.locator('#streamingQuestion').boundingBox()).y;
  }finally{await page.request.post('/__test/release-stream',{data:{query}});}
  await expect(page.locator('#streamingTurn')).toBeHidden();
  expect(Math.abs((await page.locator('#latestQuestion').boundingBox()).y-anchor)).toBeLessThanOrEqual(3);
  await page.reload();await expect(page.locator('#latestQuestion')).toHaveText(query);
  await expect.poll(()=>page.locator('#chatScroll').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThanOrEqual(2);
});

test('registro a cuadernos, persistencia al recargar, chat y logout', async ({ page }) => {
  await page.goto('/auth.html');
  await page.getByRole('tab', { name: 'Crear cuenta' }).click();
  await page.getByLabel('Nombre').fill('Persona de prueba');
  await page.locator('#signUpEmail').fill(randomUUID() + '@example.test');
  await page.locator('#signUpPassword').fill('Testing123!');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page).toHaveURL(/notebooks.html$/);
  await page.getByRole('button', { name: '+ Nuevo cuaderno' }).click();
  await page.getByLabel('Título', { exact: true }).fill('Persistente');
  await page.getByRole('button', { name: 'Crear cuaderno', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Persistente' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Persistente' })).toBeVisible();
  await page.getByRole('link', { name: /Chat general/ }).click();
  await page.locator('#userInput').fill('Hola');
  await page.locator('#chatForm').evaluate(form => form.requestSubmit());
  await expect(page.locator('#messages strong')).toHaveText('Respuesta de prueba');
  await page.locator('#logoutBtn').click();
  await expect(page).toHaveURL(/auth.html$/);
  await page.goto('/notebooks.html');
  await expect(page).toHaveURL(/auth.html$/);
});

test('chat muestra límite del proveedor sin cerrar sesión y permite volver a enviar', async ({ page }) => {
  await createSourceNotebook(page);
  await page.route('**/api/chat',route => route.fulfill({ status: 429,json: {
    error: 'OpenRouter o el proveedor del modelo limitó las solicitudes (429). Esperá antes de reintentar.',code: 'CHAT_RATE_LIMIT',
  } }));
  await page.goto('/index.html');
  await page.locator('#userInput').fill('Fixture');
  await page.locator('#chatForm').evaluate(form => form.requestSubmit());
  await expect(page.locator('#messages')).toContainText('limitó las solicitudes (429)');
  await expect(page).toHaveURL(/index.html$/);
  await expect(page.locator('#userInput')).toBeEnabled();
  await expect(page.locator('#sendBtn')).toBeEnabled();
  await page.unroute('**/api/chat');
  await page.locator('#userInput').fill('Reintento');
  await page.locator('#chatForm').evaluate(form => form.requestSubmit());
  await expect(page.locator('#messages strong')).toHaveText('Respuesta de prueba');
});

test('chat general limita el contexto y agrupa el renderizado sin retraso por letra',async({page})=>{
  await createSourceNotebook(page);
  const bodies=[];
  await page.route('**/api/chat',route=>{
    bodies.push(route.request().postDataJSON());
    return route.fulfill({contentType:'text/plain',body:'**Resumen** '+ 'Texto sintético 😎. '.repeat(600)});
  });
  await page.goto('/index.html');
  await page.evaluate(()=>{const original=window.marked.parse;window.qaParseCalls=0;window.marked.parse=(...args)=>{window.qaParseCalls++;return original(...args);};});
  for(let i=0;i<8;i++){
    await page.locator('#userInput').fill('Consulta '+i+' '+ 'x'.repeat(2000));
    await page.locator('#chatForm').evaluate(form=>form.requestSubmit());
    await expect(page.locator('#userInput')).toBeEnabled();
    await expect(page.locator('#messages strong')).toHaveCount(i+1);
    const geometry=await page.locator('#messages').evaluate(el=>({
      top:el.getBoundingClientRect().top+parseFloat(getComputedStyle(el).paddingTop),
      question:el.lastElementChild.querySelector('.items-end>div').getBoundingClientRect().top,
      overflow:el.scrollWidth-el.clientWidth,
    }));
    expect(Math.abs(geometry.top-geometry.question)).toBeLessThanOrEqual(3);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
  }
  expect(bodies).toHaveLength(8);
  expect(bodies.every(body=>body.historial.length<=6&&Buffer.byteLength(JSON.stringify(body))<=120*1024)).toBe(true);
  expect(bodies.at(-1).historial.at(-1).content).toContain('Consulta 7');
  expect(await page.evaluate(()=>window.qaParseCalls)).toBeLessThanOrEqual(32);
});

test('chat general cancela antes y después del primer chunk sin duplicar respuestas ni reintentar',async({page})=>{
  await createSourceNotebook(page);await page.goto('/index.html');const requests=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/chat')requests.push(request.postDataJSON());});
  for(const suffix of ['BEFORE','AFTER']){
    const query='QA_GENERAL_STREAM_'+suffix+'_'+randomUUID();
    await page.locator('#userInput').fill(query);await page.locator('#chatForm').evaluate(form=>form.requestSubmit());
    await expect.poll(async()=>(await(await page.request.get('/__test/stream-state',{params:{query}})).json()).waiting).toBe(true);
    if(suffix==='AFTER'){
      await expect(page.locator('#messages')).toContainText('Parte recibida 😎.');
      const offset=await page.locator('#messages').evaluate(el=>el.lastElementChild.querySelector('.items-end>div').getBoundingClientRect().top-el.getBoundingClientRect().top-parseFloat(getComputedStyle(el).paddingTop));
      expect(Math.abs(offset)).toBeLessThanOrEqual(3);
    }
    await page.locator('#cancelBtn').click();await expect(page.locator('#userInput')).toBeEnabled();
    await expect.poll(async()=>(await(await page.request.get('/__test/stream-state',{params:{query}})).json()).waiting).toBe(false);
  }
  await page.locator('#userInput').fill('Siguiente consulta');await page.locator('#chatForm').evaluate(form=>form.requestSubmit());
  await expect(page.locator('#messages strong')).toHaveText('Respuesta de prueba');
  expect(requests).toHaveLength(3);
  expect(requests[2].historial.filter(item=>item.role==='assistant')).toEqual([{role:'assistant',content:'Parte recibida 😎.'}]);
  await expect(page.locator('#messages')).not.toContainText('Final.');
});

test('limpiar chat durante streaming cancela y no restaura mensajes antiguos',async({page})=>{
  await createSourceNotebook(page);await page.goto('/index.html');const query='QA_GENERAL_STREAM_CLEAR_'+randomUUID();
  await page.locator('#userInput').fill(query);await page.locator('#chatForm').evaluate(form=>form.requestSubmit());
  await expect(page.locator('#messages')).toContainText('Parte recibida');await page.locator('#clearBtn').click();
  await expect(page.locator('#messages')).toBeEmpty();await expect(page.locator('#userInput')).toBeEnabled();
  await expect.poll(async()=>(await(await page.request.get('/__test/stream-state',{params:{query}})).json()).waiting).toBe(false);
});

test('login incorrecto presenta error rojo, accesible y visible', async ({ page }, testInfo) => {
  await page.goto('/auth.html');
  await page.locator('#signInEmail').fill('inexistente@example.test');
  await page.locator('#signInPassword').fill('incorrecta');
  await page.getByRole('button', { name: 'Entrar al chat' }).click();
  await expect(page.locator('#authFeedback')).toHaveClass(/is-error/);
  await expect(page.locator('#authFeedback')).toContainText('Email o contraseña incorrectos');
  await expect(page.locator('#authFeedback')).toHaveCSS('color', 'rgb(248, 113, 113)');
  await expect(page.locator('#authFeedback')).toBeVisible();
  await page.screenshot({ path: `qa-artifacts/login-error-${testInfo.project.name}.png`, fullPage: true });
});

test('sin conexión de Supabase se informa configuración pendiente', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({
    json: { authProvider: 'supabase', ready: false, notebooksEnabled: false, home: '/notebooks.html' },
  }));
  await page.goto('/auth.html');
  await expect(page.getByRole('button', { name: 'Entrar al chat' })).toBeDisabled();
  await expect(page.locator('#authFeedback')).toContainText('no está configurado');
  await page.goto('/notebooks.html');
  await expect(page.getByRole('heading', { name: 'Supabase no está configurado.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Explorar un ejemplo' })).toHaveCount(0);
});

test('el Markdown del chat no ejecuta HTML de la respuesta del modelo', async ({ page }) => {
  await page.goto('/auth.html');
  await page.getByRole('tab', { name: 'Crear cuenta' }).click();
  await page.getByLabel('Nombre').fill('QA');
  await page.locator('#signUpEmail').fill(randomUUID() + '@example.test');
  await page.locator('#signUpPassword').fill('Testing123!');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page).toHaveURL(/notebooks.html$/);
  await page.route('**/api/chat', route => route.fulfill({
    contentType: 'text/plain', body: '<img src=x onerror="window.xssExecuted=true">**Seguro**',
  }));
  await page.goto('/index.html');
  await page.locator('#userInput').fill('Prueba');
  await page.locator('#chatForm').evaluate(form => form.requestSubmit());
  await expect(page.locator('#messages strong')).toHaveText('Seguro');
  await expect(page.locator('#messages [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => window.xssExecuted)).toBeUndefined();
});

test('el correo predeterminado completa confirmación PKCE en el mismo navegador', async ({ page, request }) => {
  const email = randomUUID() + '@confirm.example.test';
  await page.goto('/auth.html');
  await page.getByRole('tab', { name: 'Crear cuenta' }).click();
  await page.getByLabel('Nombre').fill('Cuenta con confirmación');
  await page.locator('#signUpEmail').fill(email);
  await page.locator('#signUpPassword').fill('Testing123!');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.locator('#authFeedback')).toContainText('abrí el enlace de confirmación en este mismo navegador');
  await expect(page).toHaveURL(/auth.html$/);
  const response = await request.get('/__test/confirmation-link', { params: { email } });
  expect(response.ok()).toBe(true);
  const { link } = await response.json();
  await page.goto(link);
  await expect(page).toHaveURL(/notebooks.html$/);
  await expect(page.locator('#userName')).toHaveText('Cuenta con confirmación');
});

test('un correo abierto sin la cookie del registro da instrucciones para iniciar sesión', async ({ page, request }) => {
  const email = randomUUID() + '@confirm.example.test';
  await page.goto('/auth.html');
  await page.getByRole('tab', { name: 'Crear cuenta' }).click();
  await page.getByLabel('Nombre').fill('Otro navegador');
  await page.locator('#signUpEmail').fill(email);
  await page.locator('#signUpPassword').fill('Testing123!');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page.locator('#authFeedback')).toContainText('Revisá tu email');
  const { link } = await (await request.get('/__test/confirmation-link', { params: { email } })).json();
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page.locator('#authFeedback')).toContainText('podés iniciar sesión con tu email y contraseña');
  await expect(page).toHaveURL(/auth.html$/);
});

async function createSourceNotebook(page) {
  await page.goto('/auth.html');
  await page.getByRole('tab', { name: 'Crear cuenta' }).click();
  await page.getByLabel('Nombre').fill('QA documentos');
  await page.locator('#signUpEmail').fill(randomUUID() + '@example.test');
  await page.locator('#signUpPassword').fill('Testing123!');
  await page.getByRole('button', { name: 'Crear cuenta' }).click();
  await expect(page).toHaveURL(/notebooks.html$/);
  await page.getByRole('button', { name: '+ Nuevo cuaderno' }).click();
  await page.getByLabel('Título', { exact: true }).fill('Biblioteca de prueba');
  await page.getByRole('button', { name: 'Crear cuaderno', exact: true }).click();
  await page.getByRole('button', { name: /Biblioteca de prueba/ }).click();
  await selectPanel(page,'sources');
  await expect(page.locator('#noSources')).toBeVisible();
}

test('fuentes privadas: subir, recargar, descargar y borrar antes de eliminar el cuaderno', async ({ page }, testInfo) => {
  await createSourceNotebook(page);
  await openUpload(page);
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles([
    { name: 'guía.md', mimeType: 'text/markdown', buffer: Buffer.from('# Mi guía\nContenido privado') },
    { name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('Segunda fuente') },
  ]);
  await page.getByRole('button', { name: 'Subir archivos' }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('2 archivo(s) subido(s)');
  await expect(page.locator('#sourceList .source-row')).toHaveCount(2);
  await expect(page.locator('#sourceList')).toContainText('Pendiente de procesamiento');
  await expect(page.locator('#deleteNotebook')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('#detailDialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `qa-artifacts/sources-${testInfo.project.name}.png`, fullPage: true });
  await page.reload();
  await selectPanel(page,'sources');
  await expect(page.locator('#sourceList .source-row')).toHaveCount(2);
  await sourceOptions(page,'guía.md');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar guía.md', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('guía.md');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('# Mi guía\nContenido privado');
  for (const filename of ['guía.md', 'notas.txt']) {
    await page.getByRole('button', { name: 'Eliminar ' + filename, exact: true }).click();
    await expect(page.locator('#deleteSourcePrompt')).toBeVisible();
    await page.getByRole('button', { name: 'Eliminar fuente', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Eliminar ' + filename, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('#noSources')).toBeVisible();
  await selectPanel(page,'tools');
  await page.getByRole('button', { name: 'Eliminar cuaderno', exact: true }).click();
  await page.getByRole('dialog', { name: 'Eliminar cuaderno' }).getByRole('button', { name: 'Eliminar cuaderno' }).click();
  await expect(page.getByRole('heading', { name: 'Biblioteca de prueba' })).toHaveCount(0);
});

test('un PDF falso muestra error y permite volver a subir un archivo válido', async ({ page }) => {
  await createSourceNotebook(page);
  await openUpload(page);
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles({
    name: 'falso.pdf', mimeType: 'application/pdf', buffer: Buffer.from('No es un PDF'),
  });
  await page.getByRole('button', { name: 'Subir archivos' }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('no parece ser un PDF válido');
  await expect(page.locator('#sourceFeedback')).toHaveClass(/error/);
  await expect(page.getByRole('button', { name: 'Subir archivos' })).toBeEnabled();
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles({
    name: 'recuperado.txt', mimeType: 'text/plain', buffer: Buffer.from('Carga válida'),
  });
  await page.getByRole('button', { name: 'Subir archivos' }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('1 archivo(s) subido(s)');
  await expect(page.locator('#sourceList')).toContainText('recuperado.txt');
});

test('procesa un PDF y muestra texto persistente con las páginas originales', async ({ page }, testInfo) => {
  await createSourceNotebook(page);
  await openUpload(page);
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles({
    name: 'documento.pdf', mimeType: 'application/pdf', buffer: pdfFixture(['First page', '', 'Third page']),
  });
  await page.getByRole('button', { name: 'Subir archivos' }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('1 archivo(s) subido(s)');
  await sourceOptions(page,'documento.pdf');
  await page.getByRole('button', { name: 'Procesar documento.pdf', exact: true }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('Texto extraído: 2 fragmento(s)');
  await expect(page.locator('#sourceList')).toContainText('3 página(s)');
  await expect(page.locator('#sourceList')).toContainText('1 página(s) sin texto seleccionable');
  await page.getByRole('button', { name: 'Ver texto de documento.pdf', exact: true }).click();
  await expect(page.locator('#sourceTextPanel')).toBeVisible();
  await expect(page.locator('#sourceTextChunks h4')).toHaveText(['Página 1 · Fragmento 1','Página 3 · Fragmento 2']);
  await expect(page.locator('#sourceTextChunks pre')).toHaveText(['First page','Third page']);
  expect(await page.locator('#detailDialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `qa-artifacts/extraction-${testInfo.project.name}.png`, fullPage: true });
  await page.reload();
  await selectPanel(page,'sources');
  await sourceOptions(page,'documento.pdf');
  await expect(page.getByRole('button', { name: 'Ver texto de documento.pdf', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ver texto de documento.pdf', exact: true }).click();
  await expect(page.locator('#sourceTextChunks pre').first()).toHaveText('First page');
});

test('ver texto pagina fragmentos y nunca ejecuta HTML extraído', async ({ page }) => {
  await createSourceNotebook(page);
  await openUpload(page);
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles({
    name: 'notas.md', mimeType: 'text/markdown', buffer: Buffer.from('<img src=x onerror="window.extractedXss=true">\n' + 'Palabras de prueba. '.repeat(2000)),
  });
  await page.getByRole('button', { name: 'Subir archivos' }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('1 archivo(s) subido(s)');
  await sourceOptions(page,'notas.md');
  await page.getByRole('button', { name: 'Procesar notas.md', exact: true }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('Texto extraído');
  await page.getByRole('button', { name: 'Ver texto de notas.md', exact: true }).click();
  await expect(page.locator('#sourceTextChunks pre')).toHaveCount(20);
  await expect(page.locator('#sourceTextChunks pre').first()).toContainText('<img src=x onerror=');
  await expect(page.locator('#sourceTextPanel img')).toHaveCount(0);
  expect(await page.evaluate(() => window.extractedXss)).toBeUndefined();
  await page.getByRole('button', { name: 'Ver más fragmentos', exact: true }).click();
  await expect(page.locator('#sourceTextChunks pre')).not.toHaveCount(20);
  await expect(page.locator('#sourceTextChunks h4').nth(20)).toHaveText('Fragmento 21');
});

test('PDF sin texto informa la necesidad de OCR y conserva la opción de reintento', async ({ page }) => {
  await createSourceNotebook(page);
  await openUpload(page);
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles({
    name: 'sin-texto.pdf', mimeType: 'application/pdf', buffer: pdfFixture(['']),
  });
  await page.getByRole('button', { name: 'Subir archivos' }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('1 archivo(s) subido(s)');
  await sourceOptions(page,'sin-texto.pdf');
  await page.getByRole('button', { name: 'Procesar sin-texto.pdf', exact: true }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('necesita OCR');
  await expect(page.locator('#sourceList')).toContainText('Error de procesamiento');
  await expect(page.getByRole('button', { name: 'Procesar sin-texto.pdf', exact: true })).toBeEnabled();
  await page.reload();
  await selectPanel(page,'sources');
  await expect(page.locator('#sourceList')).toContainText('necesita OCR');
});

async function uploadAndProcess(page,files) {
  await openUpload(page);
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles(files);
  await page.getByRole('button',{ name: 'Subir archivos',exact: true }).click();
  await expect(page.locator('#sourceFeedback')).toContainText(files.length+' archivo(s) subido(s)');
  for (const file of files) {
    await sourceOptions(page,file.name);
    await page.getByRole('button',{ name: 'Procesar '+file.name,exact: true }).click();
    await expect(page.locator('#sourceFeedback')).toContainText('Texto extraído');
  }
}
async function indexSource(page,name) {
  await sourceOptions(page,name);
  await page.getByRole('button',{ name: 'Indexar '+name,exact: true }).click();
  await expect(page.locator('#indexSourcePrompt')).toContainText(/consume saldo/i);
  await page.getByRole('button',{ name: 'Confirmar e indexar',exact: true }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('Fuente indexada');
  await chatOptions(page);
}

test('indexa con confirmación y pregunta siempre a todas las fuentes sin controles de embeddings',async ({ page },testInfo) => {
  await createSourceNotebook(page);
  await expect(page.locator('#answerNotebook')).toBeDisabled();
  await uploadAndProcess(page,[
    { name: 'solar.pdf',mimeType: 'application/pdf',buffer: pdfFixture(['La energia solar viene del sol.']) },
    { name: 'plantas.md',mimeType: 'text/markdown',buffer: Buffer.from('Las plantas hacen fotosíntesis. <img src=x onerror="window.searchXss=true">') },
  ]);
  let indexCalls = 0;
  page.on('request',r => { if (r.method() === 'POST' && r.url().endsWith('/index')) indexCalls++; });
  await page.getByRole('button',{ name: 'Indexar solar.pdf',exact: true }).click();
  await page.getByRole('button',{ name: 'Cancelar',exact: true }).click();
  expect(indexCalls).toBe(0);
  await indexSource(page,'solar.pdf'); await indexSource(page,'plantas.md');
  expect(indexCalls).toBe(2);
  await page.getByLabel('¿Qué querés encontrar?').fill('¿De dónde viene la energía solar?');
  const sent = page.waitForRequest('**/api/notebooks/*/answer');
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  expect((await sent).postDataJSON()).toEqual({query:'¿De dónde viene la energía solar?',confirmExternalProcessing:true});
  await expect(page.locator('#ragAnswerText')).toContainText('La energia solar viene del sol.');
  await expect(page.locator('#searchNotebook')).toHaveCount(0);
  await expect(page.locator('#searchAllSources')).toHaveCount(0);
  await page.getByLabel('¿Qué querés encontrar?').fill('¿Qué hacen las plantas?');
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  await expect(page.locator('#ragAnswerText')).toContainText('Las plantas hacen fotosíntesis.');
  await expect(page.locator('#ragAnswerText')).toContainText('<img src=x onerror=');
  await expect(page.locator('#ragAnswer img')).toHaveCount(0);
  expect(await page.evaluate(() => window.searchXss)).toBeUndefined();
  expect(await page.locator('#detailDialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `qa-artifacts/semantic-search-${testInfo.project.name}.png`,fullPage: true });
  await page.reload(); await selectPanel(page,'sources');
  await expect(page.locator('#sourceList')).toContainText('Indexado para búsqueda');
  await expect(page.getByRole('button',{ name: 'Indexar solar.pdf',exact: true })).toHaveCount(0);
});

test('un error de saldo se muestra y permite reintentar sin bloquear el formulario',async ({ page }) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{ name: 'notas.txt',mimeType: 'text/plain',buffer: Buffer.from('Energía solar.') }]);
  const pattern = '**/api/notebooks/*/documents/*/index';
  await page.route(pattern,route => route.fulfill({ status: 402,json: { error: 'OpenRouter no tiene saldo suficiente. Revisá tus créditos.' } }));
  await page.getByRole('button',{ name: 'Indexar notas.txt',exact: true }).click();
  await page.getByRole('button',{ name: 'Confirmar e indexar' }).click();
  await expect(page.locator('#sourceFeedback')).toContainText('saldo suficiente');
  await expect(page.locator('#sourceFeedback')).toHaveClass(/error/);
  await expect(page.getByRole('button',{ name: 'Indexar notas.txt',exact: true })).toBeEnabled();
  await page.unroute(pattern); await indexSource(page,'notas.txt');
});

test('detener por lotes conserva el progreso y permite continuar',async ({ page }) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{ name: 'largo.txt',mimeType: 'text/plain',buffer: Buffer.from(Array.from({ length: 1000 },(_,i) => 'Nota '+i+': Un tema solar con palabras y notas. ').join('')) }]);
  let ready,release;
  const firstBatch = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pattern = '**/api/notebooks/*/documents/*/index';
  await page.route(pattern,async route => { const response = await route.fetch(); ready(); await gate; await route.fulfill({ response }); });
  await page.getByRole('button',{ name: 'Indexar largo.txt',exact: true }).click();
  await page.getByRole('button',{ name: 'Confirmar e indexar' }).click();
  try {
    await firstBatch;
    await page.getByRole('button',{ name: 'Detener después de este lote',exact: true }).click();
    release(); await expect(page.locator('#sourceFeedback')).toContainText('Indexación detenida');
    await expect(page.locator('#sourceList')).toContainText('Índice: 32/');
    await expect(page.locator('#answerNotebook')).toBeDisabled();
    await page.unroute(pattern); await indexSource(page,'largo.txt');
    await expect(page.locator('#answerNotebook')).toBeEnabled();
  } finally { release(); }
});

test('RAG pregunta sin casillas y abre citas PDF en modal desde respuestas actuales e históricas',async ({ page },testInfo) => {
  await createSourceNotebook(page);
  await expect(page.locator('#answerNotebook')).toBeDisabled();
  await uploadAndProcess(page,[
    { name: 'solar.pdf',mimeType: 'application/pdf',buffer: pdfFixture(['','La energia solar viene del sol.']) },
    { name: 'plantas.txt',mimeType: 'text/plain',buffer: Buffer.from('Las plantas realizan fotosíntesis.') },
  ]);
  await indexSource(page,'solar.pdf'); await indexSource(page,'plantas.txt');
  await page.getByLabel('¿Qué querés encontrar?').fill('¿De dónde viene la energía solar?');
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  await expect(page.locator('#ragAnswerText')).toContainText('La energia solar viene del sol.');
  await expect(page.locator('#ragAnswerMeta')).toHaveCount(0);
  await page.getByRole('button',{ name: 'Ver cita F1',exact: true }).click();
  await expect(page.getByRole('dialog',{name:'solar.pdf',exact:true})).toBeVisible();
  await expect(page.locator('#citationMeta')).toContainText('Página 2 · Fragmento 1');
  await expect(page.locator('#citationQuote')).toHaveText('La energia solar viene del sol.');
  await expect(page.locator('#sourceTextChunks pre')).toBeHidden();
  await page.locator('#sourceTextChunks summary').click();
  await expect(page.locator('#sourceTextChunks pre')).toBeVisible();
  await page.locator('#closeSourceText').click();
  expect(await page.locator('#detailDialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `qa-artifacts/rag-answer-${testInfo.project.name}.png`,fullPage: true });
  await page.getByLabel('¿Qué querés encontrar?').fill('¿Qué hacen las plantas?');
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  await expect(page.locator('#ragAnswerText')).toContainText('Las plantas realizan fotosíntesis.');
  await page.locator('#conversationHistory').getByRole('button',{name:'Ver cita F1',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'solar.pdf',exact:true})).toBeVisible();
  await page.locator('#closeSourceText').click();
  await page.reload();
  await expect(page.locator('#ragAnswer')).toBeVisible();
  await expect(page.locator('#ragAnswerText')).toContainText('Las plantas realizan fotosíntesis.');
});

test('RAG muestra abstención y renderiza literalmente texto hostil sin ejecutar HTML',async ({ page }) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{ name: 'hostil.md',mimeType: 'text/markdown',buffer: Buffer.from('La energía solar es renovable. <img src=x onerror="window.ragXss=true">') }]);
  await indexSource(page,'hostil.md');
  await page.getByLabel('¿Qué querés encontrar?').fill('Consulta solar');
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  await expect(page.locator('#ragAnswerText')).toContainText('<img src=x');
  await expect(page.locator('#ragAnswer img')).toHaveCount(0);
  expect(await page.evaluate(() => window.ragXss)).toBeUndefined();
  await page.getByLabel('¿Qué querés encontrar?').fill('Pregunta sin evidencia');
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  await expect(page.locator('#ragAnswerText')).toContainText('No encontré información suficiente');
  await expect(page.locator('#sourceTextPanel')).toBeHidden();
  await expect(page.locator('#ragAnswerText button')).toHaveCount(0);
});

test('RAG recupera el formulario tras error de proveedor y permite reintento explícito',async ({ page }) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{ name: 'solar.txt',mimeType: 'text/plain',buffer: Buffer.from('La energía solar proviene del sol.') }]);
  await indexSource(page,'solar.txt');
  await page.getByLabel('¿Qué querés encontrar?').fill('Consulta solar');
  const pattern = '**/api/notebooks/*/answer';
  await page.route(pattern,route => route.fulfill({ status: 429,json: { error: 'El proveedor limitó las solicitudes (429).' } }));
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  await expect(page.locator('#searchFeedback')).toContainText('(429)');
  await expect(page.locator('#searchFeedback')).toHaveClass(/error/);
  await expect(page.locator('#answerNotebook')).toBeEnabled();
  await expect(page.locator('#semanticQuery')).toHaveValue('Consulta solar');
  await expect(page.locator('#ragAnswer')).toBeHidden();
  await page.unroute(pattern);
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  await expect(page.locator('#ragAnswerText')).toContainText('La energía solar proviene del sol.');
});

test('RAG permite cancelar sin reintentar ni dejar el formulario bloqueado',async ({ page }) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{ name: 'solar.txt',mimeType: 'text/plain',buffer: Buffer.from('La energía solar proviene del sol.') }]);
  await indexSource(page,'solar.txt');
  await page.getByLabel('¿Qué querés encontrar?').fill('Consulta solar');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/notebooks/*/answer',async route => { await gate; await route.abort().catch(() => {}); });
  const sent = page.waitForRequest('**/api/notebooks/*/answer');
  await page.getByRole('button',{ name: 'Preguntar',exact: true }).click();
  try {
    await sent;
    await page.getByRole('button',{ name: 'Cancelar respuesta' }).click();
    await expect(page.locator('#searchFeedback')).toContainText('Respuesta cancelada');
    await expect(page.locator('#answerNotebook')).toBeEnabled();
    await expect(page.locator('#ragAnswer')).toBeHidden();
  } finally { release(); }
});

test('workspace separa paneles, agrega en modal grande y abre/quita una fuente desde su lista',async ({ page },testInfo) => {
  await createSourceNotebook(page);
  if (page.viewportSize().width > 900) {
    const panels = await page.locator('.work-panel').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x:r.x,width:r.width }; }));
    expect(panels[0].x+panels[0].width).toBeLessThan(panels[1].x);
    expect(panels[1].x+panels[1].width).toBeLessThan(panels[2].x);
  } else {
    await selectPanel(page,'chat'); await expect(page.locator('.chat-panel')).toBeVisible();
    await expect(page.locator('.sources-panel')).toBeHidden();
  }
  await openUpload(page);
  await page.screenshot({ path:`qa-artifacts/upload-modal-${testInfo.project.name}.png`,fullPage:true });
  await page.getByLabel('Agregá documentos a este cuaderno').setInputFiles({ name:'apuntes.txt',mimeType:'text/plain',buffer:Buffer.from('Apuntes privados. <script>window.previewXss=true</script>') });
  await page.getByRole('button',{name:'Subir archivos',exact:true}).click();
  await expect(page.locator('#uploadDialog')).toBeHidden();
  await page.getByRole('button',{name:'Abrir fuente apuntes.txt',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'apuntes.txt',exact:true})).toBeVisible();
  await expect(page.locator('#originalPreview pre')).toContainText('Apuntes privados.');
  await expect(page.locator('#originalPreview script')).toHaveCount(0);
  expect(await page.evaluate(() => window.previewXss)).toBeUndefined();
  expect((await page.locator('#sourceTextPanel').boundingBox()).width).toBeGreaterThanOrEqual(page.viewportSize().width-2);
  await page.screenshot({ path:`qa-artifacts/source-modal-${testInfo.project.name}.png`,fullPage:true });
  await page.getByRole('button',{name:'Cerrar fuente',exact:true}).click();
  await page.getByRole('button',{name:'Eliminar apuntes.txt',exact:true}).click();
  await page.getByRole('button',{name:'Eliminar fuente',exact:true}).click();
  await expect(page.locator('#noSources')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await selectPanel(page,'chat');
  await page.screenshot({ path:`qa-artifacts/workspace-${testInfo.project.name}.png`,fullPage:true });
});

test('historial conserva preguntas y citas al recargar; borrarlo no elimina los archivos',async ({page}) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'solar.txt',mimeType:'text/plain',buffer:Buffer.from('La energía solar proviene del sol.')}]);
  await indexSource(page,'solar.txt');
  await page.getByLabel('¿Qué querés encontrar?').fill('¿De dónde viene la energía solar?');
  await page.locator('#answerNotebook').click();
  await expect(page.locator('#ragAnswerText')).toContainText('La energía solar');
  await expect(page.locator('#historyFeedback')).toBeHidden();
  await page.reload();
  await expect(page.locator('#latestQuestion')).toHaveText('¿De dónde viene la energía solar?');
  await page.locator('#ragAnswer').getByRole('button',{name:'Ver cita F1',exact:true}).click();
  await expect(page.locator('#sourceTextChunks pre')).toBeHidden();
  await page.locator('#sourceTextChunks summary').click();
  await expect(page.locator('#sourceTextChunks pre')).toBeVisible();
  await page.locator('#closeSourceText').click();
  await page.locator('#clearConversation').click();
  await page.getByRole('button',{name:'Borrar conversación',exact:true}).click();
  await expect(page.locator('#chatEmpty')).toBeVisible();
  await page.reload(); await expect(page.locator('#chatEmpty')).toBeVisible();
  await selectPanel(page,'sources'); await expect(page.locator('#sourceList')).toContainText('solar.txt');
});

test('cambiar de cuaderno mantiene separadas las fuentes y el historial',async ({page}) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'primero.txt',mimeType:'text/plain',buffer:Buffer.from('Notas del primer cuaderno.')}]);
  await selectPanel(page,'tools'); await page.locator('#workspaceCreate').click();
  await page.getByLabel('Título',{exact:true}).fill('Segundo cuaderno');
  await page.getByRole('button',{name:'Crear cuaderno',exact:true}).click();
  await expect(page.locator('#detailTitle')).toHaveText('Segundo cuaderno');
  await selectPanel(page,'sources'); await expect(page.locator('#noSources')).toBeVisible();
  await expect(page.locator('#sourceList')).not.toContainText('primero.txt');
  await selectPanel(page,'tools');
  await page.locator('#workspaceNotebooks').getByRole('button',{name:/Biblioteca de prueba/}).click();
  await selectPanel(page,'sources'); await expect(page.locator('#sourceList')).toContainText('primero.txt');
  await selectPanel(page,'chat'); await expect(page.locator('#chatEmpty')).toBeVisible();
});

test('historial no disponible avisa sin bloquear una respuesta nueva',async ({page}) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'solar.txt',mimeType:'text/plain',buffer:Buffer.from('La energía solar proviene del sol.')}]);
  await indexSource(page,'solar.txt');
  await page.route('**/api/notebooks/*/conversation',route => route.fulfill({status:503,json:{error:'Aplicá la migración 005 para guardar el historial.'}}));
  await page.reload(); await expect(page.locator('#historyFeedback')).toContainText('migración 005');
  await chatOptions(page);
  await page.getByLabel('¿Qué querés encontrar?').fill('Consulta solar');
  await page.locator('#answerNotebook').click();
  await expect(page.locator('#ragAnswerText')).toContainText('La energía solar proviene del sol.');
});

test('chat simplificado: cuadernos legibles, herramientas plegadas y un solo envío sin filtros',async ({page},testInfo) => {
  if (testInfo.project.name === 'desktop') await page.setViewportSize({width:1912,height:900});
  await createSourceNotebook(page);
  for (let i=1;i<=3;i++) expect((await page.request.post('/api/notebooks',{headers:{Origin:new URL(page.url()).origin},data:{title:'Tema de estudio '+i}})).status()).toBe(201);
  await page.reload();
  await selectPanel(page,'chat');
  await expect(page.locator('.chat-options')).toHaveCount(0);
  await expect(page.locator('#searchSourceChoices')).toHaveCount(0);
  await expect(page.locator('#searchNotebook')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Preguntar',exact:true})).toBeVisible();
  await selectPanel(page,'tools');
  const book = page.locator('#workspaceNotebooks button').first();
  await expect(page.locator('#workspaceNotebooks button')).toHaveCount(4);
  await expect(book).toBeVisible();
  expect((await book.boundingBox()).height).toBeGreaterThanOrEqual(48);
  expect((await page.locator('#workspaceNotebooks').boundingBox()).height).toBeGreaterThanOrEqual(150);
  await expect(page.locator('#futureTools')).not.toHaveAttribute('open','');
  await expect(page.getByText('Una vista general de tus ideas')).toBeHidden();
  await page.screenshot({path:`qa-artifacts/simplified-workspace-${testInfo.project.name}.png`,fullPage:true});
});

test('cita abre modal centrado sin saltar al final y conserva el scroll del chat',async ({page}) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'solar.txt',mimeType:'text/plain',buffer:Buffer.from('La energía solar proviene del sol.')}]);
  await indexSource(page,'solar.txt');
  await page.getByLabel('¿Qué querés encontrar?').fill('Consulta solar');
  await page.getByRole('button',{name:'Preguntar',exact:true}).click();
  await expect(page.locator('#ragAnswerText')).toContainText('La energía solar');
  const before = await page.locator('#chatScroll').evaluate(el=>el.scrollTop);
  await page.locator('#ragAnswer').getByRole('button',{name:'Ver cita F1',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'solar.txt',exact:true})).toBeVisible();
  await expect(page.locator('#citationQuote')).toContainText('La energía solar proviene del sol.');
  const box = await page.locator('#sourceTextPanel').boundingBox();
  expect(Math.abs(box.x+box.width/2-page.viewportSize().width/2)).toBeLessThan(3);
  expect(Math.abs(box.y+box.height/2-page.viewportSize().height/2)).toBeLessThan(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sourceTextPanel')).toBeHidden();
  expect(await page.locator('#chatScroll').evaluate(el=>el.scrollTop)).toBe(before);
});

test('lectura del chat: texto amplio, párrafos separados y compositor compacto',async ({page},testInfo) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'solar.txt',mimeType:'text/plain',buffer:Buffer.from('La energía solar proviene del sol.')}]);
  await indexSource(page,'solar.txt');
  await page.route('**/api/notebooks/*/answer',async route => {
    const response=await route.fetch({headers:{...route.request().headers(),accept:'application/json'}}); const result=await response.json(); const citations=result.segments[0].citations;
    result.segments=[
      {text:'La energía solar proviene del sol. Las fuentes del cuaderno permiten estudiar cómo se transforma y cómo se aprovecha en distintas situaciones.',citations},
      {text:'Conceptos principales:\n• Origen: el sol.\n• Transformación y aprovechamiento de la energía.',citations},
      {text:'Para estudiar:\n1. Leé la explicación.\n2. Revisá el fragmento citado.',citations},
    ]; await route.fulfill({response,json:result});
  });
  await page.getByLabel('¿Qué querés encontrar?').fill('Explicame lo que dicen mis fuentes');
  await page.getByRole('button',{name:'Preguntar',exact:true}).click();
  await expect(page.locator('#ragAnswerText .rag-paragraph')).toHaveCount(3);
  const style=await page.locator('#ragAnswerText .rag-paragraph').first().evaluate(el=>{const s=getComputedStyle(el);return{font:parseFloat(s.fontSize),line:parseFloat(s.lineHeight),gap:parseFloat(s.marginBottom)}});
  expect(style.font).toBeGreaterThanOrEqual(16);expect(style.line/style.font).toBeGreaterThanOrEqual(1.6);expect(style.gap).toBeGreaterThanOrEqual(20);
  const list=page.locator('#ragAnswerText .rag-paragraph').nth(1);
  await expect(list).toContainText('• Origen: el sol.\n• Transformación');
  expect(await list.evaluate(el=>getComputedStyle(el).whiteSpace)).toBe('pre-line');
  expect((await list.boundingBox()).height).toBeGreaterThan(style.line*2);
  await expect(page.locator('#ragAnswerText .rag-paragraph').nth(2)).toContainText('1. Leé la explicación.\n2. Revisá');
  await expect(list.getByRole('button',{name:'Ver cita F1',exact:true})).toBeVisible();
  expect((await page.locator('#chatScroll').boundingBox()).height).toBeGreaterThan((await page.locator('.chat-composer').boundingBox()).height*1.5);
  expect(await page.locator('.chat-composer').evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
  await page.screenshot({path:`qa-artifacts/chat-reading-${testInfo.project.name}.png`,fullPage:true});
});

test('compositor de una línea crece con animación, Enter envía una vez y Shift Enter no envía',async ({page},testInfo) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'solar.txt',mimeType:'text/plain',buffer:Buffer.from('La energía solar proviene del sol.')}]);
  await indexSource(page,'solar.txt');
  const input = page.locator('#semanticQuery');
  await expect(input).toHaveAttribute('rows','1');
  await expect.poll(async () => (await input.boundingBox()).height).toBeLessThanOrEqual(46);
  const initial = (await input.boundingBox()).height;
  await input.fill('Una pregunta extensa sobre las fuentes y la energía solar. '.repeat(15));
  await expect.poll(async () => (await input.boundingBox()).height).toBeGreaterThan(initial+20);
  await expect.poll(async () => (await input.boundingBox()).height).toBeLessThanOrEqual(144);
  expect(await input.evaluate(el=>getComputedStyle(el).transitionProperty)).toContain('height');
  await page.screenshot({path:`qa-artifacts/growing-input-${testInfo.project.name}.png`,fullPage:true});
  await input.fill('Consulta solar');
  await expect.poll(async () => (await input.boundingBox()).height).toBe(initial);
  let sent = 0,release;
  const gate = new Promise(resolve=>{release=resolve;});
  await page.route('**/api/notebooks/*/answer',async route=>{sent++;await gate;await route.continue();});
  try {
    await input.press('Shift+Enter');
    await expect(input).toHaveValue('Consulta solar\n');
    await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});
    await input.fill('   '); await input.press('Enter');
    expect(sent).toBe(0);
    await input.fill('Consulta solar');
    await input.press('Enter');
    await expect.poll(()=>sent).toBe(1);
    await input.press('Enter');
    expect(sent).toBe(1);
    release();
    await expect(page.locator('#ragAnswerText')).toContainText('La energía solar');
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect.poll(async () => (await input.boundingBox()).height).toBe(initial);
    const bubble = await page.locator('#latestQuestion').boundingBox();
    const chat = await page.locator('#chatScroll').boundingBox();
    expect(bubble.width).toBeLessThan(chat.width*.85);
    const inset=await page.locator('#chatScroll').evaluate(el=>parseFloat(getComputedStyle(el).paddingRight));
    expect(Math.abs(bubble.x+bubble.width-(chat.x+chat.width-inset))).toBeLessThan(2);
    await page.screenshot({path:`qa-artifacts/compact-chat-${testInfo.project.name}.png`,fullPage:true});
    await page.emulateMedia({reducedMotion:'reduce'});
    expect(await input.evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
  } finally {release();}
});

test('fuentes plegadas, chat sin subtítulos y cita con fragmento completo sólo al desplegar',async ({page},testInfo) => {
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'solar.txt',mimeType:'text/plain',buffer:Buffer.from('La energía solar proviene del sol.')}]);
  await indexSource(page,'solar.txt');
  await page.reload(); await selectPanel(page,'sources');
  const options=page.locator('#sourceList .source-details');
  await expect(options).not.toHaveAttribute('open','');
  await expect(page.locator('#sourceList .source-meta')).toBeHidden();
  await expect(page.getByRole('button',{name:'Descargar solar.txt',exact:true,includeHidden:true})).toBeHidden();
  await expect(page.getByRole('button',{name:'Eliminar solar.txt',exact:true})).toBeVisible();
  await options.locator('summary').press('Enter');
  await expect(page.locator('#sourceList .source-meta')).toBeVisible();
  await expect(page.getByRole('button',{name:'Descargar solar.txt',exact:true})).toBeVisible();
  await selectPanel(page,'chat');
  await page.locator('#semanticQuery').fill('Consulta solar'); await page.locator('#semanticQuery').press('Enter');
  await expect(page.locator('#ragAnswerText')).toContainText('La energía solar');
  await expect(page.locator('.chat-panel .panel-subtitle')).toHaveCount(0);
  await expect(page.locator('#ragAnswerTitle')).toHaveClass(/sr-only/);
  await expect(page.locator('#historyFeedback')).toBeHidden();
  await page.getByRole('button',{name:'Ver cita F1',exact:true}).click();
  await expect(page.locator('#citationQuote')).toBeVisible();
  await expect(page.locator('#sourceTextChunks pre')).toBeHidden();
  await page.screenshot({path:`qa-artifacts/collapsed-citation-${testInfo.project.name}.png`,fullPage:true});
  await page.locator('#sourceTextChunks summary').click();
  await expect(page.locator('#sourceTextChunks pre')).toBeVisible();
  await page.locator('#closeSourceText').click();
  await page.reload(); await expect(page.locator('#latestQuestion')).toHaveText('Consulta solar');
  await page.getByRole('button',{name:'Ver cita F1',exact:true}).click();
  await expect(page.locator('#sourceTextChunks pre')).toBeHidden();
  await page.locator('#closeSourceText').click();
  await page.locator('#semanticQuery').fill('Otra consulta'); await page.locator('#semanticQuery').press('Enter');
  await expect(page.locator('#conversationHistory .chat-question')).toHaveText('Consulta solar');
  const oldBubble = await page.locator('#conversationHistory .chat-question').boundingBox();
  expect(oldBubble.width).toBeLessThan((await page.locator('#chatScroll').boundingBox()).width*.85);
  await expect(page.locator('#conversationHistory h3')).toHaveCount(0);
});

async function streamingNotebook(page){
  await createSourceNotebook(page);
  await uploadAndProcess(page,[{name:'solar.txt',mimeType:'text/plain',buffer:Buffer.from('La energía solar proviene del sol.')}]);
  await indexSource(page,'solar.txt');
}
async function conversation(page){
  const id=new URL(page.url()).searchParams.get('notebook');
  return (await (await page.request.get('/api/notebooks/'+id+'/conversation')).json()).turns;
}
test('streaming muestra un bloque con su cita antes del final y sólo entonces persiste el intercambio',async({page},testInfo)=>{
  await streamingNotebook(page);const query='QA_STREAM_SUCCESS_'+randomUUID();
  await page.locator('#semanticQuery').fill(query);await page.locator('#semanticQuery').press('Enter');
  try{
    await expect(page.locator('#streamingBlocks .rag-paragraph')).toHaveCount(1);
    await expect(page.locator('#streamingBlocks')).toContainText('Primer bloque validado.');
    await expect(page.locator('#answerNotebook')).toBeDisabled();
    expect((await conversation(page)).length).toBe(0);
    await page.locator('#streamingBlocks').getByRole('button',{name:'Ver cita F1',exact:true}).click();
    await expect(page.locator('#citationQuote')).toContainText('La energía solar');await page.locator('#closeSourceText').click();
    await page.screenshot({path:`qa-artifacts/streaming-first-block-${testInfo.project.name}.png`,fullPage:true});
  }finally{await page.request.post('/__test/release-stream',{data:{query}});}
  await expect(page.locator('#streamingTurn')).toBeHidden();
  await expect(page.locator('#ragAnswerText .rag-paragraph')).toHaveCount(2);
  expect((await conversation(page)).length).toBe(1);
  await page.reload();await expect(page.locator('#ragAnswerText .rag-paragraph')).toHaveCount(2);
  await expect(page.locator('#latestQuestion')).toHaveText(query);
});
test('streaming con una cita posterior inválida conserva sólo el bloque válido, avisa y no guarda',async({page},testInfo)=>{
  await streamingNotebook(page);const query='QA_STREAM_INVALID_'+randomUUID();
  await page.locator('#semanticQuery').fill(query);await page.locator('#answerNotebook').click();
  await expect(page.locator('#streamingBlocks .rag-paragraph')).toHaveCount(1);
  await page.request.post('/__test/release-stream',{data:{query}});
  await expect(page.locator('#streamingStatus')).toContainText('Respuesta incompleta');
  await expect(page.locator('#streamingBlocks .rag-paragraph')).toHaveCount(1);
  await expect(page.locator('#streamingBlocks')).not.toContainText('Segundo bloque');
  await expect(page.locator('#searchFeedback')).toContainText('citas válidas');
  await expect(page.locator('#answerNotebook')).toBeEnabled();
  expect((await conversation(page)).length).toBe(0);
  await page.screenshot({path:`qa-artifacts/streaming-incomplete-${testInfo.project.name}.png`,fullPage:true});
  await page.reload();await expect(page.locator('#chatEmpty')).toBeVisible();
});
test('cancelar después del primer bloque aborta sin guardar ni reintentar y permite otra pregunta',async({page})=>{
  await streamingNotebook(page);const query='QA_STREAM_CANCEL_'+randomUUID();let requests=0;
  page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/answer'))requests++;});
  await page.locator('#semanticQuery').fill(query);await page.locator('#answerNotebook').click();
  await expect(page.locator('#streamingBlocks .rag-paragraph')).toHaveCount(1);
  await page.locator('#cancelAnswer').click();
  await expect(page.locator('#streamingStatus')).toContainText('Respuesta incompleta');
  await expect(page.locator('#searchFeedback')).toContainText('cancelada');
  await expect.poll(async()=>(await (await page.request.get('/__test/stream-state',{params:{query}})).json()).waiting).toBe(false);
  expect((await conversation(page)).length).toBe(0);expect(requests).toBe(1);
  await page.locator('#semanticQuery').fill('Otra consulta solar');await page.locator('#semanticQuery').press('Enter');
  await expect(page.locator('#ragAnswerText')).toContainText('La energía solar');await expect(page.locator('#streamingTurn')).toBeHidden();
  expect((await conversation(page)).length).toBe(1);
});

test('una cita vacía muestra campos faltantes, no inventa extractos ni declara guardado incierto',async({page})=>{
  await streamingNotebook(page);let requests=0;
  page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/answer'))requests++;});
  await page.locator('#semanticQuery').fill('QA_STREAM_EMPTY_FIRST_'+randomUUID());await page.locator('#answerNotebook').click();
  await expect(page.locator('#searchFeedback')).toContainText('cita vacía o incompleta');
  await expect(page.locator('#streamingTurn')).toBeHidden();
  await expect(page.locator('#answerNotebook')).toBeEnabled();
  expect((await conversation(page)).length).toBe(0);expect(requests).toBe(1);
});

test('salida truncada conserva sólo bloques válidos y explica el límite sin culpar a las citas',async({page})=>{
  await streamingNotebook(page);const query='QA_STREAM_TRUNCATED_'+randomUUID();
  await page.locator('#semanticQuery').fill(query);await page.locator('#answerNotebook').click();
  await expect(page.locator('#streamingBlocks .rag-paragraph')).toHaveCount(1);
  await page.request.post('/__test/release-stream',{data:{query}});
  await expect(page.locator('#searchFeedback')).toContainText('límite de salida');
  await expect(page.locator('#searchFeedback')).not.toContainText('citas válidas');
  await expect(page.locator('#streamingStatus')).toContainText('los bloques no se guardaron');
  await expect(page.locator('#streamingStatus')).not.toContainText('guardado sin confirmar');
  expect((await conversation(page)).length).toBe(0);
});

test('referencias sin extractos generados muestran texto original, deduplican y persisten',async({page})=>{
  await streamingNotebook(page);const query='QA_STREAM_MULTI_'+randomUUID();
  await page.locator('#semanticQuery').fill(query);await page.locator('#answerNotebook').click();
  try{
    await expect(page.locator('#streamingBlocks .rag-paragraph')).toHaveCount(1);
    await expect(page.locator('#streamingBlocks .rag-citation')).toHaveCount(1);
    await page.getByRole('button',{name:'Ver cita F1',exact:true}).click();
    await expect(page.locator('#citationQuote')).toHaveText('La energía solar proviene del sol.');
    await expect(page.locator('#sourceTextChunks pre')).toBeHidden();
    await page.locator('#sourceTextChunks summary').click();
    await expect(page.locator('#sourceTextChunks pre')).toHaveText('La energía solar proviene del sol.');
    await page.locator('#closeSourceText').click();
  }finally{await page.request.post('/__test/release-stream',{data:{query}});}
  await expect(page.locator('#streamingTurn')).toBeHidden();await expect(page.locator('#ragAnswerText .rag-paragraph')).toHaveCount(2);
  const saved=(await conversation(page))[0].answer;
  expect(saved.segments[0].citations).toEqual([{sourceId:'F1',quote:'La energía solar proviene del sol.',kind:'source_reference'}]);
  await page.reload();await page.getByRole('button',{name:'Ver cita F1',exact:true}).first().click();
  await expect(page.locator('#citationQuote')).toHaveText('La energía solar proviene del sol.');
});

test('historial anterior conserva extractos y botones diferenciados sin convertirlos en vistas previas',async({page})=>{
  await streamingNotebook(page);
  const source={id:'F1',filename:'solar.txt',position:0,page_number:null,content:'La energía solar proviene del sol.'};
  const legacy={turns:[{id:randomUUID(),question:'Consulta anterior',answer:{insufficientEvidence:false,sources:[source],segments:[{text:'Respuesta anterior.',citations:[{sourceId:'F1',quote:'La energía solar proviene del sol.'},{sourceId:'F1',quote:'energía solar proviene del sol.'}]}]}}],hasMore:false};
  await page.route('**/conversation',route=>route.fulfill({json:legacy}));
  await page.reload();
  await page.getByRole('button',{name:'Ver cita F1 · extracto 2',exact:true}).click();
  await expect(page.locator('#citationQuote')).toHaveText('energía solar proviene del sol.');
});
