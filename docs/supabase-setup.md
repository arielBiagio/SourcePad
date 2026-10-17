# Conectar Supabase

## 1. Crear el proyecto y preparar la base

Creá un proyecto nuevo. En SQL Editor ejecutá una vez estos archivos, en orden:

1. `supabase/migrations/202610160001_notebooks.sql`
2. `supabase/migrations/202610160002_documents.sql`
3. `supabase/migrations/202610160003_processing.sql`
4. `supabase/migrations/202610160004_embeddings.sql`
5. `supabase/migrations/202610160005_conversations.sql` (historial privado)

Para instalaciones existentes, aplicar únicamente las migraciones pendientes: la tercera habilita procesamiento, la cuarta indexación y la quinta historial. No repetir migraciones ya aplicadas.

También puede aplicarse con el flujo habitual de migraciones de Supabase CLI. Este proyecto no ejecuta migraciones remotas al arrancar.

La primera migración crea:

- Tabla `notebooks`, ligada a `auth.users`.
- Políticas RLS para leer, crear, editar y borrar únicamente cuadernos propios.
- Permisos que impiden editar `owner_id`, `id` y timestamps desde el cliente.
- Extensión `vector`, sin fijar todavía modelo o dimensión.
- Bucket `notebook-sources` privado, sin permisos de lectura/subida de objetos aún.

La segunda habilita las fuentes privadas:

- Tabla `documents`, ligada al propietario y al cuaderno con clave foránea compuesta.
- Políticas de Storage que sólo permiten archivos respaldados por una fila propia y con la ruta exacta asignada.
- Límite de 10 MiB y tipos PDF, TXT y Markdown en el bucket privado.
- Funciones de transición que verifican propietario, estado y presencia/ausencia del objeto; el usuario no puede marcar una fuente como lista ni sobrescribir su original.
- Borrado de cuadernos únicamente cuando sus fuentes ya fueron eliminadas.

La tercera agrega extracción y fragmentación:

- Estado `extracted` y metadatos de páginas, páginas sin texto, cantidad de fragmentos y versión del procesamiento.
- Tablas `document_jobs` y `document_chunks`, con claves compuestas y RLS por propietario; no se conceden escrituras directas al cliente.
- Reclamo del trabajo con lease de dos minutos y `run_id` distinto en cada intento. Un resultado vencido o cancelado no puede guardar texto.
- Guardado de todos los fragmentos y del resultado en una sola transacción.
- Al comenzar el borrado de una fuente se cancela el trabajo activo y se retiran sus fragmentos.

La cuarta agrega `chunk_embeddings` con `vector(1024)`, perfil fijo BGE-M3, hash del texto y RLS; trabajos de indexación por lotes; transición a `ready` al completar todos los fragmentos; búsqueda coseno exacta por cuaderno/fuentes y eliminación en cascada de vectores al borrar fragmentos. No hace inferencias ni cambia originales al ejecutarse. Requiere pgvector en el esquema `extensions`, como en 001.

Las migraciones no eliminan cuentas ni originales existentes. Las funciones de borrado sólo se ejecutan ante una petición del usuario. Si una migración falla, la transacción revierte el conjunto; revisá el error antes de reintentar. Si ya se aplicó correctamente, no la vuelvas a ejecutar manualmente.

## 2. Agregar variables a tu .env

```dotenv
AUTH_PROVIDER=supabase
PORT=3000
APP_URL=http://localhost:3000
SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_PUBLISHABLE_KEY=TU_CLAVE_PUBLISHABLE
```

La URL y la clave publishable están en **Connect** o en la configuración de API del proyecto. En proyectos con claves antiguas se puede usar `SUPABASE_ANON_KEY` en lugar de `SUPABASE_PUBLISHABLE_KEY`.

Opcional: `MAX_UPLOAD_BYTES=10485760`. Permite reducir el límite de Express (en bytes), pero no aumentarlo por encima de los 10 MiB definidos en la base y el bucket. No hace falta agregarlo al `.env` para usar ese valor predeterminado.

No uses `service_role` ni `sb_secret_...` aquí. Cuadernos, documentos y procesamiento usan el JWT del usuario y RLS. Las claves no se entregan en `/api/config`. El worker de extracción recibe sólo el archivo y su extensión, sin variables de entorno del servidor ni credenciales de Supabase.

