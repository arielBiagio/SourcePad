# SourcePad

Aplicación web de chat con inteligencia artificial y cuadernos documentales. Permite organizar fuentes privadas, consultar su contenido y revisar los fragmentos utilizados para generar cada respuesta mediante recuperación aumentada por generación (RAG).

## Funcionalidades

- **Chat general:** respuestas por streaming con renderizado agrupado, presentación Markdown y envío de hasta seis mensajes recientes, con control del tamaño de la petición. La conversación y el borrador se conservan al navegar entre chat y cuadernos o recargar la misma pestaña, mientras la sesión esté activa.
- **Autenticación:** registro, acceso y confirmación de correo con Supabase Auth; sesiones administradas en el servidor mediante cookies HttpOnly.
- **Cuadernos:** creación, edición, búsqueda y eliminación de espacios independientes por tema.
- **Fuentes documentales:** carga privada de PDF, TXT y Markdown, hasta 10 MiB por archivo; vista previa, descarga y eliminación.
- **Procesamiento local:** extracción de texto, fragmentación y conservación de la página de origen en los PDF.
- **Indexación semántica:** embeddings BGE-M3 por lotes, con progreso, pausa entre lotes y reanudación.
- **Preguntas con fuentes:** recuperación sobre todas las fuentes indexadas del cuaderno y streaming por bloques, con referencias comprobadas y vistas previas obtenidas del texto original.
- **Historial por cuaderno:** preguntas y respuestas persistentes, con opción de borrar la conversación sin eliminar los documentos.
- **Interfaz adaptable:** fuentes, chat y cuadernos en tres columnas; navegación estable entre pantallas, transiciones suaves, pestañas en móvil, modales de citas y detalles desplegables. Respeta la preferencia del sistema de reducir movimiento.
- **Escritura compacta:** campo que crece con el texto; Enter envía y Shift + Enter inserta una línea. El modelo puede usar listas cuando mejoran la claridad.

El modo anterior de autenticación con Better Auth y SQLite se mantiene disponible para el chat general.

## Tecnologías

JavaScript, Node.js, Express, Supabase Auth/PostgreSQL/Storage, pgvector, PDF.js, Tailwind CSS y OpenRouter. Las pruebas utilizan Node Test Runner, Playwright y PostgreSQL embebido con PGlite.

El generador predeterminado configurado en el proyecto es `qwen/qwen3.8-flash`. Los embeddings utilizan `baai/bge-m3` con 1024 dimensiones. Cambiar el generador no requiere reindexar; cambiar el modelo o perfil de embeddings sí requiere una migración de los vectores.

## Instalación local

Requisitos: Node.js 24 LTS, npm, una clave de OpenRouter para las funciones de IA y un proyecto Supabase para los cuadernos.

```powershell
git clone https://github.com/arielBiagio/SourcePad.git
cd SourcePad
npm ci
Copy-Item .env.example .env
```

Completar `.env` localmente:

```dotenv
AUTH_PROVIDER=supabase
PORT=3000
APP_URL=http://localhost:3000
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
OPENROUTER_API_KEY=
OPENROUTER_CHAT_MODEL=qwen/qwen3.8-flash
```

Aplicar las cinco migraciones de `supabase/migrations/` en orden y configurar las URLs de autenticación según la [guía de Supabase](docs/supabase-setup.md). Las migraciones se ejecutan una sola vez; el servidor no las aplica automáticamente. Para una instalación existente, aplicar únicamente las pendientes.

```powershell
npm start
```

