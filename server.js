import express from "express";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config"; // Carga las variables de entorno desde .env

const app = express();
const PORT = 3000;

// Configuración de OpenAI apuntando a OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Middleware para entender JSON y permitir que el frontend se conecte
app.use(express.json());

// Sirve los archivos estáticos de tu Frontend (HTML/CSS/JS)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname)); 

// --- LA RUTA DE LA API DONDE LLEGARÁ TU FRONTEND ---
app.post("/api/chat", async (req, res) => {
  try {
    const { historial } = req.body;
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
      model: "nvidia/nemotron-3-nano-30b-a3b:free",
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