La clave existente `OPENROUTER_API_KEY` puede permanecer. `OPENROUTER_CHAT_MODEL` permite cambiar el generador sin editar código. Se eligió `qwen/qwen3.8-flash` como generador predeterminado (de pago); BGE-M3 continúa separado para embeddings. Cambiar el generador no exige reindexar ni ejecutar SQL. No hay llamadas al modelo al iniciar el servidor ni fallback automático al modelo gratuito anterior. Las preguntas con citas están disponibles dentro del cuaderno; el chat general sigue separado.

No agregues claves ni tokens a Git. No pegues claves administrativas en el frontend.

## 3. Autenticación con el correo predeterminado

Activá email/contraseña. Mantené la confirmación de correo activada.

En **Authentication → URL Configuration**:

- Site URL: `http://localhost:3000`
- Redirect URL permitida: `http://localhost:3000/auth/callback`
- Opcional para enlaces enviados por versiones anteriores: `http://localhost:3000/auth.html`

Dejá **Confirm sign up** con su plantilla predeterminada. No necesitás editar el HTML del correo ni configurar SMTP propio para adaptar el enlace. El panel puede bloquear esa edición hasta que conectes un SMTP.

Al registrarse, Express usa PKCE e indica `/auth/callback` como URL de retorno. El correo estándar de Supabase incluye el enlace de verificación (ConfirmationURL). Cuando lo abrís, Supabase confirma el email y vuelve a la aplicación con un código. El backend intercambia ese código junto con el verificador guardado en una cookie, crea la sesión HttpOnly y abre `/notebooks.html`.

Abrí el correo en el **mismo navegador y dispositivo** donde te registraste. Si lo abrís en otro, el email puede quedar confirmado, pero faltará la cookie para iniciar sesión automáticamente. En ese caso entrá desde `/auth.html` con tu email y contraseña. Tampoco alternes entre `localhost` y `127.0.0.1`: son hosts distintos para las cookies.

Los códigos no se imprimen en los logs de la aplicación. La ruta de retorno no acepta destinos externos y utiliza respuestas privadas sin caché. Para producción usá el dominio HTTPS tanto en APP_URL como en Site URL y Redirect URLs.

El servicio de correo integrado tiene restricciones: sólo permite destinatarios autorizados del equipo del proyecto y un límite bajo de envíos. Para probar inicialmente usá tu dirección del equipo. Para registrar usuarios externos con confirmación de correo necesitarás SMTP propio. Esto afecta a la entrega de los mensajes, no al soporte de la plantilla estándar de nuestra app.

Después del registro sin sesión la pantalla muestra que hay que confirmar el email; no redirige prematuramente. Las cuentas del SQLite anterior siguen siendo independientes: se crean cuentas nuevas en Supabase. Los enlaces anteriores con `token_hash` siguen admitidos en `/auth/confirm`, por si luego configurás SMTP y elegís una plantilla propia.

Recuperación de contraseña y Google todavía no están implementados. La UI los indica como pendientes.

## 4. Iniciar y validar

```powershell
npm ci
npm start
```

Abrí `http://localhost:3000/auth.html`, creá una cuenta, confirmá el email y entrá.

Probá con dos cuentas distintas:

1. A crea y renombra un cuaderno; persiste al recargar.
2. B ve solamente sus propios cuadernos.
3. B no puede editar o eliminar un ID perteneciente a A.
4. Logout lleva a la pantalla de acceso.
5. Una petición a `/api/notebooks` sin sesión devuelve 401.
6. A abre su cuaderno, sube un TXT/MD o PDF y ve “Pendiente de procesamiento”. Recarga y comprueba que sigue ahí; descarga el original.
7. B no puede listar, descargar ni eliminar fuentes de A, ni usando sus IDs.
8. A elimina una fuente con confirmación. Para eliminar el cuaderno primero debe eliminar todas sus fuentes.
9. A elige **Procesar** en un documento y después **Ver texto**. El resultado persiste al recargar. Para un PDF, los fragmentos indican la página original.
10. Un PDF sin texto seleccionable muestra un error explicando que necesita OCR. Si algunas páginas están vacías, se informa su cantidad sin renumerar las demás.
11. B no puede procesar ni leer los fragmentos de A. El borrado de A retira también el texto derivado.
12. A abre **Detalles y opciones**, elige **Indexar**, confirma envío/costo y espera “Indexado para búsqueda”. Formula una pregunta y revisa archivo/página/fragmento en sus citas; la UI consulta todas las fuentes indexadas del cuaderno.
13. B no puede indexar ni recuperar fragmentos de A. Borrar una fuente retira también sus embeddings y deja de aparecer en búsquedas.

Si aparece "verificá la migración", comprobá que el SQL se ejecutó en el mismo proyecto al que apunta SUPABASE_URL.

## Contrato HTTP de esta etapa

