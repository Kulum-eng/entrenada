import express from "express";
import { RekognitionClient, CompareFacesCommand } from "@aws-sdk/client-rekognition";
import fs from "fs";
import amqp from "amqplib";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = 3000;

// Configuración de RabbitMQ
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const NOTIFICATION_QUEUE = process.env.NOTIFICATION_QUEUE;
let rabbitChannel;

// Configuración de AWS Rekognition
const client = new RekognitionClient({
    region: "us-east-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
    },
});

// Función para conectar a RabbitMQ
async function connectToRabbitMQ() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        rabbitChannel = await connection.createChannel();
        await rabbitChannel.assertQueue(NOTIFICATION_QUEUE, { durable: true });
        console.log('✅ Conexión a RabbitMQ establecida - Cola "notificaciones" lista');
    } catch (error) {
        console.error('❌ Error conectando a RabbitMQ:', error.message);
        setTimeout(connectToRabbitMQ, 5000);
    }
}

// Conectar a RabbitMQ al iniciar la aplicación
connectToRabbitMQ();

// Middleware para parsear JSON
app.use(express.json({ limit: '10mb' }));

// Endpoint para comparar rostros
app.post("/compare", async (req, res) => {
    const { base64, requestId } = req.body;

    if (!base64) {
        return res.status(400).json({ error: "Se requiere una imagen de origen en base64" });
    }

    const targetImagePath = "target.jpg";
    const targetImage = fs.readFileSync(targetImagePath);

    const sourceImageBuffer = Buffer.from(base64, 'base64');

    const params = {
        SourceImage: { Bytes: sourceImageBuffer },
        TargetImage: { Bytes: targetImage },
        SimilarityThreshold: 80,
    };

    try {
        const command = new CompareFacesCommand(params);
        const response = await client.send(command);

        const result = {
            match: response.FaceMatches.length > 0,
            similarity: response.FaceMatches[0]?.Similarity || 0
        };

        // Enviar notificación a RabbitMQ
        if (rabbitChannel) {
            const notification = {
                title: "Acceso Correcto",
                body: "Bienvenido a casa",
                timestamp: new Date().toISOString()
            };
            await rabbitChannel.sendToQueue(
                NOTIFICATION_QUEUE,
                Buffer.from(JSON.stringify(notification)),
                { persistent: true }
            );
            console.log(`📨 Notificación enviada a la cola "${NOTIFICATION_QUEUE}"`);
        }

        return res.json(result);

    } catch (error) {
        console.error("Error al comparar rostros:", error);

        const errorResult = {
            error: true,
            message: error.message
        };

        // Enviar notificación de error a RabbitMQ
        if (rabbitChannel) {
            const notification = {
                title: "Acceso Denegado",
                body: "Intento de robo",
                timestamp: new Date().toISOString()
            };
            await rabbitChannel.sendToQueue(
                NOTIFICATION_QUEUE,
                Buffer.from(JSON.stringify(notification)),
                { persistent: true }
            );
        }

        return res.status(500).json(errorResult);
    }
});

// Iniciar el servidor
app.listen(port, () => {
    console.log(`🚀 Servidor de comparación facial corriendo en http://localhost:${port}`);
});

// Manejar la terminación del proceso
process.on('SIGINT', async () => {
    console.log('\n🔴 Deteniendo servidor...');
    if (rabbitChannel) await rabbitChannel.close();
    process.exit(0);
});
