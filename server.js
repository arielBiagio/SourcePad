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
    const { historial } = req.body; // Recibimos el array completo desde la web

    // --- AQUÍ OCURRE LA MAGIA DE LA VENTANA DE DESLIZAMIENTO ---
    // Definimos el límite máximo de mensajes del historial que queremos recordar
    const LIMITE_MEMORIA = 6; 
    
    // Con .slice(-LIMITE_MEMORIA) tomamos únicamente los últimos 6 elementos del array
    const historialRecortado = historial.slice(-LIMITE_MEMORIA);
    // -----------------------------------------------------------

    // Definimos la personalidad fija del sistema
    const mensajeSistema = { 
      role: "system", 
      content: "Eres un asistente de IA integrado en una interfaz personalizada. Sé amigable y conciso." 
    };

    // Unimos la personalidad base con la ventana de memoria recortada
    const mensajesParaIA = [mensajeSistema, ...historialRecortado];

    // Llamamos a OpenRouter con los datos optimizados
    const response = await openai.chat.completions.create({
      model: "nvidia/nemotron-3-nano-30b-a3b:free",
      messages: mensajesParaIA,
    });

    const respuestaIA = response.choices[0].message.content;

    // Devolvemos el texto al frontend
    res.json({ respuesta: respuestaIA });

  } catch (error) {
    console.error("❌ Error en el servidor:", error);
    res.status(500).json({ error: "Hubo un problema al procesar la solicitud con la IA." });
  }
});

// Inicia el servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});