Las mutaciones requieren `Origin` igual a APP_URL. El navegador lo agrega automáticamente. Si usás curl u otra herramienta, incluí ese header y la cookie de sesión; no agregues un token de OpenRouter al frontend.

| Método | Ruta | Cuerpo / respuesta |
| --- | --- | --- |
| GET | /api/config | Proveedor activo, estado de configuración y pantalla inicial; sin claves |
| POST | /api/auth/sign-up/email | `{name,email,password}` → `{confirmationRequired,user?}` |
| POST | /api/auth/sign-in/email | `{email,password,rememberMe}` → `{user}` y cookies |
| POST | /api/auth/sign-out | Cierra la sesión de este dispositivo |
| GET | /api/me | `{user,home}`, o 401 |
| GET | /api/notebooks | `{notebooks,hasMore}`, hasta 200 ordenados por última edición |
| POST | /api/notebooks | `{title,description?}` → 201 `{notebook}` |
| PATCH | /api/notebooks/:id | `{title,description?}` → `{notebook}` |
| DELETE | /api/notebooks/:id | 204 si no tiene fuentes activas; 409 en caso contrario |
| GET | /api/notebooks/:id/documents | `{documents,hasMore}`; hasta 200 fuentes no eliminadas |
| POST | /api/notebooks/:id/documents | Multipart con un único campo `file` → 201 `{document}` |
| GET | /api/notebooks/:id/documents/:documentId/download | Descarga privada como attachment; nunca HTML ejecutable |
| DELETE | /api/notebooks/:id/documents/:documentId | 204; borrado reintentable si Storage falla |
| POST | /api/notebooks/:id/documents/:documentId/process | Sin cuerpo → `{document}` al terminar; 409 si ya se procesa o el estado no permite procesar |
| GET | /api/notebooks/:id/documents/:documentId/chunks?offset=0 | `{document,chunks,nextOffset}`; 20 fragmentos por petición, orden estable |
| POST | /api/notebooks/:id/documents/:documentId/index | `{confirmExternalProcessing:true}` → `{document,complete}`; procesa un lote de hasta 32 fragmentos |
| POST | /api/notebooks/:id/search | `{query,sourceIds?}` → `{matches,indexedSources,profile}`; hasta 5 coincidencias |
| POST | /api/notebooks/:id/answer | `{query,confirmExternalProcessing:true,sourceIds?}` → respuesta JSON o bloques NDJSON si `Accept: application/x-ndjson` |
| POST | /api/chat | Chat general por streaming de texto; no es RAG todavía |

El propietario se determina en el servidor y vuelve a comprobarse con RLS. Las rutas nunca aceptan un owner_id del cuerpo como autorización. IDs ajenos o inexistentes producen 404.

Las cookies de Supabase se renuevan en el backend antes de empezar a transmitir la respuesta. Son HttpOnly y SameSite=Lax, Secure cuando APP_URL usa HTTPS. Las respuestas de sesión/datos son privadas y no se cachean. "Recordarme" desactivado usa cookies de sesión del navegador; no depende de localStorage.

## Documentos: alcance y estados

En la pantalla se pueden elegir hasta diez archivos y se suben de a uno. Express permite dos subidas simultáneas por proceso y veinte peticiones de subida por minuto/IP. Cada petición admite un solo archivo, máximo 10 MiB (o el límite inferior configurado). No se escriben temporales en disco.

El backend valida extensión, tamaño y contenido: UTF-8 legible para TXT/MD; firma y marcador final para PDF. Esta comprobación de subida es básica, no un análisis completo ni un antivirus. Durante el procesamiento, PDF.js intenta analizar el documento completo. Los originales se descargan como archivos adjuntos con `nosniff` y CSP sandbox; ni el original ni el texto extraído se interpretan como HTML.

Los estados son `uploading` → `uploaded` → `processing` → `extracted` → `ready`, o `error` de subida/extracción. `ready` sólo se alcanza al indexar todos los fragmentos. El estado de índice es independiente: `not_indexed`, `indexing`, `partial`, `indexed` o `error`; un error de embeddings conserva el texto extraído y los lotes ya guardados. Ningún documento se indexa automáticamente tras extraerlo.

Al eliminar se pasa a `deleting`, se elimina el objeto de Storage y se verifica su ausencia antes de marcar `deleted`. Si Storage falla se conserva el estado y se puede reintentar desde la interfaz. Mientras exista el cuaderno se mantiene la fila eliminada, oculta de la lista normal. El borrado del cuaderno elimina también esas filas. Los extractos de citas ya guardadas son snapshots y permanecen en su conversación; el modal de quitar fuente lo advierte. Borrar chat los elimina; borrar cuaderno elimina el historial en cascada. No hay limpieza automática ni borrado en segundo plano en esta etapa.

