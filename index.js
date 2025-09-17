// Simple test to verify WebSocket connection with Twilio
const express = require('express');
const WebSocket = require('ws');
const app = express();
const port = process.env.PORT || 3000;

// Create HTTP server
const server = require('http').createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => {
    res.json({ 
        message: 'WebSocket server ready',
        websocket_url: `wss://${req.get('host')}/media-stream`
    });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    console.log('🔌 New WebSocket connection from:', req.connection.remoteAddress);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Received:', data.event || 'unknown event');
            
            switch (data.event) {
                case 'connected':
                    console.log('✅ Twilio connected');
                    break;
                    
                case 'start':
                    console.log('🎙️ Stream started:', data.start.streamSid);
                    break;
                    
                case 'media':
                    console.log('🔊 Audio data received');
                    // Echo the audio back (for testing)
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: data.start?.streamSid,
                        media: {
                            payload: data.media.payload
                        }
                    }));
                    break;
                    
                case 'stop':
                    console.log('🛑 Stream stopped');
                    break;
                    
                default:
                    console.log('❓ Unknown event:', data.event);
            }
        } catch (error) {
            console.error('❌ Error processing message:', error);
        }
    });
    
    ws.on('close', () => {
        console.log('🔌 WebSocket connection closed');
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
});

server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📡 WebSocket ready at wss://your-domain/media-stream`);
});
