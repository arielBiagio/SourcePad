import express from "express";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";
import "dotenv/config"; // Carga las variables de entorno desde .env

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Configuración de OpenAI apuntando a OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Better Auth debe montarse antes de express.json() para poder leer sus peticiones.
// Express 5 necesita el parámetro con nombre: *splat.
app.all("/api/auth/*splat", toNodeHandler(auth));

// Middleware para entender JSON en las rutas propias de la aplicación.
app.use(express.json());

// Sirve los archivos estáticos de tu Frontend (HTML/CSS/JS)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname)); 

async function getSession(req) {
  return auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
}

async function requireAuth(req, res, next) {
  try {
    const session = await getSession(req);

    if (!session) {
      return res.status(401).json({ error: "No autenticado" });
    }

    req.authSession = session;
    next();
  } catch (error) {
    console.error("❌ Error validando la sesión:", error.message);
    res.status(500).json({ error: "No se pudo validar la sesión" });
  }
}

app.get("/api/me", async (req, res) => {
  try {
    const session = await getSession(req);

    if (!session) {
      return res.status(401).json({ error: "No autenticado" });
    }

    res.json(session);
  } catch (error) {
    console.error("❌ Error obteniendo la sesión:", error.message);
    res.status(500).json({ error: "No se pudo obtener la sesión" });
  }
});

// --- La ruta del chat requiere una sesión válida ---
app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const { historial } = req.body;

    if (!Array.isArray(historial)) {
      return res.status(400).json({ error: "El historial debe ser un array" });
    }

    const LIMITE_MEMORIA = 6;
    const historialRecortado = historial.slice(-LIMITE_MEMORIA);

    const mensajeSistema = { 
      role: "system", 
      content: "Eres un asistente de IA integrado en una interfaz personalizada. Sé amigable y conciso." 
    };

    const mensajesParaIA = [mensajeSistema, ...historialRecortado];

    // 1. Configuramos las cabeceras HTTP para indicarle al navegador que enviaremos un flujo continuo (SSE)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // 2. Llamamos a OpenRouter activando la opción 'stream: true'
    const stream = await openai.chat.completions.create({
      model: "poolside/laguna-xs-2.1:free",
      messages: mensajesParaIA,
      stream: true, // 👈 LA CLAVE DEL STREAMING
    });

    // 3. Iteramos de forma asíncrona sobre cada palabra que nos manda el modelo
    for await (const chunk of stream) {
      const textoParticula = chunk.choices[0]?.delta?.content || "";
      if (textoParticula) {
        // Enviamos la partícula de texto inmediatamente al navegador
        res.write(textoParticula);
      }
    }

    // 4. Cerramos la conexión cuando la IA termine de hablar
    res.end();

  } catch (error) {
    console.error("❌ Error en streaming:", error.message);
    // Si ocurre un error antes de empezar a escribir, respondemos con código 500
    if (!res.headersSent) {
      res.status(500).send("Hubo un problema con el flujo de la IA.");
    }
  }
});


// Inicia el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});