El servidor usa exclusivamente el JWT de cada usuario, no una clave administrativa. Para comprobarlo en el proyecto alojado, probá también con dos cuentas distintas y verificá que el bucket no sea público ni tenga políticas adicionales permisivas. Las pruebas locales simulan la API de Storage; no certifican por sí solas la configuración remota.

## Extracción: funcionamiento, límites y recuperación

El botón **Procesar** hace una petición autenticada y espera el resultado. Antes de extraer, Express verifica el tamaño y SHA-256 del original descargado frente a lo registrado en la subida. PDF.js trabaja localmente, con recursos de fuentes/CMaps del paquete instalado; no se envía el documento a un proveedor de IA.

Se usa un worker thread separado del event loop de Express, con un máximo de un procesamiento simultáneo por proceso y diez peticiones por usuario cada diez minutos. Límites por documento: 10 MiB, 200 páginas PDF, un millón de caracteres de texto y 1500 fragmentos. El conteo de PDF es conservador antes de normalizar, por lo que algunos documentos pueden llegar al límite antes. El parser tiene 25 segundos de tiempo real y límites de heap V8 de 256 MiB + 32 MiB de generación joven. Eso **no** limita toda la memoria nativa ni es una sandbox de sistema operativo; antes de ofrecer uploads públicos en producción conviene aislar el worker en un proceso/contenedor con límites de SO.

Este flujo sólo solicita texto: no consulta ni ejecuta acciones o scripts del documento. Se deshabilitan XFA, carga de fuentes del sistema y decodificación de imágenes; no se renderizan páginas, adjuntos o anotaciones. No hay OCR: PDF protegido, dañado, sin texto seleccionable o demasiado grande muestra un error explícito, sin fragmentos parciales. Si sólo algunas páginas no tienen texto, se informa su cantidad. Tablas, columnas, saltos y guiones pueden no reconstruirse fielmente: revisar el visor antes de indexar fuentes complejas.

El texto se normaliza a NFC, saltos LF y espacios uniformes. Cada fragmento contiene hasta 1200 puntos de código Unicode, con 180 de solapamiento; se prefiere cortar en saltos/espacios. Nunca cruza páginas. `char_start` y `char_end` son offsets base cero y fin exclusivo sobre el texto normalizado de esa página, no bytes ni posiciones del PDF original. TXT y MD usan `page_number = null`, con offsets sobre todo el archivo. La versión actual es `text-v1-char1200-overlap180`; cambiar extracción/fragmentación exige versionar y planear la reindexación posterior.

Los fragmentos y los contadores se guardan juntos mediante una función SQL que comprueba propietario, estado, intento, lease y estructura del resultado. Son contenido del usuario, no instrucciones confiables ni evidencia certificada por un administrador. El visor usa `textContent`, no Markdown/HTML ejecutable. La API pagina de a veinte para no cargar todo el documento en el navegador.

`document_jobs` guarda un trabajo por fuente, contador de intentos y el intento vigente. **No hay cola autónoma ni reanudación automática**: el worker se activa bajo la sesión del usuario al pulsar Procesar. Si Express cae, el trabajo puede quedar `running`/`processing`; pasado el lease de dos minutos, el botón Reintentar crea un `run_id` nuevo. No se persisten JWTs. Mientras el lease esté activo se rechaza otro procesamiento con 409; un trabajo local ocupado devuelve 429. Un éxito repetido devuelve los metadatos existentes sin duplicar fragmentos.

Si otra pestaña elimina una fuente mientras se procesa, su resultado posterior se descarta. Un borrado retira los fragmentos incluso si falla Storage y requiere reintentar el borrado del original. Los textos/documentos previamente subidos se pueden procesar después de aplicar 003, sin subirlos otra vez ni modificar `.env`.

## BGE-M3: indexación, costo y búsqueda

Se usa `baai/bge-m3` a través de la API `/api/v1/embeddings` de OpenRouter con la misma clave del servidor, salida `float` y vectores densos de 1024 dimensiones. No se usa para generar respuestas, ni se solicitan vectores sparse/ColBERT. Se fija el perfil `baai/bge-m3:dense:1024:cosine:v1`; no hay configuración que cambie silenciosamente de modelo o dimensión. No cambies `OPENROUTER_CHAT_MODEL` por este modelo.