Frontend y API comparten el servidor de [localhost:3000](http://localhost:3000). No se necesita un servidor de frontend separado. El comando genera los estilos antes del arranque.

### Rutas principales

- `/auth.html`: inicio de sesión y registro.
- `/notebooks.html`: biblioteca y espacio de trabajo documental.
- `/index.html`: chat general, separado del contexto documental.

Sin un proyecto Supabase configurado, el modo `supabase` informa la configuración pendiente. Los cuadernos requieren una cuenta; no hay modo de demostración. Para usar el modo anterior, establecer `AUTH_PROVIDER=legacy`, generar un `BETTER_AUTH_SECRET` aleatorio de al menos 32 caracteres y ejecutar `npm run auth:migrate` antes de iniciar. Las cuentas de ambos proveedores son independientes.

## Flujo documental

1. Crear un cuaderno y agregar fuentes.
2. Abrir **Detalles y opciones** de cada fuente y seleccionar **Procesar** para extraer el texto localmente.
3. Seleccionar **Indexar** y confirmar el envío de los fragmentos al proveedor de embeddings.
4. Escribir una pregunta: la aplicación consulta las fuentes indexadas del cuaderno activo.
5. Abrir las citas numeradas para revisar la procedencia y, opcionalmente, el fragmento completo.

Los bloques aparecen a medida que termina su generación y se validan sus referencias. El modelo resume y elige los fragmentos; el servidor obtiene su texto original y metadatos, sin exigirle al modelo transcribir citas. El historial sólo se guarda después de completar y validar la respuesta entera. Si se cancela o falla la generación, los bloques ya recibidos quedan marcados como respuesta incompleta; no se guarda una respuesta parcial ni hay reintentos automáticos. Si la conexión se pierde durante el guardado final, conviene recargar el historial antes de repetir la consulta: una respuesta completa podría haberse guardado aunque no llegara su confirmación.

Al abrir un cuaderno se muestra el final del historial. Cada consulta nueva comienza con la pregunta arriba y la respuesta debajo; recibir bloques no fuerza el desplazamiento. La navegación y el tema oscuro se comparten entre chat, cuadernos y acceso. El original de una fuente se abre en un visor que ocupa todo el viewport; los PDF se dibujan localmente con controles de página y zoom, sin depender del plugin del navegador. Las citas permanecen en un modal compacto.

Las respuestas documentales solicitan un esquema JSON con identificadores de fragmentos obligatorios. Cada referencia abre una vista previa del inicio del fragmento (hasta 300 caracteres), con el contexto completo desplegable; no es un pasaje elegido automáticamente que demuestre cada afirmación. Las referencias no garantizan que el resumen interprete correctamente el documento. Se pide responder lo que esté respaldado, aclarar las limitaciones si la información es parcial y avisar cuando no alcance para responder. Los errores técnicos se distinguen de la falta de información, sin registrar texto de documentos ni claves. Las citas del historial anterior siguen disponibles; este cambio no requiere migraciones ni reindexación.

## Privacidad y seguridad

- Las claves se configuran exclusivamente en el entorno del servidor; no se entregan al navegador.
- El chat general se conserva en `sessionStorage`, separado por usuario y sin tokens. Se restaura sólo después de validar la sesión; se limpia al cerrar sesión, iniciar otra o borrar el chat. No se sincroniza entre dispositivos y se elimina al cerrar la pestaña. Si el navegador bloquea el almacenamiento o se queda sin espacio, el chat continúa en memoria y avisa que no pudo conservarlo. Navegar durante una generación la interrumpe: se mantiene el texto recibido y no se reintenta automáticamente.
- El acceso a cuadernos, documentos, vectores e historial se limita por usuario mediante autenticación y políticas RLS. Los originales se guardan en un bucket privado.
- La extracción de texto es local al servidor. La indexación envía fragmentos a OpenRouter y su proveedor; las preguntas también envían la consulta y los fragmentos recuperados. Estas operaciones pueden consumir saldo.
- Se solicita routing con `data_collection: deny`, pero esto no constituye una garantía absoluta de ausencia de retención. Revisar las políticas de los proveedores antes de cargar información sensible.
- Quitar una fuente no elimina los extractos ya conservados en respuestas históricas. Para retirarlos también es necesario borrar el chat; eliminar el cuaderno elimina su historial.
- `.env`, bases locales, backups, claves privadas y artefactos de pruebas están excluidos de Git. `.env.example` contiene únicamente configuración de referencia, sin credenciales.

Si una credencial se publica accidentalmente, debe revocarse o rotarse; borrarla de un commit posterior no elimina su exposición anterior.

## Pruebas

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

Las suites cubren autenticación, aislamiento entre usuarios, migraciones/RLS, documentos, extracción, embeddings, validación de citas, historial y recorridos de navegador en escritorio y móvil. Utilizan datos sintéticos y servicios externos simulados, sin llamadas pagas a modelos. No sustituyen las pruebas de integración con un proyecto Supabase real ni la evaluación de calidad del modelo.

## Alcance y limitaciones

- No hay OCR: los PDF necesitan texto seleccionable. Tablas y columnas pueden requerir revisión.
- Las citas verifican procedencia y coincidencia literal, no garantizan que cada conclusión sea correcta.
- El historial se guarda, pero las preguntas documentales son independientes: las respuestas anteriores no se reenvían como contexto al modelo. La interfaz muestra los últimos 30 intercambios.
- No hay reintentos automáticos de IA, cola autónoma ni límite monetario global. Un intento fallido o cancelado puede generar cargos.
- Recuperación de contraseña, acceso con Google y las herramientas marcadas como próximas todavía no están implementados.
- Antes de un despliegue público se deben configurar HTTPS, correo/SMTP, políticas de acceso, aislamiento del procesamiento de archivos, límites de recursos y controles de gasto. Publicar el código no implica que el servicio esté preparado para producción.

La [guía técnica de Supabase](docs/supabase-setup.md) detalla la configuración, las migraciones, el contrato HTTP y los límites del procesamiento.

## Organización del código

El frontend utiliza módulos JavaScript nativos: `general-chat.js` para el chat general; `notebooks.js` para coordinar el workspace; `source-list.js`, `source-viewer.js` y `chat-view.js` para sus vistas. El transporte HTTP se comparte en `http.js` y los límites públicos en `contracts.js`. El backend conserva la validación independiente de cada petición y comparte la búsqueda documental mediante `document-access.js`, sin retirar los filtros de propietario/cuaderno ni las políticas RLS.
