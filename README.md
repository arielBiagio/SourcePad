# My Chat AI

Aplicación web de chat con inteligencia artificial y cuadernos documentales. Permite organizar fuentes privadas, consultar su contenido y revisar los fragmentos utilizados para generar cada respuesta mediante recuperación aumentada por generación (RAG).

## Funcionalidades

- **Chat general:** respuestas por streaming, presentación Markdown y contexto reciente de la conversación.
- **Autenticación:** registro, acceso y confirmación de correo con Supabase Auth; sesiones administradas en el servidor mediante cookies HttpOnly.
- **Cuadernos:** creación, edición, búsqueda y eliminación de espacios independientes por tema.
- **Fuentes documentales:** carga privada de PDF, TXT y Markdown, hasta 10 MiB por archivo; vista previa, descarga y eliminación.
- **Procesamiento local:** extracción de texto, fragmentación y conservación de la página de origen en los PDF.
- **Indexación semántica:** embeddings BGE-M3 por lotes, con progreso, pausa entre lotes y reanudación.
- **Preguntas con fuentes:** recuperación sobre todas las fuentes indexadas del cuaderno y respuestas con citas y extractos verificables.
- **Historial por cuaderno:** preguntas y respuestas persistentes, con opción de borrar la conversación sin eliminar los documentos.
- **Interfaz adaptable:** fuentes, chat y cuadernos en tres columnas; navegación por pestañas en móvil, modales de citas y detalles desplegables.
- **Escritura compacta:** campo que crece con el texto; Enter envía y Shift + Enter inserta una línea. El modelo puede usar listas cuando mejoran la claridad.
- **Vista de ejemplo:** exploración de la biblioteca sin cuentas ni llamadas a servicios de IA.

El modo anterior de autenticación con Better Auth y SQLite se mantiene disponible para el chat general.

## Tecnologías

JavaScript, Node.js, Express, Supabase Auth/PostgreSQL/Storage, pgvector, PDF.js, Tailwind CSS y OpenRouter. Las pruebas utilizan Node Test Runner, Playwright y PostgreSQL embebido con PGlite.

El generador predeterminado configurado en el proyecto es `qwen/qwen3.8-flash`. Los embeddings utilizan `baai/bge-m3` con 1024 dimensiones. Cambiar el generador no requiere reindexar; cambiar el modelo o perfil de embeddings sí requiere una migración de los vectores.

## Instalación local

Requisitos: Node.js 24 LTS, npm, una clave de OpenRouter para las funciones de IA y un proyecto Supabase para los cuadernos.

```powershell
git clone https://github.com/arielBiagio/mi-primer-chat-ai.git
cd mi-primer-chat-ai
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
- `/notebooks.html?preview=1`: ejemplo interactivo con datos temporales en memoria.
- `/index.html`: chat general, separado del contexto documental.

Sin un proyecto Supabase configurado, el modo `supabase` informa la configuración pendiente y permite acceder a la vista de ejemplo. Para usar el modo anterior, establecer `AUTH_PROVIDER=legacy`, generar un `BETTER_AUTH_SECRET` aleatorio de al menos 32 caracteres y ejecutar `npm run auth:migrate` antes de iniciar. Las cuentas de ambos proveedores son independientes.

## Flujo documental

1. Crear un cuaderno y agregar fuentes.
2. Abrir **Detalles y opciones** de cada fuente y seleccionar **Procesar** para extraer el texto localmente.
3. Seleccionar **Indexar** y confirmar el envío de los fragmentos al proveedor de embeddings.
4. Escribir una pregunta: la aplicación consulta las fuentes indexadas del cuaderno activo.
5. Abrir las citas numeradas para revisar la procedencia y, opcionalmente, el fragmento completo.

## Privacidad y seguridad

- Las claves se configuran exclusivamente en el entorno del servidor; no se entregan al navegador.
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