Tras ejecutar 004 y reiniciar Express: abrir una fuente ya extraída → **Indexar** → confirmar envío del texto y uso de saldo → esperar “Indexado para búsqueda” → escribir una consulta → **Preguntar**. La interfaz usa siempre todas las fuentes indexadas del cuaderno activo, sin selector ni botón separado de embeddings. No hay que volver a subir ni extraer los PDFs. Si falta la clave, la interfaz lo informa y no habilita indexación/preguntas. La clave no se expone en `/api/config`, sólo un booleano de configuración y el nombre del modelo.

**Privacidad y cobro:** se envían fragmentos de texto a OpenRouter y al proveedor enrutado, no el original PDF; las consultas también salen del equipo. Cada indexación/pregunta puede consumir saldo. La indexación requiere confirmación explícita; el formulario de preguntas no repite el aviso en cada envío. Se pide routing `data_collection: deny` y `require_parameters: true`; si no hay proveedor compatible, se devuelve error, sin relajar la política. Esto no garantiza cero retención en toda la cadena: revisar sus políticas antes de usar documentos sensibles. Los tests automatizados usan datos sintéticos y servicios de IA simulados.

La indexación reclama hasta 32 posiciones por petición, genera embeddings y guarda el lote completo en una transacción. El navegador sigue con el siguiente lote y muestra progreso. **Detener después de este lote** conserva lo ya guardado. Después de recargar o fallar se puede continuar; un reclamo activo bloquea duplicados por dos minutos. Los reclamos vencidos se reemplazan por un `run_id` distinto. No hay daemon, cola autónoma ni JWTs persistidos.

Se reutilizan los vectores ya guardados por documento/posición/perfil/hash de texto. Dentro de un lote se deduplican textos idénticos antes de llamar al proveedor. No hay caché global entre usuarios ni reutilización de consultas. Si el proveedor cobra pero falla el guardado o se pierde la respuesta, un reintento puede generar de nuevo el lote no persistido: no se promete cobro exactamente una vez. Errores de saldo/permisos/límites se muestran sin detalles sensibles; el SDK no tiene reintentos automáticos. Tiempo máximo de la llamada de embeddings: 30 segundos; la UI espera hasta 90 segundos por lote incluyendo base de datos.

El backend verifica modelo, cantidad/índices, dimensiones, números finitos y norma no nula; normaliza cada vector. Acepta `baai/bge-m3`, la variante de mayúsculas `BAAI/bge-m3` y el alias exacto `parasail-bge-m3` observado en la prueba real de 32 frases. La solicitud y el perfil siguen siendo BGE-M3; no se aceptan otros modelos por tener 1024 dimensiones. Los errores distinguen identificador inesperado de lote incompleto y no muestran el contenido de la respuesta externa. La base exige 1024 dimensiones y norma unitaria, valida el hash contra el texto actual, el intento/lease vigente y que el lote corresponda a sus posiciones reclamadas. Un documento sólo es consultable cuando todos sus fragmentos están indexados; repetir un documento ya terminado no hace otra llamada. Los RPCs comprueban propiedad y estructura, pero no certifican que vectores enviados directamente por un propietario provengan realmente del proveedor.

### Errores de OpenRouter

El chat y los embeddings distinguen acceso/clave, saldo, modelo no disponible, límite 429, routing y timeout sin exponer mensajes privados del proveedor. Un error de OpenRouter no cierra la sesión de Supabase. No hay reintento ni cambio de modelo automáticos. El chat también detecta errores dentro de una respuesta HTTP 200 o SSE y una respuesta terminada sin texto visible. Si el proveedor responde 429, esperar o elegir manualmente otro `OPENROUTER_CHAT_MODEL` y reiniciar Express; esto no cambia BGE-M3 ni requiere SQL. Si el stream ya entregó texto y luego falla, se corta la conexión, no se convierte en un éxito completo.

La búsqueda acepta de 1 a 1000 caracteres y, opcionalmente, de 1 a 20 IDs de fuentes distintas. Primero comprueba propiedad y estado: cuaderno/fuentes ajenas o no indexadas se rechazan antes de enviar la consulta al proveedor. Si no hay fuentes indexadas devuelve vacío sin consumir embeddings. Después vectoriza la consulta con el mismo modelo y recupera los cinco vecinos por coseno, aplicando nuevamente RLS/filtros de usuario, cuaderno, estado, perfil y fuentes. Las funciones de búsqueda son `SECURITY INVOKER`, sin clave administrativa.

Se usa búsqueda exacta en pgvector, sin índice ANN/HNSW por ahora: simplifica resultados/filtros para el volumen personal inicial. Hay índices de alcance por propietario/cuaderno; medir antes de escalar y elegir ANN/iterative scans. Como protección local se permiten dos operaciones de embeddings simultáneas por proceso y cien peticiones por usuario cada diez minutos, compartidas entre lotes y consultas. No es una cuota global multiinstancia ni un límite de gasto monetario.

Los resultados incluyen archivo, página cuando corresponde, posición, texto y similitud coseno; el navegador muestra texto literal. El score no es una probabilidad de veracidad ni de respuesta correcta. No hay umbral calibrado, reranking ni evaluación semántica real: siempre revisar los fragmentos. El borrado cancela trabajos pendientes y elimina vectores junto con los fragmentos; resultados atrasados no pueden restaurarlos.

## Preguntas con citas (sin nuevas migraciones)

El campo del chat empieza en una línea, crece con animación al escribir y se reduce al borrar/enviar. Enter envía y Shift + Enter agrega un salto; se evita enviar durante composición IME o duplicar una consulta pendiente. No hay subtítulos ni avisos rutinarios de guardado, pero sí se muestran errores y respuestas sin guardar. Los mensajes propios se ajustan al texto a la derecha. En la lista, los datos/acciones de las fuentes se abren desde **Detalles y opciones**; × sigue disponible para quitar una fuente.

En el formulario del chat, pulsar **Preguntar**. La UI envía `{query, confirmExternalProcessing:true}` y consulta todas las fuentes indexadas del cuaderno activo, sin selector ni casilla de costo por pregunta. `POST /api/notebooks/:notebookId/answer` acepta `sourceIds` opcional para consumidores de la API y aplica los controles de propiedad y RLS; no acepta historial, contexto ni metadatos de citas del cliente. Cuaderno/fuentes ajenos, no indexados o entrada inválida se rechazan antes de IA. Sin fuentes indexadas se abstiene sin embedding/generación. Se conserva la API `/search`, pero la pantalla no ofrece ese modo separado.

Se recuperan hasta cinco fragmentos, se asignan IDs F1–F5 en el servidor y se envían al modelo configurado con la pregunta. Se solicita `response_format: json_schema` con `strict: true`: cada bloque contiene `text` y `citations:[{sourceId:"F1"}]`. El modelo sólo elige IDs; no se solicita `quote` ni se aceptan metadatos o extractos generados. Se mantienen razonamiento desactivado y routing `data_collection: deny` / `require_parameters: true`. El modelo y endpoint deben admitir salidas estructuradas; si no hay routing compatible se informa el error, sin retirar el esquema ni cambiar automáticamente de modelo o políticas. La validación local sigue siendo necesaria aunque el proveedor admita el esquema. No se usan tools, navegación ni ejecución de acciones. Los documentos/pregunta se serializan como datos no confiables en un mensaje separado del sistema; esto es una mitigación, no una garantía contra prompt injection.

Antes de mostrar la respuesta, el servidor exige JSON exacto, hasta cuatro bloques citados (párrafos o listas) y de una a cinco referencias por bloque a fragmentos recuperados. Los IDs repetidos dentro de un bloque se deduplican. Página, archivo, posición y texto se toman de Supabase, no del modelo. Para mantener el formato de la API e historial, el servidor añade a cada cita `quote` (prefijo literal de hasta 300 caracteres, sin cortar pares Unicode) y `kind:"source_reference"`. Es una vista previa del inicio, no un extracto seleccionado como prueba puntual. Una referencia válida verifica procedencia, NO implicación semántica; no certifica que cada conclusión sea correcta. Se pide dar una respuesta parcial útil si hay respaldo para parte de la pregunta y aclarar lo que falta. Si el modelo declara evidencia insuficiente se devuelve un mensaje fijo sin respuesta improvisada. JSON, referencias o salida truncada inválidos siguen siendo errores técnicos y no se presentan como falta de información. No hay umbral de abstención calibrado: el top-5 puede ser irrelevante y la decisión de suficiencia depende del modelo.

El chat muestra bloques completos a medida que se validan y resuelven sus referencias, con letra de 17px, interlineado 1.7 y separación entre párrafos. No publica tokens ni JSON incompletos del modelo. Cada cita abre un modal pequeño centrado con vista previa, archivo, página y fragmento de esa respuesta; no despliega evidencia al final ni desplaza el chat. Funciona también para respuestas históricas y fuentes eliminadas, usando el snapshot privado. Las citas anteriores sin `kind` conservan sus extractos y botones diferenciados. Texto del modelo/documento/nombres se renderiza con `textContent`. Las preguntas son independientes: no se reenvía el historial al modelo. Con la migración 005, sólo la respuesta terminada y validada completa se conserva al recargar. El chat general queda intacto. No se necesita una migración adicional ni reindexar por el cambio de referencias.

### Protocolo de streaming por bloques

El cliente envía `Accept: application/x-ndjson` al mismo endpoint `/answer`, con la misma autenticación, límites y cuerpo. Sin ese header se conserva la respuesta JSON anterior. El streaming reutiliza una única generación de OpenRouter: no llama al modelo por cada bloque ni necesita otra migración.

- `block`: índice consecutivo, segmento completo con referencias resueltas por el servidor y snapshots únicamente de las fuentes citadas por ese bloque. Se verifican formato, límites e identificadores antes de emitirlo y se copia la vista previa del original. Esto no certifica la implicación semántica de las afirmaciones.
- `done`: resultado final validado, estado de guardado y metadatos de conversación. Se emite después de finalizar el modelo y el intento de persistencia; no duplica bloques en la interfaz.
- `error`: fallo seguro posterior al primer bloque; termina la transmisión sin guardar una respuesta parcial. Los fallos anteriores al primer bloque conservan su código HTTP y cuerpo JSON.

El lector incremental respeta strings, escapes, llaves y arrays del JSON. Si el modelo cambia el orden de los campos raíz, la respuesta puede validarse y emitirse al terminar, sin intentar adivinar bloques parciales. El JSON completo debe coincidir con los bloques ya emitidos antes de guardar. Se conservan los límites de cuatro bloques y 12.000 caracteres de salida bruta; el cliente limita el transporte a 256 KiB y rechaza índices repetidos, cambios de contenido y EOF sin evento final.

Una interrupción deja los bloques recibidos marcados como incompletos y no los agrega al historial en memoria ni en la base. Si la respuesta ya terminó y se pierde la conexión durante el guardado/confirmación final, una fila completa podría haberse guardado; la interfaz indica guardado sin confirmar y recomienda revisar el historial antes de repetir. No se promete persistencia exactamente una vez ni reversión de cargos. Cancelar aborta la lectura y el proveedor cuando es posible. El servidor envía `no-store`, `no-transform` y `X-Accel-Buffering: no`; el hosting debe permitir respuestas largas sin buffering adicional.

El modal muestra primero sólo la vista previa y su procedencia; el aviso la identifica como el inicio del fragmento. El contexto queda cerrado en **Ver fragmento completo**, también al reabrir una cita histórica; desplegarlo no genera otra petición a la IA.

Cada ID aparece una sola vez por bloque nuevo, aunque puede respaldar varios bloques. Se mantiene el límite de cinco referencias por bloque. No se completa un ID vacío ni se acepta uno inventado: únicamente se resuelven IDs que existan en la recuperación de esa consulta. Los textos originales no se reconstruyen, corrigen ni comparan aproximadamente con texto generado.

Los errores de validación incluyen un `reason` estático (por ejemplo `CITATION_FIELDS_MISSING`, `UNKNOWN_SOURCE` o `INVALID_JSON`) y un mensaje específico. El flujo nuevo no depende de que el modelo copie citas y ya no genera `QUOTE_NOT_FOUND`. `RAG_OUTPUT_TRUNCATED` indica que el modelo alcanzó el límite de salida; no significa que haya una cita falsa. Los logs contienen sólo código/motivo/ruta, no el contenido del documento o la respuesta. Un rechazo confirmado se diferencia de una desconexión con guardado final incierto. El límite sigue siendo 2048 tokens, sin reintentos; no se aumenta automáticamente el gasto máximo ni se promete responder durante fallos del proveedor.

## Interfaz e historial (migración 005)

El código del workspace se divide en un coordinador (`public/notebooks.js`), lista de fuentes (`source-list.js`), visor (`source-viewer.js`) y vista de respuestas (`chat-view.js`). Las vistas reciben sus dependencias y acceso al estado explícitamente. `http.js` comparte JSON/blob/respuestas streaming, credenciales same-origin, timeout y errores, sin reintentos. En autenticación un 401 de credenciales no dispara redirección; en recursos privados se vuelve al login. `contracts.js` contiene sólo límites públicos, nunca claves o configuración privada.

El chat general carga `general-chat.js` como módulo y agrupa los chunks de texto por fotograma antes de aplicar Markdown y DOMPurify. No se elimina el saneamiento HTML. Se conserva la conversación visible, pero la petición usa hasta seis mensajes recientes y un máximo de 120 KiB, bajo el límite HTTP de 128 KiB. Si el texto multibyte o sus escapes superan el presupuesto, se omiten mensajes antiguos completos, sin recortar ni modificar la pregunta actual. El mensaje actual conserva el límite del servidor de 16.000 unidades UTF-16. Cancelar descarta renders pendientes y limpiar durante streaming cancela la generación.

Si 001–004 ya están aplicadas, ejecutar sólo `202610160005_conversations.sql` desde SQL Editor y recargar. Es una tabla nueva con RLS, índice por usuario/cuaderno/fecha y borrado en cascada; no altera cuentas, archivos, vectores ni hace inferencias. No volver a ejecutar migraciones previas. El servidor no ejecuta SQL remoto automáticamente.

`notebook_turns` almacena cada intercambio en una fila atómica: pregunta (1–1000 caracteres), respuesta JSON validada con citas/snapshots (máximo 64 KiB), owner, notebook y fecha. RLS y el backend exigen propiedad del usuario y del cuaderno. Se concede SELECT/DELETE e INSERT sólo de campos autorizados; no UPDATE de intercambios ni INSERT de ID/fecha. Un propietario con acceso directo a su DB puede insertar contenido propio: el historial no es un registro criptográficamente inviolable ni se usa como instrucción al modelo.

`GET /api/notebooks/:id/conversation` devuelve las últimas 30 preguntas cronológicas y `hasMore`; lo anterior sigue guardado pero aún no hay paginación de historial en la interfaz. `DELETE` exige `{confirm:true}` y borra sólo ese historial. No toca fuentes ni llama a OpenRouter. Tras generar, el servidor guarda la pareja pregunta/respuesta antes de devolver `saved:true`; si falla el guardado devuelve la respuesta con `saved:false` y aviso, sin retry con costo. Sin migración, la app avisa y permite seguir respondiendo en memoria; recargar pierde lo no guardado.

El workspace divide fuentes, chat y cuadernos/herramientas. En móvil se alternan pestañas. El modal grande contiene únicamente la carga, límites y formatos disponibles; no simula integraciones que no existen. El visor pequeño abre texto extraído paginado u original privado con blob URL revocada al cerrar/cambiar. El texto se muestra literalmente; los PDF originales usan el visor del navegador. Las futuras herramientas se muestran como “próximamente”. No se guardan conversaciones, blobs ni claves en localStorage. El enlace del cuaderno conserva selección al recargar, validada contra los cuadernos propios.

Límites locales: 20 preguntas/minuto por usuario y dos respuestas en curso por proceso; plazo total de 90 segundos y límite de salida 2048 tokens/12000 caracteres. Cancelación y desconexión abortan el proveedor cuando es posible. No hay reintentos automáticos ni devolución de cargos garantizada. Cada intento puede cobrar embedding y generación aunque la validación falle. Las cuotas de embeddings existentes cubren búsqueda/indexación, mientras `/answer` tiene su propio limitador; no son un límite monetario global ni multiinstancia. No se cambiaron claves, perfil de embeddings ni políticas SQL.

## Lo que sigue

1. Probar manualmente preguntas con Qwen real, revisar cargos, citas y casos sin respuesta. Esta etapa se verificó con IA simulada, sin inferencias pagas nuevas.
2. Evaluar memoria conversacional y paginación de historial si se necesitan; la persistencia y el panel de evidencia ya están implementados.
3. Evaluación real de recuperación y fundamento, incluyendo contradicciones, prompt injection y ausencia de evidencia.
4. Cola/worker autónomo, aislamiento y controles globales de gasto para producción; OCR si hace falta.

Documentación consultada:

- [Supabase SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
- [Confirmación y plantillas de email](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Flujo PKCE y navegador de origen](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Restricciones del correo integrado y SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Storage privado](https://supabase.com/docs/guides/storage/security/access-control)
- [PDF.js: ejemplo oficial de extracción en Node](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs)
- [Opciones de PDF.js y texto por página](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)
- [BGE-M3 en OpenRouter: dimensiones y tarifa vigente](https://openrouter.ai/baai/bge-m3)
- [Contrato de embeddings de OpenRouter](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
- [Modelo BAAI/BGE-M3](https://huggingface.co/BAAI/bge-m3)
- [DeepInfra: ejemplo de respuesta con model BAAI/bge-m3](https://deepinfra.com/BAAI/bge-m3/api)
- [pgvector: distancia coseno y tipos vectoriales](https://github.com/pgvector/pgvector)
- [OpenRouter: razonamiento opcional y presupuesto de salida](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [OpenRouter: salidas estructuradas y streaming con JSON Schema](https://openrouter.ai/docs/guides/features/structured-outputs)
